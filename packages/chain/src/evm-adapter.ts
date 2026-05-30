import { ethers, JsonRpcProvider, FallbackProvider, Wallet, Contract, Interface } from 'ethers';
import {
  createFilterErrorSilencer,
  installFilterNotFoundConsoleSuppressor,
  formatProviderError,
  type FilterErrorSilencer,
} from './filter-error-silencer.js';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  ChainAdapter,
  IdentityProof,
  ReservedRange,
  BatchMintParams,
  BatchMintResult,
  TxResult,
  ChainEvent,
  EventFilter,
  CreateContextGraphParams,
  ContextGraphOnChain,
  OnChainPublishResult,
  KAUpdateVerification,
  CreateOnChainContextGraphParams,
  CreateOnChainContextGraphResult,
  VerifyParams,
  PublishToContextGraphParams,
  V10PublishParams,
  V10UpdateKCParams,
  NodeChallenge,
  ProofPeriodStatus,
  CreateChallengeResult,
  OperationalWalletRegistrationResult,
  V10PublishingConvictionAccountInfo,
  VerifyACKIdentityResult,
  ApprovalPolicy,
} from './chain-adapter.js';
import {
  NoEligibleContextGraphError,
  NoEligibleKnowledgeCollectionError,
  MerkleRootMismatchError,
  ChallengeNoLongerActiveError,
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_REPLENISH_TARGET_ALLOWANCE,
  DEFAULT_REFILL_BELOW_FRACTION,
} from './chain-adapter.js';
import { HubResolutionCache } from './hub-resolution-cache.js';
import { PcaUnavailableError } from './pca-errors.js';
import {
  buildAuthorAttestationTypedData,
  AUTHOR_SCHEME_VERSION_V1,
  floorPublishTokenAmount,
  computeUpdateACKDigest,
} from '@origintrail-official/dkg-core';

/**
 * Default TTL for re-resolving `RandomSampling` / `RandomSamplingStorage`
 * from the Hub. Matches the daemon auto-update poll cadence — small
 * enough that a missed `Hub.ContractChanged` event still self-heals
 * within ~5 min, large enough that the steady-state RPC overhead is
 * effectively zero (one extra `eth_call` every 5 min for the two
 * names, vs. the prover's per-tick reads). Override per-adapter via
 * `EVMAdapterConfig.randomSamplingHubRefreshMs`.
 */
const DEFAULT_RANDOM_SAMPLING_HUB_REFRESH_MS = 5 * 60 * 1000;

/**
 * Hard ceiling for the best-effort live `getActiveProofingPeriodDurationInBlocks()`
 * read inside `getActiveProofPeriodStatus()`. The status read itself is one
 * `eth_call`; the duration probe is a sibling `eth_call` on the same provider
 * and should typically resolve in <100ms. If it hasn't returned in 2s the
 * provider is slow or hanging — fall back to `undefined` and let the prover
 * use the cached `existing.proofingPeriodDurationInBlocks` rather than
 * stalling the whole tick. Codex round 5 on PR #369.
 */
const DURATION_PROBE_TIMEOUT_MS = 2000;

/**
 * Upper bound on the in-flight duration probe slot age. The single-flight
 * guard reuses a pending probe to bound RPC cardinality at 1, but if the
 * underlying `eth_call` never settles (hung provider, dropped websocket)
 * the slot would otherwise stay populated forever and suppress every
 * fresh probe. After this many ms we abandon the slot regardless and
 * let the next call start a new probe — capping leaked-handle growth
 * to one per `MAX_PROBE_AGE_MS` window instead of one per tick. Set
 * generously above `DURATION_PROBE_TIMEOUT_MS` so honest slow paths
 * (high RPC latency, congested chain) still benefit from single-flight.
 * Codex round 8 on PR #369.
 */
const MAX_PROBE_AGE_MS = 30_000;
const RPC_READ_STALL_TIMEOUT_MS = 4_000;
const RPC_BROADCAST_ATTEMPT_TIMEOUT_MS = 10_000;
const RPC_RECEIPT_ATTEMPT_TIMEOUT_MS = 5_000;
const RPC_RECEIPT_POLL_INTERVAL_MS = 2_000;
const RPC_RECEIPT_TIMEOUT_MS = 180_000;

/**
 * Substrings we treat as "the Hub no longer recognises this contract
 * as a registered participant" — i.e. the cached address is stale and
 * the next call should re-resolve from the Hub. Conservative match on
 * the canonical revert wording from `ContractStatus.onlyContracts` /
 * `UnauthorizedAccess(Only Contracts in Hub)` so we don't accidentally
 * drop the cache on an unrelated authorization failure.
 */
/**
 * Maps a Hub-registered contract name to the function that invalidates
 * the corresponding boot-bound field on `EVMChainAdapter.contracts`.
 *
 * Used by:
 *   1. `startHubRotationListener` — when a Hub rotation event fires
 *      for `name`, the listener checks this allowlist, marks the
 *      adapter uninitialised, and leaves the existing handle intact so
 *      in-flight calls that already passed `init()` don't observe a
 *      transient `undefined`.
 *   2. `invalidateAllBoundContracts` — bulk drop, called by the
 *      write-side self-heal path (`withHubStaleRetry`) when a stale
 *      address surfaces `UnauthorizedAccess(Only Contracts in Hub)`.
 *
 * `RandomSampling` / `RandomSamplingStorage` are intentionally absent —
 * they go through `randomSamplingPairCache` + `invalidateRandomSamplingPair()`
 * which owns side-channel state (in-flight probe, ready flag) that
 * a simple field reset wouldn't touch.
 *
 * Names listed here MUST match what `init()` resolves via
 * `Hub.getContractAddress(name)` / `Hub.getAssetStorageAddress(name)`
 * — keep these in sync when adding/removing bindings in `init()`.
 */
const BOUND_CONTRACT_INVALIDATORS = new Map<string, (adapter: EVMChainAdapter) => void>([
  ['Identity',                   (a) => { (a as any).contracts.identity = undefined; }],
  ['Profile',                    (a) => { (a as any).contracts.profile = undefined; }],
  ['ProfileStorage',             (a) => { (a as any).contracts.profileStorage = undefined; }],
  ['ParametersStorage',          (a) => { (a as any).contracts.parametersStorage = undefined; }],
  ['Staking',                    (a) => { (a as any).contracts.staking = undefined; }],
  ['Token',                      (a) => { (a as any).contracts.token = undefined; }],
  ['AskStorage',                 (a) => { (a as any).contracts.askStorage = undefined; }],
  ['KnowledgeAssets',            (a) => { (a as any).contracts.knowledgeAssets = undefined; }],
  ['KnowledgeAssetsStorage',     (a) => { (a as any).contracts.knowledgeAssetsStorage = undefined; }],
  ['KnowledgeAssetsV10',         (a) => { (a as any).contracts.knowledgeAssetsV10 = undefined; }],
  ['KnowledgeAssetsLifecycle',   (a) => { (a as any).contracts.knowledgeAssetsV10 = undefined; }],
  ['KnowledgeCollection',        (a) => { (a as any).contracts.knowledgeCollection = undefined; }],
  ['KnowledgeCollectionStorage', (a) => { (a as any).contracts.knowledgeCollectionStorage = undefined; }],
  ['DKGKnowledgeAssets',         (a) => { (a as any).contracts.knowledgeCollectionStorage = undefined; }],
  ['ContextGraphNameRegistry',   (a) => { (a as any).contracts.contextGraphNameRegistry = undefined; }],
  ['ContextGraphs',              (a) => { (a as any).contracts.contextGraphs = undefined; }],
  ['ContextGraphStorage',        (a) => { (a as any).contracts.contextGraphStorage = undefined; }],
  ['DKGPublishingConvictionNFT', (a) => { (a as any).contracts.dkgPublishingConvictionNFT = undefined; }],
  ['Chronos',                    (a) => { (a as any).contracts.chronos = undefined; }],
]);

const HUB_STALE_ERROR_MARKERS = [
  'Only Contracts in Hub',
  'UnauthorizedAccess(Only Contracts in Hub)',
];

export function resolveRpcUrls(rpcUrl: string, rpcUrls?: string[]): string[] {
  const out: string[] = [];
  for (const candidate of [rpcUrl, ...(rpcUrls ?? [])]) {
    const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
    if (!trimmed || out.includes(trimmed)) continue;
    out.push(trimmed);
  }
  if (out.length === 0) {
    throw new Error('EVMChainAdapter requires at least one RPC URL');
  }
  return out;
}

/**
 * On-chain minimum the `KnowledgeAssetsV10.publish` / `update` contract
 * pulls via `token.transferFrom(msg.sender, CSS, fullCost)` even for
 * zero-byte / zero-value publishes — the contract rounds `fullCost` up to
 * `1` wei-TRAC. Empirically reproduced on Base Sepolia, May 2026: a
 * publish with JS-side `params.tokenAmount === 0n` reverted with
 * `TooLowAllowance(token, 0, 1)` because the auto-approve path (then
 * gated on `tokenAmount > 0n` / `currentAllowance < tokenAmount`) skipped
 * approval entirely.
 *
 * On mainnet the same fires whenever the pricing oracle returns `0`
 * (new / dust-value CGs, certain edge cases in `getRequiredPublishTokenAmount`),
 * so we floor the approval ceiling at the on-chain minimum.
 */
export const V10_PUBLISH_ONCHAIN_MIN_ALLOWANCE: bigint = 1n;

/**
 * Returns the TRAC allowance ceiling required to cover one V10 publish /
 * update. Floors at the on-chain minimum so the direct-spend branch
 * (`token.transferFrom(..., fullCost)`) never reverts with
 * `TooLowAllowance` when the JS-side `tokenAmount` is `0n`.
 *
 * This is the *building block* for the `per-publish` approval policy and
 * the lower-bound clamp used by every other policy mode in
 * `computeApprovalAction`. The bounded-per-publish security property of
 * the legacy code path lives here.
 */
export function effectivePublishAllowance(
  tokenAmount: bigint,
  onChainMin: bigint = V10_PUBLISH_ONCHAIN_MIN_ALLOWANCE,
): bigint {
  return tokenAmount > onChainMin ? tokenAmount : onChainMin;
}

const MAX_UINT256_ALLOWANCE: bigint = (1n << 256n) - 1n;

