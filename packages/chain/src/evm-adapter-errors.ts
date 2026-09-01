// SPDX-License-Identifier: Apache-2.0

/**
 * EVM error decoding / classification helpers extracted from
 * evm-adapter.ts. Covers low-level error-shape extraction
 * (`errorMessage` / `errorName` / `errorCode` / `errorStatus`), custom-error ABI
 * decoding (`decodeEvmError` / `enrichEvmError` and the lazily-cached
 * error/PCA interfaces), the Hub-stale revert markers, and the
 * `TooLowAllowance` classifier. Bodies are a 1:1 move from the original
 * module.
 */
import { ethers, Interface } from 'ethers';
import {
  NO_FUNDED_PUBLISHER_WALLET_CODE,
  NO_FUNDED_PUBLISHER_WALLET_MESSAGE_PREFIX,
  messageIndicatesNoFundedPublisherWallet,
} from '@origintrail-official/dkg-core';
import { loadAbi } from './evm-adapter-abi.js';

export const PCA_COVERAGE_UNSUPPORTED_CODE = 'PCA_COVERAGE_UNSUPPORTED' as const;
export const CONTEXT_GRAPH_FACADE_VERSION_UNKNOWN_CODE =
  'CONTEXT_GRAPH_FACADE_VERSION_UNKNOWN' as const;
export const CONTEXT_GRAPH_REGISTRATION_SIGNER_UNAVAILABLE_CODE =
  'CONTEXT_GRAPH_REGISTRATION_SIGNER_UNAVAILABLE' as const;
export const CONTEXT_GRAPH_REGISTRATION_COVERAGE_SIGNER_UNAVAILABLE_CODE =
  'CONTEXT_GRAPH_REGISTRATION_COVERAGE_SIGNER_UNAVAILABLE' as const;
export const STALE_HUB_BINDING_CODE = 'STALE_HUB_BINDING' as const;

/**
 * An explicit, decoupled PCA coverage request cannot be represented by the
 * deployed ContextGraphs facade. Explicit intent must never silently become a
 * paid legacy registration.
 */
export class PcaCoverageUnsupportedError extends Error {
  readonly code = PCA_COVERAGE_UNSUPPORTED_CODE;
  readonly facadeVersion: string;

  constructor(facadeVersion: string) {
    super(
      `Explicit PCA registration coverage requires ContextGraphs 10.0.5 or newer; ` +
      `the deployed facade reports ${facadeVersion}.`,
    );
    this.name = 'PcaCoverageUnsupportedError';
    this.facadeVersion = facadeVersion;
  }
}

/** A facade version could not be classified safely; retry after deployment/RPC recovery. */
export class ContextGraphFacadeVersionUnknownError extends Error {
  readonly code = CONTEXT_GRAPH_FACADE_VERSION_UNKNOWN_CODE;
  readonly retryable = true;

  constructor(options?: { cause?: unknown }) {
    super(
      'Unable to determine the deployed ContextGraphs facade capability; retry after the RPC or deployment state stabilizes.',
      options,
    );
    this.name = 'ContextGraphFacadeVersionUnknownError';
  }
}

/** The signer sealed into a prepared capability is no longer in the adapter pool. */
export class ContextGraphRegistrationSignerUnavailableError extends Error {
  readonly code = CONTEXT_GRAPH_REGISTRATION_SIGNER_UNAVAILABLE_CODE;
  readonly signerAddress: string;

  constructor(signerAddress: string) {
    super(
      `Prepared context-graph registration signer ${signerAddress} is no longer available in the EVM signer pool.`,
    );
    this.name = 'ContextGraphRegistrationSignerUnavailableError';
    this.signerAddress = signerAddress;
  }
}

/** No configured signer can exercise one explicitly requested PCA account. */
export class ContextGraphRegistrationCoverageSignerUnavailableError extends Error {
  readonly code = CONTEXT_GRAPH_REGISTRATION_COVERAGE_SIGNER_UNAVAILABLE_CODE;
  readonly accountId: bigint;