function clampApprovalFraction(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_REFILL_BELOW_FRACTION;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Computes the approval action for one V10 publish / update, dispatched
 * by `ApprovalPolicy.mode`.
 *
 * Contract:
 *   - `needsApprove === true`  → caller MUST submit `approve(KA,
 *     targetAllowance)` before the publish to satisfy
 *     `token.transferFrom(..., fullCost)` on-chain.
 *   - `needsApprove === false` → skip the approve; the existing allowance
 *     already covers this publish.
 *
 * Invariants enforced for every mode:
 *   - `targetAllowance >= effectivePublishAllowance(tokenAmount)` — even
 *     a misconfigured `replenishing` target gets raised to the on-chain
 *     minimum so the immediate publish succeeds.
 *   - `needsApprove` is monotone in `currentAllowance` — strictly more
 *     existing allowance never flips a `false` to `true`.
 *
 * See {@link ApprovalPolicy} in `chain-adapter.ts` for the mode
 * semantics; see `evm-adapter.unit.test.ts` for the pinned-down behaviour
 * under every combination of `(mode, tokenAmount, currentAllowance)`.
 */
export function computeApprovalAction(
  policy: ApprovalPolicy,
  tokenAmount: bigint,
  currentAllowance: bigint,
): { needsApprove: boolean; targetAllowance: bigint } {
  const publishFloor = effectivePublishAllowance(tokenAmount);
  switch (policy.mode) {
    case 'unlimited': {
      // Approve `MaxUint256` once per wallet. After that, currentAllowance
      // covers any plausible tokenAmount — re-approve only if some external
      // actor brought it back under the immediate publish's floor (manual
      // `approve(KA, 0)`, contract upgrade, etc.).
      return {
        needsApprove: currentAllowance < publishFloor,
        targetAllowance: MAX_UINT256_ALLOWANCE,
      };
    }
    case 'replenishing': {
      // Approve a configurable ceiling once, then refill when current drops
      // below `target × fraction`. Raise the target to at least the publish
      // floor so a misconfigured low `targetAllowance` doesn't brick the
      // publish — the bigger of (operator's intent, what we need right now).
      const requestedTarget =
        policy.targetAllowance ?? DEFAULT_REPLENISH_TARGET_ALLOWANCE;
      const target = requestedTarget > publishFloor ? requestedTarget : publishFloor;
      const fraction = clampApprovalFraction(
        policy.refillBelowFraction ?? DEFAULT_REFILL_BELOW_FRACTION,
      );
      // bigint-safe `target * fraction` via basis points so a fractional
      // refill threshold never drifts on round-trip.
      const fractionBp = BigInt(Math.round(fraction * 10_000));
      let threshold = (target * fractionBp) / 10_000n;
      // The refill threshold must cover the immediate publish's floor too —
      // refilling below it would just let the next publish revert with
      // `TooLowAllowance` again.
      if (threshold < publishFloor) threshold = publishFloor;
      return { needsApprove: currentAllowance < threshold, targetAllowance: target };
    }
    case 'per-publish':
    default: {
      // Approve exactly the publish floor. Matches the legacy bounded-
      // per-publish behaviour (with the 1n on-chain minimum closing the
      // gap that previously bricked zero-cost publishes).
      return {
        needsApprove: currentAllowance < publishFloor,
        targetAllowance: publishFloor,
      };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`);
      (err as any).code = 'TIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try { return JSON.stringify(err); } catch { return String(err); }
}

function errorCode(err: unknown): string {
  return String((err as any)?.code ?? (err as any)?.error?.code ?? '').toUpperCase();
}

function errorStatus(err: unknown): number | undefined {
  const raw =
    (err as any)?.status ??
    (err as any)?.statusCode ??
    (err as any)?.response?.status ??
    (err as any)?.error?.status ??
    (err as any)?.error?.statusCode;
  return typeof raw === 'number' ? raw : undefined;
}

function isRetryableRpcError(err: unknown): boolean {
  if (err instanceof Error) enrichEvmError(err);
  const code = errorCode(err);
  const status = errorStatus(err);
  const msg = errorMessage(err).toLowerCase();

  if (code === 'CALL_EXCEPTION' || code === 'INSUFFICIENT_FUNDS' || code === 'NONCE_EXPIRED'
    || code === 'RPC_RECEIPT_LOOKUP_FAILED'
    || code === 'REPLACEMENT_UNDERPRICED' || code === 'TRANSACTION_REPLACED'
    || code === 'ACTION_REJECTED' || code === 'INVALID_ARGUMENT' || code === 'UNPREDICTABLE_GAS_LIMIT') {
    return false;
  }
  if (msg.includes('execution reverted') || msg.includes('call exception')
    || msg.includes('insufficient funds') || msg.includes('invalid argument')
    || msg.includes('nonce too low') || msg.includes('replacement transaction underpriced')
    || msg.includes('intrinsic gas too low') || msg.includes('exceeds block gas limit')) {
    return false;
  }

  if (status === 429 || (typeof status === 'number' && status >= 500)) return true;
  if (code === 'TIMEOUT' || code === 'TIMEOUT_ERROR' || code === 'SERVER_ERROR'
    || code === 'NETWORK_ERROR' || code === 'ECONNRESET' || code === 'ECONNREFUSED'
    || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'EAI_AGAIN'
    || code === 'UNKNOWN_ERROR' || code === 'BAD_DATA') {
    return true;
  }
  return /timeout|timed out|network|socket|reset|econnreset|econnrefused|etimedout|enotfound|eai_again|rate limit|too many requests|429|503|502|500|gateway|temporarily unavailable|fetch failed|connection/i
    .test(msg);
}

function assertSuccessfulReceipt(receipt: ethers.TransactionReceipt, label: string): void {
  if (receipt.status !== 0) return;
  const err = new Error(`${label} tx ${receipt.hash} was mined but reverted (status=0)`);
  (err as any).code = 'CALL_EXCEPTION';
  (err as any).receipt = receipt;
  throw err;
}

function isKnownTransactionError(err: unknown): boolean {
  const code = errorCode(err);
  const msg = errorMessage(err).toLowerCase();
  return code === 'NONCE_EXPIRED'
    || msg.includes('already known')
    || msg.includes('known transaction')
    || msg.includes('already imported')
    || msg.includes('transaction already in mempool')
    || msg.includes('already exists')
    || msg.includes('already have transaction')
    || msg.includes('nonce too low')
    || msg.includes('duplicate transaction');
}

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const localAbiDir = join(__dirname, '..', 'abi');

function loadAbi(contractName: string): ethers.InterfaceAbi {
  const localPath = join(localAbiDir, `${contractName}.json`);
  if (existsSync(localPath)) {
    return JSON.parse(readFileSync(localPath, 'utf-8'));
  }
  return require(`@origintrail-official/dkg-evm-module/abi/${contractName}.json`);
}

const ERROR_ABI_CONTRACTS = [
  'KnowledgeAssets', 'KnowledgeAssetsV10', 'KnowledgeAssetsStorage', 'KnowledgeCollection',
  'KnowledgeCollectionStorage', 'ContextGraphs', 'ContextGraphStorage',
  'ContextGraphNameRegistry', 'Profile', 'Identity', 'IdentityStorage',
  'Staking', 'StakingStorage', 'StakingV10', 'StakingKPI',
  'ConvictionStakingStorage',
  'DKGStakingConvictionNFT', 'DKGPublishingConvictionNFT',
  // Post PR #650 split — PCA business errors are declared on the logic
  // and storage contracts, NOT the slim wrapper. Both must be in this
  // list so wrapper-bubbled reverts (e.g. NoConvictionAccount, AccountExpired,
  // UnknownAccount, InvalidAmount, AgentAlreadyRegistered) decode at runtime.
  'PublishingConviction', 'PublishingConvictionStorage',
  'Hub', 'Token', 'Ask', 'AskStorage',
  'Paymaster', 'ShardingTable', 'ParametersStorage',
  'PublishingConvictionAccount',
  'RandomSampling', 'RandomSamplingStorage',
];

const ADMIN_KEY_PURPOSE = 1;
const OPERATIONAL_KEY_PURPOSE = 2;

let _errorInterface: Interface | null = null;
let _pcaLogicInterface: Interface | null = null;

/**
 * Lazy-cached `ethers.Interface` over the `PublishingConviction` (logic)
 * contract ABI.
 *
 * Post PR #650, all PCA state-change events (`AccountCreated`, `ToppedUp`,
 * `CostCovered`, `WindowSettled`, `AccountFinalSwept`,
 * `AgentRegistered`, `AgentDeregistered`) are emitted by the logic contract
 * — NOT by the `DKGPublishingConvictionNFT` wrapper. Receipt-log parsing
 * for those events MUST go through this interface; parsing through the
 * wrapper's interface returns `null` because the wrapper ABI no longer
 * declares those events. See `DKGPublishingConvictionNFT.sol` NatSpec
 * "Deliberate breaks in the v2.x → v3.0.0 wrapper bump".
 */
function getPcaLogicInterface(): Interface {
  if (_pcaLogicInterface) return _pcaLogicInterface;
  _pcaLogicInterface = new Interface(loadAbi('PublishingConviction') as any[]);
  return _pcaLogicInterface;
}

function getErrorInterface(): Interface {
  if (_errorInterface) return _errorInterface;
  const errorFragments: string[] = [];
  for (const name of ERROR_ABI_CONTRACTS) {
    try {
      const abi = loadAbi(name) as any[];
      for (const entry of abi) {
        if (entry.type === 'error') {
          const params = (entry.inputs ?? []).map((i: any) => `${i.type} ${i.name}`).join(', ');
          errorFragments.push(`error ${entry.name}(${params})`);
        }
      }
    } catch { /* ABI not available */ }
  }
  _errorInterface = new Interface([...new Set(errorFragments)]);
  return _errorInterface;
}

/**
 * Decode an EVM custom error selector into a human-readable string.
 * Returns null if the selector doesn't match any known contract error.
 */
export function decodeEvmError(data: string | Uint8Array): { name: string; args: ethers.Result } | null {
  try {
    const hex = typeof data === 'string' ? data : ethers.hexlify(data);
    if (hex.length < 10) return null;
    const parsed = getErrorInterface().parseError(hex);
    return parsed ? { name: parsed.name, args: parsed.args } : null;
  } catch {
    return null;
  }
}

/**
 * Enrich a caught EVM error with a decoded custom error name.
 * Modifies the error message in-place and returns the decoded name (if any).
 */
export function enrichEvmError(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  // Match the revert-data hex across the RPC-shape variants we see in the
  // wild. CH-10:
  //   - Hardhat:        ... data="0x..."             (key="value", quoted)
  //   - Geth:           ... data: "0x..."            (key: value, JS-object)
  //   - Geth no-quote:  ... data=0x...               (key=value, unquoted)
  //   - Infura/Alchemy: ... errorData="0x..."        (errorData= prefix)
  //   - JSON body:      ... "data":"0x..."           (JSON-encoded provider error)
  // Leading non-letter (or string start) ensures `errorData` doesn't match
  // as `data`. Separator class accepts any combination of `=`, `:`, `"`,
  // `'`, whitespace.
  const match = err.message.match(
    /(?:^|[^a-zA-Z])(?:errorData|data)["':=\s]+(0x[0-9a-fA-F]+)/,
  );
  if (!match) return null;
  const decoded = decodeEvmError(match[1]);
  if (!decoded) return null;
  const argsStr = decoded.args.length > 0 ? `(${decoded.args.join(', ')})` : '';
  const decodedStr = `${decoded.name}${argsStr}`;
  err.message = err.message.replace('unknown custom error', decodedStr);
  return decoded.name;
}

interface EVMAdapterBaseConfig {
  rpcUrl: string;
  rpcUrls?: string[];
  /** Primary operational wallet key (used for identity registration, staking, etc.) */
  privateKey: string;
  /** Additional operational wallet keys for parallel transaction submission. */
  additionalKeys?: string[];
  hubAddress: string;
  chainId?: string;
  /**
   * TTL (ms) for re-resolving `RandomSampling` / `RandomSamplingStorage`
   * addresses from the Hub. Defaults to 5 minutes. Values `<= 0` are
   * treated as "use default" and intentionally NOT supported as a
   * "disable periodic refresh" mode: even with the Hub event listener
   * and the `Only Contracts in Hub` retry wrapper, a missed event on
   * a read-only path (e.g. `getActiveProofPeriodStatus`,
   * `getNodeChallenge`) would leave the adapter pinned to a stale
   * address until restart, exactly the failure mode this cache exists
   * to prevent. The TTL is a backstop, not the primary refresh
   * mechanism — keep it short enough that a missed rotation
   * self-heals within minutes and the steady-state RPC overhead is
   * still effectively zero.
   */
  randomSamplingHubRefreshMs?: number;
  /**
   * Policy that controls how the V10 publish / update auto-approve sizes
   * its TRAC allowance request. Defaults to {@link DEFAULT_APPROVAL_POLICY}
   * (`per-publish`), preserving the bounded-per-publish behaviour that
   * existed before this field landed. See {@link ApprovalPolicy} for the
   * mode semantics.
   */
  approvalPolicy?: ApprovalPolicy;
}

export interface EVMAdapterConfig extends EVMAdapterBaseConfig {
  /** Admin wallet key used for profile/key-management transactions. */
  adminPrivateKey?: string;
  /**
   * Documents that this adapter is intentionally running without admin
   * authority. Missing admin keys are still accepted for backwards-compatible
   * publish/read-only usage; admin-only operations fail when invoked.
   */
  allowNoAdminSigner?: boolean;
}

interface ContractCache {
  hub: Contract;
  identity?: Contract;
  profile?: Contract;
  /**
   * RFC 04 v0.3 — read getRelayCapable and listen for RelayCapabilityUpdated
   * events from here. Profile.sol is the only writer (via onlyContracts) but
   * the storage contract owns both the view surface and the event surface.
   */
  profileStorage?: Contract;
  knowledgeAssets?: Contract;
  knowledgeAssetsStorage?: Contract;
  knowledgeCollection?: Contract;
  knowledgeCollectionStorage?: Contract;
  staking?: Contract;
  contextGraphNameRegistry?: Contract;
  token?: Contract;
  parametersStorage?: Contract;
  askStorage?: Contract;
  contextGraphs?: Contract;
  contextGraphStorage?: Contract;
  knowledgeAssetsV10?: Contract;
  /** V10 NFT-backed PCA. Backs the PCA write surface + the publisher's
   *  `kcEpochs == lockDurationEpochs` discount check (SDK pre-coerces). */
  dkgPublishingConvictionNFT?: Contract;
  randomSampling?: Contract;
  randomSamplingStorage?: Contract;
  identityStorage?: Contract;
  convictionStakingStorage?: Contract;
  stakingStorage?: Contract;
  /**
   * Epoch oracle used by the update path to compute `remainingEpochs`
   * (`endEpoch - currentEpoch`) when sizing `newTokenAmount` so the
   * daemon's pre-flight matches `KnowledgeAssetsLifecycle._validateTokenAmount`.
   * Without this, byteSize-growth updates revert with `InvalidTokenAmount(1, 0)`
   * because the carry-forward `currentTokenAmount` produces `deltaTokenAmount == 0`.
   * Tracked at issue #831.
   */
  chronos?: Contract;
}

function formatProviderContext(config: Pick<EVMAdapterConfig, 'chainId' | 'rpcUrl'>): string {
  let rpcHost: string;
  try {
    const parsed = new URL(config.rpcUrl);
    rpcHost = parsed.host || parsed.protocol || 'unknown-rpc';
  } catch {
    rpcHost = 'unparseable-rpc';
  }
  return `chainId=${config.chainId ?? 'unknown'} rpc=${rpcHost}`;
}

/**
 * EVM chain adapter implementing the V9 ChainAdapter interface.
 * Resolves contract addresses dynamically from the Hub.
 */
export class EVMChainAdapter implements ChainAdapter {
  /** See `ChainAdapter.deploymentId`. */
  get deploymentId(): string {
    return `${this.chainId}:hub=${this.hubAddress.toLowerCase()}`;
  }
  readonly chainType = 'evm' as const;
  readonly chainId: string;

  private readonly provider: JsonRpcProvider | FallbackProvider;
  private readonly primaryProvider: JsonRpcProvider;
  private readonly providers: JsonRpcProvider[];
  private readonly rpcUrls: string[];
  private readonly filterErrorSilencer: FilterErrorSilencer;
  /** Primary signer — used for identity/profile/staking operations. */
  private readonly signer: Wallet;
  /** All operational signers (includes primary). Used round-robin for publish TXs. */
  private readonly signerPool: Wallet[];
  /** Admin signer — used only for profile/key-management operations. */
  private readonly adminSigner?: Wallet;
  private signerIndex = 0;
  private signerSelectionQueue: Promise<void> = Promise.resolve();
  private readonly hubAddress: string;
  /**
   * Operator-configured allowance sizing policy for V10 publish / update
   * auto-approve. See {@link ApprovalPolicy}. Default is `'per-publish'`,
   * preserving the bounded-per-publish behaviour from before the policy
   * landed.
   */
  private readonly approvalPolicy: ApprovalPolicy;
  private contracts: ContractCache;
  private initialized = false;
  /**
   * Single self-refreshing cache for the `RandomSampling` /
   * `RandomSamplingStorage` pair. RS is the highest-value Hub-resolved
   * surface (it gates per-period proof rewards), so it gets stricter
   * freshness guarantees than the one-shot resolution every other
   * contract uses.
   *
   * The two addresses are deliberately treated as a **coupled unit**
   * because `RandomSampling.initialize()` snapshots its
   * `RandomSamplingStorage` address once at deploy time. If the
   * adapter ever held a mixed pair (e.g. new RS + old RSS, or the
   * inverse) `createChallenge()` would write through one contract
   * and `getNodeChallenge()` would read from the other — producing
   * the empty-struct / state-mismatch failures the prover already
   * has a defensive guard against. Resolving both names atomically
   * inside one cache eliminates that race.
   *
   * See `HubResolutionCache` for the semantics; the listener
   * installed in `init()` invalidates this cache on
   * `Hub.ContractChanged` / `Hub.NewContract` for **either** name,
   * and `withHubStaleRetry()` invalidates it when a write surfaces
   * `UnauthorizedAccess(Only Contracts in Hub)`.
   */
  private readonly randomSamplingPairCache: HubResolutionCache<{ rs: Contract; rss: Contract }>;
  /**
   * OT-RFC-39 — per-process cache for `getIdentityIdForAddress`.
   * Only positive (non-zero) hits are memoised; see the method body
   * for the rationale (negative-hit invalidation hazard).
   */
  private readonly identityIdByAddressCache: Map<string, bigint> = new Map();
  private hubRotationListenerStarted = false;
  /**
   * Single-flight guard for the best-effort
   * `getActiveProofingPeriodDurationInBlocks()` probe inside
   * `getActiveProofPeriodStatus()`. Codex round 5 on PR #369: the
   * 2s `Promise.race` timeout returns `undefined` to the caller but
   * the underlying `eth_call` is NOT cancellable in ethers v6, so
   * naively issuing one new probe per tick would accumulate one
   * stuck request per tick on a hung provider. Instead we reuse the
   * same in-flight promise across overlapping calls — at most one
   * probe is ever pending against the provider at a time.
   *
   * Codex round 8 on PR #369: also track the `RandomSampling`
   * Contract instance the probe was started against AND a wall-clock
   * creation timestamp.
   *   - Contract-identity guard: a TTL refresh of
   *     `randomSamplingPairCache` re-resolves `rs` to a freshly
   *     constructed `Contract` instance WITHOUT calling
   *     `invalidateRandomSamplingPair()`. The HubResolutionCache
   *     generation counter is invalidate-only (it is also used by
   *     `resolveAndAssignRandomSamplingPair()` to detect concurrent
   *     invalidations, so it must NOT bump on normal refreshes), so
   *     it can't signal a TTL refresh. Comparing the resolved
   *     Contract instance by reference is the canonical check: a
   *     refresh always hands back a new instance.
   *   - Max-age guard: `Promise.race` returns `undefined` to the
   *     caller on timeout, but the underlying `eth_call` may
   *     never settle (truly hung provider). Without an upper
   *     bound on slot age, a single hung probe would suppress
   *     every fresh probe forever. After `MAX_PROBE_AGE_MS` we
   *     abandon the slot regardless; the orphan promise still has
   *     its `.finally` attached but the slot identity check inside
   *     it correctly does nothing.
   */
  private inflightDurationProbe: Promise<bigint | undefined> | undefined;
  private inflightDurationProbeContract: Contract | undefined;
  private inflightDurationProbeStartedAt = 0;

  /**
   * PR3 / RC11 — TTL cache for the three "publish pre-flight" reads the
   * V10 ACK provider needs on every publish:
   *
   *   - `getEvmChainId()`           (chain id, never changes after
   *                                  the JSON-RPC endpoint is configured)
   *   - `getKnowledgeAssetsV10Address()` (KAV10 contract address —
   *                                  changes only on contract redeploy)
   *   - `getMinimumRequiredSignatures()` (governance parameter — changes
   *                                  only on a `ParametersStorage` write)
   *
   * Pre-PR3 every publish issued three serial JSON-RPC calls before
   * even dialling peers for ACKs. The dzudza incident (Sun 20:42 UTC,
   * `eth_chainId` rate-limited on the public Base Sepolia RPC) is the
   * canonical symptom: a single rate-limited pre-flight call killed
   * the entire publish path even though the chain values themselves
   * had never changed for the daemon's lifetime.
   *
   * The TTL is conservative (1h) because all three values are
   * structurally stable. A `ParametersStorage` governance vote that
   * changed `minimumRequiredSignatures` mid-cycle would take up to 1h
   * to propagate to the ACK collector — acceptable, since the contract
   * itself rejects mismatched-quorum publishes and the publisher
   * retries on the next attempt. Chain-id and KAV10 address never
   * change without a daemon restart in practice.
   *
   * Cache is keyed implicitly on `this` (per-adapter instance); a
   * second adapter pointed at a different chain has its own cache
   * with no cross-talk.
   */
  private static readonly PREFLIGHT_TTL_MS = 60 * 60 * 1000;
  private cachedChainId: { value: bigint; cachedAt: number } | undefined;
  private cachedKav10Address: { value: string; cachedAt: number } | undefined;
  private cachedMinRequiredSignatures: { value: number; cachedAt: number } | undefined;

  /**
   * Reset the PR3 publish-preflight cache. Public so daemon code that
   * knows about an external chain reconfiguration (e.g. a hot-reload
   * of `chainRpcUrl` or a deliberate governance-vote test fixture)
   * can flush the cache without waiting out the TTL. Tests use this
   * to reset state between cases.
   */
  invalidatePublishPreflightCache(): void {
    this.cachedChainId = undefined;
    this.cachedKav10Address = undefined;
    this.cachedMinRequiredSignatures = undefined;
  }

  private static preflightCacheFresh(
    entry: { cachedAt: number } | undefined,
    now: number,
  ): boolean {
    if (!entry) return false;
    return now - entry.cachedAt < EVMChainAdapter.PREFLIGHT_TTL_MS;
  }

  constructor(config: EVMAdapterConfig) {
    this.rpcUrls = resolveRpcUrls(config.rpcUrl, config.rpcUrls);
    this.providers = this.rpcUrls.map((url) => new JsonRpcProvider(url, undefined, { cacheTimeout: -1 }));
    this.primaryProvider = this.providers[0];
    this.provider = this.providers.length === 1
      ? this.primaryProvider
      : new FallbackProvider(
        this.providers.map((provider, index) => ({
          provider,
          priority: index + 1,
          stallTimeout: RPC_READ_STALL_TIMEOUT_MS,
          weight: 1,
        })),
        undefined,
        { quorum: 1 },
      );
    const providerContext = formatProviderContext(config);
    // PR-8: install the filter-not-found silencer. Without this, RPC
    // nodes that GC filters faster than ethers' polling cadence
    // (observed: 134 MB of daemon.log spam in 24h on beacon-01) spam
    // the operator's logs with per-tick "filter not found" errors.
    // The silencer dedupe-logs once per DEDUP_WINDOW_MS and lets every
    // other provider error propagate normally. It does not recreate
    // filters or guarantee every Hub-resolved contract handle stays
    // fresh; only the RandomSampling pair has a TTL self-heal path.
    // The warning text keeps the wider event-polling degradation visible.
    this.filterErrorSilencer = createFilterErrorSilencer({
      log: (msg) => console.warn(`${msg} (${providerContext})`),
    });
    // BUG-022: ethers v6 swallows `eth_getFilterChanges` "filter not
    // found" errors with a literal `console.log("@TODO", error)` from
    // subscriber-filterid.js — that path bypasses
    // `provider.on('error', ...)` entirely, so the per-provider
    // silencer above never gets a chance to suppress them. Install a
    // process-wide `console.log` interceptor (idempotent) that catches
    // exactly that two-arg shape and routes it through a dedicated
    // silencer with the same dedup window. Real `console.log` calls
    // are forwarded untouched.
    installFilterNotFoundConsoleSuppressor();
    const providerErrorHandler = (err: unknown) => {
      if (this.filterErrorSilencer.handle(err)) return;
      // Non-filter provider errors fall through to the error
      // path so they remain visible. Operators grepping their logs
      // for chain-provider issues still see everything they used to
      // EXCEPT the filter-spam class.
      console.error(`[chain] provider error (${providerContext}): ${formatProviderError(err)}`);
    };
    for (let i = 0; i < this.providers.length; i += 1) {
      const provider = this.providers[i];
      const listenerContext = `${providerContext}; rpc #${i + 1}`;
      try {
        void Promise.resolve(provider.on('error', providerErrorHandler)).catch((err: unknown) => {
          console.error(
            `[chain] provider error listener registration failed (${listenerContext}): ${formatProviderError(err)}`,
          );
        });
      } catch (err) {
        console.error(
          `[chain] provider error listener registration failed (${listenerContext}): ${formatProviderError(err)}`,
        );
      }
    }
    this.signer = new Wallet(config.privateKey, this.provider);
    this.signerPool = [this.signer];
    for (const key of config.additionalKeys ?? []) {
      this.signerPool.push(new Wallet(key, this.provider));
    }
    if (config.adminPrivateKey) {
      this.adminSigner = new Wallet(config.adminPrivateKey, this.provider);
      const adminAddress = this.adminSigner.address.toLowerCase();
      if (this.signerPool.some((signer) => signer.address.toLowerCase() === adminAddress)) {
        throw new Error('EVM adminPrivateKey must be distinct from operational keys');
      }
    }
    this.hubAddress = config.hubAddress;
    this.chainId = config.chainId ?? 'evm:31337';
    this.approvalPolicy = config.approvalPolicy ?? DEFAULT_APPROVAL_POLICY;

    this.contracts = {
      hub: new Contract(config.hubAddress, loadAbi('Hub'), this.signer),
    };

    // Coerce `<=0` to the default. The "disable refresh entirely" mode
    // is intentionally unsupported (see `randomSamplingHubRefreshMs`
    // doc above) — without a TTL backstop, a missed Hub event on a
    // read-only path (`getActiveProofPeriodStatus`, `getNodeChallenge`)
    // would silently pin the adapter to a stale address until restart.
    const rawRsRefreshMs = config.randomSamplingHubRefreshMs ?? DEFAULT_RANDOM_SAMPLING_HUB_REFRESH_MS;
    const rsRefreshMs = rawRsRefreshMs > 0 ? rawRsRefreshMs : DEFAULT_RANDOM_SAMPLING_HUB_REFRESH_MS;
    this.randomSamplingPairCache = new HubResolutionCache(
      async () => {
        // Resolve both names in a single round (Promise.all) so that
        // the cache only ever holds a coherent pair: when this
        // resolves, both addresses came from the same Hub view.
        const [rs, rss] = await Promise.all([
          this.resolveContract('RandomSampling'),
          this.resolveContract('RandomSamplingStorage'),
        ]);
        return { rs, rss };
      },
      { ttlMs: rsRefreshMs },
    );
  }

  /** Pick the next signer from the pool (round-robin). */
  private nextSigner(): Wallet {
    const s = this.signerPool[this.signerIndex % this.signerPool.length];
    this.signerIndex++;
    return s;
  }

  private findSignerByAddress(address: string): Wallet | undefined {
    const normalized = ethers.getAddress(address).toLowerCase();
    return this.signerPool.find((signer) => signer.address.toLowerCase() === normalized);
  }

  private async broadcastSignedTransactionWithFailover(
    signedTx: string,
    txHash: string,
    label: string,
  ): Promise<void> {
    let lastRetryable: unknown;
    for (let i = 0; i < this.providers.length; i += 1) {
      const provider = this.providers[i];
      try {
        await withTimeout(
          provider.broadcastTransaction(signedTx),
          RPC_BROADCAST_ATTEMPT_TIMEOUT_MS,
          `${label} broadcast via RPC #${i + 1}`,
        );
        return;
      } catch (err) {
        if (isKnownTransactionError(err)) return;
        if (!isRetryableRpcError(err)) throw err;
        lastRetryable = err;
      }
    }
    throw new Error(
      `${label} broadcast failed on all configured RPC endpoints for tx ${txHash}: ${errorMessage(lastRetryable)}`,
      { cause: lastRetryable },
    );
  }

  private async getTransactionReceiptWithFailover(txHash: string): Promise<ethers.TransactionReceipt | null> {
    let lastRetryable: unknown;
    let sawNonErrorResponse = false;
    for (let i = 0; i < this.providers.length; i += 1) {
      const provider = this.providers[i];
      try {
        const receipt = await withTimeout(
          provider.getTransactionReceipt(txHash),
          RPC_RECEIPT_ATTEMPT_TIMEOUT_MS,
          `receipt lookup via RPC #${i + 1}`,
        );
        sawNonErrorResponse = true;
        if (receipt) return receipt;
      } catch (err) {
        if (!isRetryableRpcError(err)) throw err;
        lastRetryable = err;
      }
    }
    if (lastRetryable && !sawNonErrorResponse) {
      const err = new Error(
        `Receipt lookup for tx ${txHash} failed on all configured RPC endpoints: ${errorMessage(lastRetryable)}`,
        { cause: lastRetryable },
      );
      (err as any).code = 'RPC_RECEIPT_LOOKUP_FAILED';
      throw err;
    }
    return null;
  }

  private async waitForReceiptWithFailover(
    txHash: string,
    label: string,
  ): Promise<ethers.TransactionReceipt> {
    const deadline = Date.now() + RPC_RECEIPT_TIMEOUT_MS;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const receipt = await this.getTransactionReceiptWithFailover(txHash);
        if (receipt) {
          assertSuccessfulReceipt(receipt, label);
          return receipt;
        }
      } catch (err) {
        if (!isRetryableRpcError(err)) throw err;
        lastError = err;
      }
      await sleep(RPC_RECEIPT_POLL_INTERVAL_MS);
    }
    throw new Error(
      `${label} tx ${txHash} was broadcast but no receipt was found within ${RPC_RECEIPT_TIMEOUT_MS}ms` +
      (lastError ? ` (last RPC error: ${errorMessage(lastError)})` : ''),
      { cause: lastError },
    );
  }

  private async signPopulatedTransaction(
    signer: Wallet,
    populated: ethers.TransactionRequest,
  ): Promise<{ signedTx: string; txHash: string }> {
    const filled = await signer.populateTransaction(populated);
    const signedTx = await signer.signTransaction(filled);
    const txHash = ethers.Transaction.from(signedTx).hash ?? '0x';
    return { signedTx, txHash };
  }

  private async sendSignedTransactionAndWait(
    signedTx: string,
    txHash: string,
    label: string,
  ): Promise<ethers.TransactionReceipt> {
    await this.broadcastSignedTransactionWithFailover(signedTx, txHash, label);
    return this.waitForReceiptWithFailover(txHash, label);
  }

  private async sendPopulatedTransaction(
    signer: Wallet,
    populated: ethers.TransactionRequest,
    label: string,
  ): Promise<ethers.TransactionReceipt> {
    const { signedTx, txHash } = await this.signPopulatedTransaction(signer, populated);
    return this.sendSignedTransactionAndWait(signedTx, txHash, label);
  }

  private async sendContractTransaction(
    contract: Contract,
    method: string,
    args: readonly unknown[],
    signer: Wallet,
    label: string,
  ): Promise<ethers.TransactionReceipt> {
    const connected = contract.connect(signer) as any;
    const populated = await connected[method].populateTransaction(...args);
    return this.sendPopulatedTransaction(signer, populated, label);
  }

  /**
   * V10 approval gate shared by `publishV10` and `updateV10`.
   *
   * Reads the on-chain TRAC allowance from `signer.address` to the V10
   * `KnowledgeAssets` contract, then dispatches through
   * `computeApprovalAction(this.approvalPolicy, tokenAmount, current)`:
   *   - `per-publish` (default): bounded-per-call, with a `1n` floor so
   *     zero-cost publishes / metadata-only updates still satisfy the
   *     contract's `transferFrom(..., 1n)` minimum (the #720 mainnet
   *     revert we shipped a fix for).
   *   - `replenishing`: approve a ceiling, refill at a fraction.
   *   - `unlimited`: V9-style one-shot MaxUint256.
   *
   * Acts as a no-op when `this.contracts.token` is absent (read-only
   * adapters). Extracted from the two near-identical inline blocks in
   * `publishV10` / `updateV10` so the approve branches are exercised by
   * a single seam in unit tests (`mock allowance() / approve()`).
   */
  private async ensureV10ApproveTrac(
    signer: Wallet,
    kav10Address: string,
    tokenAmount: bigint,
    txLabel: string,
  ): Promise<void> {
    if (!this.contracts.token) return;
    const tokenWithSigner = this.contracts.token.connect(signer) as Contract;
    const currentAllowance: bigint = await tokenWithSigner.allowance(
      signer.address,
      kav10Address,
    );
    const { needsApprove, targetAllowance } = computeApprovalAction(
      this.approvalPolicy,
      tokenAmount,
      currentAllowance,
    );
    if (needsApprove) {
      await this.sendContractTransaction(
        tokenWithSigner,
        'approve',
        [kav10Address, targetAllowance],
        signer,
        txLabel,
      );
    }
  }

  /**
   * Pick the next signer in the pool that the on-chain ContextGraphs contract
   * authorizes for the target context graph. Falls back to round-robin only
   * when the auth surface is unavailable.
   */
  private async nextAuthorizedSigner(contextGraphId: bigint): Promise<Wallet> {
    const previousSelection = this.signerSelectionQueue;
    let releaseSelection!: () => void;
    this.signerSelectionQueue = new Promise<void>((resolve) => { releaseSelection = resolve; });
    await previousSelection;
    try {
      if (!this.contracts.contextGraphs) {
        return this.nextSigner();
      }

      const start = this.signerIndex % this.signerPool.length;
      for (let i = 0; i < this.signerPool.length; i += 1) {
        const idx = (start + i) % this.signerPool.length;
        const signer = this.signerPool[idx];
        const authorized = await this.contracts.contextGraphs.isAuthorizedPublisher(contextGraphId, signer.address);
        if (authorized) {
          this.signerIndex = idx + 1;
          return signer;
        }
      }

      throw new Error(
        `No authorized publisher wallet found in signer pool for context graph ${contextGraphId.toString()}. ` +
        'Ensure at least one configured wallet is permitted by on-chain publish authority.',
      );
    } finally {
      releaseSelection();
    }
  }

  /**
   * Reserve the next authorized signer and return its address. The publisher
   * uses this to bind off-chain signatures to the tx signer before
   * `publishDirect` is submitted.
   */
  async getAuthorizedPublisherAddress(contextGraphId: bigint): Promise<string> {
    await this.init();

    return (await this.nextAuthorizedSigner(contextGraphId)).address;
  }

  /** All operational wallet addresses (for display / funding). */
  getSignerAddresses(): string[] {
    return this.signerPool.map((s) => s.address);
  }

  /** Primary operational private key (hex string with 0x prefix). */
  getOperationalPrivateKey(): string {
    return this.signer.privateKey;
  }

  private walletKeyHash(address: string): string {
    return ethers.keccak256(ethers.solidityPacked(['address'], [ethers.getAddress(address)]));
  }

  private async getIdentityStorage(): Promise<Contract> {
    if (!this.contracts.identityStorage) {
      this.contracts.identityStorage = await this.resolveContract('IdentityStorage');
    }
    return this.contracts.identityStorage;
  }

  private async getConvictionStakingStorage(): Promise<Contract | null> {
    if (!this.contracts.convictionStakingStorage) {
      try {
        this.contracts.convictionStakingStorage = await this.resolveContract('ConvictionStakingStorage');
      } catch { return null; }
    }
    return this.contracts.convictionStakingStorage;
  }

  private async getStakingStorage(): Promise<Contract | null> {
    if (!this.contracts.stakingStorage) {
      try {
        this.contracts.stakingStorage = await this.resolveContract('StakingStorage');
      } catch { return null; }
    }
    return this.contracts.stakingStorage;
  }

  private async hasAdminPurpose(
    identityStorage: Contract,
    identityId: bigint,
    address: string,
  ): Promise<boolean> {
    return identityStorage.keyHasPurpose(
      identityId,
      this.walletKeyHash(address),
      ADMIN_KEY_PURPOSE,
    );
  }

  private async hasOperationalPurpose(
    identityStorage: Contract,
    identityId: bigint,
    address: string,
  ): Promise<boolean> {
    return identityStorage.keyHasPurpose(
      identityId,
      this.walletKeyHash(address),
      OPERATIONAL_KEY_PURPOSE,
    );
  }

  async isOperationalWalletRegistered(identityId: bigint, address: string): Promise<boolean> {
    await this.init();
    const identityStorage = await this.getIdentityStorage();
    return this.hasOperationalPurpose(identityStorage, identityId, address);
  }

  async ensureOperationalWalletsRegistered(options?: {
    identityId?: bigint;
    additionalAddresses?: string[];
  }): Promise<OperationalWalletRegistrationResult> {
    await this.init();

    const identityId = options?.identityId ?? (await this.getIdentityId());
    const result: OperationalWalletRegistrationResult = {
      identityId,
      registered: [],
      alreadyRegistered: [],
      taken: [],
    };
    if (identityId === 0n) return result;

    const identityStorage = await this.getIdentityStorage();
    const candidates = [
      ...this.signerPool.map((s) => s.address),
      ...(options?.additionalAddresses ?? []),
    ];
    const seen = new Set<string>();
    const uniqueAddresses: string[] = [];
    for (const candidate of candidates) {
      const address = ethers.getAddress(candidate);
      const key = address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueAddresses.push(address);
    }

    const onChainIds = await Promise.all(
      uniqueAddresses.map((addr) => identityStorage.getIdentityId(addr).then(BigInt)),
    );
    const missing: string[] = [];
    for (let i = 0; i < uniqueAddresses.length; i++) {
      const address = uniqueAddresses[i];
      const existingIdentityId = onChainIds[i];
      if (existingIdentityId === identityId) {
        result.alreadyRegistered.push(address);
      } else if (existingIdentityId === 0n) {
        missing.push(address);
      } else {
        result.taken.push({ address, identityId: existingIdentityId });
      }
    }

    if (missing.length === 0) return result;

    if (!this.adminSigner) {
      throw new Error(
        `Cannot register operational wallets for identity ${identityId}: ` +
        'adminPrivateKey is not configured.',
      );
    }
    if (!(await this.hasAdminPurpose(identityStorage, identityId, this.adminSigner.address))) {
      throw new Error(
        `Cannot register operational wallets for identity ${identityId}: configured admin wallet ` +
        `${this.adminSigner.address} is not registered on-chain as an admin key for this identity.`,
      );
    }

    await this.sendContractTransaction(
      this.contracts.profile!,
      'addOperationalWallets',
      [identityId, missing],
      this.adminSigner,
      'addOperationalWallets',
    );

    for (const address of missing) {
      if (await this.hasOperationalPurpose(identityStorage, identityId, address)) {
        result.registered.push(address);
      }
    }

    return result;
  }

  // =====================================================================
  // RFC 04 v0.3 / Issue #461 — Network State Registry surface (relay-capable).
  // Multiaddrs are NOT exposed here — they live in per-round attestation KCs
  // (RFC 04 §5.2), not on Profile.
  // =====================================================================

  async getRelayCapable(identityId: bigint): Promise<boolean> {
    await this.init();
    if (!this.contracts.profileStorage) {
      throw new Error('getRelayCapable: ProfileStorage not deployed on this Hub.');
    }
    return Boolean(await this.contracts.profileStorage.getRelayCapable(identityId));
  }

  async setRelayCapable(relayCapable: boolean): Promise<TxResult> {
    await this.init();
    if (!this.contracts.profile) {
      throw new Error('setRelayCapable: Profile not deployed on this Hub.');
    }
    const identityId = await this.getIdentityId();
    if (identityId === 0n) {
      throw new Error('setRelayCapable: signer has no on-chain profile (call ensureProfile first).');
    }
    const receipt = await this.sendContractTransaction(
      this.contracts.profile,
      'updateRelayCapable',
      [identityId, relayCapable],
      this.signer,
      'updateRelayCapable',
    );
    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      success: receipt.status === 1,
    };
  }

  private async resolveContract(name: string, abiName?: string): Promise<Contract> {
    let address: string;
    try {
      address = await this.contracts.hub.getContractAddress(name);
    } catch (err) {
      if (this.isContractMissingRevert(err)) {
        throw new Error(`Contract "${name}" not found in Hub at ${this.hubAddress}`, { cause: err });
      }
      throw err;
    }
    if (address === ethers.ZeroAddress) {
      throw new Error(`Contract "${name}" not found in Hub at ${this.hubAddress}`);
    }
    return new Contract(address, loadAbi(abiName ?? name), this.signer);
  }

  private async resolveAssetStorage(name: string, abiName?: string): Promise<Contract> {
    let address: string;
    try {
      address = await this.contracts.hub.getAssetStorageAddress(name);
    } catch (err) {
      if (this.isContractMissingRevert(err)) {
        throw new Error(`Asset storage "${name}" not found in Hub at ${this.hubAddress}`, { cause: err });
      }
      throw err;
    }
    if (address === ethers.ZeroAddress) {
      throw new Error(`Asset storage "${name}" not found in Hub at ${this.hubAddress}`);
    }
    return new Contract(address, loadAbi(abiName ?? name), this.signer);
  }

  /**
   * The current Hub implementation reverts with `ContractDoesNotExist(name)`
   * (custom error from `UnorderedNamedContractDynamicSet.get`) when a name
   * is missing, instead of returning `address(0)`. We normalise both
   * shapes onto the legacy `Contract "X" not found in Hub at <addr>` marker
   * so downstream code (`getRandomSampling()`'s catch block) only needs
   * to recognise one wording.
   */
  private isContractMissingRevert(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    enrichEvmError(err);
    return err.message.includes('ContractDoesNotExist')
      || err.message.includes('AddressDoesNotExist');
  }

  private async init(): Promise<void> {
    if (this.initialized) return;

    this.contracts.identity = await this.resolveContract('Identity');
    this.contracts.profile = await this.resolveContract('Profile');
    this.contracts.parametersStorage = await this.resolveContract('ParametersStorage');

    // V8 `Staking` is archived (PRD §4.1 — `Staking.sol` moved under
    // contracts/archive/, deploy script 023 archived). Tolerate its absence
    // so the V10 surface still initialises; the contract slot is retained
    // only to keep stale Hub bindings on older deploys resolving cleanly.
    try {
      this.contracts.staking = await this.resolveContract('Staking');
    } catch {
      // V8 Staking not deployed on this Hub — V10 surface continues.
    }

    // RFC 04 — ProfileStorage holds the relay registry views + events.
    // Tolerated as optional so adapters bound to a Hub that pre-dates the
    // Profile 1.2.0 / ProfileStorage 1.1.0 deploy still init cleanly; the
    // relay-registry methods will throw with a clear message at call time.
    try {
      this.contracts.profileStorage = await this.resolveContract('ProfileStorage');
    } catch {
      // Older deployments without the relay registry surface.
    }

    // V8 KnowledgeCollection is archived; tolerate missing Hub binding.
    // KnowledgeCollectionStorage remains active and is required.
    try {
      this.contracts.knowledgeCollection = await this.resolveContract('KnowledgeCollection');
    } catch {
      // V8 KnowledgeCollection not deployed — legacy publish surface unavailable.
    }
    try {
      this.contracts.knowledgeCollectionStorage = await this.resolveAssetStorage('DKGKnowledgeAssets');
    } catch {
      this.contracts.knowledgeCollectionStorage = await this.resolveAssetStorage('KnowledgeCollectionStorage');
    }

    // V9 contracts (KnowledgeAssets + KnowledgeAssetsStorage) are archived
    // (PRD §4.1, deploy scripts 040+041 moved under deploy/archive). Keep
    // the try/catch so adapters bound to legacy deploys still resolve them.
    // AskStorage is V10-active (deploy script 017 still in the active set);
    // split it out so a missing V9 binding doesn't strand AskStorage. The
    // V10 publish-token-amount path depends on AskStorage being resolved.
    try {
      this.contracts.knowledgeAssets = await this.resolveContract('KnowledgeAssets');
      this.contracts.knowledgeAssetsStorage = await this.resolveAssetStorage('KnowledgeAssetsStorage');
    } catch {
      // V9 contracts not deployed — V9 publish/update surface unavailable.
    }
    try {
      this.contracts.askStorage = await this.resolveContract('AskStorage');
    } catch {
      // Older deployments that pre-date AskStorage — token-amount derivation unavailable.
    }

    try {
      this.contracts.contextGraphNameRegistry = await this.resolveContract('ContextGraphNameRegistry');
    } catch {
      // ContextGraphNameRegistry not registered in Hub — createContextGraph/listContextGraphsFromChain unavailable
    }

    try {
      this.contracts.contextGraphs = await this.resolveContract('ContextGraphs');
      this.contracts.contextGraphStorage = await this.resolveAssetStorage('ContextGraphStorage');
    } catch {
      // ContextGraphs not deployed — context graph operations unavailable
    }

    try {
      this.contracts.knowledgeAssetsV10 = await this.resolveContract('KnowledgeAssetsLifecycle');
    } catch {
      try {
        this.contracts.knowledgeAssetsV10 = await this.resolveContract('KnowledgeAssetsV10');
      } catch {
        // Lifecycle / V10 contract not deployed — createKnowledgeAssetsV10 unavailable
      }
    }

    try {
      this.contracts.dkgPublishingConvictionNFT = await this.resolveContract('DKGPublishingConvictionNFT');
    } catch {
      // DKGPublishingConvictionNFT not deployed — V10 PCA agent-resolution unavailable
    }

    try {
      this.contracts.chronos = await this.resolveContract('Chronos');
    } catch {
      // Chronos not deployed — update-path growth-cost sizing falls back to
      // currentEpoch=0 (treats KC as having full `endEpoch` remaining lifetime).
      // Greenfield V10 deployments always have Chronos; this catch is for older
      // adapters bound to deploys that pre-date the Chronos registration.
    }

    try {
      await this.resolveAndAssignRandomSamplingPair();
    } catch {
      // RandomSampling not deployed — proof submission unavailable
    }

    await this.startHubRotationListener();

    const tokenAddress: string = await this.contracts.hub.getContractAddress('Token');
    if (tokenAddress !== ethers.ZeroAddress) {
      this.contracts.token = new Contract(
        tokenAddress,
        [
          'function approve(address,uint256) returns (bool)',
          'function balanceOf(address) view returns (uint256)',
          'function allowance(address,address) view returns (uint256)',
        ],
        this.signer,
      );
    }

    this.initialized = true;
  }

  private requireV9(): void {
    if (!this.contracts.knowledgeAssets || !this.contracts.knowledgeAssetsStorage) {
      throw new Error(
        'V9 contracts (KnowledgeAssets, KnowledgeAssetsStorage) not deployed. ' +
        'Deploy them first using the deploy scripts.',
      );
    }
  }

  private async getBlockTimestamp(blockNumber: number): Promise<number> {
    const block = await this.provider.getBlock(blockNumber);
    return block?.timestamp ?? 0;
  }

  // =====================================================================
  // Identity
  // =====================================================================

  async getIdentityId(): Promise<bigint> {
    await this.init();
    const identityStorage = await this.getIdentityStorage();
    const id: bigint = await identityStorage.getIdentityId(this.signer.address);
    return id;
  }

  /**
   * OT-RFC-39 — view-only address → identityId lookup. Returns 0n
   * when the address is not registered as a node operator. Caches
   * results per-process: `IdentityStorage.identities` is append-only
   * (operator key rotation goes through a separate slot), so a
   * memoised hit is safe.
   */
  async getIdentityIdForAddress(address: string): Promise<bigint> {
    if (!ethers.isAddress(address)) return 0n;
    const checksum = ethers.getAddress(address);
    const cached = this.identityIdByAddressCache.get(checksum.toLowerCase());
    if (cached !== undefined) return cached;
    await this.init();
    const identityStorage = await this.resolveContract('IdentityStorage');
    const id: bigint = await identityStorage.getIdentityId(checksum);
    if (id > 0n) {
      // Only memoise positive hits — a 0n result may flip to non-zero
      // once the operator registers, and we don't want to lock the
      // negative answer in for the process lifetime.
      this.identityIdByAddressCache.set(checksum.toLowerCase(), id);
    }
    return id;
  }

  async ensureProfile(options?: { nodeName?: string; stakeAmount?: bigint; lockTier?: number }): Promise<bigint> {
    await this.init();

    let identityId = await this.getIdentityId();

    // Step 1: Create profile if none exists
    if (identityId === 0n) {
      const nodeName = options?.nodeName ?? `node-${Date.now()}`;
      if (!this.adminSigner) {
        throw new Error(
          'Cannot create profile: adminPrivateKey is required so the profile admin key is not lost.',
        );
      }
      const nodeId = ethers.hexlify(ethers.randomBytes(32));

      const receipt = await this.sendContractTransaction(
        this.contracts.profile!,
        'createProfile',
        [this.adminSigner.address, [], nodeName, nodeId, 0],
        this.signer,
        'createProfile',
      );

      for (const log of receipt.logs) {
        try {
          const parsed = this.contracts.identity!.interface.parseLog({
            topics: [...log.topics],
            data: log.data,
          });
          if (parsed?.name === 'IdentityCreated') {
            identityId = BigInt(parsed.args.identityId);
            break;
          }
        } catch { /* not this contract */ }
      }

      if (identityId === 0n) {
        throw new Error('Profile created but no IdentityCreated event found');
      }
    }

    // Step 2: Stake via V10 path (separate try/catch so profile isn't lost).
    //
    // V10 consolidation (v4.0.0): stake routes through
    // `DKGStakingConvictionNFT.createConviction(identityId, amount, lockTier)`,
    // which mints a V10 NFT position, writes `nodeStakeV10` in
    // `ConvictionStakingStorage`, and pulls TRAC into the V10 vault (CSS) via
    // `StakingV10`. The legacy V8 `Staking.stake` path updates only V8
    // `StakingStorage` and leaves `nodeStakeV10 = 0`, so
    // `RandomSampling.calculateNodeScore` (which reads `getNodeStakeV10`
    // exclusively) computes zero and node scores never grow — exactly the
    // bug we just chased on devnet. This path mirrors `scripts/devnet.sh`.
    //
    // TRAC allowance must go to `StakingV10` (the actual `transferFrom`
    // caller), NOT to the NFT — the NFT is only the entry point and never
    // custodies TRAC.
    const stakeAmount = options?.stakeAmount ?? ethers.parseEther('50000');
    const lockTier = options?.lockTier ?? 1; // tier 1 = 1-month, cheapest non-zero multiplier
    if (stakeAmount > 0n && this.contracts.token) {
      try {
        const stakingNFT = await this.resolveContract('DKGStakingConvictionNFT');
        const stakingV10Addr: string = await this.contracts.hub.getContractAddress('StakingV10');
        if (stakingV10Addr === ethers.ZeroAddress) {
          throw new Error('StakingV10 not registered in Hub — V10 staking unavailable');
        }
        await this.sendContractTransaction(
          this.contracts.token,
          'approve',
          [stakingV10Addr, stakeAmount],
          this.signer,
          'approve staking TRAC',
        );
        // Wait an extra block for state propagation on public RPCs
        await new Promise(r => setTimeout(r, 2000));

        await this.sendContractTransaction(
          stakingNFT,
          'createConviction',
          [identityId, stakeAmount, lockTier],
          this.signer,
          'create staking conviction',
        );
      } catch (err) {
        console.warn(
          `[ensureProfile] V10 staking failed for identity ${identityId} (profile exists, stake manually via DKGStakingConvictionNFT.createConviction): ` +
          (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    return identityId;
  }

  async registerIdentity(proof: IdentityProof): Promise<bigint> {
    await this.init();
    if (!this.adminSigner) {
      throw new Error(
        'Cannot register identity: adminPrivateKey is required so the profile admin key is not lost.',
      );
    }
    const nodeName = `node-${ethers.hexlify(ethers.randomBytes(4)).slice(2)}`;
    const nodeId = proof.publicKey.length > 0 ? proof.publicKey : ethers.randomBytes(32);

    const receipt = await this.sendContractTransaction(
      this.contracts.profile!,
      'createProfile',
      [this.adminSigner.address, [], nodeName, nodeId, 0],
      this.signer,
      'createProfile',
    );

    for (const log of receipt.logs) {
      try {
        const parsed = this.contracts.identity!.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (parsed?.name === 'IdentityCreated') {
          return BigInt(parsed.args.identityId);
        }
      } catch { /* not this contract */ }
    }

    for (const log of receipt.logs) {
      try {
        const parsed = this.contracts.profile!.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (parsed?.name === 'ProfileCreated') {
          return BigInt(parsed.args.identityId);
        }
      } catch { /* not this contract */ }
    }

    throw new Error('Identity registration succeeded but no identity ID found in events');
  }

  // =====================================================================
  // V9: UAL Reservation
  // =====================================================================

  async reserveUALRange(count: number): Promise<ReservedRange> {
    await this.init();
    this.requireV9();

    const receipt = await this.sendContractTransaction(
      this.contracts.knowledgeAssets!,
      'reserveUALRange',
      [count],
      this.signer,
      'reserveUALRange',
    );

    for (const log of receipt.logs) {
      try {
        const parsed = this.contracts.knowledgeAssetsStorage!.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (parsed?.name === 'UALRangeReserved') {
          return {
            startId: BigInt(parsed.args.startId),
            endId: BigInt(parsed.args.endId),
          };
        }
      } catch { /* not this contract */ }
    }

    throw new Error('reserveUALRange succeeded but no UALRangeReserved event found');
  }

  // =====================================================================
  // V9: Batch Minting
  // =====================================================================

  async batchMintKnowledgeAssets(params: BatchMintParams): Promise<BatchMintResult> {
    await this.init();
    this.requireV9();

    const ka = this.contracts.knowledgeAssets!;
    const kaAddress = await ka.getAddress();

    if (this.contracts.token && params.tokenAmount > 0n) {
      const currentAllowance: bigint = await this.contracts.token.allowance(this.signer.address, kaAddress);
      if (currentAllowance < params.tokenAmount) {
        await this.sendContractTransaction(
          this.contracts.token,
          'approve',
          [kaAddress, ethers.MaxUint256],
          this.signer,
          'approve KA TRAC',
        );
      }
    }

    const identityIds = params.receiverSignatures.map((s) => s.identityId);
    const rValues = params.receiverSignatures.map((s) => ethers.hexlify(s.r));
    const vsValues = params.receiverSignatures.map((s) => ethers.hexlify(s.vs));

    const receipt = await this.sendContractTransaction(
      ka,
      'batchMintKnowledgeAssets',
      [
        params.publisherNodeIdentityId,
        ethers.hexlify(params.merkleRoot),
        params.startKAId,
        params.endKAId,
        params.publicByteSize,
        params.epochs,
        params.tokenAmount,
        ethers.ZeroAddress, // paymaster
        ethers.hexlify(params.publisherSignature.r),
        ethers.hexlify(params.publisherSignature.vs),
        identityIds,
        rValues,
        vsValues,
      ],
      this.signer,
      'batchMintKnowledgeAssets',
    );

    let batchId = 0n;
    for (const log of receipt.logs) {
      try {
        const parsed = this.contracts.knowledgeAssetsStorage!.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (parsed?.name === 'KnowledgeBatchCreated') {
          batchId = BigInt(parsed.args.batchId);
          break;
        }
      } catch { /* not this contract */ }
    }

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      success: receipt.status === 1,
      batchId,
    };
  }

  // =====================================================================
  // V9: Update Verification (for gossip receivers)
  // =====================================================================

  async verifyKAUpdate(txHash: string, batchId: bigint, publisherAddress: string): Promise<KAUpdateVerification> {
    await this.init();
    if (!this.contracts.knowledgeAssetsStorage && !this.contracts.knowledgeCollectionStorage) {
      return { verified: false };
    }

    try {
      const receipt = await this.getTransactionReceiptWithFailover(txHash);
      if (!receipt || receipt.status !== 1) return { verified: false };

      let onChainMerkleRoot: Uint8Array | undefined;

      // V9: KnowledgeBatchUpdated on KnowledgeAssetsStorage
      if (!onChainMerkleRoot && this.contracts.knowledgeAssetsStorage) {
        const storage = this.contracts.knowledgeAssetsStorage;
        const storageAddress = (await storage.getAddress()).toLowerCase();
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== storageAddress) continue;
          try {
            const parsed = storage.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed?.name === 'KnowledgeBatchUpdated' && BigInt(parsed.args.batchId) === batchId) {
              onChainMerkleRoot = ethers.getBytes(parsed.args.newMerkleRoot);
              break;
            }
          } catch { /* parse failure — skip */ }
        }
      }

      // V10: KnowledgeCollectionUpdated on KnowledgeCollectionStorage
      if (!onChainMerkleRoot && this.contracts.knowledgeCollectionStorage) {
        const kcs = this.contracts.knowledgeCollectionStorage;
        const kcsAddress = (await kcs.getAddress()).toLowerCase();
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== kcsAddress) continue;
          try {
            const parsed = kcs.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (
              (parsed?.name === 'KnowledgeCollectionUpdated' ||
                parsed?.name === 'KnowledgeAssetUpdated') &&
              BigInt(parsed.args.id) === batchId
            ) {
              onChainMerkleRoot = ethers.getBytes(parsed.args.merkleRoot);
              break;
            }
          } catch { /* parse failure — skip */ }
        }
      }

      if (!onChainMerkleRoot) return { verified: false };

      // Check publisher address: try V10 storage first, then V9
      let onChainPublisher: string | undefined;
      if (this.contracts.knowledgeCollectionStorage) {
        try {
          onChainPublisher = await this.contracts.knowledgeCollectionStorage.getLatestMerkleRootPublisher(batchId);
        } catch { /* not found in V10 storage */ }
      }
      if ((!onChainPublisher || onChainPublisher === ethers.ZeroAddress) && this.contracts.knowledgeAssetsStorage) {
        try {
          onChainPublisher = await this.contracts.knowledgeAssetsStorage.getBatchPublisher(batchId);
        } catch { /* not found in V9 storage */ }
      }
      if (!onChainPublisher || onChainPublisher.toLowerCase() !== publisherAddress.toLowerCase()) {
        return { verified: false };
      }

      return {
        verified: true,
        onChainMerkleRoot,
        blockNumber: receipt.blockNumber,
        txIndex: receipt.index,
      };
    } catch {
      return { verified: false };
    }
  }

  async getRequiredPublishTokenAmount(publicByteSize: bigint, epochs: number): Promise<bigint> {
    await this.init();
    if (!this.contracts.askStorage) {
      throw new Error('AskStorage not available');
    }
    const ask = await this.contracts.askStorage.getStakeWeightedAverageAsk();
    return (BigInt(ask) * publicByteSize * BigInt(epochs)) / 1024n;
  }

  // =====================================================================
  // Events
  // =====================================================================

  async *listenForEvents(filter: EventFilter): AsyncIterable<ChainEvent> {
    await this.init();

    for (const eventType of filter.eventTypes) {
      if (eventType === 'KnowledgeBatchCreated') {
        // V8-only event — emitted by archived KnowledgeAssetsStorage. When the
        // V8 contract is absent (the V10-only deploy path after this PR), this
        // branch yields nothing and consumers must rely on V10 `KCCreated`.
        const storage = this.contracts.knowledgeAssetsStorage;
        if (!storage) {
          continue;
        }
        const eventFilter = storage.filters.KnowledgeBatchCreated();
        const logs = await storage.queryFilter(eventFilter, filter.fromBlock ?? 0, filter.toBlock);

        for (const log of logs) {
          const parsed = storage.interface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed) {
            yield {
              type: 'KnowledgeBatchCreated',
              blockNumber: log.blockNumber,
              data: {
                batchId: parsed.args.batchId.toString(),
                publisherAddress: parsed.args.publisher?.toString(),
                merkleRoot: parsed.args.merkleRoot,
                startKAId: parsed.args.startKAId.toString(),
                endKAId: parsed.args.endKAId.toString(),
                txHash: log.transactionHash,
              },
            };
          }
        }
      }

      if (eventType === 'ContextGraphExpanded') {
        const cgStorage = this.contracts.contextGraphStorage;
        if (cgStorage) {
          const eventFilter = cgStorage.filters.ContextGraphExpanded();
          const logs = await cgStorage.queryFilter(eventFilter, filter.fromBlock ?? 0, filter.toBlock);

          for (const log of logs) {
            const parsed = cgStorage.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed) {
              yield {
                type: 'ContextGraphExpanded',
                blockNumber: log.blockNumber,
                data: {
                  contextGraphId: parsed.args.contextGraphId.toString(),
                  batchId: parsed.args.batchId?.toString(),
                  txHash: log.transactionHash,
                },
              };
            }
          }
        }
      }

      // V10 greenfield (DKGKnowledgeAssets) emits `KnowledgeAssetCreated`
      // plus a single ERC-721 `Transfer(0x0, owner, tokenId)` per publish
      // (tokenId == kaId == kcId; no batch mint). Legacy V8/V9
      // (KnowledgeCollectionStorage) emits `KnowledgeCollectionCreated` +
      // `KnowledgeAssetsMinted` (a start/end range + recipient). The bound
      // contract may be either ABI (see resolveAssetStorage fallback in
      // init()), so resolve the create event the contract actually exposes
      // and derive the KA range / publisher from whichever mint surface is
      // present — otherwise a greenfield node would crash here calling a
      // non-existent `filters.KnowledgeCollectionCreated()`.
      if (eventType === 'KCCreated' || eventType === 'KnowledgeCollectionCreated') {
        const kcStorage = this.contracts.knowledgeCollectionStorage;
        if (kcStorage) {
          const fromB = filter.fromBlock ?? 0;
          const toB = filter.toBlock ?? 'latest';

          const hasEvent = (name: string) =>
            kcStorage.interface.fragments.some(
              (f) => f.type === 'event' && (f as { name?: string }).name === name,
            );

          const isGreenfield = hasEvent('KnowledgeAssetCreated');
          const createEventName = isGreenfield
            ? 'KnowledgeAssetCreated'
            : 'KnowledgeCollectionCreated';

          const kcFilter = kcStorage.filters[createEventName]();
          const kcLogs = await kcStorage.queryFilter(kcFilter, fromB, toB);

          // Legacy mint range. `KnowledgeAssetsMinted` is still declared on the
          // greenfield ABI but never emitted by `createKnowledgeCollection`, so
          // this map stays empty there and the per-log fallback below derives
          // the (single-KA) range + owner from the create id + Transfer.
          const mintByTx = new Map<string, { publisherAddress: string; startKAId: string; endKAId: string }>();
          if (hasEvent('KnowledgeAssetsMinted')) {
            const mintFilter = kcStorage.filters.KnowledgeAssetsMinted();
            const mintLogs = await kcStorage.queryFilter(mintFilter, fromB, toB);
            for (const ml of mintLogs) {
              const mp = kcStorage.interface.parseLog({ topics: [...ml.topics], data: ml.data });
              if (mp) {
                mintByTx.set(ml.transactionHash, {
                  publisherAddress: mp.args.to,
                  startKAId: mp.args.startId.toString(),
                  endKAId: (BigInt(mp.args.endId) - 1n).toString(),
                });
              }
            }
          }

          // Greenfield publisher resolution: `_safeMint(author, kaId)` emits a
          // single ERC-721 mint `Transfer(address(0), owner, tokenId)`. The
          // token owner is the publisher/recipient of record (mirrors the
          // receipt-parse path). Keyed by tokenId so each KnowledgeAssetCreated
          // id resolves its own owner.
          const ownerByTokenId = new Map<string, string>();
          if (isGreenfield) {
            try {
              const transferFilter = kcStorage.filters.Transfer(ethers.ZeroAddress);
              const transferLogs = await kcStorage.queryFilter(transferFilter, fromB, toB);
              for (const tl of transferLogs) {
                const tp = kcStorage.interface.parseLog({ topics: [...tl.topics], data: tl.data });
                if (tp && tp.args.tokenId != null) {
                  ownerByTokenId.set(tp.args.tokenId.toString(), String(tp.args.to));
                }
              }
            } catch {
              // Best-effort — the `author` topic on the create event is the
              // fallback when Transfer enumeration is unavailable.
            }
          }

          for (const log of kcLogs) {
            const parsed = kcStorage.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed) {
              const mint = mintByTx.get(log.transactionHash);
              const idStr = parsed.args.id.toString();
              // V10.1: `author` is the EIP-712-attested author identity recovered
              // by `_verifyAuthorAttestation` on-chain (or `address(0)` for the
              // unattributed publish path). Surfacing it here lets replicas
              // rebuild `dkg:Publication` / `dkg:authoredBy` provenance triples
              // that match what the originating publisher emitted in
              // `generateKCMetadata` (Round 5 review §10).
              const author = typeof parsed.args.author === 'string' ? parsed.args.author : '';
              yield {
                type: 'KCCreated',
                blockNumber: log.blockNumber,
                data: {
                  kcId: idStr,
                  merkleRoot: parsed.args.merkleRoot,
                  merkleRootBytes: parsed.args.merkleRoot,
                  byteSize: parsed.args.byteSize.toString(),
                  txHash: log.transactionHash,
                  // Greenfield: no batch mint → publisher is the KA owner
                  // (Transfer recipient), falling back to the attested author.
                  publisherAddress: mint?.publisherAddress ?? ownerByTokenId.get(idStr) ?? author,
                  author,
                  // Greenfield: single KA, range collapses to [id, id].
                  startKAId: mint?.startKAId ?? idStr,
                  endKAId: mint?.endKAId ?? idStr,
                },
              };
            }
          }
        }
      }

      if (eventType === 'NameClaimed' || eventType === 'ContextGraphNameClaimed') {
        const registry = this.contracts.contextGraphNameRegistry;
        if (registry) {
          const eventFilter = registry.filters.NameClaimed();
          const logs = await registry.queryFilter(eventFilter, filter.fromBlock ?? 0, filter.toBlock);
          for (const log of logs) {
            const parsed = registry.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed) {
              yield {
                type: 'NameClaimed',
                blockNumber: log.blockNumber,
                data: {
                  contextGraphId: parsed.args.nameHash?.toString() ?? '',
                  creator: parsed.args.creator?.toString() ?? '',
                  accessPolicy: Number(parsed.args.accessPolicy ?? 0),
                  txHash: log.transactionHash,
                },
              };
            }
          }
        }
      }

      if (eventType === 'ContextGraphCreated') {
        const cgStorage = this.contracts.contextGraphStorage;
        if (cgStorage) {
          const eventFilter = cgStorage.filters.ContextGraphCreated();
          const logs = await cgStorage.queryFilter(eventFilter, filter.fromBlock ?? 0, filter.toBlock);
          for (const log of logs) {
            const parsed = cgStorage.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed) {
              // OT-RFC-38 / LU-6 Phase B — `nameHash` is the curator-committed
              // wire id used to derive the SWM gossip topic. Zero indicates
              // the curator opted out at create time (rare); cores fall back
              // to the discovery-beacon path in that case.
              const nameHashRaw = parsed.args.nameHash?.toString() ?? '0x';
              const nameHash = nameHashRaw === '0x' ? null : nameHashRaw.toLowerCase();
              yield {
                type: 'ContextGraphCreated',
                blockNumber: log.blockNumber,
                data: {
                  contextGraphId: parsed.args.contextGraphId?.toString() ?? '',
                  creator: parsed.args.owner?.toString() ?? '',
                  owner: parsed.args.owner?.toString() ?? '',
                  accessPolicy: Number(parsed.args.accessPolicy ?? 0),
                  publishPolicy: Number(parsed.args.publishPolicy ?? 0),
                  nameHash,
                  txHash: log.transactionHash,
                },
              };
            }
          }
        }
      }

      // RFC 04 v0.3 / Issue #461 — Network State Registry events.
      if (eventType === 'RelayCapabilityUpdated') {
        const profileStorage = this.contracts.profileStorage;
        if (profileStorage) {
          const eventFilter = profileStorage.filters.RelayCapabilityUpdated();
          const logs = await profileStorage.queryFilter(eventFilter, filter.fromBlock ?? 0, filter.toBlock);
          for (const log of logs) {
            const parsed = profileStorage.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed) {
              yield {
                type: 'RelayCapabilityUpdated',
                blockNumber: log.blockNumber,
                data: {
                  identityId: parsed.args.identityId?.toString() ?? '0',
                  oldValue: Boolean(parsed.args.oldValue),
                  newValue: Boolean(parsed.args.newValue),
                  txHash: log.transactionHash,
                },
              };
            }
          }
        }
      }
    }
  }

  // =====================================================================
  // V9: Publisher range verification (for PublishHandler)
  // =====================================================================

  async verifyPublisherOwnsRange(
    publisherAddress: string,
    startKAId: bigint,
    endKAId: bigint,
  ): Promise<boolean> {
    await this.init();
    if (!this.contracts.knowledgeAssetsStorage) return false;

    const storage = this.contracts.knowledgeAssetsStorage;
    const count = await storage.getPublisherRangesCount(publisherAddress);
    for (let i = 0; i < Number(count); i++) {
      const [startId, endId] = await storage.getPublisherRange(publisherAddress, i);
      if (startId <= startKAId && endId >= endKAId) return true;
    }
    return false;
  }

  // =====================================================================
  // Context Graphs (name-hash commitment via ContextGraphNameRegistry)
  //
  // Thin transitional affordance — reserves a bytes32 name-hash with an
  // optional cleartext metadata reveal. Governance for the context graph
  // itself (publish policy, participant agents) lives in `ContextGraphs` /
  // `ContextGraphStorage` — see createOnChainContextGraph.
  // =====================================================================

  async createContextGraph(params: CreateContextGraphParams): Promise<TxResult> {
    await this.init();
    const registry = this.contracts.contextGraphNameRegistry;
    const name = params.name ?? params.metadata?.['name'];
    if (!registry || !name) {
      throw new Error(
        'createContextGraph: requires ContextGraphNameRegistry in Hub and params.name (or metadata.name). ' +
          'Deploy ContextGraphNameRegistry and register it in the Hub, or provide name.',
      );
    }
    const accessPolicy = params.accessPolicy ?? 0;
    const nameHash = ethers.keccak256(ethers.toUtf8Bytes(name));
    const receipt = await this.sendContractTransaction(
      registry,
      'claimName',
      [nameHash, accessPolicy],
      this.signer,
      'claim context graph name',
    );
    if (!receipt) throw new Error('createContextGraph: no receipt');
    let contextGraphIdHex: string | undefined;
    for (const log of receipt.logs) {
      try {
        const parsed = registry.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === 'NameClaimed') {
          contextGraphIdHex = String(parsed.args.nameHash);
          break;
        }
      } catch { /* not this contract */ }
    }

    // Optionally reveal cleartext metadata on-chain
    if (params.revealOnChain) {
      const description = params.description ?? params.metadata?.['description'] ?? '';
      await this.revealContextGraphMetadata(nameHash, name, description);
    }

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      success: true,
      contextGraphId: contextGraphIdHex ?? nameHash,
    };
  }

  async submitToContextGraph(_kcId: string, _contextGraphId: string): Promise<TxResult> {
    throw new Error('submitToContextGraph: not yet implemented on EVM adapter (Milestone 5)');
  }

  async revealContextGraphMetadata(contextGraphId: string, name: string, description: string): Promise<TxResult> {
    await this.init();
    const registry = this.contracts.contextGraphNameRegistry;
    if (!registry) throw new Error('revealContextGraphMetadata: ContextGraphNameRegistry not available');
    const receipt = await this.sendContractTransaction(
      registry,
      'revealMetadata',
      [contextGraphId, name, description],
      this.signer,
      'reveal context graph metadata',
    );
    if (!receipt) throw new Error('revealContextGraphMetadata: no receipt');
    return { hash: receipt.hash, blockNumber: receipt.blockNumber, success: true };
  }

  async listContextGraphsFromChain(fromBlock?: number): Promise<ContextGraphOnChain[]> {
    await this.init();
    const registry = this.contracts.contextGraphNameRegistry;
    if (!registry) return [];
    const eventFilter = registry.filters.NameClaimed();
    const head = await this.provider.getBlockNumber();
    const PAGE = 9_000;
    const start = fromBlock ?? 0;
    const results: ContextGraphOnChain[] = [];

    // Paginate in PAGE-sized chunks to stay within RPC range limits.
    for (let lo = start; lo <= head; lo += PAGE) {
      const hi = Math.min(lo + PAGE - 1, head);
      const logs = await registry.queryFilter(eventFilter, lo, hi);
      for (const log of logs) {
        const parsed = registry.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (!parsed || parsed.name !== 'NameClaimed') continue;
        results.push({
          contextGraphId: String(parsed.args.nameHash),
          creator: String(parsed.args.creator),
          accessPolicy: Number(parsed.args.accessPolicy),
          blockNumber: log.blockNumber,
          metadataRevealed: false,
        });
      }
    }

    return results;
  }

  // =====================================================================
  // On-Chain Context Graphs (ContextGraphs contract)
  // =====================================================================

  /** True when `contextGraphId` is an active minted CG in ContextGraphStorage. */
  async isContextGraphActiveOnChain(contextGraphId: bigint): Promise<boolean> {
    await this.init();
    if (!this.contracts.contextGraphStorage) return false;
    try {
      return Boolean(await this.contracts.contextGraphStorage.isContextGraphActive(contextGraphId));
    } catch {
      return false;
    }
  }

  async createOnChainContextGraph(params: CreateOnChainContextGraphParams): Promise<CreateOnChainContextGraphResult> {
    await this.init();
    if (!this.contracts.contextGraphs || !this.contracts.contextGraphStorage) {
      throw new Error('ContextGraphs contract not deployed. Deploy ContextGraphs and ContextGraphStorage first.');
    }

    if (params.accessPolicy === undefined || params.publishPolicy === undefined) {
      throw new Error(
        'createOnChainContextGraph: `accessPolicy` and `publishPolicy` are required (SPEC_CG_MEMORY_MODEL). ' +
        'Pass both explicitly — e.g. { accessPolicy: 1, publishPolicy: 0 } for invite-only + curators-only.',
      );
    }
    const receipt = await this.sendContractTransaction(
      this.contracts.contextGraphs,
      'createContextGraph',
      [
        params.participantAgents ?? [],
        params.metadataBatchId ?? 0n,
        params.accessPolicy,
        params.publishPolicy,
        params.publishAuthority ?? ethers.ZeroAddress,
        params.publishAuthorityAccountId ?? 0n,
        // OT-RFC-38 / LU-6 Phase B — opt-in wire-id commitment. Default
        // `bytes32(0)` opts out; the agent supplies a non-zero hash
        // (typically `keccak256(bytes(cleartextId))`) to enable cores'
        // chain-event-driven host-mode auto-subscribe path.
        params.nameHash ?? ethers.ZeroHash,
      ],
      this.signer,
      'create on-chain context graph',
    );

    let contextGraphId: bigint | undefined;
    for (const log of receipt.logs) {
      try {
        const parsed = this.contracts.contextGraphStorage!.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (parsed?.name === 'ContextGraphCreated') {
          contextGraphId = BigInt(parsed.args.contextGraphId);
          break;
        }
      } catch { /* not this contract */ }
    }

    if (contextGraphId === undefined) {
      return {
        hash: receipt.hash,
        blockNumber: receipt.blockNumber,
        success: false,
        contextGraphId: 0n,
      };
    }

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      success: receipt.status === 1,
      contextGraphId,
    };
  }

  async verify(params: VerifyParams): Promise<TxResult> {
    await this.init();
    if (!this.contracts.contextGraphs) {
      throw new Error('ContextGraphs contract not deployed.');
    }

    const receipt = await this.sendContractTransaction(
      this.contracts.contextGraphs,
      'registerKnowledgeCollection',
      [params.contextGraphId, params.batchId],
      this.signer,
      'register knowledge collection',
    );

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      success: receipt.status === 1,
    };
  }

  async publishToContextGraph(params: PublishToContextGraphParams): Promise<OnChainPublishResult> {
    await this.init();
    if (!this.contracts.knowledgeAssets) {
      throw new Error('KnowledgeAssets contract not deployed.');
    }
    if (!this.contracts.knowledgeAssetsStorage) {
      throw new Error('KnowledgeAssetsStorage contract not deployed (required for log parsing).');
    }

    const signer = await this.nextAuthorizedSigner(params.contextGraphId);
    const receiverIdentityIds = params.receiverSignatures.map((s) => s.identityId);
    const receiverRs = params.receiverSignatures.map((s) => ethers.hexlify(s.r));
    const receiverVSs = params.receiverSignatures.map((s) => ethers.hexlify(s.vs));
    const participantIdentityIds = params.participantSignatures.map((s) => s.identityId);
    const participantRs = params.participantSignatures.map((s) => ethers.hexlify(s.r));
    const participantVSs = params.participantSignatures.map((s) => ethers.hexlify(s.vs));

    const ka = this.contracts.knowledgeAssets.connect(signer) as any;
    const kaAddress = await this.contracts.knowledgeAssets.getAddress();

    if (this.contracts.token && params.tokenAmount > 0n) {
      const token = this.contracts.token.connect(signer) as Contract;
      const currentAllowance: bigint = await token.allowance(signer.address, kaAddress);
      if (currentAllowance < params.tokenAmount) {
        await this.sendContractTransaction(
          token,
          'approve',
          [kaAddress, ethers.MaxUint256],
          signer,
          'approve context graph publish TRAC',
        );
      }
    }

    const tx = await ka.publishToContextGraph(
      params.kaCount,
      params.publisherNodeIdentityId,
      ethers.hexlify(params.merkleRoot),
      params.publicByteSize,
      params.epochs,
      params.tokenAmount,
      ethers.ZeroAddress,
      ethers.hexlify(params.publisherSignature.r),
      ethers.hexlify(params.publisherSignature.vs),
      receiverIdentityIds,
      receiverRs,
      receiverVSs,
      params.contextGraphId,
      participantIdentityIds,
      participantRs,
      participantVSs,
    );

    const ackSignatures = [
      ...params.receiverSignatures,
      ...params.participantSignatures,
    ].filter((s, i, arr) =>
      i === arr.findIndex((a) => a.identityId === s.identityId),
    );

    // V9→V10 mirror: RandomSampling reads `merkleLeafCount` from on-chain
    // storage to pick `chunkId`. Silently writing 1 here would brick every
    // bridged KC whose flat-KC tree has more than one leaf (the prover
    // would request a chunk past the tree's leaf range). Refuse to mirror
    // if the caller didn't supply the real count.
    if (
      typeof params.merkleLeafCount !== 'number'
      || !Number.isInteger(params.merkleLeafCount)
      || params.merkleLeafCount < 1
    ) {
      throw new Error(
        'publishToContextGraph: missing/invalid merkleLeafCount. '
        + 'V10 mirror requires the caller to supply the V10MerkleTree leaf count '
        + '(integer ≥ 1). Hard-coding would corrupt RandomSampling chunk selection.',
      );
    }

    // V9→V10 mirror: synthesize an RFC-001 author attestation using the
    // V9 publish signer as the author of record. The signer is the same
    // wallet that signed the V9 publisher digest above, so attribution
    // stays consistent across the legacy/canonical pair.
    const v10ChainId = (await this.provider.getNetwork()).chainId;
    const v10KavAddress = await this.contracts.knowledgeAssetsV10!.getAddress();
    const authorTypedData = buildAuthorAttestationTypedData({
      chainId: v10ChainId,
      kav10Address: v10KavAddress,
      contextGraphId: params.contextGraphId,
      merkleRoot: params.merkleRoot,
      authorAddress: signer.address,
    });
    const authorSig = ethers.Signature.from(
      await signer.signTypedData(
        authorTypedData.domain,
        authorTypedData.types,
        authorTypedData.message,
      ),
    );

    return this.createKnowledgeAssetsV10({
      publishOperationId: ethers.hexlify(ethers.randomBytes(32)),
      contextGraphId: params.contextGraphId,
      merkleRoot: params.merkleRoot,
      knowledgeAssetsAmount: params.kaCount,
      byteSize: params.publicByteSize,
      epochs: params.epochs,
      tokenAmount: params.tokenAmount,
      merkleLeafCount: params.merkleLeafCount,
      isImmutable: false,
      publisherNodeIdentityId: params.publisherNodeIdentityId,
      author: {
        address: signer.address,
        signature: {
          r: ethers.getBytes(authorSig.r),
          vs: ethers.getBytes(authorSig.yParityAndS),
        },
        schemeVersion: AUTHOR_SCHEME_VERSION_V1,
      },
      ackSignatures,
    });
  }

  async resolvePublishByTxHash(txHash: string): Promise<OnChainPublishResult | null> {
    await this.init();

    try {
      const receipt = await this.getTransactionReceiptWithFailover(txHash);
      if (!receipt || receipt.status !== 1) return null;

      const v10 = this.contracts.knowledgeCollectionStorage
        ? await this.parseV10PublishReceipt(receipt)
        : null;
      if (v10) return v10;

      const v9 = this.contracts.knowledgeAssetsStorage
        ? await this.parseV9PublishReceipt(receipt)
        : null;
      return v9;
    } catch (err: any) {
      const msg = err?.message ?? '';
      if (msg.includes('could not find') || msg.includes('not found') || msg.includes('unknown transaction')) {
        return null;
      }
      throw err;
    }
  }

  // =====================================================================
  // V10 Publish (KnowledgeAssetsV10 → KnowledgeCollectionStorage)
  // =====================================================================

  async getDKGKnowledgeAssetsAddress(): Promise<string> {
    if (!this.contracts.knowledgeCollectionStorage) {
      throw new Error('DKGKnowledgeAssets / KnowledgeCollectionStorage not deployed on this chain.');
    }
    return this.contracts.knowledgeCollectionStorage.target as string;
  }

  async getKnowledgeAssetsV10Address(): Promise<string> {
    // PR3 / RC11: TTL-cached. KAV10 address only changes on a contract
    // redeploy + Hub-rotation event; 1h staleness is harmless and the
    // ACK digest mismatch the contract would surface on actually-stale
    // input is loud enough that operators would notice immediately.
    const now = Date.now();
    if (EVMChainAdapter.preflightCacheFresh(this.cachedKav10Address, now)) {
      return this.cachedKav10Address!.value;
    }
    await this.init();
    if (!this.contracts.knowledgeAssetsV10) {
      throw new Error('KnowledgeAssetsLifecycle / KnowledgeAssetsV10 contract not deployed on this chain.');
    }
    const addr = await this.contracts.knowledgeAssetsV10.getAddress();
    this.cachedKav10Address = { value: addr, cachedAt: now };
    return addr;
  }

  async getEvmChainId(): Promise<bigint> {
    // PR3 / RC11: TTL-cached so an `eth_chainId` rate-limit on the
    // public RPC (the dzudza failure mode) cannot kill steady-state
    // publish traffic. Chain id is structurally immutable for a given
    // provider — once we've read it successfully we know it can't
    // change without a daemon restart.
    const now = Date.now();
    if (EVMChainAdapter.preflightCacheFresh(this.cachedChainId, now)) {
      return this.cachedChainId!.value;
    }
    const network = await this.provider.getNetwork();
    this.cachedChainId = { value: network.chainId, cachedAt: now };
    return network.chainId;
  }

  /**
   * Return `true` iff the address has deployed bytecode on this chain.
   * Used by the off-chain seal-integrity preflights to dispatch EOA
   * vs EIP-1271 verification the same way `_verifyAuthorAttestation`
   * does on-chain (see ChainAdapter.hasContractCode for the full
   * rationale). Treats a JSON-RPC failure as "unknown" (returns
   * `false` so the EOA recovery path stays in effect) — safer to
   * preserve the existing strict check than to silently accept a
   * potentially-bad signature when the provider is flaky.
   */
  async hasContractCode(address: string): Promise<boolean> {
    try {
      const code = await this.provider.getCode(address);
      return code !== undefined && code !== null && code !== '0x' && code.length > 2;
    } catch {
      return false;
    }
  }

  async createKnowledgeAssetsV10(params: V10PublishParams): Promise<OnChainPublishResult> {
    await this.init();

    if (!this.contracts.knowledgeAssetsV10) {
      throw new Error('KnowledgeAssetsLifecycle / KnowledgeAssetsV10 contract not deployed.');
    }

    // Pre-tx validation of `contextGraphId`. The V10 contract rejects
    // `cgId == 0` at `KnowledgeAssetsV10.sol:379` with `ZeroContextGraphId`;
    // catching this here gives a clearer error than a generic revert and
    // saves a round-trip. Reject `<= 0n` rather than `=== 0n` so that
    // `BigInt("-1") === -1n` does not slip past our fail-loud boundary and
    // die in ethers' uint256 encoder with a cryptic low-level error — the
    // upstream guards in `dkg-publisher.ts`, `agent/dkg-agent.ts`,
    // `cli/publisher-runner.ts`, and `publisher/storage-ack-handler.ts`
    // accept whatever `BigInt(...)` returns for non-throwing inputs, which
    // includes negative decimal strings.
    if (params.contextGraphId <= 0n) {
      throw new Error(
        'V10 publish requires a positive on-chain context graph id; ' +
        `got ${params.contextGraphId}. Register the context graph via ` +
        '`ContextGraphs.createContextGraph` first and pass the returned ' +
        'numeric id as `publishContextGraphId`.',
      );
    }

    let txSigner: Wallet;
    if (params.publisherAddress) {
      const selected = this.findSignerByAddress(params.publisherAddress);
      if (!selected) {
        throw new Error(
          `Configured publisherAddress ${params.publisherAddress} is not present in the EVM signer pool.`,
        );
      }
      if (this.contracts.contextGraphs) {
        const authorized = await this.contracts.contextGraphs.isAuthorizedPublisher(
          params.contextGraphId,
          selected.address,
        );
        if (!authorized) {
          throw new Error(
            `Configured publisherAddress ${selected.address} is not authorized to publish ` +
            `to context graph ${params.contextGraphId.toString()}.`,
          );
        }
      }
      txSigner = selected;
    } else {
      txSigner = await this.nextAuthorizedSigner(params.contextGraphId);
    }
    const ka = this.contracts.knowledgeAssetsV10.connect(txSigner) as Contract;
    const kaAddress = await ka.getAddress();

    // Approval policy: always ensure the operational signer has the
    // allowance required by the configured `chain.approvalPolicy` for
    // this `tokenAmount`. RFC-001 unified `publish`/`publishDirect`
    // (KnowledgeAssetsV10.sol): the contract auto-detects PCA discount
    // via `agentToAccountId[msg.sender] != 0` and falls through to
    // `token.transferFrom(msg.sender, CSS, fullCost)` for the
    // direct-spend branch. A redundant allowance is cheap and idle when
    // the PCA branch covers the cost. Helper handles the
    // `tokenAmount === 0n` floor (`transferFrom(..., 1n)` minimum), the
    // bounded-per-publish vs replenishing vs unlimited dispatch, and the
    // `this.contracts.token === undefined` no-op for read-only adapters.
    await this.ensureV10ApproveTrac(
      txSigner,
      kaAddress,
      params.tokenAmount,
      'approve V10 publish TRAC',
    );

    // Build the on-chain PublishParams struct matching the field order +
    // types in `KnowledgeAssetsV10.sol` (RFC-001 author-attestation
    // shape). ethers v6 encodes object literals to solidity structs
    // positionally by field name.
    // KAV10 10.1.1 strict-positive `tokenAmount` floor: the contract now
    // reverts on `tokenAmount == 0`. Free-publish flows (devnets where
    // `ask == 0`) used to round to 1 wei-TRAC silently inside the
    // direct-spend branch; clamp here so they keep working. Matches the
    // same floor inside `computePublishACKDigest`, so the on-chain ACK
    // recovery hashes the same `tokenAmount` the contract receives.
    const flooredTokenAmount = floorPublishTokenAmount(params.tokenAmount);
    const publishParamsStruct = {
      publishOperationId: params.publishOperationId,
      contextGraphId: params.contextGraphId,
      merkleRoot: ethers.hexlify(params.merkleRoot),
      knowledgeAssetsAmount: params.knowledgeAssetsAmount,
      byteSize: params.byteSize,
      epochs: params.epochs,
      tokenAmount: flooredTokenAmount,
      isImmutable: params.isImmutable,
      merkleLeafCount: params.merkleLeafCount,
      // RFC-39 Phase A.5 / LU-11 — ciphertext-commitment pair.
      //
      // The two fields MUST be set together or omitted together.
      // - Both omitted (or root=ZeroHash + count=0) = legacy /
      //   public-KC path: picker skips this KC in the curated draw
      //   today (commit 8 baseline) and RFC-39 random sampling never
      //   indexes it; safe wire-compatible default for non-chunked
      //   callers.
      // - Both set = LU-11 chunked publish: cores already hold the
      //   matching per-chunk ciphertexts under
      //   urn:dkg:swm:v10-publish-ciphertext-chunk/<batchId>/<i> and
      //   recomputed the same root before signing the V2 ACK.
      // Anything else is a programmer error — fail loud instead of
      // silently defaulting one side and producing an asymmetric
      // commitment that on-chain `_pickWeightedChallenge` would
      // skip (count=0) or that core-side V2 verifiers would never
      // try to satisfy (root=ZeroHash but count>0).
      ciphertextChunksRoot: (() => {
        const haveRoot = !!params.ciphertextChunksRoot && params.ciphertextChunksRoot.length === 32;
        const haveCount = typeof params.ciphertextChunkCount === 'number' && params.ciphertextChunkCount > 0;
        if (haveRoot !== haveCount) {
          throw new Error(
            `evm-adapter.createKnowledgeAssetsV10: ciphertextChunksRoot and ciphertextChunkCount ` +
            `must both be set or both omitted; got root=${haveRoot ? 'set' : 'unset'}, ` +
            `count=${haveCount ? params.ciphertextChunkCount : 'unset'}. ` +
            `An asymmetric pair would leave RandomSampling._pickWeightedChallenge unable to ` +
            `verify the curated draw against off-chain ciphertext storage.`,
          );
        }
        return haveRoot ? ethers.hexlify(params.ciphertextChunksRoot!) : ethers.ZeroHash;
      })(),
      ciphertextChunkCount: params.ciphertextChunkCount ?? 0,
      publisherNodeIdentityId: params.publisherNodeIdentityId,
      authorAddress: params.author.address,
      authorR: ethers.hexlify(params.author.signature.r),
      authorVS: ethers.hexlify(params.author.signature.vs),
      authorSchemeVersion: params.author.schemeVersion,
      identityIds: params.ackSignatures.map((s) => s.identityId),
      r: params.ackSignatures.map((s) => ethers.hexlify(s.r)),
      vs: params.ackSignatures.map((s) => ethers.hexlify(s.vs)),
    };

    // P-1 review (follow-up, Codex iter-5): the `onBroadcast` hook is
    // the durable WAL checkpoint, so it MUST fire in the true send
    // path — after populate / gas-estimate / sign succeed, and
    // immediately before `eth_sendRawTransaction`. If the hook throws
    // (WAL persistence failed, disk full, etc.) we MUST abort: the tx
    // was signed but never broadcast, so the caller is free to retry
    // without any on-chain effect. `contract.method(...)` does
    // populate + sign + broadcast as one step, so we break it apart:
    //
    //   1. populateTransaction — builds the `{ to, data, value }` request
    //   2. signer.populateTransaction — fills chainId / gas / nonce
    //   3. signer.signTransaction — returns the signed hex string
    //   4. onBroadcast — WAL checkpoint; throw aborts the broadcast
    //   5. provider.broadcastTransaction — the real eth_sendRawTransaction
    //
    // This also gives the WAL the pre-broadcast tx hash (ethers v6
    // exposes it on the returned TransactionResponse), so recovery can
    // reconcile an in-flight tx after a daemon crash.
    const populated = await (ka as any).publish.populateTransaction(
      publishParamsStruct,
    );
    const { signedTx, txHash: preBroadcastTxHash } = await this.signPopulatedTransaction(txSigner, populated);
    // Derive the pre-broadcast tx hash from the signed raw hex so WAL
    // consumers can log the exact identity of the tx about to hit the
    // wire. After broadcast completes, the receipt hash matches this.
    // Codex PR #241 iter-7: `await` the hook. `onBroadcast` is typed
    // as `Promise<void> | void`, so an async WAL writer (disk flush,
    // remote gossip) must run to completion BEFORE we proceed to
    // `broadcastTransaction`. Without `await`, a synchronous
    // `try/catch` here would silently let the broadcast race the
    // still-unresolved WAL promise and break the fail-closed contract.
    try {
      await params.onBroadcast?.({ txHash: preBroadcastTxHash });
    } catch (hookErr) {
      // Fail closed: the signed tx is still in this function's local
      // scope — it has not been sent. Surface the hook error to the
      // caller so they know WAL persistence failed BEFORE broadcast.
      throw new Error(
        `chain:writeahead hook failed before publish broadcast: ` +
        `${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
      );
    }
    const receipt = await this.sendSignedTransactionAndWait(signedTx, preBroadcastTxHash, 'V10 publish');
    if (!receipt) throw new Error('Transaction receipt is null');

    let kcId = 0n;
    let startKAId = 0n;
    let endKAId = 0n;
    let publisherAddress = txSigner.address;
    let authorAddress: string | undefined;
    const kcs = this.contracts.knowledgeCollectionStorage;
    if (!kcs) {
      throw new Error(
        `V10 publish tx ${receipt.hash} succeeded but DKGKnowledgeAssets ` +
        `contract is not available — cannot parse minted IDs from receipt`,
      );
    }
    const storageAddress = String(kcs.target).toLowerCase();
    {
      let foundCreated = false;
      let foundLegacyMint = false;
      for (const log of receipt.logs) {
        const logAddr = typeof log.address === 'string' ? log.address.toLowerCase() : '';
        if (logAddr !== storageAddress) continue;
        try {
          const parsed = kcs.interface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed?.name === 'KnowledgeAssetCreated' || parsed?.name === 'KnowledgeCollectionCreated') {
            kcId = BigInt(parsed.args.id);
            authorAddress = String(parsed.args.author);
            startKAId = kcId;
            endKAId = kcId;
            foundCreated = true;
          }
          if (parsed?.name === 'KnowledgeAssetsMinted') {
            startKAId = BigInt(parsed.args.startId);
            endKAId = BigInt(parsed.args.endId) - 1n;
            publisherAddress = parsed.args.to;
            foundLegacyMint = true;
          }
        } catch { /* not this contract */ }
      }
      if (!foundCreated) {
        throw new Error(
          `V10 publish tx ${receipt.hash} succeeded but KnowledgeAssetCreated / ` +
          `KnowledgeCollectionCreated event not found in receipt logs — contract ABI may be stale`,
        );
      }
      if (!foundLegacyMint && startKAId === 0n) {
        startKAId = kcId;
        endKAId = kcId;
      }
    }

    const blockTimestamp = await this.getBlockTimestamp(receipt.blockNumber);

    return {
      batchId: kcId,
      kaId: kcId,
      knowledgeAssetsContract: storageAddress,
      startKAId,
      endKAId,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      blockTimestamp,
      publisherAddress,
      authorAddress,
      gasUsed: receipt.gasUsed ? BigInt(receipt.gasUsed) : undefined,
      effectiveGasPrice: receipt.gasPrice ? BigInt(receipt.gasPrice) : undefined,
      gasCostWei: receipt.gasUsed && receipt.gasPrice ? BigInt(receipt.gasUsed) * BigInt(receipt.gasPrice) : undefined,
      tokenAmount: params.tokenAmount,
    };
  }

  private async parseV10PublishReceipt(
    receipt: NonNullable<Awaited<ReturnType<typeof this.provider.getTransactionReceipt>>>,
  ): Promise<OnChainPublishResult | null> {
    const kcs = this.contracts.knowledgeCollectionStorage;
    if (!kcs) return null;

    let kcId = 0n;
    let startKAId = 0n;
    let endKAId = 0n;
    let publisherAddress = '';
    let authorAddress: string | undefined;
    let foundCreated = false;
    const storageAddress = String(kcs.target).toLowerCase();

    for (const log of receipt.logs) {
      const logAddr = typeof log.address === 'string' ? log.address.toLowerCase() : '';
      if (logAddr !== storageAddress) continue;
      try {
        const parsed = kcs.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === 'KnowledgeAssetCreated' || parsed?.name === 'KnowledgeCollectionCreated') {
          kcId = BigInt(parsed.args.id);
          authorAddress = String(parsed.args.author);
          startKAId = kcId;
          endKAId = kcId;
          foundCreated = true;
        }
        if (parsed?.name === 'KnowledgeAssetsMinted') {
          startKAId = BigInt(parsed.args.startId);
          endKAId = BigInt(parsed.args.endId) - 1n;
          publisherAddress = parsed.args.to;
        }
      } catch {
        // ignore unrelated logs
      }
    }

    if (!foundCreated) return null;

    if (!publisherAddress) {
      publisherAddress = receipt.from ?? authorAddress ?? '';
    }

    const blockTimestamp = await this.getBlockTimestamp(receipt.blockNumber);

    return {
      batchId: kcId,
      kaId: kcId,
      knowledgeAssetsContract: String(kcs.target),
      startKAId,
      endKAId,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      blockTimestamp,
      publisherAddress,
      authorAddress,
    };
  }

  private async parseV9PublishReceipt(
    receipt: NonNullable<Awaited<ReturnType<typeof this.provider.getTransactionReceipt>>>,
  ): Promise<OnChainPublishResult | null> {
    const storage = this.contracts.knowledgeAssetsStorage;
    if (!storage) return null;

    let batchId = 0n;
    let startKAId = 0n;
    let endKAId = 0n;
    let publisherAddress = '';
    let foundBatchCreated = false;

    for (const log of receipt.logs) {
      try {
        const parsed = storage.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === 'UALRangeReserved') {
          publisherAddress = parsed.args.publisher;
          startKAId = BigInt(parsed.args.startId);
          endKAId = BigInt(parsed.args.endId);
        }
        if (parsed?.name === 'KnowledgeBatchCreated') {
          batchId = BigInt(parsed.args.batchId);
          foundBatchCreated = true;
        }
      } catch {
        // ignore unrelated logs
      }
    }

    if (!foundBatchCreated) return null;

    const blockTimestamp = await this.getBlockTimestamp(receipt.blockNumber);

    return {
      batchId,
      startKAId,
      endKAId,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      blockTimestamp,
      publisherAddress,
    };
  }

  // =====================================================================
  // V10 Update (KnowledgeAssetsV10 → KnowledgeCollectionStorage)
  // =====================================================================

  /**
   * Compute the `newTokenAmount` to submit (and bind into the ACK digest)
   * for a V10 update, matching the contract's growth-cost validator.
   *
   * The contract gate (`KnowledgeAssetsLifecycle._executeUpdateCore` §"Byte-size
   * growth cost check") only fires when `newByteSize > currentByteSize`, and
   * then requires `deltaTokenAmount = newTokenAmount - currentTokenAmount`
   * to be:
   *   1) strictly positive (`tokenAmount == 0` floors `_validateTokenAmount`),
   *   2) at least `(ask * byteSizeGrowth * remainingEpochs) / 1024`.
   *
   * Pre-#831 the daemon carried `newTokenAmount = currentTokenAmount`, so any
   * growth update produced `deltaTokenAmount = 0` and reverted with
   * `InvalidTokenAmount(1, 0)`. We now pay the exact marginal growth cost so
   * the contract's expected-cost branch is satisfied without overshooting.
   *
   * Pure metadata updates (`newByteSize <= currentByteSize`) skip the
   * validator entirely — the carry-forward `currentTokenAmount` is returned
   * unchanged and `deltaTokenAmount == 0` is accepted.
   *
   * MUST be called from BOTH `computeV10UpdateAckDigest` and
   * `updateKnowledgeCollectionV10` so the off-chain signed ACK and the
   * on-chain submission see the same `newTokenAmount`.
   */
  private async resolveCurrentTokenAmount(kcId: bigint): Promise<bigint> {
    const kcs = this.contracts.knowledgeCollectionStorage;
    let currentTokenAmount = 0n;
    if (kcs) {
      try {
        currentTokenAmount = BigInt(await kcs.getTokenAmount(kcId));
      } catch { /* not in KCS */ }
    }
    if (currentTokenAmount === 0n && this.contracts.knowledgeAssetsStorage) {
      try {
        const batch = await this.contracts.knowledgeAssetsStorage.getBatch(kcId);
        if (batch && batch.tokenAmount != null) {
          currentTokenAmount = BigInt(batch.tokenAmount);
        }
      } catch { /* not in KAS either */ }
    }
    return currentTokenAmount;
  }

  private async computeUpdateNewTokenAmount(params: {
    kcId: bigint;
    newByteSize: bigint;
    currentTokenAmount: bigint;
    userProvidedNewTokenAmount?: bigint;
  }): Promise<bigint> {
    const kcs = this.contracts.knowledgeCollectionStorage;
    let currentByteSize = 0n;
    let endEpoch = 0n;
    if (kcs) {
      try {
        const ctx = await kcs.getKnowledgeCollectionUpdateContext(params.kcId);
        // Tuple shape from `DKGKnowledgeAssets.getKnowledgeCollectionUpdateContext`:
        // (preUpdateMerkleRootCount, minted, byteSize, endEpoch, tokenAmount, isImmutable, preUpdateMerkleLeafCount)
        currentByteSize = BigInt(ctx[2]);
        endEpoch = BigInt(ctx[3]);
      } catch (err) {
        throw new Error(
          `Failed to read KC update context for kcId ${params.kcId}: ${(err as Error).message}`,
        );
      }
    }

    let currentEpoch = 0n;
    if (this.contracts.chronos) {
      try {
        currentEpoch = BigInt(await this.contracts.chronos.getCurrentEpoch());
      } catch (err) {
        throw new Error(
          `Failed to read Chronos currentEpoch for update tokenAmount sizing: ${(err as Error).message}`,
        );
      }
    }
    const remainingEpochs = endEpoch > currentEpoch ? endEpoch - currentEpoch : 0n;

    let growthCost = 0n;
    if (params.newByteSize > currentByteSize && this.contracts.askStorage) {
      try {
        const ask = BigInt(await this.contracts.askStorage.getStakeWeightedAverageAsk());
        const byteSizeGrowth = params.newByteSize - currentByteSize;
        if (remainingEpochs > 0n) {
          growthCost = (ask * byteSizeGrowth * remainingEpochs) / 1024n;
        } else {
          // Final epoch: remainingEpochs==0 but byte-size growth still needs a
          // strict-positive delta (contract rejects deltaTokenAmount==0).
          growthCost = 1n;
        }
        if (growthCost === 0n) growthCost = 1n;
      } catch (err) {
        throw new Error(
          `Failed to read askStorage for byte-size growth costing: ${(err as Error).message}`,
        );
      }
    }

    const minimumTokenAmount = params.currentTokenAmount + growthCost;
    const baseTokenAmount = params.userProvidedNewTokenAmount ?? minimumTokenAmount;
    const raw = baseTokenAmount > minimumTokenAmount ? baseTokenAmount : minimumTokenAmount;
    // Match computeUpdateACKDigest()'s floorPublishTokenAmount so ACK signatures
    // and the on-chain submission bind the same newTokenAmount wire value.
    return floorPublishTokenAmount(raw);
  }

  /**
   * Canonical V10 update ACK digest — mirrors `KnowledgeAssetsLifecycle`
   * `_executeUpdateCore` and the values `updateKnowledgeCollectionV10`
   * submits on-chain. Test helpers and ACK collectors should call this
   * instead of re-deriving inputs so signatures recover to the expected
   * operational keys.
   */
  async computeV10UpdateAckDigest(params: {
    kcId: bigint;
    newMerkleRoot: Uint8Array;
    newByteSize: bigint;
    newMerkleLeafCount: number;
    mintAmount?: bigint;
    burnTokenIds?: bigint[];
    newTokenAmount?: bigint;
    newCiphertextChunksRoot?: Uint8Array;
    newCiphertextChunkCount?: number;
  }): Promise<Uint8Array> {
    await this.init();
    if (!this.contracts.knowledgeAssetsV10) {
      throw new Error('KnowledgeAssetsV10 contract not deployed');
    }

    const kcs = this.contracts.knowledgeCollectionStorage;
    const kav10Address = await this.contracts.knowledgeAssetsV10.getAddress();
    const evmChainId = BigInt((await this.provider.getNetwork()).chainId);

    const currentTokenAmount = await this.resolveCurrentTokenAmount(params.kcId);

    // #831: size `newTokenAmount` against the contract's growth-cost validator
    // (matches `KnowledgeAssetsLifecycle._validateTokenAmount` exactly). The
    // floor that lived here is now redundant — `computeUpdateNewTokenAmount`
    // returns `currentTokenAmount + growthCost` (with growthCost == 0 for
    // pure metadata updates), which is always >= 1 on a V10 chain.
    const newTokenAmount = await this.computeUpdateNewTokenAmount({
      kcId: params.kcId,
      newByteSize: params.newByteSize,
      currentTokenAmount,
      userProvidedNewTokenAmount: params.newTokenAmount,
    });

    let contextGraphId = 0n;
    if (this.contracts.contextGraphStorage) {
      try {
        contextGraphId = BigInt(
          await this.contracts.contextGraphStorage.kcToContextGraph(params.kcId),
        );
      } catch { /* use 0 */ }
    }

    let preUpdateMerkleRootCount = 0n;
    if (kcs) {
      try {
        const roots: unknown[] = await kcs.getMerkleRoots(params.kcId);
        preUpdateMerkleRootCount = BigInt(roots.length);
      } catch { /* use 0 */ }
    }

    const burnIds = params.burnTokenIds ?? [];
    const ciphertextRoot = params.newCiphertextChunksRoot ?? new Uint8Array(32);
    const ciphertextCount = BigInt(params.newCiphertextChunkCount ?? 0);

    return computeUpdateACKDigest(
      evmChainId,
      kav10Address,
      contextGraphId,
      params.kcId,
      preUpdateMerkleRootCount,
      params.newMerkleRoot,
      params.newByteSize,
      newTokenAmount,
      params.mintAmount ?? 0n,
      burnIds,
      BigInt(params.newMerkleLeafCount),
      ciphertextRoot,
      ciphertextCount,
    );
  }

  async updateKnowledgeCollectionV10(params: V10UpdateKCParams): Promise<TxResult> {
    await this.init();

    if (!this.contracts.knowledgeAssetsV10) {
      throw new Error('KnowledgeAssetsV10 contract not deployed — cannot update via V10 path.');
    }

    let signer: Wallet | undefined;

    // Look up the on-chain publisher to select the correct signer.
    const kcs = this.contracts.knowledgeCollectionStorage;
    if (kcs) {
      try {
        const onChainPublisher: string = await kcs.getLatestMerkleRootPublisher(params.kcId);
        if (onChainPublisher && onChainPublisher !== ethers.ZeroAddress) {
          signer = this.signerPool.find(
            (s) => s.address.toLowerCase() === onChainPublisher.toLowerCase(),
          );
        }
      } catch {
        // Fall through to hint-based or round-robin
      }
    }

    if (!signer && params.publisherAddress) {
      signer = this.signerPool.find(
        (s) => s.address.toLowerCase() === params.publisherAddress!.toLowerCase(),
      );
    }
    if (!signer) signer = this.nextSigner();

    const ka = this.contracts.knowledgeAssetsV10.connect(signer) as Contract;

    const kav10Address = await this.contracts.knowledgeAssetsV10.getAddress();
    const evmChainId = (await this.provider.getNetwork()).chainId;

    const identityId = params.publisherNodeIdentityId ?? await this.getIdentityId();

    const currentTokenAmount = await this.resolveCurrentTokenAmount(params.kcId);

    // #831: size `newTokenAmount` against the contract's growth-cost validator
    // (matches `KnowledgeAssetsLifecycle._validateTokenAmount` exactly).
    //
    // The contract gate (`_executeUpdateCore` §"Byte-size growth cost check")
    // only fires when `newByteSize > currentByteSize` and then requires
    // `deltaTokenAmount = newTokenAmount - currentTokenAmount` to satisfy
    // `(ask * byteSizeGrowth * remainingEpochs) / 1024` with a strict-positive
    // floor. Pre-#831 the daemon carried `newTokenAmount = max(currentTokenAmount,
    // ask * newByteSize / 1024)`, which on a healthy V10 KC always equals
    // `currentTokenAmount` (carry-forward already covers the new total cost),
    // making `deltaTokenAmount == 0` and reverting every byteSize-growth
    // update with `InvalidTokenAmount(1, 0)`. The shared helper now pays the
    // exact marginal growth cost so the validator's expected-cost branch is
    // satisfied without overshooting.
    //
    // The old `floorPublishTokenAmount` clamp on the publish-flooring helper
    // is intentionally NOT applied here: this update path floors to
    // `currentTokenAmount + growthCost`, which on any V10 KC is already >= 1.
    // The redundant publish-time floor removal is still tracked separately at
    // issue #803 (post-testnet follow-up).
    const newTokenAmount = await this.computeUpdateNewTokenAmount({
      kcId: params.kcId,
      newByteSize: params.newByteSize,
      currentTokenAmount,
      userProvidedNewTokenAmount: params.newTokenAmount,
    });

    // Look up the contextGraphId for this KC
    const contextGraphStorage = this.contracts.contextGraphStorage;
    let contextGraphId = 0n;
    if (contextGraphStorage) {
      try {
        contextGraphId = BigInt(await contextGraphStorage.kcToContextGraph(params.kcId));
      } catch { /* use 0 */ }
    }

    // Compute pre-update merkle root count (array length)
    let preUpdateMerkleRootCount = 0n;
    if (kcs) {
      try {
        const roots: unknown[] = await kcs.getMerkleRoots(params.kcId);
        preUpdateMerkleRootCount = BigInt(roots.length);
      } catch { /* use 0 */ }
    }

    const opId = params.updateOperationId ?? `update-${Date.now()}`;
    const burnIds = params.burnTokenIds ?? [];

    // RFC-001: per-publish publisher signature is removed from the
    // contract surface. The update entrypoint no longer takes
    // `publisherNodeR`/`publisherNodeVS` — `publisherNodeIdentityId`
    // remains as a self-claimed attribution target only.

    let ackSigs = params.ackSignatures ?? [];
    if (ackSigs.length === 0) {
      const ackDigest = await this.computeV10UpdateAckDigest({
        kcId: params.kcId,
        newMerkleRoot: params.newMerkleRoot,
        newByteSize: params.newByteSize,
        newMerkleLeafCount: params.newMerkleLeafCount ?? 0,
        mintAmount: params.mintAmount !== undefined ? BigInt(params.mintAmount) : undefined,
        burnTokenIds: burnIds,
        newTokenAmount: params.newTokenAmount,
        newCiphertextChunksRoot: params.newCiphertextChunksRoot,
        newCiphertextChunkCount: params.newCiphertextChunkCount,
      });
      const raw = ethers.Signature.from(await signer.signMessage(ackDigest));
      ackSigs = [{ identityId, r: ethers.getBytes(raw.r), vs: ethers.getBytes(raw.yParityAndS) }];
    }

    if (!params.authorAddress || !params.authorR?.length || !params.authorVS?.length) {
      throw new Error(
        'updateKnowledgeCollectionV10 requires authorAddress, authorR, and authorVS from precomputedUpdateAttestation',
      );
    }

    const updateParams = {
      id: params.kcId,
      updateOperationId: opId,
      newMerkleRoot: ethers.hexlify(params.newMerkleRoot),
      newByteSize: params.newByteSize,
      newTokenAmount,
      newMerkleLeafCount: params.newMerkleLeafCount,
      mintKnowledgeAssetsAmount: params.mintAmount ?? 0,
      knowledgeAssetsToBurn: burnIds,
      // Codex PR #630 R1 #2 — RFC-39 Phase A.5 commitment refresh.
      // Defaults to `bytes32(0)` / 0 (metadata-only update or
      // public-CG path; KC's existing commitment stays in place).
      // Callers refreshing curated ciphertext set BOTH non-zero.
      newCiphertextChunksRoot: params.newCiphertextChunksRoot
        ? ethers.hexlify(params.newCiphertextChunksRoot)
        : ethers.ZeroHash,
      newCiphertextChunkCount: params.newCiphertextChunkCount ?? 0,
      publisherNodeIdentityId: identityId,
      identityIds: ackSigs.map(s => s.identityId),
      r: ackSigs.map(s => ethers.hexlify(s.r)),
      vs: ackSigs.map(s => ethers.hexlify(s.vs)),
      authorAddress: params.authorAddress,
      authorR: ethers.hexlify(params.authorR),
      authorVS: ethers.hexlify(params.authorVS),
      authorSchemeVersion: params.authorSchemeVersion ?? AUTHOR_SCHEME_VERSION_V1,
    };

    // Approve TRAC for the V10 update — the contract may transferFrom
    // for the newTokenAmount (same direct-spend policy as publish).
    // Shares the `ensureV10ApproveTrac` helper with the publish path so a
    // single config knob (`chain.approvalPolicy`) controls allowance
    // sizing for both V10 surfaces. The default `per-publish` policy
    // floors at 1n so metadata-only updates with `newTokenAmount === 0n`
    // still satisfy the contract's `transferFrom(..., 1n)` minimum.
    await this.ensureV10ApproveTrac(
      signer,
      kav10Address,
      newTokenAmount,
      'approve V10 update TRAC',
    );

    // P-1 review (Codex iter-5): same pattern as the publish path —
    // break the single contract call into populate / sign / hook /
    // broadcast so the `onBroadcast` checkpoint fires at the actual
    // eth_sendRawTransaction boundary, and so a hook failure (e.g.
    // WAL persistence error) aborts broadcast instead of leaving an
    // unmatched WAL record. RFC-001 unified `update`/`updateDirect`
    // into a single entrypoint: the contract auto-detects PCA discount
    // via `agentToAccountId(msg.sender)` for any positive
    // `deltaTokenAmount`.
    const populated = await (ka as any).update.populateTransaction(updateParams);
    const { signedTx, txHash: preBroadcastTxHash } = await this.signPopulatedTransaction(signer, populated);
    // Codex PR #241 iter-7: `await` so async WAL writes complete
    // before broadcast (see publish above for the full rationale).
    try {
      await params.onBroadcast?.({ txHash: preBroadcastTxHash });
    } catch (hookErr) {
      throw new Error(
        `chain:writeahead hook failed before update broadcast: ` +
        `${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
      );
    }
    const receipt = await this.sendSignedTransactionAndWait(signedTx, preBroadcastTxHash, 'V10 update');
    if (!receipt) {
      throw new Error(
        `update broadcast succeeded (txHash=${preBroadcastTxHash}) but receipt was null ` +
        `— the tx was likely replaced or dropped before confirmation`,
      );
    }

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      success: receipt.status === 1,
      publisherAddress: signer.address,
    };
  }

  // =====================================================================
  // Staking + Publishing Conviction Account legacy surface — ARCHIVED
  /**
   * Reverse-resolve a wallet to its V10 PCA account id, or `0n` if the
   * wallet is not registered as a publishing agent. Mirrors the
   * `DKGPublishingConvictionNFT.agentToAccountId(agent)` view.
   *
   * The publisher SDK uses this to decide, BEFORE building a publish
   * tx, whether `KnowledgeAssetsV10.publish()` will route through the
   * PCA discount branch — and therefore whether `publishEpochs` must
   * be coerced to the PCA's `lockDurationEpochs`. Wrong epochs do NOT
   * revert the contract any more; they just demote the publish to
   * direct spend at full price.
   *
   * Returns `0n` (not registered) when the NFT contract is not
   * deployed on this chain, the address is malformed, or the chain
   * call fails — callers treat the unknown case as "no PCA path".
   */
  async getConvictionAgentAccountId(agent: string): Promise<bigint> {
    await this.init();
    if (!this.contracts.dkgPublishingConvictionNFT) return 0n;
    if (!ethers.isAddress(agent)) return 0n;
    try {
      const id: bigint = await this.contracts.dkgPublishingConvictionNFT.agentToAccountId(agent);
      return BigInt(id);
    } catch (err: any) {
      if (err?.code === 'CALL_EXCEPTION') return 0n;
      throw err;
    }
  }

  async getConvictionAccountLockDurationEpochs(accountId: bigint): Promise<number> {
    await this.init();
    if (!this.contracts.dkgPublishingConvictionNFT) return 0;
    if (accountId <= 0n) return 0;
    try {
      // `accounts(uint256)` returns
      // (committedTRAC, createdAtEpoch, expiresAtEpoch, createdAtTimestamp,
      //  expiresAtTimestamp, lockDurationEpochs, discountBps,
      //  lastSettledWindow, fullySwept). Pull index 5.
      const tuple = await this.contracts.dkgPublishingConvictionNFT.accounts(accountId);
      const lock = tuple[5];
      return Number(lock);
    } catch (err: any) {
      if (err?.code === 'CALL_EXCEPTION') return 0;
      throw err;
    }
  }

  async getPublishingConvictionAccountOwner(accountId: bigint): Promise<string> {
    await this.init();
    const nft = await this.resolveContract('DKGPublishingConvictionNFT');
    const owner = await nft.ownerOf(accountId);
    return ethers.getAddress(owner);
  }

  private requireConvictionNFT(): Contract {
    const nft = this.contracts.dkgPublishingConvictionNFT;
    if (!nft) {
      throw new PcaUnavailableError();
    }
    return nft;
  }

  /**
   * Common wrapper for every PCA (Publisher Conviction Account) write
   * path. Two responsibilities:
   *
   *   1. Opaque "unknown custom error"+data reverts from the post-split
   *      `PublishingConviction` logic contract carry no decoded name
   *      out of ethers — `enrichEvmError` decodes them so the daemon's
   *      error classifier can match downstream (mirrors what
   *      `isContractMissingRevert` does for the resolution path).
   *
   *   2. Self-heal on a stale `DKGPublishingConvictionNFT` /
   *      `PublishingConvictionStorage` binding. Both contracts were
   *      redeployed for v10.0.0-rc.11 (PCA split); the wrapper NFT
   *      lazy-resolves `PublishingConviction` on every call so a
   *      logic rotation is handled on-chain, but a wrapper rotation
   *      surfaces here as `UnauthorizedAccess(Only Contracts in Hub)`
   *      on the FIRST PCA write after the Hub re-registration. The
   *      `withHubStaleRetryAny` outer layer drops every boot-bound
   *      handle, re-runs `init()` to repopulate from the live Hub,
   *      and retries the closure once — `op` re-reads
   *      `this.contracts.dkgPublishingConvictionNFT` via
   *      `requireConvictionNFT()` so the retry uses the new address.
   *
   * NOTE — rc.12 follow-up: other V10 write paths
   * (`createKnowledgeAssetsV10`, `createContextGraph`,
   * `updateKnowledgeCollectionV10`, etc.) should be wrapped with the
   * same self-heal pattern. Tracked in the broader migration to
   * `HubResolutionCache` for every boot-bound contract.
   */
  private async pcaWrite<T>(op: () => Promise<T>): Promise<T> {
    return this.withHubStaleRetryAny(async () => {
      try {
        return await op();
      } catch (err) {
        if (err instanceof Error) enrichEvmError(err);
        throw err;
      }
    });
  }

  async createPublishingConvictionAccount(
    committedTRAC: bigint,
  ): Promise<{ accountId: bigint } & TxResult> {
    await this.init();
    return this.pcaWrite(async () => {
      const nft = this.requireConvictionNFT();
      const nftAddress = await nft.getAddress();

      // createAccount() does transferFrom(msg.sender → stakingStorage,
      // committedTRAC) — the signer must allow the NFT to pull the TRAC.
      if (this.contracts.token) {
        const allowance: bigint = await this.contracts.token.allowance(this.signer.address, nftAddress);
        if (allowance < committedTRAC) {
          await this.sendContractTransaction(
            this.contracts.token,
            'approve',
            [nftAddress, ethers.MaxUint256],
            this.signer,
            'approve PCA TRAC',
          );
        }
      }

      const receipt = await this.sendContractTransaction(
        nft,
        'createAccount',
        [committedTRAC],
        this.signer,
        'create publishing conviction account',
      );

      // Post PR #650 split, `AccountCreated` is emitted by
      // `PublishingConviction` (logic), NOT by the wrapper. Parse via
      // the logic ABI so this keeps working once `chain/abi/DKGPublishingConvictionNFT.json`
      // is refreshed to its post-split slim surface (which no longer
      // declares any PCA events).
      const pcaLogic = getPcaLogicInterface();
      let accountId = 0n;
      for (const log of receipt.logs) {
        try {
          const parsed = pcaLogic.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed?.name === 'AccountCreated') {
            accountId = BigInt(parsed.args.accountId);
            break;
          }
        } catch { /* not a PublishingConviction event */ }
      }
      if (accountId === 0n) {
        throw new Error('createPublishingConvictionAccount succeeded but no AccountCreated event found');
      }

      return {
        accountId,
        hash: receipt.hash,
        blockNumber: receipt.blockNumber,
        success: receipt.status === 1,
      };
    });
  }

  async getPublishingConvictionAccountInfo(accountId: bigint): Promise<V10PublishingConvictionAccountInfo | null> {
    await this.init();
    // Undeployed NFT → capability error (503). null is reserved below
    // for a genuine account-missing revert so the route can disambiguate.
    if (!this.contracts.dkgPublishingConvictionNFT) throw new PcaUnavailableError();
    try {
      const t = await this.contracts.dkgPublishingConvictionNFT.getAccountInfo(accountId);
      return {
        owner: ethers.getAddress(t[0]),
        committedTRAC: BigInt(t[1]),
        baseEpochAllowance: BigInt(t[2]),
        createdAtEpoch: Number(t[3]),
        expiresAtEpoch: Number(t[4]),
        createdAtTimestamp: Number(t[5]),
        expiresAtTimestamp: Number(t[6]),
        discountBps: Number(t[7]),
        topUpBuffer: BigInt(t[8]),
        agentCount: Number(t[9]),
        lastSettledWindow: Number(t[10]),
        fullySwept: Boolean(t[11]),
      };
    } catch (err: any) {
      if (err?.code === 'CALL_EXCEPTION') return null;
      throw err;
    }
  }

  async topUpPublishingConvictionAccount(accountId: bigint, amount: bigint): Promise<TxResult> {
    await this.init();
    return this.pcaWrite(async () => {
      const nft = this.requireConvictionNFT();
      const nftAddress = await nft.getAddress();
      if (this.contracts.token) {
        const allowance: bigint = await this.contracts.token.allowance(this.signer.address, nftAddress);
        if (allowance < amount) {
          await this.sendContractTransaction(
            this.contracts.token,
            'approve',
            [nftAddress, ethers.MaxUint256],
            this.signer,
            'approve PCA top-up TRAC',
          );
        }
      }
      const receipt = await this.sendContractTransaction(
        nft,
        'topUp',
        [accountId, amount],
        this.signer,
        'top up publishing conviction account',
      );
      return { hash: receipt.hash, blockNumber: receipt.blockNumber, success: receipt.status === 1 };
    });
  }

  async settlePublishingConvictionAccount(accountId: bigint): Promise<TxResult> {
    await this.init();
    return this.pcaWrite(async () => {
      const nft = this.requireConvictionNFT();
      const receipt = await this.sendContractTransaction(
        nft,
        'settle',
        [accountId],
        this.signer,
        'settle publishing conviction account',
      );
      return { hash: receipt.hash, blockNumber: receipt.blockNumber, success: receipt.status === 1 };
    });
  }

  async registerPublishingConvictionAgent(accountId: bigint, agent: string): Promise<TxResult> {
    await this.init();
    return this.pcaWrite(async () => {
      const nft = this.requireConvictionNFT();
      const receipt = await this.sendContractTransaction(
        nft,
        'registerAgent',
        [accountId, agent],
        this.signer,
        'register publishing conviction agent',
      );
      return { hash: receipt.hash, blockNumber: receipt.blockNumber, success: receipt.status === 1 };
    });
  }

  async deregisterPublishingConvictionAgent(accountId: bigint, agent: string): Promise<TxResult> {
    await this.init();
    return this.pcaWrite(async () => {
      const nft = this.requireConvictionNFT();
      const receipt = await this.sendContractTransaction(
        nft,
        'deregisterAgent',
        [accountId, agent],
        this.signer,
        'deregister publishing conviction agent',
      );
      return { hash: receipt.hash, blockNumber: receipt.blockNumber, success: receipt.status === 1 };
    });
  }

  async isPublishingConvictionAgent(accountId: bigint, agent: string): Promise<boolean> {
    await this.init();
    if (!this.contracts.dkgPublishingConvictionNFT) return false;
    if (!ethers.isAddress(agent)) return false;
    try {
      return Boolean(await this.contracts.dkgPublishingConvictionNFT.isAgent(accountId, agent));
    } catch (err: any) {
      if (err?.code === 'CALL_EXCEPTION') return false;
      throw err;
    }
  }

  // =====================================================================
  // Utilities
  // =====================================================================

  getSignerAddress(): string {
    return this.signer.address;
  }

  async getMinimumRequiredSignatures(): Promise<number> {
    // PR3 / RC11: TTL-cached. Governance vote that changes
    // `minimumRequiredSignatures` propagates within 1h to the ACK
    // collector; on-chain validation in `KnowledgeAssetsV10` would
    // reject a publish that used the stale quorum so a single
    // mis-routed retry past the boundary is the worst-case symptom.
    const now = Date.now();
    if (EVMChainAdapter.preflightCacheFresh(this.cachedMinRequiredSignatures, now)) {
      return this.cachedMinRequiredSignatures!.value;
    }
    await this.init();
    // FAIL-CLOSED (Codex PR #595 round-5): the agent + publisher
    // verify paths trust whatever this method returns. A silent
    // fallback to a hardcoded `3` (or any other value) when
    // ParametersStorage isn't resolvable would let verify use the
    // wrong quorum without anyone noticing. Refuse to guess.
    if (!this.contracts.parametersStorage) {
      throw new Error(
        'getMinimumRequiredSignatures: ParametersStorage contract is not resolvable. ' +
        'Verify cannot enforce ACK quorum without a real chain read — fix the adapter wiring or pass an explicit override.',
      );
    }
    const value = Number(await this.contracts.parametersStorage.minimumRequiredSignatures());
    this.cachedMinRequiredSignatures = { value, cachedAt: now };
    return value;
  }

  async isShardingTableMember(identityId: bigint): Promise<boolean> {
    if (identityId <= 0n) return false;
    await this.init();
    const storage = await this.resolveContract('ShardingTableStorage');
    if (!storage) {
      throw new Error(
        'isShardingTableMember: ShardingTableStorage contract is not resolvable. ' +
        'Verify path cannot enforce sharding-table eligibility without it.',
      );
    }
    return Boolean(await storage.nodeExists(identityId));
  }

  /**
   * Off-chain pre-flight for the V10 ACK signer gate. Mirrors the on-chain
   * check in `KnowledgeAssetsV10._verifyACKSignature` (post-RFC-001): the
   * recovered signer must be a registered OPERATIONAL_KEY for the claimed
   * identity AND that identity must be in the active sharding table.
   *
   * Returns a structured reason on rejection so the ACKCollector log can
   * distinguish operator-actionable failures (key registration, sub-
   * `minimumStake` stake) from infrastructure failures (RPC outage). Pre-
   * RFC-001 versions of this method gated on `getNodeStakeV10 > 0`, which
   * let sub-`minimumStake` operators clear off-chain quorum and then revert
   * on-chain with `"ACK signer not in sharding table"`. ST membership is
   * updated atomically by `StakingV10` whenever a node's V10 stake crosses
   * `minimumStake` up or down.
   */
  async verifyACKIdentityDetailed(
    recoveredAddress: string,
    claimedIdentityId: bigint,
  ): Promise<VerifyACKIdentityResult> {
    try {
      await this.init();
      const identityStorage = await this.resolveContract('IdentityStorage');
      if (!identityStorage) return { valid: false, reason: 'rpc-error' };

      const keyHash = ethers.keccak256(ethers.solidityPacked(['address'], [recoveredAddress]));
      const hasPurpose: boolean = await identityStorage.keyHasPurpose(
        claimedIdentityId,
        keyHash,
        OPERATIONAL_KEY_PURPOSE,
      );
      if (!hasPurpose) return { valid: false, reason: 'key-not-registered' };

      const shardingTableStorage = await this.resolveContract('ShardingTableStorage');
      if (!shardingTableStorage) return { valid: false, reason: 'rpc-error' };
      const inST: boolean = Boolean(await shardingTableStorage.nodeExists(claimedIdentityId));
      if (!inST) return { valid: false, reason: 'not-in-sharding-table' };
      return { valid: true };
    } catch {
      // Any chain-side throw (filter expired, RPC rate-limit, contract
      // resolution failure mid-call) is reported as `rpc-error` so the
      // ACKCollector can log it distinctly from a definitive negative.
      // Mirrors the existing wrapper in `dkg-agent.ts:createV10ACKProvider`
      // which used to swallow these exceptions as `false`, conflating
      // transient infra failures with permanent rejections.
      return { valid: false, reason: 'rpc-error' };
    }
  }

  async verifyACKIdentity(recoveredAddress: string, claimedIdentityId: bigint): Promise<boolean> {
    // PR #711 + rc.12: delegate to the structured variant so the off-chain
    // gate stays in lockstep with the on-chain `KnowledgeAssetsV10` ACK-
    // signer check (operational-key purpose AND sharding-table membership).
    // The legacy V10-stake / V8-stake fallback that lived inline here is
    // superseded by the ST-membership check inside
    // `verifyACKIdentityDetailed`, which is updated atomically by
    // `StakingV10` whenever a node crosses `minimumStake`. PR #732's
    // lazy-cache perf optimization is unaffected — the other call sites
    // in this file pick up `getIdentityStorage()` via the auto-merge.
    return (await this.verifyACKIdentityDetailed(recoveredAddress, claimedIdentityId)).valid;
  }

  async verifySyncIdentity(recoveredAddress: string, claimedIdentityId: bigint): Promise<boolean> {
    await this.init();
    const identityStorage = await this.getIdentityStorage();
    if (!identityStorage) return false;

    const keyHash = ethers.keccak256(ethers.solidityPacked(['address'], [recoveredAddress]));
    return identityStorage.keyHasPurpose(claimedIdentityId, keyHash, OPERATIONAL_KEY_PURPOSE);
  }

  async signACKDigest(digest: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array } | undefined> {
    try {
      const identityId = await this.getIdentityId();
      if (identityId === 0n) return undefined;
      if (!(await this.isOperationalWalletRegistered(identityId, this.signer.address))) {
        return undefined;
      }

      const sig = ethers.Signature.from(await this.signer.signMessage(digest));
      return {
        r: ethers.getBytes(sig.r),
        vs: ethers.getBytes(sig.yParityAndS),
      };
    } catch {
      return undefined;
    }
  }

  getACKSignerKey(): string | undefined {
    return this.signer.privateKey;
  }

  isV10Ready(): boolean {
    return !!this.contracts.knowledgeAssetsV10;
  }

  isRandomSamplingReady(): boolean {
    return !!this.contracts.randomSampling && !!this.contracts.randomSamplingStorage;
  }

  async signMessage(messageHash: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array }> {
    const sig = ethers.Signature.from(
      await this.signer.signMessage(messageHash),
    );
    return {
      r: ethers.getBytes(sig.r),
      vs: ethers.getBytes(sig.yParityAndS),
    };
  }

  async signMessageAs(address: string, messageHash: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array }> {
    const selected = this.findSignerByAddress(address);
    if (!selected) {
      throw new Error(`Cannot sign with ${address}: address is not present in the EVM signer pool.`);
    }
    const sig = ethers.Signature.from(
      await selected.signMessage(messageHash),
    );
    return {
      r: ethers.getBytes(sig.r),
      vs: ethers.getBytes(sig.yParityAndS),
    };
  }

  async signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    return this.signer.signTypedData(domain, types, value);
  }

  async signTypedDataAs(
    address: string,
    domain: ethers.TypedDataDomain,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    const selected = this.findSignerByAddress(address);
    if (!selected) {
      throw new Error(`Cannot sign typed data with ${address}: address is not present in the EVM signer pool.`);
    }
    return selected.signTypedData(domain, types, value);
  }

  async getBlockNumber(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  getProvider(): JsonRpcProvider {
    return this.primaryProvider;
  }

  getReadProvider(): JsonRpcProvider | FallbackProvider {
    return this.provider;
  }

  getRpcUrls(): string[] {
    return [...this.rpcUrls];
  }

  async getContract(name: string): Promise<Contract> {
    await this.init();
    return this.resolveContract(name);
  }

  // =====================================================================
  // Random Sampling (V10 RandomSampling.sol)
  // =====================================================================

  /**
   * Resolve `RandomSampling` and `RandomSamplingStorage` through the
   * Hub-backed cache. Each call may trigger a re-resolve when the
   * cached value is missing or has expired (TTL or invalidation),
   * which is exactly the property that makes node operators no longer
   * need a daemon restart after a Hub-side contract rotation.
   *
   * Failure-mode handling: only the documented "name not registered
   * in the Hub" case (which `resolveContract` throws as
   * `Contract "X" not found in Hub at <addr>`) is rewritten to a
   * deployment-oriented hint. Every other failure (transient RPC,
   * ABI mismatch, provider error, etc.) propagates with its original
   * message preserved so the prover loop's error log points
   * operators at the actual cause instead of misdirecting them
   * toward a redeploy.
   */
  private async getRandomSampling(): Promise<{ rs: Contract; rss: Contract }> {
    try {
      return await this.resolveAndAssignRandomSamplingPair();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found in Hub at')) {
        throw new Error(
          'RandomSampling / RandomSamplingStorage not deployed in this Hub. ' +
          'The deployer is responsible for shipping these alongside V10 publish.',
          { cause: err },
        );
      }
      throw err;
    }
  }

  /**
   * Resolve the RS+RSS pair from the cache and write the handles into
   * `this.contracts.randomSampling[Storage]` ONLY if no `invalidate()`
   * happened during the await. Without the generation guard, an
   * in-flight resolve started before a Hub rotation would leak the
   * pre-rotation pair back into the side-channel handles, undoing the
   * invalidation's clearing of those handles and leaving
   * `isRandomSamplingReady()` reporting `true` against stale addresses.
   * Returning the (possibly stale) pair to the immediate caller is
   * still safe — `withHubStaleRetry` catches the inevitable on-chain
   * `UnauthorizedAccess` and re-tries against the freshly resolved
   * pair.
   */
  private async resolveAndAssignRandomSamplingPair(): Promise<{ rs: Contract; rss: Contract }> {
    const generationBefore = this.randomSamplingPairCache.currentGeneration();
    const pair = await this.randomSamplingPairCache.get();
    if (this.randomSamplingPairCache.currentGeneration() === generationBefore) {
      this.contracts.randomSampling = pair.rs;
      this.contracts.randomSamplingStorage = pair.rss;
    }
    return pair;
  }

  /**
   * Run `fn` and, if it fails with the unique "this caller is no
   * longer registered as a Hub contract" revert, drop the cached RS
   * pair and retry exactly once. This is the safety net for the
   * rare case where (a) the daemon missed the `Hub.ContractChanged`
   * event (RPC reconnect, dropped subscription, etc.) AND (b) the TTL
   * hasn't expired yet. After the retry, the cache holds the freshly
   * resolved pair for subsequent ticks.
   */
  private async withHubStaleRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Error) enrichEvmError(err);
      const msg = err instanceof Error ? err.message : '';
      if (HUB_STALE_ERROR_MARKERS.some((m) => msg.includes(m))) {
        this.invalidateRandomSamplingPair();
        return await fn();
      }
      throw err;
    }
  }

  /**
   * Like `withHubStaleRetry` but generalized for any boot-bound
   * contract — not just the RS pair. On `UnauthorizedAccess(Only
   * Contracts in Hub)`, drops every boot-bound `this.contracts.X`
   * handle, re-runs `init()` to re-resolve all bindings from Hub,
   * then retries the operation exactly once.
   *
   * Used at write-side call sites that touch any of the redeployable
   * V10 contracts (PCA NFT, ContextGraphs, KnowledgeCollection, etc.)
   * so the FIRST write after a Hub rotation self-heals even when the
   * event listener never fired (HTTP-only RPC endpoints, dropped
   * subscriptions, rate-limited filter installs — all of which we
   * see in the wild on public Base Sepolia / Gnosis Chain RPCs).
   *
   * Idempotency note: the wrapped closure MUST be safe to call twice.
   * That holds for our write paths because the on-chain side either
   * (a) reverted with the marker error, meaning no state changed, or
   * (b) succeeded, meaning no retry happens. The closure SHOULD
   * re-read `this.contracts.X` on each invocation (don't capture the
   * handle into a local outside the closure) so the retry uses the
   * fresh binding.
   */
  private async withHubStaleRetryAny<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Error) enrichEvmError(err);
      const msg = err instanceof Error ? err.message : '';
      if (HUB_STALE_ERROR_MARKERS.some((m) => msg.includes(m))) {
        this.invalidateAllBoundContracts();
        await this.init();
        return await fn();
      }
      throw err;
    }
  }

  /**
   * Invalidate both the cache AND the side-channel contract handles. Without
   * dropping `this.contracts.randomSampling[Storage]`, the public
   * `isRandomSamplingReady()` probe would keep returning `true` after a Hub
   * rotation (until the next `getRandomSampling()` re-populates the
   * handles), giving the prover a stale all-clear.
   *
   * Codex round 6 on PR #369: ALSO drop the in-flight duration probe.
   * The probe was started against the OLD `RandomSampling` contract;
   * if Hub rotates while it is pending we MUST NOT pair the new
   * contract's `getActiveProofPeriodStatus()` with the old contract's
   * duration in the next call. Worse, if the old probe never settles
   * (hung provider) it would suppress every fresh probe forever via
   * the single-flight guard. Clearing the slot here lets the next
   * call issue a fresh probe against the new contract; the now-orphan
   * old promise is still handled by its `.finally` hook (the slot
   * identity check inside .finally won't match, so it correctly does
   * nothing).
   */
  private invalidateRandomSamplingPair(): void {
    this.randomSamplingPairCache.invalidate();
    this.contracts.randomSampling = undefined;
    this.contracts.randomSamplingStorage = undefined;
    this.inflightDurationProbe = undefined;
    this.inflightDurationProbeContract = undefined;
    this.inflightDurationProbeStartedAt = 0;
  }

  /**
   * Subscribe to Hub rotation events and invalidate the local cache for any
   * Hub-rotated contract.
   *
   * Two invalidation paths, dispatched by name:
   *
   *   1. `RandomSampling` / `RandomSamplingStorage` → atomic pair
   *      invalidation through `invalidateRandomSamplingPair()` so the
   *      coupled cache + in-flight probe lifecycle stays consistent.
   *      See the `randomSamplingPairCache` field comment for the
   *      coupling invariants this path preserves.
   *
   *   2. Any other name in `BOUND_CONTRACT_INVALIDATORS` → leave the
   *      existing `this.contracts.X` field intact but flip
   *      `this.initialized` back to `false` so the next `await
   *      this.init()` re-resolves every binding fresh from Hub. Keeping
   *      the old handle until the next init pass avoids a race where an
   *      in-flight public method already passed `init()` and then trips
   *      over a transient `undefined` field. This is the structural fix
   *      for the post-rotation stale-address bug on the wider V10
   *      contract set (PCA NFT, ContextGraphs, KnowledgeCollection
   *      family, storage contracts, etc.) — without this dispatch,
   *      operators were silently stuck on the pre-rotation address
   *      until a daemon restart.
   *
   *   3. Unknown name → ignored. We deliberately allowlist rather
   *      than reflexively re-init on any rotation: third-party
   *      deployments may register names we don't bind, and we don't
   *      want a benign rotation of an unrelated contract to thrash
   *      our cache.
   *
   * `Hub._setContractAddress` is double-tap-emitting (`Hub-extra.test.ts`
   * E-7): on the new-contract path it emits `NewContract` twice, and
   * on the update path it emits both `ContractChanged` AND
   * `NewContract`. Storage bindings resolved through
   * `getAssetStorageAddress(...)` emit the parallel `AssetStorageChanged`
   * / `NewAssetStorage` events. We listen to all four events so the cache
   * invalidates regardless of which Hub set owns the name, and both the
   * RS-pair invalidation and the generic boot-bound invalidation are
   * idempotent so duplicate notifications are harmless.
   *
   * `Contract.on(...)` is async in ethers v6: a sync `try/catch` would
   * miss provider rejections (e.g. HTTP-only endpoints that can't
   * install filter subscriptions) and leave us with an unhandled
   * rejection. We `await` every subscription and only set
   * `hubRotationListenerStarted` after all succeed, so a failed
   * provider can be retried by a future call site if we ever need to
   * — and meanwhile the TTL refresh path (for RS) and the
   * `withHubStaleRetry` write-side fallback (for all boot-bound
   * contracts) still keep stale bindings recoverable without a
   * working event subscription.
   */
  private async startHubRotationListener(): Promise<void> {
    if (this.hubRotationListenerStarted) return;
    const onChange = (name: unknown): void => {
      if (typeof name !== 'string') return;
      if (name === 'RandomSampling' || name === 'RandomSamplingStorage') {
        this.invalidateRandomSamplingPair();
        return;
      }
      if (BOUND_CONTRACT_INVALIDATORS.has(name)) {
        this.invalidatePublishPreflightCache();
        // Force the next public-method entry through `init()` so it
        // re-resolves every binding. Do not clear the current handle
        // here: the callback can fire between a public method's
        // `await init()` and its first `this.contracts.X` read.
        this.initialized = false;
      }
    };
    try {
      await this.contracts.hub.on('ContractChanged', onChange);
      await this.contracts.hub.on('NewContract', onChange);
      await this.contracts.hub.on('AssetStorageChanged', onChange);
      await this.contracts.hub.on('NewAssetStorage', onChange);
      this.hubRotationListenerStarted = true;
    } catch {
      /* provider doesn't support filter subscriptions — TTL refresh (RS)
       * and `withHubStaleRetry` (writes) are the fallbacks */
    }
  }

  /**
   * Drop every boot-bound contract handle and re-arm `init()`.
   *
   * Used by `withHubStaleRetry` on the write-side self-heal path when
   * a Hub-rotated contract surfaces `UnauthorizedAccess(Only Contracts
   * in Hub)`: the listener may have missed the rotation event (HTTP-only
   * RPC, dropped subscription, etc.) so the failing operation can't tell
   * which specific name was rotated. Resetting everything is the safest
   * fallback — the next `await this.init()` re-resolves all 15+ bindings
   * in a single pass (still under a second on a healthy RPC) and the
   * caller's retry picks up the fresh handles.
   *
   * RS pair is handled separately because it owns side-channel state
   * (in-flight probe, ready flag) that `init()` alone won't reset.
   */
  private invalidateAllBoundContracts(): void {
    for (const invalidator of BOUND_CONTRACT_INVALIDATORS.values()) {
      invalidator(this);
    }
    this.invalidatePublishPreflightCache();
    this.invalidateRandomSamplingPair();
    this.initialized = false;
  }

  /**
   * Map a caught chain error onto a typed prover error when the revert
   * matches one of the documented retry-next-period / non-retryable
   * conditions; otherwise rethrow the original. Centralised so the
   * three call sites stay in sync with the on-chain revert wording.
   *
   * Note: `createChallenge` reverts via custom errors (decoded by the
   * `getErrorInterface()` helper above), `submitProof` uses
   * `revert("...")` strings for the period/proof-mismatch cases plus a
   * `MerkleRootMismatchError` custom error.
   */
  private translateRandomSamplingError(err: unknown): never {
    if (!(err instanceof Error)) throw err;
    enrichEvmError(err);
    const msg = err.message;
    if (msg.includes('NoEligibleContextGraph')) throw new NoEligibleContextGraphError();
    if (msg.includes('NoEligibleKnowledgeCollection')) throw new NoEligibleKnowledgeCollectionError();
    if (msg.includes('This challenge is no longer active')) throw new ChallengeNoLongerActiveError();
    const merkleMatch = msg.match(/MerkleRootMismatchError\((0x[0-9a-fA-F]+),\s*(0x[0-9a-fA-F]+)\)/);
    if (merkleMatch) {
      throw new MerkleRootMismatchError(merkleMatch[1], merkleMatch[2]);
    }
    throw err;
  }

  /**
   * Convert the on-chain `Challenge` tuple (or struct) into our wire
   * type. The contract returns an all-zero struct when no challenge
   * exists for an identity, which we surface as `null` so callers
   * don't have to dispatch on `kcId === 0n`.
   */
  private toNodeChallenge(raw: any): NodeChallenge | null {
    const kcId = BigInt(raw.knowledgeCollectionId ?? raw[0]);
    const startBlock = BigInt(raw.activeProofPeriodStartBlock ?? raw[4]);
    if (kcId === 0n && startBlock === 0n) return null;
    return {
      knowledgeCollectionId: kcId,
      chunkId: BigInt(raw.chunkId ?? raw[1]),
      knowledgeCollectionStorageContract: String(raw.knowledgeCollectionStorageContract ?? raw[2]),
      epoch: BigInt(raw.epoch ?? raw[3]),
      activeProofPeriodStartBlock: startBlock,
      proofingPeriodDurationInBlocks: BigInt(raw.proofingPeriodDurationInBlocks ?? raw[5]),
      solved: Boolean(raw.solved ?? raw[6]),
    };
  }

  async createChallenge(): Promise<CreateChallengeResult> {
    await this.init();

    const identityStorage = await this.getIdentityStorage();
    const identityId: bigint = await identityStorage.getIdentityId(this.signer.address);

    return this.withHubStaleRetry(async () => {
      const { rs, rss } = await this.getRandomSampling();

      let receipt: ethers.TransactionReceipt;
      try {
        receipt = await this.sendContractTransaction(
          rs,
          'createChallenge',
          [],
          this.signer,
          'create random-sampling challenge',
        );
      } catch (err) {
        this.translateRandomSamplingError(err);
      }

      // Decode `ChallengeGenerated(identityId, contextGraphId, kcId, chunkId, epoch, startBlock)`
      // from the receipt. cgId is indexed (topic[2]); the rest are in data
      // but we only need cgId here — the proof builder reads kcId/chunkId
      // off the Challenge struct fetched below, so everything stays
      // consistent if the storage layout shifts.
      let contextGraphId = 0n;
      const rsIface = rs.interface;
      for (const log of receipt.logs) {
        try {
          const parsed = rsIface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed?.name === 'ChallengeGenerated') {
            contextGraphId = BigInt(parsed.args.contextGraphId);
            break;
          }
        } catch { /* not this contract */ }
      }
      if (contextGraphId === 0n) {
        // The picker only emits the event when it actually lands on a CG,
        // so a missing event is a bug — fail loud rather than fall back
        // to "lookup by KC" which V10 doesn't support natively.
        throw new Error(
          'createChallenge succeeded on-chain but no ChallengeGenerated event was found in the receipt; ' +
          'cannot route proof builder without contextGraphId.',
        );
      }

      const challengeRaw = await rss.getNodeChallenge(identityId);
      const challenge = this.toNodeChallenge(challengeRaw);
      if (!challenge) {
        throw new Error(
          `createChallenge succeeded but RandomSamplingStorage.getNodeChallenge(${identityId}) ` +
          'returned an empty struct. This indicates a state inconsistency between ' +
          'RandomSampling and RandomSamplingStorage.',
        );
      }

      return {
        hash: receipt.hash,
        blockNumber: receipt.blockNumber,
        success: true,
        challenge,
        contextGraphId,
      };
    });
  }

  async submitProof(leaf: Uint8Array | `0x${string}`, merkleProof: Uint8Array[]): Promise<TxResult> {
    await this.init();

    const leafHex = typeof leaf === 'string' ? leaf : ethers.hexlify(leaf);
    if (!ethers.isHexString(leafHex, 32)) {
      throw new Error('submitProof: leaf must be a 32-byte value (bytes32)');
    }
    const proofHex = merkleProof.map((p) => ethers.hexlify(p));

    return this.withHubStaleRetry(async () => {
      const { rs } = await this.getRandomSampling();

      let receipt: ethers.TransactionReceipt;
      try {
        receipt = await this.sendContractTransaction(
          rs,
          'submitProof',
          [leafHex, proofHex],
          this.signer,
          'submit random-sampling proof',
        );
      } catch (err) {
        this.translateRandomSamplingError(err);
      }

      return {
        hash: receipt.hash,
        blockNumber: receipt.blockNumber,
        success: true,
      };
    });
  }

  async getActiveProofPeriodStatus(): Promise<ProofPeriodStatus> {
    await this.init();
    const { rs } = await this.getRandomSampling();

    // Codex round 2 on PR #369: the cached `NodeChallenge.proofingPeriodDurationInBlocks`
    // is whatever the contract used at challenge-creation time. The chain's
    // `updateAndGetActiveProofPeriodStartBlock()` rolls forward using the
    // CURRENT epoch's duration via `getActiveProofingPeriodDurationInBlocks()`.
    // If a governance change shortens the duration mid-flight, off-chain
    // staleness checks against the cached duration would underestimate
    // expiry and re-deadlock at the rollover boundary. Pull the live
    // duration alongside the status read so the prover can compare
    // wall-clock against the same value the contract uses for rollover.
    //
    // Codex round 3 + 4 + 5 — keep the live-duration read STRICTLY best-effort:
    // a transient RPC blip, partial rollout, or an older RS deployment
    // that omits the method from its ABI must NOT make the whole
    // `getActiveProofPeriodStatus()` reject OR stall.
    //
    // Naive `Promise.allSettled` is NOT enough —
    // `rs.getActiveProofingPeriodDurationInBlocks()` would throw
    // synchronously (`TypeError: ... is not a function`) before
    // `allSettled` can wrap it when the method is missing entirely.
    //
    // Plain `try/catch` is also NOT enough — a hung RPC (provider
    // accepts the request but never responds) keeps the await pending
    // forever, blocking the entire status probe even though the
    // primary `getActiveProofPeriodStatus()` already returned. The
    // prover can safely continue with the cached challenge duration,
    // so race the duration read against a short timeout and prefer
    // `undefined` on slow paths. The prover treats `undefined` as
    // "fall back to existing.proofingPeriodDurationInBlocks".
    const readDurationBestEffort = async (): Promise<bigint | undefined> => {
      try {
        const fn = (rs as unknown as { getActiveProofingPeriodDurationInBlocks?: () => Promise<unknown> })
          .getActiveProofingPeriodDurationInBlocks;
        if (typeof fn !== 'function') return undefined;
        const v = await fn.call(rs);
        return BigInt(v as never);
      } catch {
        return undefined;
      }
    };
    const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      });
      return Promise.race([
        p.then((v) => { if (timer) clearTimeout(timer); return v; }),
        timeout,
      ]);
    };
    // Single-flight: if a previous tick's probe is still pending,
    // reuse it instead of issuing a fresh `eth_call`. Codex round 8:
    // first invalidate the slot if (a) the resolved RS Contract
    // instance has changed since the probe was started (TTL-refresh
    // path constructs a fresh Contract WITHOUT calling
    // invalidateRandomSamplingPair → the probe was started against
    // the old contract and must not be paired with the new
    // contract's status), or (b) the slot is older than
    // MAX_PROBE_AGE_MS (a truly hung probe must not suppress retries
    // forever).
    const probeAgeMs = this.inflightDurationProbe
      ? Date.now() - this.inflightDurationProbeStartedAt
      : 0;
    if (this.inflightDurationProbe && (
      this.inflightDurationProbeContract !== rs ||
      probeAgeMs > MAX_PROBE_AGE_MS
    )) {
      this.inflightDurationProbe = undefined;
    }
    let probe = this.inflightDurationProbe;
    if (!probe) {
      const fresh = readDurationBestEffort();
      this.inflightDurationProbe = fresh;
      this.inflightDurationProbeContract = rs;
      this.inflightDurationProbeStartedAt = Date.now();
      // `.finally` covers both resolve and reject paths without
      // altering the value the caller observes.
      void fresh.finally(() => {
        if (this.inflightDurationProbe === fresh) {
          this.inflightDurationProbe = undefined;
        }
      });
      probe = fresh;
    }
    const [raw, proofingPeriodDurationInBlocks] = await Promise.all([
      rs.getActiveProofPeriodStatus(),
      withTimeout(probe, DURATION_PROBE_TIMEOUT_MS, undefined),
    ]);
    return {
      activeProofPeriodStartBlock: BigInt(raw.activeProofPeriodStartBlock ?? raw[0]),
      isValid: Boolean(raw.isValid ?? raw[1]),
      proofingPeriodDurationInBlocks,
    };
  }

  async getNodeChallenge(identityId: bigint): Promise<NodeChallenge | null> {
    await this.init();
    const { rss } = await this.getRandomSampling();
    const raw = await rss.getNodeChallenge(identityId);
    return this.toNodeChallenge(raw);
  }

  async getNodeEpochProofPeriodScore(
    identityId: bigint,
    epoch: bigint,
    periodStartBlock: bigint,
  ): Promise<bigint> {
    await this.init();
    const { rss } = await this.getRandomSampling();
    const score: bigint = await rss.getNodeEpochProofPeriodScore(identityId, epoch, periodStartBlock);
    return BigInt(score);
  }

  // =====================================================================
  // KC views (V10 KnowledgeCollectionStorage + ContextGraphStorage)
  // =====================================================================

  private requireKCStorage(): Contract {
    const kcs = this.contracts.knowledgeCollectionStorage;
    if (!kcs) {
      throw new Error(
        'KnowledgeCollectionStorage not deployed in this Hub. ' +
        'V10 KC views require a Hub with KnowledgeCollectionStorage registered.',
      );
    }
    return kcs;
  }

  private requireContextGraphStorage(): Contract {
    const cgs = this.contracts.contextGraphStorage;
    if (!cgs) {
      throw new Error(
        'ContextGraphStorage not deployed in this Hub. ' +
        'getKCContextGraphId requires a Hub with ContextGraphStorage registered.',
      );
    }
    return cgs;
  }

  async getLatestMerkleRoot(kcId: bigint): Promise<Uint8Array> {
    await this.init();
    const kcs = this.requireKCStorage();
    const rootHex: string = await kcs.getLatestMerkleRoot(kcId);
    return ethers.getBytes(rootHex);
  }

  async getMerkleLeafCount(kcId: bigint): Promise<number> {
    await this.init();
    const kcs = this.requireKCStorage();
    const count: bigint = BigInt(await kcs.getMerkleLeafCount(kcId));
    return Number(count);
  }

  async getLatestCiphertextChunksRoot(kcId: bigint): Promise<Uint8Array> {
    await this.init();
    const kcs = this.requireKCStorage();
    const rootHex: string = await kcs.getLatestCiphertextChunksRoot(kcId);
    return ethers.getBytes(rootHex);
  }

  async getCiphertextChunkCount(kcId: bigint): Promise<number> {
    await this.init();
    const kcs = this.requireKCStorage();
    const count: bigint = BigInt(await kcs.getCiphertextChunkCount(kcId));
    return Number(count);
  }

  async getLatestMerkleRootPublisher(kcId: bigint): Promise<string> {
    await this.init();
    const kcs = this.requireKCStorage();
    const publisher: string = await kcs.getLatestMerkleRootPublisher(kcId);
    return publisher;
  }

  async getLatestMerkleRootAuthor(kcId: bigint): Promise<string> {
    await this.init();
    const kcs = this.requireKCStorage();
    const author: string = await kcs.getLatestMerkleRootAuthor(kcId);
    return author;
  }

  async getKCContextGraphId(kcId: bigint): Promise<bigint> {
    await this.init();
    const cgs = this.requireContextGraphStorage();
    const cgId: bigint = await cgs.kcToContextGraph(kcId);
    return BigInt(cgId);
  }

  /**
   * OT-RFC-38 / LU-5: chain-backed access-policy oracle for cores.
   * `ContextGraphStorage.getAccessPolicy` returns the uint8 enum
   * (`0`=public, `1`=curated). Unregistered ids return `0` (Solidity
   * default-zero mapping); callers should treat that as "public /
   * unknown" — for the encrypted-payload guard, `0` MUST NOT be
   * interpreted as a positive curation signal.
   */
  async getContextGraphAccessPolicy(contextGraphId: bigint): Promise<number> {
    await this.init();
    const cgs = this.requireContextGraphStorage();
    const raw: bigint = BigInt(await cgs.getAccessPolicy(contextGraphId));
    return Number(raw);
  }

  /**
   * OT-RFC-38 / LU-6 Phase B — chain-backed participant-agent
   * allowlist read. Mirrors {@link getContextGraphAccessPolicy}
   * (single eth_call, used as the authoritative oracle when the
   * local store has no answer).
   *
   * `ContextGraphStorage.getParticipantAgents` returns the address
   * array as registered at create time. Empty array for unregistered
   * ids or CGs that genuinely have no agents (the Solidity getter
   * just returns the stored mapping; absent ids return zero-length).
   * Addresses are returned in EIP-55 checksum form to keep callers
   * consistent with the local-store accessor.
   */
  async getContextGraphParticipantAgents(contextGraphId: bigint): Promise<string[]> {
    await this.init();
    const cgs = this.requireContextGraphStorage();
    const raw: string[] = await cgs.getParticipantAgents(contextGraphId);
    return raw.map((addr: string) => ethers.getAddress(addr));
  }

  /**
   * OT-RFC-38 / LU-6 Phase B — read the curator-committed wire id
   * from `ContextGraphStorage.getNameHash(uint256)`. Returns `null`
   * for unregistered ids OR for the opt-out path (curator passed
   * `bytes32(0)` at create time); callers fall back to the discovery
   * beacon in that case.
   */
  async getContextGraphNameHash(contextGraphId: bigint): Promise<string | null> {
    await this.init();
    const cgs = this.requireContextGraphStorage();
    try {
      const raw: string = await cgs.getNameHash(contextGraphId);
      if (!raw || raw === ethers.ZeroHash) return null;
      return raw.toLowerCase();
    } catch (err) {
      // Fail-closed: an RPC hiccup shouldn't leak as a positive id.
      // Caller treats `null` as "no chain-anchored hash" and falls
      // back to the beacon path or rejects.
      return null;
    }
  }
}