  constructor(accountId: bigint, options?: { cause?: unknown }) {
    super(
      `No configured EVM signer could be verified as the owner or exact registered agent ` +
      `of explicit PCA account ${accountId}.`,
      options,
    );
    this.name = 'ContextGraphRegistrationCoverageSignerUnavailableError';
    this.accountId = accountId;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try { return JSON.stringify(err); } catch { return String(err); }
}

/**
 * Read the top-level error class name exposed by Error / DOMException shapes.
 * Unlike status and code extraction, this deliberately does not traverse
 * wrappers: a name describes the caught surface error, while nested transport
 * metadata is decoded separately by {@link errorCode} / {@link errorStatus}.
 */
export function errorName(err: unknown): string {
  if (!err || typeof err !== 'object') return '';
  const { name } = err as { name?: unknown };
  return typeof name === 'string' ? name : '';
}

export function errorCode(err: unknown): string {
  return String((err as any)?.code ?? (err as any)?.error?.code ?? '').toUpperCase();
}

export function errorStatus(err: unknown): number | undefined {
  // Walk the nested wrapper chains ethers v6 / managed RPCs actually populate, so
  // a provider HTTP status buried at e.g. `err.cause.info.error.status` is still
  // found (a shallow one-level read misses it and the caller would misclassify a
  // 401/403/429 as a non-status error). Depth- and cycle-bounded.
  const seen = new Set<unknown>();
  const visit = (e: any, depth: number): number | undefined => {
    if (e == null || typeof e !== 'object' || depth > 5 || seen.has(e)) return undefined;
    seen.add(e);
    for (const raw of [e.status, e.statusCode, e.response?.status, e.error?.status, e.error?.statusCode]) {
      // Numeric, OR a digit-only string ("429"/"401") — several wrapped RPC/fetch
      // errors serialize the HTTP status as a string, so coerce those too rather
      // than missing them and falling back to message heuristics.
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
      if (typeof raw === 'string' && /^\d{3}$/.test(raw.trim())) return Number(raw);
    }
    for (const k of ['cause', 'info', 'error']) {
      const found = visit(e[k], depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return visit(err, 0);
}

export const ERROR_ABI_CONTRACTS = [
  'KnowledgeAssets', 'KnowledgeAssetsLifecycle', 'KnowledgeAssetsStorage',
  'DKGKnowledgeAssets', 'ContextGraphs', 'ContextGraphStorage',
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

/**
 * Substrings we treat as "the Hub no longer recognises this contract
 * as a registered participant" — i.e. the cached address is stale and
 * the next call should re-resolve from the Hub. Conservative match on
 * the canonical revert wording from `ContractStatus.onlyContracts` /
 * `UnauthorizedAccess(Only Contracts in Hub)` so we don't accidentally
 * drop the cache on an unrelated authorization failure.
 */
export const HUB_STALE_ERROR_MARKERS = [
  'Only Contracts in Hub',
  'UnauthorizedAccess(Only Contracts in Hub)',
];

/** Local proof that a cached boot-bound contract no longer matches Hub. */
export class StaleHubBindingError extends Error {
  readonly code = STALE_HUB_BINDING_CODE;
  readonly contractName: string;
  readonly boundAddress?: string;

  constructor(contractName: string, boundAddress?: string) {
    super(
      `Cached ${contractName} binding${boundAddress ? ` ${boundAddress}` : ''} is stale relative to Hub.`,
    );
    this.name = 'StaleHubBindingError';
    this.contractName = contractName;
    this.boundAddress = boundAddress;
  }
}

/** Shared classifier for provider-reported Hub authorization and local coherence failures. */
export function isHubStaleError(err: unknown): boolean {
  if (err instanceof StaleHubBindingError) return true;
  const message = err instanceof Error ? err.message : '';
  return HUB_STALE_ERROR_MARKERS.some((marker) => message.includes(marker));
}

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
export function getPcaLogicInterface(): Interface {
  if (_pcaLogicInterface) return _pcaLogicInterface;
  _pcaLogicInterface = new Interface(loadAbi('PublishingConviction') as any[]);
  return _pcaLogicInterface;
}

export function getErrorInterface(): Interface {
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

export type DecodedEvmError = {
  name: string;
  args: ethers.Result;
  signature?: string;
  selector?: string;
};

/**
 * Decode an EVM custom error selector into a human-readable string.
 * Returns null if the selector doesn't match any known contract error.
 */
export function decodeEvmError(data: string | Uint8Array): DecodedEvmError | null {
  try {
    const hex = typeof data === 'string' ? data : ethers.hexlify(data);
    if (hex.length < 10) return null;
    const parsed = getErrorInterface().parseError(hex);
    return parsed
      ? {
          name: parsed.name,
          args: parsed.args,
          signature: parsed.signature,
          selector: parsed.selector,
        }
      : null;
  } catch {
    return null;
  }
}

type EvmErrorLike = {
  data?: unknown;
  errorData?: unknown;
  message?: unknown;
  revert?: unknown;
  [key: string]: unknown;
};

type RawRevertData = string | Uint8Array;

const RAW_REVERT_DATA_WRAPPER_KEYS = [
  'error',
  'cause',
  'info',
  'data',
  'originalError',
] as const;

function isRawRevertData(raw: unknown): raw is RawRevertData {
  if (raw instanceof Uint8Array) return true;
  return typeof raw === 'string' && /^0x[0-9a-fA-F]+$/.test(raw);
}

function rawRevertDataFromDirectFields(err: EvmErrorLike): RawRevertData[] {
  const candidates: RawRevertData[] = [];
  for (const raw of [err.data, err.errorData]) {
    if (isRawRevertData(raw)) candidates.push(raw);
  }
  return candidates;
}

function rawRevertDataFromMessage(message: string): string | null {
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
  const match = message.match(
    /(?:^|[^a-zA-Z])(?:errorData|data)["':=\s]+(0x[0-9a-fA-F]+)/,
  );
  return match?.[1] ?? null;
}

function rawRevertDataFromWrapperFields(err: EvmErrorLike): RawRevertData[] {
  const candidates: RawRevertData[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 5) return;
    seen.add(value);
    const e = value as EvmErrorLike;
    candidates.push(...rawRevertDataFromDirectFields(e));
    if (typeof e.message === 'string') {
      const messageData = rawRevertDataFromMessage(e.message);
      if (messageData) candidates.push(messageData);
    }
    for (const key of RAW_REVERT_DATA_WRAPPER_KEYS) {
      visit(e[key], depth + 1);
    }
  };
  for (const key of RAW_REVERT_DATA_WRAPPER_KEYS) {
    visit(err[key], 1);
  }
  return candidates;
}

/**
 * Enrich a caught EVM error with a decoded custom error name.
 * Modifies the error message in-place and returns the decoded name (if any).
 */
export function enrichEvmError(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as EvmErrorLike;
  const message = typeof e.message === 'string' ? e.message : '';
  const messageData = rawRevertDataFromMessage(message);
  const candidates = [
    ...rawRevertDataFromDirectFields(e),
    ...rawRevertDataFromWrapperFields(e),
    ...(messageData ? [messageData] : []),
  ];
  let decoded: ReturnType<typeof decodeEvmError> = null;
  for (const data of candidates) {
    decoded = decodeEvmError(data);
    if (decoded) break;
  }
  if (!decoded) return null;
  const argsStr = decoded.args.length > 0 ? `(${decoded.args.join(', ')})` : '';
  const decodedStr = `${decoded.name}${argsStr}`;
  if (typeof e.message === 'string') {
    e.message = e.message.replace('unknown custom error', decodedStr);
  }
  e.revert = {
    name: decoded.name,
    signature: decoded.signature,
    selector: decoded.selector,
    args: decoded.args,
  };
  return decoded.name;
}

/**
 * #888 — true iff `err` is the V10 publish `TooLowAllowance(TRAC, ...)`
 * custom-error revert.
 *
 * The on-chain allowance read that gates the auto-approve and the
 * `estimateGas` that ethers runs while populating the publish tx can
 * observe a *stale* allowance on an internally load-balanced RPC: a
 * just-consumed per-publish `1`-wei floor still reads as `1` (so the
 * re-approve is skipped), or a freshly-sent approve has not yet
 * propagated to the read replica. Either way the contract reverts
 * `TooLowAllowance` during gas estimation — strictly BEFORE broadcast —
 * and the publisher can recover by forcing a fresh approve and retrying.
 *
 * Matches ethers v6's decoded custom-error shape (`err.revert.name`) and
 * falls back to string matching on the message / shortMessage / reason /
 * nested cause so a stringified or re-wrapped revert is still caught.
 */
export function isTooLowAllowanceError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    revert?: { name?: unknown };
    message?: unknown;
    shortMessage?: unknown;
    reason?: unknown;
    cause?: unknown;
  };
  if (typeof e.revert?.name === 'string' && e.revert.name === 'TooLowAllowance') {
    return true;
  }
  const causeMessage =
    e.cause && typeof e.cause === 'object'
      ? (e.cause as { message?: unknown }).message
      : undefined;
  const haystack = [e.message, e.shortMessage, e.reason, causeMessage]
    .filter((s): s is string => typeof s === 'string')
    .join(' ');
  return /TooLowAllowance/i.test(haystack);
}

/**
 * True iff `err` is an ethers/RPC NATIVE-gas insufficient-funds error
 * (`code: 'INSUFFICIENT_FUNDS'` or an `insufficient funds for gas * price + value`
 * message). A TRAC-balance shortfall is NOT this — it surfaces as a generic
 * contract revert (`transferFrom`), so callers confirm a TRAC shortfall with a
 * balance read rather than this classifier.
 */
export function isInsufficientFundsError(err: unknown): boolean {
  if (errorCode(err) === 'INSUFFICIENT_FUNDS') return true;
  return /insufficient funds/i.test(errorMessage(err));
}

/** Machine-readable code carried by {@link InsufficientPublisherFundsError}.
 *  Defined in dkg-core (UI-safe shared package) and re-exported here so chain
 *  consumers can keep importing it from dkg-chain. */
export { NO_FUNDED_PUBLISHER_WALLET_CODE };

/** Per-operational-wallet balance snapshot for the no-funded-wallet diagnostic. */
export interface PublisherWalletBalance {
  address: string;
  /** Native gas balance (wei), or `null` when it could not be read. */
  nativeWei: bigint | null;
  /** TRAC balance (wei), or `null` when it could not be read / no token contract. */
  tracWei: bigint | null;
}

/**
 * Thrown when a publish cannot proceed because no operational wallet holds the
 * funds (native gas AND TRAC) a publish requires. Carries a stable `code` and
 * the per-wallet balances so the daemon route / node-ui can surface an
 * actionable "fund a wallet and retry" message instead of the raw ethers
 * "insufficient funds" string the user sees today.
 */
export class InsufficientPublisherFundsError extends Error {
  readonly code = NO_FUNDED_PUBLISHER_WALLET_CODE;
  readonly balances: PublisherWalletBalance[];
  constructor(message: string, balances: PublisherWalletBalance[], options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InsufficientPublisherFundsError';
    this.balances = balances;
  }
}

/**
 * True iff `err` is the no-funded-publisher-wallet failure — code-first, with a
 * message-marker fallback for a wrapper that dropped `.code`. Uses the same
 * shared dkg-core contract (`messageIndicatesNoFundedPublisherWallet`) as the
 * daemon-side predicate, so the chain and daemon classifiers agree on semantics.
 */
export function isNoFundedPublisherWalletError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null | undefined;
  return e?.code === NO_FUNDED_PUBLISHER_WALLET_CODE
    || messageIndicatesNoFundedPublisherWallet(e?.message);
}

function formatWeiOrUnknown(wei: bigint | null): string {
  return wei === null ? 'unknown' : ethers.formatEther(wei);
}

/** Build the actionable, user-facing no-funded-wallet publish error message. */
export function formatNoFundedPublisherWalletMessage(balances: PublisherWalletBalance[]): string {
  const lines = balances
    .map((b) => `  ${b.address}: ${formatWeiOrUnknown(b.tracWei)} TRAC, ${formatWeiOrUnknown(b.nativeWei)} gas`)
    .join('\n');
  return (
    `${NO_FUNDED_PUBLISHER_WALLET_MESSAGE_PREFIX} to publish to Verifiable Memory — ` +
    'each publish needs native gas AND TRAC on the same wallet. ' +
    'Operational wallet balances:\n' + lines + '\n' +
    'Fund one of these wallets (run `dkg wallets` to list addresses) and retry the publish.'
  );
}
