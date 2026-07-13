// SPDX-License-Identifier: Apache-2.0

/**
 * Shared base class for the EVMChainAdapter mixin split. Holds ALL instance
 * state (providers, signers, caches, config), the constructor, low-level
 * transaction / Hub-resolution plumbing, and helpers used by more than one
 * domain group. Per-domain method groups live in sibling `evm-adapter-*.ts`
 * holder classes that `extends EVMChainAdapterBase` and are mixed into the
 * concrete `EVMChainAdapter` in evm-adapter.ts. Members formerly `private`
 * are widened to `protected` so holder methods can reach them via `this`;
 * the external public API is unchanged.
 */

import { JsonRpcProvider, Wallet, Contract, ethers } from 'ethers';
import { createFilterErrorSilencer, installFilterNotFoundConsoleSuppressor, formatProviderError } from './filter-error-silencer.js';
import type { FilterErrorSilencer } from './filter-error-silencer.js';
import { DEFAULT_APPROVAL_POLICY, buildEvmDeploymentId } from './chain-adapter.js';
import type {
  ApprovalPolicy,
  V10PublishParams,
  OnChainPublishResult,
  PublisherPublishPlan,
  PublisherPublishPlanRequest,
} from './chain-adapter.js';
import {
  resolvePublisherCandidatePricing,
  type PublisherConvictionPlanReader,
} from './publisher-plan.js';
import { HubResolutionCache } from './hub-resolution-cache.js';
import { KeyedSerializer } from './keyed-mutex.js';
import { floorPublishTokenAmount, withSpan, getMetrics } from '@origintrail-official/dkg-core';
import { loadAbi } from './evm-adapter-abi.js';
import { errorCode, errorMessage, errorStatus, isTooLowAllowanceError, enrichEvmError, getPcaLogicInterface, HUB_STALE_ERROR_MARKERS, isInsufficientFundsError, InsufficientPublisherFundsError, formatNoFundedPublisherWalletMessage, type PublisherWalletBalance } from './evm-adapter-errors.js';
import { resolveRpcUrls, boundedRetryFetchRequest, withTimeout, isRetryableRpcError, assertSuccessfulReceipt, sleep } from './evm-adapter-rpc.js';
import { rpcHost } from './rpc-failover-log.js';
import { ChainRpcTransportError, createRpcTimeoutError } from './chain-rpc-transport-error.js';
import { RpcFailoverClient, type ReadOpts } from './rpc-failover-client.js';
import { RpcUsageTracker, createCountingJsonRpcProvider, type RpcUsageWindow } from './rpc-usage.js';
import { computeApprovalAction, effectivePublishAllowance, V10_PUBLISH_ONCHAIN_MIN_ALLOWANCE } from './evm-adapter-allowance.js';
import { formatProviderContext } from './evm-adapter-types.js';
import { ReadThroughTtlCache } from './keyed-ttl-single-flight-cache.js';
import { PcaReadCache } from './pca-read-cache.js';
import { HubRotationPoller } from './hub-rotation-poller.js';
import { ContextGraphRegistryScanCursor } from './context-graph-registry-scan-cursor.js';
import type { ContractCache, EVMAdapterConfig } from './evm-adapter-types.js';
import { RPC_READ_STALL_TIMEOUT_MS, DEFAULT_RANDOM_SAMPLING_HUB_REFRESH_MS, RPC_RECEIPT_TIMEOUT_MS, RPC_RECEIPT_POLL_INTERVAL_MS, RPC_ENDPOINT_SET_RETRIES, RPC_ENDPOINT_SET_RETRY_BACKOFF_MS, ADMIN_KEY_PURPOSE, OPERATIONAL_KEY_PURPOSE, PUBLISHER_FUNDING_CACHE_TTL_MS } from './evm-adapter-constants.js';

type ContractWriteSender = (
  contract: Contract,
  method: string,
  args: readonly unknown[],
  signer: Wallet,
  label: string,
  opts?: { gasLimitBufferBps?: number },
) => Promise<ethers.TransactionReceipt>;

type SerializedSignerWriteContext = {
  sendContractTransaction: ContractWriteSender;
};

/**
 * Maps a Hub-registered contract name to its local binding invalidation policy.
 *
 * Used by:
 *   1. `startHubRotationListener` — when the Hub rotation poller sees
 *      `name`, it checks this allowlist, marks the adapter uninitialised,
 *      and leaves the existing handle intact so in-flight calls that already
 *      passed `init()` don't observe a transient `undefined`.
 *   2. `invalidateAllBoundContracts` — bulk drop, called by the
 *      write-side self-heal path (`withHubStaleRetry`) when a stale
 *      address surfaces `UnauthorizedAccess(Only Contracts in Hub)`.
 *
 * `RandomSampling` / `RandomSamplingStorage` are intentionally absent —
 * they go through `randomSamplingPairCache` + `invalidateRandomSamplingPair()`
 * which owns side-channel state (in-flight probe, ready flag) that
 * a simple field reset wouldn't touch.
 *
 * Boot-bound names listed here MUST match contracts that `init()` resolves via
 * `Hub.getContractAddress(name)` / `Hub.getAssetStorageAddress(name)`. Lazy
 * names listed here MUST match helpers such as `getIdentityStorage()`.
 */
type ResettableContractCacheKey = {
  [K in keyof ContractCache]: undefined extends ContractCache[K] ? K : never
}[keyof ContractCache];

type HubContractCacheKey = Exclude<ResettableContractCacheKey, undefined>;

type HubBindingInvalidationPolicy =
  | { contractKey: HubContractCacheKey; invalidateOnRotation?: false }
  | { special: 'identityStorage'; invalidateOnRotation: true };

const HUB_BINDING_INVALIDATOR_ENTRIES = [
  ['Identity',                   { contractKey: 'identity' }],
  ['IdentityStorage',            { special: 'identityStorage', invalidateOnRotation: true }],
  ['Profile',                    { contractKey: 'profile' }],
  ['ProfileStorage',             { contractKey: 'profileStorage' }],
  ['ParametersStorage',          { contractKey: 'parametersStorage' }],
  ['Staking',                    { contractKey: 'staking' }],
  ['Token',                      { contractKey: 'token' }],
  ['AskStorage',                 { contractKey: 'askStorage' }],
  ['KnowledgeAssets',            { contractKey: 'knowledgeAssets' }],
  ['KnowledgeAssetsStorage',     { contractKey: 'knowledgeAssetsStorage' }],
  ['KnowledgeAssetsLifecycle',   { contractKey: 'knowledgeAssetsLifecycle' }],
  ['DKGKnowledgeAssets',         { contractKey: 'knowledgeAssetStorage' }],
  ['ContextGraphNameRegistry',   { contractKey: 'contextGraphNameRegistry' }],
  ['ContextGraphs',              { contractKey: 'contextGraphs' }],
  ['ContextGraphStorage',        { contractKey: 'contextGraphStorage' }],
  ['DKGPublishingConvictionNFT', { contractKey: 'dkgPublishingConvictionNFT' }],
  ['Chronos',                    { contractKey: 'chronos' }],
] as const satisfies ReadonlyArray<readonly [string, HubBindingInvalidationPolicy]>;

const HUB_BINDING_INVALIDATORS = new Map<string, HubBindingInvalidationPolicy>(
  HUB_BINDING_INVALIDATOR_ENTRIES,
);

/**
 * Contract names deliberately EXCLUDED from the `resolvedContractAddressCache`
 * address memo (#1583 — the 100-KA publish-burst RPC read amplifier that funnels
 * ~150-250 redundant `Hub.getContractAddress` eth_calls through the chain RPC).
 * The memo caches a resolved proxy address to skip that read, but two families
 * MUST always resolve fresh:
 *
 *   - `RandomSampling` / `RandomSamplingStorage` — already owned by
 *     `randomSamplingPairCache`, which uses a deliberately SHORTER TTL
 *     (`randomSamplingHubRefreshMs`) as a missed-rotation backstop for the
 *     read-only prover paths plus its own `invalidateRandomSamplingPair()`
 *     lifecycle. Its loader calls `resolveContract`, so memoizing these addresses
 *     in the 1h memo would shadow that shorter backstop (and is redundant with
 *     the pair cache).
 *
 *   - `PublishingConviction` / `ShardingTable` / `DKGStakingConvictionNFT` — these
 *     three are resolved per-call (not lazy-bound) on COLD paths only: the PCA UI
 *     `version()`/`clearAgentsSupported` gate (evm-adapter-conviction.ts:610), the
 *     `listDesignatableNodes` logic read (itself behind a 30s cache), and the
 *     one-shot conviction-NFT provisioning write (evm-adapter-identity.ts:350).
 *     They are NOT excluded for a correctness reason — the round-2 unconditional
 *     rotation flush (`applyHubRotationEventName`) would self-heal them on an
 *     observed rotation exactly like the memoized names — but because memoizing a
 *     cold path saves ~nothing, keeping them fresh-every-call is a zero-cost strict
 *     non-regression (identical to pre-#1583). Excluding them also keeps this list
 *     as documentation of "which names the memo intentionally skips."
 *
 * NOTE on the two ACK-verify-floor contracts, `IdentityStorage` and
 * `ShardingTableStorage`, which ARE memoized (not excluded): both are on the
 * per-ACK hot path (`verifyACKIdentityDetailed` resolves both on every ACK, so a
 * 100-KA burst re-resolved each ~once per ACK ≈ hundreds of redundant Hub reads),
 * and both are security-sensitive only in their RESULTS — `keyHasPurpose` (key
 * revoked) and `nodeExists` (node left the table), which are NEVER cached and so
 * stay live within a single ACK regardless of this memo. The only thing memoized
 * is the proxy ADDRESS, which changes only on a Hub re-registration of the
 * contract itself (a rare, coordinated migration — NOT a key revocation or a
 * table exit). Any OBSERVED such rotation of EITHER flushes the whole memo
 * immediately: `applyHubRotationEventName` calls `resolvedContractAddressCache`
 * `.invalidateAll()` unconditionally on every Hub rotation event (round-2 fix —
 * this is what covers ShardingTableStorage, which has no lazy binding and so no
 * `HUB_BINDING_INVALIDATORS` entry). The only residual — a poller-MISSED contract
 * rotation of either — is bounded to `RESOLVE_CONTRACT_ADDRESS_MEMO_TTL_MS` (30s,
 * the staleness the codebase already accepts for the sibling `listDesignatableNodes`
 * read), across a compound edge (rare contract rotation × rare poller miss × ≤30s).
 * Memoizing these two is a deliberate reversal of the first cut's ShardingTableStorage
 * exclusion (review of PR #1615): excluding it while memoizing its ACK-path twin
 * IdentityStorage was inconsistent and left ~half of ACK-verify address
 * amplification uncut.
 */
const RESOLVE_CONTRACT_ADDRESS_MEMO_EXCLUDED = new Set<string>([
  'RandomSampling',
  'RandomSamplingStorage',
  'PublishingConviction',
  'ShardingTable',
  'DKGStakingConvictionNFT',
]);

/**
 * TTL for the `resolvedContractAddressCache` address memo. Deliberately SHORT
 * (30s) rather than the 1h `PREFLIGHT_TTL_MS` (review of PR #1615): it matches
 * the staleness the codebase ALREADY accepts for the same class of read — the
 * `listDesignatableNodes` sharding-table cache is 30s (evm-adapter-conviction.ts)
 * — and it bounds the only residual risk of memoizing a contract address (a Hub
 * contract-rotation the event poller MISSES → a memoized-stale address, e.g.
 * IdentityStorage behind ACK `keyHasPurpose`) to ≤30s instead of ≤1h, while a
 * publish burst (seconds–minutes) still resolves each contract from ~1 read
 * instead of ~150. Observed rotations still invalidate immediately via the
 * unconditional flush in `applyHubRotationEventName`; contract rotation is itself
 * a rare coordinated migration event.
 *
 * Exported (not a class member) so the memo unit test can couple its TTL-backstop
 * assertion to the production value without widening the adapter's protected
 * surface — the same idiom already used for `decodeConvictionCostCovered` and the
 * `CG_REGISTRY_*` consts. (Review of PR #1615, round-2.)
 */
export const RESOLVE_CONTRACT_ADDRESS_MEMO_TTL_MS = 30_000;

const KA_HIGH_WATER_VIEW_SIGNATURE = 'getMaxKaNumberForAuthor(address)';

type IdentityIdCacheEntry = {
  identityId: bigint;
  ttlMs: number;
};

class IdentityIdCache {
  private readonly values = new ReadThroughTtlCache<string, IdentityIdCacheEntry>({
    ttlMs: (entry) => entry.ttlMs,
  });

  constructor(
    private readonly signerCacheKey: string,
    private readonly positiveTtlMs: number,
    private readonly signerZeroTtlMs: number,
  ) {}

  async getOrLoad(
    address: string,
    load: (checksumAddress: string) => Promise<bigint>,
  ): Promise<bigint> {
    if (!ethers.isAddress(address)) return 0n;
    const checksum = ethers.getAddress(address);
    const cacheKey = checksum.toLowerCase();
    const entry = await this.values.getOrLoad(cacheKey, cacheKey, async () => {
      const identityId = await load(checksum);
      return this.entry(cacheKey, identityId);
    });
    return entry.identityId;
  }

  seed(address: string, identityId: bigint): void {
    const cacheKey = ethers.getAddress(address).toLowerCase();
    this.values.seed(cacheKey, this.entry(cacheKey, identityId));
  }

  invalidate(address: string): void {
    const cacheKey = ethers.getAddress(address).toLowerCase();
    this.values.invalidate(cacheKey);
  }

  invalidateAll(): void {
    this.values.invalidateAll();
  }

  private entry(cacheKey: string, identityId: bigint): IdentityIdCacheEntry {
    const ttlMs = identityId > 0n
      ? this.positiveTtlMs
      : cacheKey === this.signerCacheKey
        ? this.signerZeroTtlMs
        : 0;
    return { identityId, ttlMs };
  }
}

/**
 * Upper bound on the pre-10.0.4 KnowledgeAssetCreated fallback scan, in
 * 2,000-block eth_getLogs pages. The scan is anchored at the contract's deploy
 * block (not genesis) and runs ONCE per author per node lifetime (cached), so a
 * few hundred pages is fine; this cap only trips for a genuinely old pre-10.0.4
 * deployment on a small-range-cap RPC, where we fail loud with guidance instead
 * of silently issuing thousands of sequential calls. At the default 2,000-block
 * window the budget covers ~3M blocks of contract lifetime; an older pre-10.0.4
 * deployment is refused with actionable guidance — the dominant cost lever is
 * the deploy-block anchor (an archive RPC), and the canonical fix is deploying
 * DKGKnowledgeAssets >= 10.0.4 (which removes the scan via the O(1) view). The
 * window can be widened (adapter-level `kaHighWaterScanPageSize`) on an RPC that
 * serves larger eth_getLogs ranges.
 */
const KA_HIGH_WATER_MAX_SCAN_PAGES = 1_500;

/** Default pre-10.0.4 fallback eth_getLogs window — the smallest common cap. */
const KA_HIGH_WATER_DEFAULT_PAGE_SIZE = 2_000;

const CG_REGISTRY_DEFAULT_PAGE_SIZE = 2_000;

const CG_REGISTRY_LEGACY_PAGE_SIZE = 9_000;
const CG_REGISTRY_LEGACY_MAX_SCAN_PAGES = 1_500;

/**
 * Preserve the old default registry scan span while using smaller RPC-safe
 * pages. Larger configured page windows extend the block span at the same call
 * budget.
 */
export const CG_REGISTRY_MAX_SCAN_PAGES = Math.ceil(
  (CG_REGISTRY_LEGACY_PAGE_SIZE * CG_REGISTRY_LEGACY_MAX_SCAN_PAGES) /
  CG_REGISTRY_DEFAULT_PAGE_SIZE,
);

export const CG_REGISTRY_REORG_BUFFER_BLOCKS = 50;

// Keep generic Hub binding invalidation responsive for read paths while still
// replacing four hidden ethers subscription pollers with one owned log poller.
const HUB_ROTATION_POLL_INTERVAL_MS = 30 * 1000;
const HUB_ROTATION_REORG_BUFFER_BLOCKS = 50;

/**
 * Per-backend timeout for a single KnowledgeAssetCreated scan page before
 * failing over to the next eligible backend — generous enough for a slow
 * archive getLogs, short enough that a hung backend can't add its stall to every
 * page (the sticky preferred-backend ordering then keeps the hung one out of the
 * front of the line for subsequent pages).
 */
const KA_HIGH_WATER_PAGE_TIMEOUT_MS = 15_000;

type ScanProvider = { provider: JsonRpcProvider; backendHead: number };

/**
 * B8 — decode the `CostCovered` event from a publish receipt's logs via the
 * PublishingConviction LOGIC ABI (the event is emitted by the logic contract, a
 * different address than KA storage, so the KA-storage receipt loop skips it).
 * Returns the discount detail (cost fields bigint → decimal strings via the
 * daemon's JSON replacer; `epoch` a number) when a publish drew on a Publishing
 * Conviction Account, else `undefined`. `coverPublishingCost` runs once per
 * publish tx, so a (batch) publish emits ONE CostCovered covering the batch's
 * total draw — this returns that single event (the "discount applied" badge is
 * tx-level; a precise per-KA breakdown would be a future enhancement). Exported
 * for unit testing.
 */
export function decodeConvictionCostCovered(
  logs: ReadonlyArray<{ topics: ReadonlyArray<string>; data: string }>,
): OnChainPublishResult['convictionCostCovered'] {
  const pcaLogic = getPcaLogicInterface();
  for (const log of logs) {
    try {
      const parsed = pcaLogic.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === 'CostCovered') {
        return {
          accountId: BigInt(parsed.args.accountId),
          epoch: Number(parsed.args.epoch),
          baseCost: BigInt(parsed.args.baseCost),
          discountedCost: BigInt(parsed.args.discountedCost),
          drawnFromEpoch: BigInt(parsed.args.drawnFromEpoch),
          drawnFromTopUp: BigInt(parsed.args.drawnFromTopUp),
        };
      }
    } catch { /* not a PublishingConviction event */ }
  }
  return undefined;
}

function normalizeScanPageSize(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

function configuredStaticChainId(config: Pick<EVMAdapterConfig, 'chainId' | 'staticNetwork'>): bigint | undefined {
  if (config.staticNetwork === false) return undefined;
  const { chainId } = config;
  if (!chainId) return undefined;
  const tail = chainId.includes(':') ? chainId.split(':').pop() : chainId;
  if (!tail || !/^[0-9]+$/.test(tail)) {
    return undefined;
  }
  try {
    const numeric = BigInt(tail);
    if (numeric > 0n) return numeric;
  } catch {
    // Fall through to the uniform configuration error below.
  }
  throw new Error(
    `EVMAdapterConfig.chainId must end with a positive decimal chain id when staticNetwork is enabled (got ${chainId}); set staticNetwork: false to use dynamic detection`,
  );
}

/**
 * True for the UNAMBIGUOUS "the deployed DKGKnowledgeAssets has no
 * `getMaxKaNumberForAuthor` selector" error shapes — the cases where we can pick
 * the pre-10.0.4 log-scan fallback without any extra RPC call:
 *   - `BAD_DATA` "could not decode result data" with an EMPTY `value="0x"`
 *     payload (the provider returned nothing for the int256). A non-empty
 *     `value="0x…"` is a malformed/garbage decode and is rethrown. This
 *     classifier is only reached from the single `getMaxKaNumberForAuthor` view
 *     call, so a contract-name match in the message is not required (ethers
 *     versions vary on whether they include it).
 *   - an explicit "function selector"/"selector not recognized" message.
 *
 * The CALL_EXCEPTION / "missing revert data" shape that some RPCs (e.g. Base
 * Sepolia) return for an absent selector is AMBIGUOUS with a genuine bare
 * revert, so it is handled by `isKaHighWaterBareRevert` + a deployed-bytecode
 * selector probe (`kaHighWaterViewSelectorInCode`) — see
 * `getMaxKaNumberForAuthor`.
 */
function isKaHighWaterViewUnavailable(err: unknown): boolean {
  if (err instanceof Error) enrichEvmError(err);
  const code = errorCode(err);
  const msg = errorMessage(err).toLowerCase();

  if (code === 'BAD_DATA') {
    return msg.includes('could not decode result data')
      && msg.includes('value="0x"');
  }
  return msg.includes('function selector')
    || msg.includes('selector not recognized');
}

/**
 * True for a CALL_EXCEPTION that carries NO revert payload (ethers v6:
 * `reason=null`, `data=null`, message "missing revert data"). A deployed
 * contract that lacks the called selector and has no fallback reverts exactly
 * this way — but so does a genuine bare `revert()` from a function that DOES
 * exist — so this shape is only treated as "view absent" once
 * `kaHighWaterViewSelectorInCode` confirms the selector is genuinely missing
 * from the deployed bytecode. A revert that carries a reason/data (e.g.
 * `execution reverted: Paused`) is NOT a bare revert and is rethrown.
 */
function isKaHighWaterBareRevert(err: unknown): boolean {
  if (errorCode(err) !== 'CALL_EXCEPTION') return false;
  const e = err as { data?: unknown; reason?: unknown };
  const hasRevertPayload =
    (e.data != null && e.data !== '0x') ||
    (typeof e.reason === 'string' && e.reason.length > 0);
  if (hasRevertPayload) return false;
  return errorMessage(err).toLowerCase().includes('missing revert data');
}

/**
 * True iff the `getMaxKaNumberForAuthor(address)` selector appears as a
 * `PUSH4 <selector>` dispatcher entry in `code` (the resolved contract's
 * deployed runtime bytecode). A Solidity function dispatcher compares
 * `msg.sig` against each external selector via `PUSH4 <selector>` (opcode
 * `0x63`), so we match `63<selector>` rather than the bare 4 selector bytes —
 * a plain substring match would false-POSITIVE on the same 4 bytes appearing
 * inside an unrelated constant or the metadata blob, making a pre-10.0.4
 * contract look like it implements the view and wrongly rethrowing the
 * bare-revert path. Absence of the PUSH4 entry reliably signals the view is
 * not deployed (the pre-10.0.4 case) — for a DIRECT deployment. DKGKnowledgeAssets
 * is resolved straight from the Hub (not behind a proxy), so this probe sees the
 * real dispatcher; if it were ever proxied, the implementation's selectors would
 * not appear in the proxy bytecode (a proxying change MUST revisit this probe).
 * The selector is derived from the contract interface so it tracks the
 * signature; if it can't be derived we return false (treat as absent → fall
 * back, which is safe: the scan yields the correct high-water either way).
 */
function kaHighWaterViewSelectorInCode(storage: Contract, code: string): boolean {
  let selector: string | undefined;
  try {
    selector = storage.interface.getFunction(KA_HIGH_WATER_VIEW_SIGNATURE)?.selector;
  } catch {
    selector = undefined;
  }
  if (!selector) return false;
  // `63` = PUSH4 opcode; the 4 selector bytes must follow it to count as a real
  // dispatcher entry (not a coincidental byte run elsewhere in the bytecode).
  return code.toLowerCase().includes(`63${selector.toLowerCase().slice(2)}`);
}

/**
 * True only for errors that mean "this RPC cannot serve historical state at the
 * requested block" — a pruned/non-archive node — as opposed to a real RPC
 * outage / auth failure / timeout. The deploy-block search degrades to a
 * genesis-anchored scan ONLY for these; every other failure is rethrown so a
 * broken provider surfaces loudly instead of being masked as a pre-10.0.4
 * fallback that triggers a large log sweep. Conservative substring match over
 * the common provider phrasings (geth/erigon/nethermind/managed endpoints).
 */
/**
 * Flatten an error into a single lowercased string across the nested fields
 * ethers v6 / managed RPCs actually populate — `message`, `shortMessage`,
 * `reason`, `body`, and recursively `error` / `info` / `cause` / `data`. The
 * plain `errorMessage` reads only `.message`, so a managed-RPC denial whose text
 * lives in `err.info.error.message` / `err.body` would otherwise be invisible.
 */
function allErrorText(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const visit = (e: any, depth: number): void => {
    if (e == null || depth > 5 || seen.has(e)) return;
    if (typeof e === 'string') { parts.push(e); return; }
    if (typeof e !== 'object') return;
    seen.add(e);
    for (const k of ['message', 'shortMessage', 'reason', 'body']) {
      if (typeof e[k] === 'string') parts.push(e[k]);
    }
    for (const k of ['error', 'info', 'cause', 'data']) visit(e[k], depth + 1);
  };
  visit(err, 0);
  return parts.join(' ').toLowerCase();
}

/**
 * True when `err` is a TRANSIENT rate-limit / throttle from the RPC provider —
 * keyed on the provider HTTP status (`429`; `errorStatus` recurses nested
 * `cause`/`info`/`error` fields) plus a rate-limit / quota / compute-unit
 * vocabulary guard, since providers routinely concatenate the upstream node's
 * pruned-state text into their own throttle envelope.
 *
 * This is the ONE class the deploy-block search surfaces early instead of
 * degrading: degrading would fire getCode retries + a page-1 `eth_getLogs` that
 * only WORSEN a throttle, and it clears on its own. Everything else — a pruned
 * node, a STATIC access/plan/archive denial, a transient timeout/503, or a hard
 * 401 — falls through to the genesis scan. Crucially a "not archive / archive not
 * on your plan" denial is NOT here: `eth_getLogs` does not need archive state, so
 * the scan still computes the high-water mark on a non-archive provider, and
 * surfacing it would needlessly fail a publish that would otherwise succeed (the
 * scan surfaces a genuine TOTAL outage itself, on page 1).
 */
function isTransientThrottle(err: unknown): boolean {
  if (errorStatus(err) === 429) return true;
  const msg = allErrorText(err);
  return /\b(too many requests|rate[ -]?limit|throttl|compute units?|capacity|quota|credits?|(daily|monthly|request|compute)[^.]{0,12}\blimit|limit reached|over (the )?limit)\b/.test(msg);
}

/**
 * True ONLY when the deploy-block getCode failure is a genuine "this node does
 * not retain historical state" condition. A transient throttle is excluded FIRST
 * (see `isTransientThrottle`). Used by the head probe; the deploy-block search no
 * longer gates degrade-vs-throw on it (it degrades on everything except a
 * transient throttle, letting the genesis scan arbitrate).
 */
function isHistoricalStateUnavailable(err: unknown): boolean {
  if (isTransientThrottle(err)) return false;

  const msg = allErrorText(err);

  // Genuine "node lacks historical state" shapes → degrade to the genesis log scan.
  // NOTE: a bare `header not found` is intentionally NOT here — nodes also return
  // it while out-of-sync / restarting, so it must surface rather than mask a real
  // fault as a degrade (a "header not found" caused by pruning is accompanied by a
  // pruned/older-than/archive phrase below, which still degrades).
  return (
    msg.includes('missing trie node') ||
    msg.includes('state not available') ||
    msg.includes('state is not available') ||
    msg.includes('historical state') ||
    msg.includes('pruned') ||
    // "block is older than the latest N blocks" — the pruned-window shape, not a
    // bare "older than" (which appears in unrelated messages).
    /older than\b[^.]*\bblocks?\b/.test(msg) ||
    // "requires an archive node" / "needs archive" — anchored on requires/needs.
    /\b(requires?|needs?)\s+(an?\s+)?archive/.test(msg)
  );
}

async function contractAddress(contract: Contract): Promise<string> {
  const getAddress = (contract as any).getAddress;
  if (typeof getAddress === 'function') {
    return ethers.getAddress(await getAddress.call(contract));
  }
  const target = (contract as any).target;
  if (typeof target === 'string') {
    return ethers.getAddress(target);
  }
  throw new Error('DKGKnowledgeAssets address is unavailable from the resolved contract handle.');
}

/**
 * Per-tx-type funding requirement for operational-wallet selection. A
 * discriminated union so "native-only" (RS challenge/proof, relay, settle —
 * gas only, no TRAC transfer) is UNREPRESENTABLE-AS-TRAC-GATED: applying a
 * publish TRAC floor to a gas-only tx would wrongly reject a valid,
 * gas-funded, zero-TRAC wallet. `native+trac` (publish/update) additionally
 * requires own-TRAC to cover the publish above the operator floor, with an
 * explicit Publishing Conviction Account (PCA) policy: disabled, provisional
 * signer discovery, or an exact epoch-bearing publish plan.
 */
export type PcaFundingMode =
  | { kind: 'none' }
  /** Candidate discovery while an omitted lifetime is still signer-dependent. */
  | { kind: 'provisional-publish' }
  /** Exact publish plan: the PCA lock must equal `epochs`. */
  | { kind: 'publish'; epochs: number };

export type FundingMode =
  | { kind: 'native-only'; nativeFloorWei: bigint }
  | {
      kind: 'native+trac';
      nativeFloorWei: bigint;
      tracFloorWei: bigint;
      requiredTracWei: bigint;
      /** Explicit PCA semantics; exact publish checks cannot omit the lock. */
      pca: PcaFundingMode;
    };

export type NativeOnlyFundingMode = Extract<FundingMode, { kind: 'native-only' }>;
export type NativeAndTracFundingMode = Extract<FundingMode, { kind: 'native+trac' }>;

type PublisherCandidatePlan = PublisherPublishPlan & { signer: Wallet; address: string };

/**
 * Generalized operational-wallet selection request. The discriminant fixes the
 * eligible-wallet scope and the required funding model together, so invalid
 * combinations (for example, publish policy selection without a context graph or
 * with native-only funding) do not compile.
 *
 * - `rotatable-policy`  → publish: eligible = on-chain authorized publishers
 *                          for `contextGraphId` (whole pool when no ContextGraphs surface).
 * - `rotatable-funded`  → update: eligible = whole pool, native+TRAC funding.
 * - `rotatable-free`    → RS / relay / settle: eligible = whole pool, native-only funding.
 */
export type SelectSignerSpec =
  | {
      txClass: 'rotatable-policy';
      funding: NativeAndTracFundingMode;
      /** The CG whose authorized publishers gate publish eligibility. */
      contextGraphId: bigint;
      /** Soft, fail-open bias toward a funded wallet whose per-wallet lock is free. Default false. */
      preferIdle?: boolean;
    }
  | {
      txClass: 'rotatable-funded';
      funding: NativeAndTracFundingMode;
      contextGraphId?: never;
      /** Soft, fail-open bias toward a funded wallet whose per-wallet lock is free. Default false. */
      preferIdle?: boolean;
    }
  | {
      txClass: 'rotatable-free';
      funding: NativeOnlyFundingMode;
      contextGraphId?: never;
      /** Soft, fail-open bias toward a funded wallet whose per-wallet lock is free. Default false. */
      preferIdle?: boolean;
    };

export class EVMChainAdapterBase {
  /** See `ChainAdapter.deploymentId`. */
  get deploymentId(): string {
    return buildEvmDeploymentId({ chainId: this.chainId, hubAddress: this.hubAddress });
  }

  readonly chainType = 'evm' as const;

  readonly chainId: string;

  /**
   * The bare primary RPC provider (== `primaryProvider`). The nominal runner
   * that signers, boot-bound contract handles, and the Hub-rotation event
   * subscription bind to — NOT the read-failover surface. Every read reconnects
   * to a per-endpoint provider via the read facades (`readContract`/`readProvider`
   * → `this.rpcFailover`); the `FallbackProvider` was removed (see the
   * constructor). Kept as a distinct field name for the binding sites; reads must
   * never call `this.provider.<read>()` directly (route through the read facades).
   */
  protected readonly provider: JsonRpcProvider;

  protected readonly primaryProvider: JsonRpcProvider;

  protected readonly providers: JsonRpcProvider[];

  protected readonly rpcUrls: string[];

  protected readonly walletRpcUrls: string[];

  /**
   * The pure per-endpoint RPC transport mechanism. Owns the read-failover loop +
   * the named timeout-policy matrix + typed exhaustion; constructed with a LIVE
   * endpoint thunk over `this.providers` / `this.rpcUrls` and the
   * `signPopulatedTransaction` callback, so it never holds a back-reference to
   * the adapter and never owns tx-safety state.
   */
  protected readonly rpcFailover: RpcFailoverClient;
  /** Raw JSON-RPC request accounting (provider-billing unit). See rpc-usage.ts. */
  protected readonly rpcUsage: RpcUsageTracker;

  protected readonly configuredStaticChainId?: bigint;

  protected readonly filterErrorSilencer: FilterErrorSilencer;

  /** Primary signer — used for identity/profile/staking operations. */
  protected readonly signer: Wallet;

  /** All operational signers (includes primary). Used round-robin for publish TXs. */
  protected readonly signerPool: Wallet[];

  /** Admin signer — used only for profile/key-management operations. */
  protected readonly adminSigner?: Wallet;

  protected signerIndex = 0;

  protected signerSelectionQueue: Promise<void> = Promise.resolve();

  /**
   * Serializes the nonce-critical send window (populate → sign → broadcast →
   * confirm) per operational wallet. The round-robin pool can route two
   * concurrent writes to the same wallet; without this they each read the
   * same `pending` nonce before either broadcasts and the second reverts
   * `Nonce too low` (OriginTrail/dkg#953). Cross-wallet concurrency is
   * preserved.
   */
  protected readonly signerTxSerializer = new KeyedSerializer();

  /**
   * Lowercased addresses of operational wallets CONFIRMED registered on-chain
   * under the node's identity. Seeded with the primary signer (`pool[0]`, the
   * identity anchor guaranteed registered via `createProfile`) and extended by
   * `ensureOperationalWalletsRegistered` / `addOperationalWallet`. Used by
   * `selectSigner` for `rotatable-free` (RS) eligibility, which must fail CLOSED
   * to registered wallets: `RandomSampling` resolves the node via
   * `getIdentityId(msg.sender)`, so a signer that is not a registered
   * operational key resolves to identity 0 and reverts — burning the proof
   * period. A wallet is admitted here only once its registration is confirmed,
   * never optimistically.
   *
   * This is a same-process cache of on-chain state: seeded/extended on confirmed
   * registration and PRUNED on a first-party `removeOperationalWallet`. It does
   * NOT observe out-of-band changes (a removal via another node instance / a
   * direct admin tx, or a key re-assigned to a different identity) — those go
   * stale until restart (which re-seeds to currently-registered wallets). Impact
   * of staleness is bounded: RS may waste one proof attempt on a no-longer-registered
   * wallet, no fund/safety loss. A durable close (revalidate `getIdentityId(w)`
   * at selection time via the identityId cache) is a tracked follow-up.
   */
  protected readonly registeredOperationalAddresses = new Set<string>();

  /**
   * Funding-aware publish selection floors. A wallet is "fundable" (preferred
   * by `nextAuthorizedSigner`) when its native balance > `minPublisherNativeWei`
   * AND its TRAC balance > `minPublisherTracWei`. Default `0n` (strictly
   * positive). See `EVMAdapterBaseConfig.minPublisher*Wei`.
   */
  protected readonly minPublisherNativeWei: bigint;

  protected readonly minPublisherTracWei: bigint;

  /**
   * Kill-switch (env `DKG_DISABLE_FUNDED_WALLET_SELECTION=1`): when set,
   * `selectSigner` reverts to the pre-funding-aware behaviour
   * (first eligible wallet in round-robin order, no balance reads).
   */
  protected readonly fundedWalletSelectionDisabled: boolean;

  /**
   * Independent kill-switch (env `DKG_DISABLE_IDLE_AWARE_SELECTION=1`): when
   * set, `selectSigner` never applies the idle-aware preference even for specs
   * that request `preferIdle`. Separate from the funding kill-switch so idle
   * biasing can be disabled without losing funding-awareness. Idle preference
   * is a soft, fail-open bias (prefer a funded wallet whose per-wallet lock is
   * currently free); it is OFF for publish (`preferIdle: false`) until soaked.
   */
  protected readonly idleAwareSelectionDisabled: boolean;

  /**
   * Short-TTL per-wallet funding cache (lowercased address → native+TRAC wei).
   * A `null` metric means the read failed / no token contract; callers FAIL
   * OPEN (treat null as fundable). Reused across a bulk publish loop so it
   * does not re-read the same wallet on every iteration.
   */
  // `nativeTs`/`tracTs` age independently: a native-only (RS) probe refreshes
  // ONLY the native slot, so a transient TRAC read failure during an RS tick
  // can never overwrite a valid cached TRAC balance with a fail-open `null` —
  // which a publish selection inside the TTL would misread as "TRAC-fundable".
  protected readonly fundingCache = new Map<string, { native: bigint | null; nativeTs: number; trac: bigint | null; tracTs: number }>();

  protected readonly hubAddress: string;

  protected readonly tokenAddress?: string;

  /**
   * Operator-configured allowance sizing policy for V10 publish / update
   * auto-approve. See {@link ApprovalPolicy}. Default is `'per-publish'`,
   * preserving the bounded-per-publish behaviour from before the policy
   * landed.
   */
  protected readonly approvalPolicy: ApprovalPolicy;

  protected contracts: ContractCache;

  protected initialized = false;

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
   * See `HubResolutionCache` for the semantics; the poller
   * started in `init()` invalidates this cache on
   * `Hub.ContractChanged` / `Hub.NewContract` for **either** name,
   * and `withHubStaleRetry()` invalidates it when a write surfaces
   * `UnauthorizedAccess(Only Contracts in Hub)`.
   */
  protected readonly randomSamplingPairCache: HubResolutionCache<{ rs: Contract; rss: Contract }>;

  protected static readonly IDENTITY_ID_POSITIVE_TTL_MS = 5 * 60 * 1000;

  protected static readonly SIGNER_IDENTITY_ID_ZERO_TTL_MS = 15 * 1000;

  /**
   * OT-RFC-39 — per-process identity-id cache. Positive hits are memoised with
   * a bounded TTL; arbitrary-address negative hits are only single-flighted so
   * later external registration is visible immediately. The signer address has
   * a short zero TTL so fresh edge-node startup sync does not repeat the same
   * self `0n` lookup per page.
   */
  protected identityIdCache!: IdentityIdCache;

  protected readonly pcaReadCache = new PcaReadCache();

  /**
   * #1583 — resolved-address memo for `resolveContract`. Caches the Hub-resolved
   * proxy ADDRESS (string) per contract name so a sustained 100-KA publish burst
   * stops funnelling ~150-250 redundant `Hub.getContractAddress` eth_calls
   * (identity resolution, ACK verification, token-amount) through the chain RPC —
   * on that workload the RPC was ~99% reads, almost all address re-resolution.
   *
   * Only the ADDRESS is memoized; the `Contract` handle is still built fresh per
   * call (a cheap object build, not an RPC). `this.signer` is a constant readonly
   * pool[0], so caching the handle would be behaviourally safe — but reads go via
   * `staticCall` and writes `.connect()` an explicitly-passed signer, so the fresh
   * build is the simplest correct thing and avoids an ABI-vs-address cache pairing.
   * Keyed `${hubAddress}:${chainId}:${name}` — the hub+chain scope is
   * constant for an adapter instance but is kept explicit so the key survives any
   * future shared-cache refactor. Proxy addresses are immutable except on a Hub
   * re-registration, so the memo is cleared at the SAME rotation/invalidation
   * hooks as `identityIdCache`, with a `PREFLIGHT_TTL_MS` backstop so a missed
   * hook cannot strand a stale address forever. A zero/missing result is never
   * cached (only a successfully-resolved non-zero address). See
   * `RESOLVE_CONTRACT_ADDRESS_MEMO_EXCLUDED` for names that always resolve fresh.
   * Assigned in the constructor (TTL sourced from the `PREFLIGHT_TTL_MS` static).
   */
  protected readonly resolvedContractAddressCache: ReadThroughTtlCache<string, string>;

  protected readonly hubRotationPoller: HubRotationPoller;

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
  protected inflightDurationProbe: Promise<bigint | undefined> | undefined;

  protected inflightDurationProbeContract: Contract | undefined;

  protected inflightDurationProbeStartedAt = 0;

  /**
   * PR3 / RC11 — TTL cache for the three "publish pre-flight" reads the
   * V10 ACK provider needs on every publish:
   *
   *   - `getEvmChainId()`           (chain id, never changes after
   *                                  the JSON-RPC endpoint is configured)
   *   - `getKnowledgeAssetsLifecycleAddress()` (KAV10 contract address —
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
  protected static readonly PREFLIGHT_TTL_MS = 60 * 60 * 1000;

  protected cachedChainId: { value: bigint; cachedAt: number } | undefined;

  protected readonly configuredStaticChainIdsByProvider = new Map<
    JsonRpcProvider,
    { value: bigint; cachedAt: number }
  >();

  protected readonly configuredStaticChainIdValidationsByProvider = new Map<
    JsonRpcProvider,
    Promise<bigint>
  >();

  protected cachedKav10Address: { value: string; cachedAt: number } | undefined;

  protected cachedMinRequiredSignatures: { value: number; cachedAt: number } | undefined;

  /**
   * Cached deploy blocks, keyed by lowercase contract address. Anchors long
   * event-log scans at the contract's birth instead of genesis. A contract's
   * deploy block is immutable, so this needs no TTL.
   */
  protected readonly cachedContractDeployBlocks: Map<string, number> = new Map();

  protected readonly contextGraphRegistryScanCursor: ContextGraphRegistryScanCursor;

  /**
   * eth_getLogs block-window for the pre-10.0.4 getMaxKaNumberForAuthor fallback
   * scan (adapter-level config `kaHighWaterScanPageSize`; non-integer / `< 1`
   * values fall back to KA_HIGH_WATER_DEFAULT_PAGE_SIZE = 2,000).
   */
  protected readonly kaHighWaterScanPageSize: number;

  protected readonly cgRegistryScanPageSize: number;

  /**
   * Reset the PR3 publish-preflight cache. Public so daemon code that
   * knows about an external chain reconfiguration (e.g. a hot-reload
   * of `chainRpcUrl` or a deliberate governance-vote test fixture)
   * can flush the cache without waiting out the TTL. Tests use this
   * to reset state between cases.
   */
  invalidatePublishPreflightCache(): void {
    this.cachedChainId = undefined;
    this.configuredStaticChainIdsByProvider.clear();
    this.configuredStaticChainIdValidationsByProvider.clear();
    this.cachedKav10Address = undefined;
    this.cachedMinRequiredSignatures = undefined;
    this.cachedContractDeployBlocks.clear();
    this.contextGraphRegistryScanCursor.clearMemoryCache();
  }

  protected clearIdentityIdForAddress(address: string): void {
    this.identityIdCache.invalidate(address);
    // #1583 — this fires on the identity-management / RS-challenge paths (NOT
    // the per-KA-publish hot path), so dropping the address memo here is cheap
    // and keeps the resolved-address cache flushed whenever we suspect an
    // identity binding shifted.
    this.resolvedContractAddressCache.invalidateAll();
  }

  protected seedIdentityIdForAddress(address: string, identityId: bigint): void {
    this.identityIdCache.seed(address, identityId);
  }

  protected invalidateIdentityStorageBinding(): void {
    this.contracts.identityStorage = undefined;
    this.identityIdCache.invalidateAll();
    // #1583 — an IdentityStorage rotation changes its proxy address; drop the
    // memoized address so the next resolve re-hits the Hub.
    this.resolvedContractAddressCache.invalidateAll();
  }

  protected async identityStorageAddressChanged(
    previous: Contract | undefined,
    next: Contract,
  ): Promise<boolean> {
    if (!previous) return false;
    if (previous === next) return false;
    try {
      return (await contractAddress(previous)).toLowerCase() !== (await contractAddress(next)).toLowerCase();
    } catch {
      return true;
    }
  }

  protected async readIdentityIdFromStorage(address: string): Promise<bigint> {
    if (!ethers.isAddress(address)) return 0n;
    const checksum = ethers.getAddress(address);
    await this.init();
    const previousIdentityStorage = this.contracts.identityStorage;
    // #1583 — keep the `{ refresh: true }` re-resolve. Pre-#1583 this re-hit the
    // Hub on every getIdentityId miss (a major RPC amplifier during publish
    // bursts); now `resolveContractAddress` memoizes the address, so the
    // re-resolve is memo-served (no RPC on the hot path) yet still rebinds the
    // lazy Contract to whatever the memo currently holds. That coupling is the
    // point: a Hub rotation the event poller MISSES no longer strands this
    // binding on a dead proxy — the address memo TTL-expires within
    // RESOLVE_CONTRACT_ADDRESS_MEMO_TTL_MS (30s) and this re-resolve picks up the
    // new address, bounding the missed-rotation window to ≤30s. (An OBSERVED
    // rotation clears both binding and memo immediately via
    // `invalidateIdentityStorageBinding`.) The `getIdentityId` VALUE read below
    // stays fresh/uncached; `identityStorageChanged` flushes the identity caches
    // when the re-resolve lands on a new address.
    const identityStorage = await this.getIdentityStorage({ refresh: true });
    const identityStorageChanged = await this.identityStorageAddressChanged(previousIdentityStorage, identityStorage);
    if (identityStorageChanged) {
      this.identityIdCache.invalidateAll();
      this.resolvedContractAddressCache.invalidateAll();
    }
    const id: bigint = await this.readContract(
      identityStorage, 'identityStorage.getIdentityId', 'getIdentityId', checksum,
    );
    const identityId = BigInt(id);
    if (identityStorageChanged) this.identityIdCache.seed(checksum, identityId);
    return identityId;
  }

  protected async readIdentityIdForAddress(address: string): Promise<bigint> {
    return this.identityIdCache.getOrLoad(address, (checksum) => this.readIdentityIdFromStorage(checksum));
  }

  protected async refreshIdentityIdForAddress(address: string): Promise<bigint> {
    if (!ethers.isAddress(address)) return 0n;
    const checksum = ethers.getAddress(address);
    this.identityIdCache.invalidate(checksum);
    const identityId = await this.readIdentityIdFromStorage(checksum);
    this.identityIdCache.seed(checksum, identityId);
    return identityId;
  }

  protected static preflightCacheFresh(
    entry: { cachedAt: number } | undefined,
    now: number,
  ): boolean {
    if (!entry) return false;
    return now - entry.cachedAt < EVMChainAdapterBase.PREFLIGHT_TTL_MS;
  }

  constructor(config: EVMAdapterConfig) {
    this.rpcUrls = resolveRpcUrls(config.rpcUrl, config.rpcUrls);
    this.walletRpcUrls = Array.from(new Set(
      (config.walletRpcUrls ?? [])
        .map((url) => typeof url === 'string' ? url.trim() : '')
        .filter((url) => /^https?:\/\//i.test(url)),
    ));
    // Floor a finite `>= 1` value (so e.g. 10000.5 -> 10000, preserving the
    // window); only a `< 1` (or non-finite) value falls back to the default — a
    // fractional value in (0,1) must NOT floor to 0 (which makes pages Infinity).
    this.kaHighWaterScanPageSize = normalizeScanPageSize(
      config.kaHighWaterScanPageSize,
      KA_HIGH_WATER_DEFAULT_PAGE_SIZE,
    );
    this.cgRegistryScanPageSize = normalizeScanPageSize(
      config.cgRegistryScanPageSize,
      CG_REGISTRY_DEFAULT_PAGE_SIZE,
    );
    // BUG-022 root-cause fix: force ethers' `PollingEventSubscriber`
    // (eth_getLogs over a sliding block window) instead of the default
    // `FilterIdEventSubscriber` (eth_newFilter + eth_getFilterChanges).
    //
    // The filter-id path is unrecoverable on any RPC that GC's filters
    // faster than the poll cadence: when `eth_getFilterChanges` returns
    // null/non-array for a dropped filter, ethers v6.16's
    // `subscriber-filterid.js#_emitResults` throws `TypeError: results is
    // not iterable`, the `#poll` catch swallows it as `console.log("@TODO",
    // err)` WITHOUT invalidating the dead filterId, and re-arms on the next
    // `block` event — pinning the daemon at 100% CPU and starving the event
    // loop until the API hangs (observed on a 5-node devnet: 2/5 daemons
    // wedged after ~30-60min). The prior mitigation (filter-error-silencer)
    // only deduped the LOG spam and never recovered the filter; worse, it
    // didn't even match this `TypeError` variant.
    //
    // `polling: true` carries a small extra-RPC cost (one eth_getLogs per
    // block per active subscription) in exchange for a stateless,
    // self-healing subscription with no server-side filter to leak. This is
    // ethers' own fallback path for filter-unsupported RPCs.
    // Bound ethers' built-in per-request 429/5xx retry (see
    // `boundedRetryFetchRequest`) so a perpetually rate-limited RPC surfaces a
    // retryable error within seconds instead of stalling reads (e.g. `init()`'s
    // Hub lookups) for minutes — which would otherwise make context-graph
    // register hang past its HTTP timeout rather than returning 503.
    // Disable ethers' JSON-RPC request batching (default `batchMaxCount` = 100).
    // Under RPC rate limiting a *batched* `eth_getLogs` response is a single
    // JSON-RPC error covering the whole batch; ethers' coalesce path then
    // rejects on the un-awaited batch-drain promise rather than the per-request
    // promise the caller awaits, so the failure escapes as an UNHANDLED "could
    // not coalesce error" rejection (~30k observed on a live node under a
    // gossip/finalization on-chain-verification storm — see issue #939). With
    // `batchMaxCount: 1` each read is its own request whose rejection attaches
    // to the awaited promise and is caught by the caller's existing try/catch
    // (gossip-publish-handler / finalization-handler `verifyOnChain`). Batching
    // is a transport optimisation only — disabling it is semantically inert and
    // does not change the number of `eth_getLogs` operations issued.
    // Immediate-failover (R1): per-endpoint retries are 0 when ≥2 endpoints are
    // configured, so the FIRST retryable failure propagates at once and the
    // explicit per-provider failover loops (reads: the `RpcFailoverClient` read
    // facades; writes: `sendContractTransaction` / broadcast / receipt / the V10 populate loop)
    // advance to the next endpoint immediately instead of burning ~7.5s of
    // same-endpoint backoff on an endpoint we already know is failing. A
    // single-RPC node keeps the bounded `RPC_REQUEST_MAX_RETRIES` retry (its
    // only resilience; #894) via the default. See `boundedRetryFetchRequest`.
    const perEndpointRetries = this.rpcUrls.length > 1 ? 0 : undefined;
    // CountingJsonRpcProvider reports every raw JSON-RPC request to the usage
    // tracker (the PROVIDER-BILLING unit — see rpc-usage.ts). With
    // `batchMaxCount: 1` below, one send() == one HTTP request, so the count is
    // exact. `this.chainId` is assigned later in this constructor → live thunk.
    this.rpcUsage = new RpcUsageTracker(() => this.chainId);
    // One transport factory wires BOTH billing-exact accounting hooks (first
    // attempt at `_send` + every ethers-internal retry attempt) to the tracker —
    // see createCountingJsonRpcProvider for the invariant.
    this.configuredStaticChainId = configuredStaticChainId(config);
    const staticNetwork = this.configuredStaticChainId == null
      ? undefined
      : ethers.Network.from(this.configuredStaticChainId);
    this.providers = this.rpcUrls.map(
      (url) => createCountingJsonRpcProvider(url, perEndpointRetries, this.rpcUsage, {
        cacheTimeout: -1,
        polling: true,
        batchMaxCount: 1,
      }, staticNetwork),
    );
    this.primaryProvider = this.providers[0];
    // No `FallbackProvider`: reads route through the `RpcFailoverClient` read
    // facades over the bare `this.providers[]` for TRUE immediate failover. ethers' quorum:1
    // FallbackProvider threw a fast error straight to the caller WITHOUT
    // consulting a backup (it advanced only on a ~4s stall) — empirically
    // unreliable read failover even with per-endpoint retries > 0 — and its
    // sub-providers shared this same `this.providers[]` array, so the
    // multi-RPC `retries=0` above would have disabled its staller-based failover
    // anyway. Removing it also eliminates the sticky `_lastFatalError` /
    // one-shot `#initialSync` latch. `this.provider` is now just the bare
    // primary: the nominal runner that signers, boot-bound contract handles, and
    // the Hub-rotation event subscription bind to. Every actual READ reconnects
    // to the loop provider (via the `RpcFailoverClient` read facades) and every
    // WRITE reconnects per-endpoint explicitly, so this binding is never the
    // failover surface.
    this.provider = this.primaryProvider;
    // Construct the transport client AFTER `this.providers`/`this.rpcUrls` are
    // set (above). The endpoint thunk reads `providers`/`rpcUrls` live (so a
    // reassignment of `(a as any).providers` is observed) and signing routes back
    // to `signPopulatedTransaction` so that helper stays on the adapter. No
    // failover read can run before this point — the constructor below only builds
    // Wallets/Contracts and a lazily-resolved HubResolutionCache.
    this.rpcFailover = new RpcFailoverClient(
      // Mapped at CALL time inside the thunk (NOT captured), so a reassignment of
      // `(a as any).providers` / `(a as any).rpcUrls` after construction still
      // propagates live. `providers`/`rpcUrls` are built in lockstep
      // (`providers = rpcUrls.map(...)`), so index i pairs provider[i]↔rpcUrl[i].
      () => this.providers.map((provider, i) => ({ provider, rpcUrl: this.rpcUrls[i] })),
      (signer, populated) => this.signPopulatedTransaction(signer, populated),
      // `this.chainId` is assigned later in this constructor (after the client is
      // built), so pass a LIVE thunk — resolved at metric-record time — rather
      // than capturing the still-undefined field value here.
      () => this.chainId,
      {
        validateEndpoint: async (endpoint) => { await this.ensureConfiguredStaticChainIdValidated(endpoint.provider); },
        // Endpoint-stickiness config. The kill-switch is resolved HERE at the config
        // boundary (LIVE per-check so flipping the env + restart disables it) so the
        // transport core stays free of any process-global dependency.
        stickiness: { isEnabled: () => process.env.DKG_DISABLE_RPC_STICKINESS !== '1' },
      },
    );
    this.hubRotationPoller = new HubRotationPoller({
      readProvider: (label, fn, opts) => this.readProvider(label, fn, opts),
      intervalMs: HUB_ROTATION_POLL_INTERVAL_MS,
      reorgBufferBlocks: HUB_ROTATION_REORG_BUFFER_BLOCKS,
      onContractName: (name) => this.applyHubRotationEventName(name),
    });
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
    // The primary signer is the node's identity anchor (a registered operational
    // key via createProfile), so RS may always fall back to it. Additional
    // wallets join this set only once their registration is confirmed on-chain.
    this.registeredOperationalAddresses.add(this.signer.address.toLowerCase());
    if (config.adminPrivateKey) {
      this.adminSigner = new Wallet(config.adminPrivateKey, this.provider);
      const adminAddress = this.adminSigner.address.toLowerCase();
      if (this.signerPool.some((signer) => signer.address.toLowerCase() === adminAddress)) {
        throw new Error('EVM adminPrivateKey must be distinct from operational keys');
      }
    }
    this.identityIdCache = new IdentityIdCache(
      this.signer.address.toLowerCase(),
      EVMChainAdapterBase.IDENTITY_ID_POSITIVE_TTL_MS,
      EVMChainAdapterBase.SIGNER_IDENTITY_ID_ZERO_TTL_MS,
    );
    // #1583 — resolved-contract-address memo, 30s TTL backstop
    // (RESOLVE_CONTRACT_ADDRESS_MEMO_TTL_MS — bounds a poller-missed rotation).
    this.resolvedContractAddressCache = new ReadThroughTtlCache<string, string>({
      ttlMs: RESOLVE_CONTRACT_ADDRESS_MEMO_TTL_MS,
    });
    this.hubAddress = config.hubAddress;
    if (config.tokenAddress && !ethers.isAddress(config.tokenAddress)) {
      throw new Error(`Invalid tokenAddress: ${config.tokenAddress}`);
    }
    this.tokenAddress = config.tokenAddress ? ethers.getAddress(config.tokenAddress) : undefined;
    this.chainId = config.chainId ?? 'evm:31337';
    this.contextGraphRegistryScanCursor = new ContextGraphRegistryScanCursor({
      chainId: this.chainId,
      deploymentId: this.deploymentId,
      store: config.contextGraphRegistryScanCursorStore,
    });
    this.approvalPolicy = config.approvalPolicy ?? DEFAULT_APPROVAL_POLICY;
    this.minPublisherNativeWei = config.minPublisherNativeWei ?? 0n;
    this.minPublisherTracWei = config.minPublisherTracWei ?? 0n;
    this.fundedWalletSelectionDisabled = process.env.DKG_DISABLE_FUNDED_WALLET_SELECTION === '1';
    this.idleAwareSelectionDisabled = process.env.DKG_DISABLE_IDLE_AWARE_SELECTION === '1';

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
  protected nextSigner(): Wallet {
    const s = this.signerPool[this.signerIndex % this.signerPool.length];
    this.signerIndex++;
    return s;
  }

  protected findSignerByAddress(address: string): Wallet | undefined {
    const normalized = ethers.getAddress(address).toLowerCase();
    return this.signerPool.find((signer) => signer.address.toLowerCase() === normalized);
  }

  /**
   * Resolve and authorize an explicitly pinned publisher through one shared
   * boundary. Reservation and transaction submission both call this helper so
   * signer-pool membership, authorization policy, and error shaping cannot
   * drift between the preflight and the final write.
   */
  protected async resolvePinnedPublisherSigner(
    contextGraphId: bigint,
    publisherAddress: string,
  ): Promise<Wallet> {
    const selected = this.findSignerByAddress(publisherAddress);
    if (!selected) {
      throw new Error(
        `Configured publisherAddress ${publisherAddress} is not present in the EVM signer pool.`,
      );
    }
    if (this.contracts.contextGraphs) {
      const authorized = await this.readContract(
        this.contracts.contextGraphs,
        'contextGraphs.isAuthorizedPublisher',
        'isAuthorizedPublisher',
        contextGraphId,
        selected.address,
      );
      if (!authorized) {
        throw new Error(
          `Configured publisherAddress ${selected.address} is not authorized to publish ` +
          `to context graph ${contextGraphId.toString()}.`,
        );
      }
    }
    return selected;
  }

  /**
   * Classify an RPC error for low-cardinality metric labels: `timeout` for the
   * synthetic `withTimeout` TIMEOUT code, else `error`. Used by the adapter's own
   * instrumented `eth_getLogs` page scan (`queryEventLogsPage`) so the `outcome`
   * label stays bounded. (The failover transports — broadcast / receipt / eth_call
   * / populate — now record their outcomes inside `RpcFailoverClient`.)
   */
  private _rpcOutcomeForError(err: unknown): 'error' | 'timeout' {
    return errorCode(err) === 'TIMEOUT' ? 'timeout' : 'error';
  }

  /**
   * Thin delegator to `this.rpcFailover.broadcast` — the per-endpoint broadcast
   * loop. `sendSignedTransactionAndWait`'s set-retry loop calls this method; it
   * only forwards an already-signed tx, so no tx-safety state crosses here.
   */
  protected broadcastSignedTransactionWithFailover(
    signedTx: string,
    txHash: string,
    label: string,
  ): Promise<void> {
    return this.rpcFailover.broadcast(signedTx, txHash, label);
  }

  /**
   * Thin delegator to `this.rpcFailover.getReceipt` — the per-endpoint receipt
   * loop. Used by `waitForReceiptWithFailover` and the `publish.ts` callers.
   */
  protected getTransactionReceiptWithFailover(txHash: string): Promise<ethers.TransactionReceipt | null> {
    return this.rpcFailover.getReceipt(txHash);
  }

  /**
   * Common point-view CONTRACT read — the chain-concept surface the domain mixins
   * call: a `contract`, a `label`, a string `method` name, and its args, run with
   * the default `pointRead` policy + the `isContractViewRetryable` classifier. The
   * untyped ethers `Contract` resolves the string method through `any`, so this
   * loses NO static checking versus a `c.method(...)` lambda.
   */
  protected readContract<T = any>(
    contract: Contract,
    label: string,
    method: string,
    ...args: unknown[]
  ): Promise<T> {
    return this.rpcFailover.readContract(label, contract, (c) => c[method](...args), {
      rpcUsageConsumer: label,
    });
  }

  /**
   * CONTRACT view read needing a non-default policy or classifier — the funding
   * reads (`failOpenFundingRead`), the events scan (`wideLogScan`), or a bespoke
   * `isRetryable`. Keeps the `fn` lambda (vs the string-method `readContract`) for
   * reads whose call shape isn't a plain `c.method(...args)`.
   */
  protected readContractWith<T>(
    contract: Contract,
    label: string,
    fn: (c: Contract) => Promise<T>,
    opts?: ReadOpts,
  ): Promise<T> {
    return this.rpcFailover.readContract(label, contract, fn, {
      ...opts,
      rpcUsageConsumer: opts?.rpcUsageConsumer ?? label,
    });
  }

  /**
   * Raw PROVIDER read (no contract rebind) — `getCode` / `getBlock` /
   * `getNetwork` / `getBalance` / `getBlockNumber`, the fail-open native-balance
   * funding read, and the `getMaxKaNumberForAuthor` staticCall with its bespoke
   * absent-view classifier. Default `pointRead` + `isRetryableRpcError`; override
   * the policy/classifier via `opts`.
   */
  protected readProvider<T>(
    label: string,
    fn: (provider: JsonRpcProvider) => Promise<T>,
    opts?: ReadOpts,
  ): Promise<T> {
    return this.rpcFailover.read(label, fn, {
      ...opts,
      rpcUsageConsumer: opts?.rpcUsageConsumer ?? label,
    });
  }

  /**
   * Raw PROVIDER read for a TIP-SENSITIVE value — the current head / `latest`
   * block / any read that must stay canonical-fresh and preference-transparent
   * (a lagging endpoint-stickiness backend would make the tip non-monotonic
   * across calls). This is the POSITIVE freshness intent at the call site, so
   * callers pick `readTipProvider` by meaning instead of remembering the
   * transport-internal `skipPreferred` opt-out on a plain `readProvider`.
   */
  protected readTipProvider<T>(
    label: string,
    fn: (provider: JsonRpcProvider) => Promise<T>,
    opts?: ReadOpts,
  ): Promise<T> {
    return this.readProvider(label, fn, { ...opts, skipPreferred: true });
  }

  /**
   * Raw PROVIDER read whose `null` is a "not on this endpoint (yet)" signal, not a
   * definitive answer. A `null` FAILS OVER to the other endpoints (a lagging
   * endpoint must not hide an object a healthy one has) WITHOUT de-preferring that
   * endpoint or emitting failover/exhaustion telemetry — because an empty result is
   * not a transport failure. Returns the first NON-null result, or `null` only when
   * EVERY endpoint returned `null` and none had a real transport error. A
   * non-retryable provider error (e.g. `INVALID_ARGUMENT`) or a genuine transport
   * exhaustion PROPAGATES — never masked as `null`. The empty-vs-error distinction
   * (and thus the order-independent all-null decision) is handled by the transport
   * loop via `ReadOpts.isEmptyResult`, so no sentinel exception is tunnelled
   * through the generic failover/telemetry path.
   */
  protected readProviderRetryingNull<T>(
    label: string,
    fn: (provider: JsonRpcProvider) => Promise<T>,
    opts?: ReadOpts,
  ): Promise<T | null> {
    return this.readProvider<T | null>(label, fn, { ...opts, isEmptyResult: (v) => v == null });
  }

  /**
   * Rebind a CONTRACT to a `provider` for one per-endpoint VIEW read, leaving the
   * boot-bound `this.contracts.*` handle untouched. The sole remaining base caller
   * is the `getMaxKaNumberForAuthor` staticCall (a `readProvider` lambda); the
   * write-path signer rebind lives in the module's `populateAndSign`. The
   * `as Contract` recovers the dynamic-method index signature ethers'
   * `BaseContract.connect` drops.
   */
  protected rebindContract(contract: Contract, runner: JsonRpcProvider | Wallet): Contract {
    return contract.connect(runner) as Contract;
  }

  protected async waitForReceiptWithFailover(
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
    throw createRpcTimeoutError(
      `${label} tx ${txHash} timed out waiting for a receipt after ${RPC_RECEIPT_TIMEOUT_MS}ms` +
      (lastError ? ` (last RPC error: ${errorMessage(lastError)})` : ''),
      { cause: lastError, txHash },
    );
  }

  protected async signPopulatedTransaction(
    signer: Wallet,
    populated: ethers.TransactionRequest,
  ): Promise<{ signedTx: string; txHash: string }> {
    const filled = await signer.populateTransaction(populated);
    const signedTx = await signer.signTransaction(filled);
    const txHash = ethers.Transaction.from(signedTx).hash ?? '0x';
    return { signedTx, txHash };
  }

  /**
   * #888: populate + sign a V10 write tx (shared by publish + update) with a
   * one-shot recovery for a stale-RPC `TooLowAllowance` revert. Gas estimation
   * during populate can read a stale TRAC allowance and revert even though the
   * approve succeeded; this is strictly pre-broadcast, so on that ONE revert we
   * force a fresh approve (`ensureV10ApproveTrac(force=true)`) and retry exactly
   * once. Any other error, or a second `TooLowAllowance`, propagates.
   */
  protected async populateAndSignV10WithAllowanceRecovery(
    signer: Wallet,
    kaContract: Contract,
    method: 'publish' | 'update',
    methodParams: unknown,
    kav10Address: string,
    tokenAmount: bigint,
    reapproveLabel: string,
    approvalSender: ContractWriteSender = this.sendContractTransaction.bind(this),
  ): Promise<{ signedTx: string; txHash: string }> {
    // Per-endpoint populate+sign failover lives in the shared
    // `populateAndSignAcrossProviders` (so a 429ing primary can't fail-fast the
    // publish); the #888 stale-allowance recovery stays a strict ONE-SHOT. OUTER
    // (this loop) owns the SINGLE `forcedReapprove` latch + the lone forced
    // approve; INNER iterates the bare providers. `TooLowAllowance` is a
    // CALL_EXCEPTION (non-retryable), so the inner loop does NOT fail over on it —
    // it propagates up here. The latch is never reset per endpoint, so at most
    // ONE forced approve fires per publish regardless of endpoints tried. Only the
    // one returned signed tx is broadcast; the whole thing runs inside the
    // per-wallet `KeyedSerializer` (#953), strictly pre-broadcast / pre-WAL.
    let forcedReapprove = false;
    for (;;) {
      try {
        return await this.populateAndSignAcrossProviders(
          kaContract,
          method,
          [methodParams],
          signer,
          `V10 ${method}`,
        );
      } catch (err) {
        enrichEvmError(err);
        if (!forcedReapprove && isTooLowAllowanceError(err)) {
          forcedReapprove = true;
          console.warn(
            `[chain] V10 ${method} gas-estimation reverted TooLowAllowance for ` +
            `signer=${signer.address} — forcing a fresh TRAC approve and ` +
            `retrying once (likely a stale RPC allowance read, #888).`,
          );
          await this.ensureV10ApproveTrac(
            signer,
            kav10Address,
            tokenAmount,
            reapproveLabel,
            true,
            approvalSender,
          );
          continue; // re-run the WHOLE inner per-provider populate loop, allowance now in place
        }
        throw err; // any other error, or a SECOND TooLowAllowance, propagates
      }
    }
  }

  protected async sendSignedTransactionAndWait(
    signedTx: string,
    txHash: string,
    label: string,
  ): Promise<ethers.TransactionReceipt> {
    // Bounded set-retry, BROADCAST phase ONLY: after a full per-endpoint
    // broadcast pass exhausts with a retryable error (a brief all-endpoints-429),
    // re-broadcast the SAME signed tx up to `RPC_ENDPOINT_SET_RETRIES` extra
    // passes with a short backoff. tx-safe: this seam is SIGNER-FREE so re-signing
    // is structurally impossible, re-broadcasting the byte-identical tx is
    // idempotent (`isKnownTransactionError`), and the WAL `onBroadcast` already
    // fired once upstream. The receipt wait is NOT re-broadcast (it owns its own
    // poll + deadline), so lock-hold (held across the retries for the V10 path)
    // stays bounded.
    for (let pass = 0; ; pass += 1) {
      try {
        await this.broadcastSignedTransactionWithFailover(signedTx, txHash, label);
        break;
      } catch (err) {
        if (isRetryableRpcError(err) && pass < RPC_ENDPOINT_SET_RETRIES) {
          await sleep(RPC_ENDPOINT_SET_RETRY_BACKOFF_MS);
          continue;
        }
        throw err;
      }
    }
    return this.waitForReceiptWithFailover(txHash, label);
  }

  /**
   * Shared dispatch for the two V10 write paths (`publishToContextGraph`,
   * `updateKnowledgeCollectionV10`). Serializes the nonce-critical window
   * (populate → sign → WAL checkpoint → broadcast → confirm) PER operational
   * wallet.
   *
   * #953: the round-robin signer pool can route two concurrent writes to the
   * SAME wallet. Without serialization both `populateTransaction` calls read
   * the same `pending` nonce before either is broadcast, so the second tx
   * reverts `Nonce too low` on chain and the publish degrades to a tentative
   * `kaId:0`. Holding the per-wallet lock until the prior tx is mined keeps
   * the nonce monotonic; cross-wallet writes are unaffected (different keys
   * run concurrently).
   *
   * `buildSignedTx` runs INSIDE the lock so the nonce read can't race a
   * concurrent same-wallet send. `onBroadcast` is the durable WAL checkpoint:
   * it `await`s before broadcast and a throw fails closed (the signed tx is
   * still local, never sent, so the caller can retry with no on-chain effect).
   */
  protected async dispatchSerializedV10Write(
    signer: Wallet,
    label: 'publish' | 'update',
    onBroadcast: ((info: { txHash: string }) => Promise<void> | void) | undefined,
    buildSignedTx: (ctx: SerializedSignerWriteContext) => Promise<{ signedTx: string; txHash: string }>,
    onNullReceipt: (preBroadcastTxHash: string) => never,
  ): Promise<ethers.TransactionReceipt> {
    return this.withSerializedSignerWrite(signer, async (ctx) => {
      const { signedTx, txHash: preBroadcastTxHash } = await buildSignedTx(ctx);
      try {
        await onBroadcast?.({ txHash: preBroadcastTxHash });
      } catch (hookErr) {
        throw new Error(
          `chain:writeahead hook failed before ${label} broadcast: ` +
          `${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
        );
      }
      const receipt = await this.sendSignedTransactionAndWait(
        signedTx,
        preBroadcastTxHash,
        `V10 ${label}`,
      );
      if (!receipt) onNullReceipt(preBroadcastTxHash);
      return receipt;
    });
  }

  protected async sendPopulatedTransaction(
    signer: Wallet,
    populated: ethers.TransactionRequest,
    label: string,
  ): Promise<ethers.TransactionReceipt> {
    const { signedTx, txHash } = await this.signPopulatedTransaction(signer, populated);
    return this.sendSignedTransactionAndWait(signedTx, txHash, label);
  }

  /**
   * Thin delegator to `this.rpcFailover.populateAndSign` — the per-endpoint
   * populate+sign loop (which reaches `signPopulatedTransaction` via the injected
   * callback). Called by `populateAndSignV10WithAllowanceRecovery` (the
   * `forcedReapprove` latch owner) and `sendContractTransaction`. STRICTLY
   * pre-broadcast — the caller owns the WAL split and broadcasts the single
   * returned tx.
   */
  protected async populateAndSignAcrossProviders(
    contract: Contract,
    method: string,
    args: readonly unknown[],
    signer: Wallet,
    label: string,
    opts?: { gasLimitBufferBps?: number },
  ): Promise<{ signedTx: string; txHash: string }> {
    return this.rpcFailover.populateAndSign(contract, method, args, signer, label, opts);
  }

  /**
   * Serialized public entry for a standalone contract write. Same-wallet writes
   * now run strictly serially so their `pending` nonce stays monotonic; writes
   * on different wallets stay concurrent. Nested V10 sub-sends receive the
   * unlocked sender only through `withSerializedSignerWrite`'s scoped context.
   */
  protected async sendContractTransaction(
    contract: Contract,
    method: string,
    args: readonly unknown[],
    signer: Wallet,
    label: string,
    opts?: { gasLimitBufferBps?: number },
  ): Promise<ethers.TransactionReceipt> {
    return this.withSerializedSignerWrite(signer, (ctx) =>
      ctx.sendContractTransaction(contract, method, args, signer, label, opts),
    );
  }

  /**
   * Owns the per-wallet serializer and exposes the unlocked write primitive
   * only to code already running inside that serializer window.
   */
  protected async withSerializedSignerWrite<T>(
    signer: Wallet,
    fn: (ctx: SerializedSignerWriteContext) => Promise<T>,
  ): Promise<T> {
    return this.signerTxSerializer.run(signer.address, () =>
      fn({
        sendContractTransaction: (contract, method, args, innerSigner, label, opts) => {
          if (ethers.getAddress(innerSigner.address) !== ethers.getAddress(signer.address)) {
            throw new Error(
              `chain: scoped signer write for ${signer.address} cannot send with ${innerSigner.address}`,
            );
          }
          return this.sendContractTransactionUnlocked(contract, method, args, innerSigner, label, opts);
        },
      }),
    );
  }

  private async sendContractTransactionUnlocked(
    contract: Contract,
    method: string,
    args: readonly unknown[],
    signer: Wallet,
    label: string,
    // Optional gas headroom for methods whose on-chain gas cost depends on
    // per-block randomness. ethers fills `gasLimit` from a single
    // `eth_estimateGas` with NO margin, but that estimate runs against the
    // CURRENT block while the tx is mined in a LATER block with different
    // `prevrandao`/`blockhash`/`timestamp`. If the mined block's entropy
    // drives a more expensive code path than the estimate's, the tx runs
    // out of gas and reverts with empty (`0x`) data. `RandomSampling.createChallenge`
    // is exactly this case (weighted CG draw + historical blockhash access):
    // observed estimate-vs-execution spread is small here but unbounded in
    // production with many CGs/KCs. When set, we estimate once and inflate
    // the limit by `gasLimitBufferBps` basis points so the drift can't OOG.
    opts?: { gasLimitBufferBps?: number },
  ): Promise<ethers.TransactionReceipt> {
    // Parent span for the whole send. Broadcast + receipt-wait open their own
    // nested spans/metrics (chain.tx_submit / chain.tx_wait) inside
    // sendSignedTransactionAndWait; populate+sign failover is counted inside
    // populateAndSignAcrossProviders.
    return withSpan(
      'chain.tx_send',
      async (span) => {
        // Populate+sign with per-endpoint failover (shared with the V10 path),
        // then broadcast+confirm the single signed tx. Split so `onBroadcast`
        // (the WAL checkpoint) can sit between sign and broadcast for V10 callers.
        const { signedTx, txHash } = await this.populateAndSignAcrossProviders(
          contract, method, args, signer, label, opts,
        );
        span.setAttribute('dkg.tx_hash', txHash);
        return this.sendSignedTransactionAndWait(signedTx, txHash, label);
      },
      { attributes: { 'rpc.method': 'eth_sendRawTransaction', 'dkg.chain_id': this.chainId } },
    );
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
  protected async ensureV10ApproveTrac(
    signer: Wallet,
    kav10Address: string,
    tokenAmount: bigint,
    txLabel: string,
    // #888: set on the retry after a `TooLowAllowance` revert. Forces a
    // fresh approve up to the publish floor regardless of the (possibly
    // stale) on-chain allowance read, then confirms it is visible before
    // returning. See `isTooLowAllowanceError` / `createKnowledgeAssets`.
    force = false,
    approvalSender: ContractWriteSender = this.sendContractTransaction.bind(this),
  ): Promise<void> {
    if (!this.contracts.token) return;
    const tokenWithSigner = this.contracts.token.connect(signer) as Contract;
    const currentAllowance: bigint = await this.readContract(
      tokenWithSigner,
      'token.allowance',
      'allowance',
      signer.address,
      kav10Address,
    );
    const { needsApprove, targetAllowance } = computeApprovalAction(
      this.approvalPolicy,
      tokenAmount,
      currentAllowance,
    );
    // When forced, approve at least the publish floor even if the gating
    // read above said `needsApprove === false` — that "false" may be a
    // stale-high read of an allowance the prior publish already consumed.
    const publishFloor = effectivePublishAllowance(tokenAmount);
    const target = force && targetAllowance < publishFloor ? publishFloor : targetAllowance;
    if (needsApprove || force) {
      // Surface the per-publish floor explicitly when (and only when) the
      // policy lifted `targetAllowance` above the caller's `tokenAmount`
      // — i.e. `tokenAmount === 0n` and the floor in
      // `effectivePublishAllowance` produced `targetAllowance === 1n`
      // (`V10_PUBLISH_ONCHAIN_MIN_ALLOWANCE`). That's the #720 workaround
      // for the contract's `transferFrom(..., 1n)` minimum on zero-cost
      // publishes. Without this log, operators who manually inspect
      // on-chain allowance see "1 wei dust" persisting after every
      // publish and misread it as a stuck or ghosted approval (#871).
      //
      // The `tokenAmount === 0n` half of the guard matters: a legitimate
      // `tokenAmount === 1n` publish ALSO produces `targetAllowance === 1n`
      // under per-publish, but in that case the 1-wei is the real publish
      // cost, not the workaround floor — claiming "#720 floor" there
      // would be a false positive (Codex, PR #875).
      if (
        this.approvalPolicy.mode === 'per-publish' &&
        tokenAmount === 0n &&
        target === V10_PUBLISH_ONCHAIN_MIN_ALLOWANCE
      ) {
        console.warn(
          `[chain] V10 per-publish auto-approve floor: signer=${signer.address} ` +
          `kav10=${kav10Address} target=1 wei (tokenAmount=0, ` +
          `currentAllowance=${currentAllowance.toString()}). This is the #720 ` +
          `transferFrom-minimum workaround; not a stuck approval.`,
        );
      }
      await approvalSender(
        tokenWithSigner,
        'approve',
        [kav10Address, target],
        signer,
        txLabel,
      );
      // #888: only on the forced re-approve (the retry after a
      // `TooLowAllowance` revert) do we confirm the approve is visible on
      // the same read path the caller's gas-estimation will use, so the
      // retry doesn't immediately re-hit the RPC read-after-write lag
      // that prompted it. Gated on `force` so the steady-state publish
      // path issues exactly one allowance read + one approve (unchanged
      // behaviour / latency); the bounded poll returns as soon as the
      // allowance reflects the target.
      if (force) {
        await this.confirmAllowanceVisible(tokenWithSigner, signer.address, kav10Address, target);
      }
    }
  }

  /**
   * #888 — poll `allowance(owner, spender)` until it reflects `target`,
   * bounded by `ALLOWANCE_VISIBILITY_POLL_ATTEMPTS`. Best-effort: if the
   * allowance still hasn't propagated after the budget, we return anyway
   * and let the caller's gas-estimation surface a definitive revert (the
   * `createKnowledgeAssets` retry then forces a fresh approve). Exits on
   * the first read in the common case where the approve is immediately
   * visible, so steady-state publish latency is unchanged.
   */
  protected async confirmAllowanceVisible(
    token: Contract,
    owner: string,
    spender: string,
    target: bigint,
  ): Promise<void> {
    const POLL_ATTEMPTS = 6;
    for (let i = 0; i < POLL_ATTEMPTS; i += 1) {
      let current = -1n;
      try {
        // Bound each read: a raw `token.allowance()` on a hung / read-stalled
        // RPC would otherwise never reject and could block this "bounded"
        // recovery poll indefinitely. `withTimeout` rejects after
        // `RPC_READ_STALL_TIMEOUT_MS`, which the catch below treats as a
        // not-yet-visible read and backs off (same as a thrown read error).
        current = (await this.readContractWith(
          token,
          'allowance visibility poll',
          (c) => c.allowance(owner, spender),
          { policy: 'failOpenFundingRead' },
        )) as bigint;
      } catch {
        // Transient read failure / stall timeout — treat as not-yet-visible
        // and back off.
        current = -1n;
      }
      if (current >= target) return;
      if (i < POLL_ATTEMPTS - 1) {
        await sleep(Math.min(250 * (i + 1), 1500));
      }
    }
  }

  /**
   * Generalized operational-wallet selector. Orders the pool round-robin from
   * `signerIndex`, narrows to the `spec.txClass` eligibility set, then PREFERS a
   * funded wallet (per `spec.funding`) — optionally an idle one — so a write is
   * never routed to an eligible-but-empty wallet. When no candidate is fundable
   * it falls back to the best-funded one (the caller then surfaces an actionable
   * error rather than a raw revert). `DKG_DISABLE_FUNDED_WALLET_SELECTION` is the
   * only path that reverts to a plain round-robin pick (the first eligible
   * wallet, no balance reads). Serialized via `signerSelectionQueue` so
   * concurrent selections advance the `signerIndex` cursor coherently.
   *
   * `nextAuthorizedSigner` is the thin publish wrapper over this; RS / update /
   * relay route through it with their own `txClass` + `FundingMode` in later phases.
   */
  private async _withSignerSelection<T extends { address: string }>(
    select: (ordered: Wallet[]) => Promise<T>,
  ): Promise<T> {
    const previousSelection = this.signerSelectionQueue;
    let releaseSelection!: () => void;
    this.signerSelectionQueue = new Promise<void>((resolve) => { releaseSelection = resolve; });
    await previousSelection;
    try {
      const start = this.signerIndex % this.signerPool.length;
      const ordered: Wallet[] = [];
      for (let i = 0; i < this.signerPool.length; i += 1) {
        ordered.push(this.signerPool[(start + i) % this.signerPool.length]);
      }
      const chosen = await select(ordered);
      const chosenPoolIdx = this.signerPool.findIndex((s) => s.address === chosen.address);
      this.signerIndex = (chosenPoolIdx >= 0 ? chosenPoolIdx : 0) + 1;
      return chosen;
    } finally {
      releaseSelection();
    }
  }

  private async _authorizedPublisherSigners(
    ordered: Wallet[],
    contextGraphId: bigint,
  ): Promise<Wallet[]> {
    if (!this.contracts.contextGraphs) return ordered;
    const eligible: Wallet[] = [];
    for (const signer of ordered) {
      if (await this.readContract(
        this.contracts.contextGraphs, 'contextGraphs.isAuthorizedPublisher',
        'isAuthorizedPublisher', contextGraphId, signer.address,
      )) {
        eligible.push(signer);
      }
    }
    if (eligible.length === 0) {
      throw new Error(
        `No authorized publisher wallet found in signer pool for context graph ${contextGraphId.toString()}. ` +
        'Ensure at least one configured wallet is permitted by on-chain publish authority.',
      );
    }
    return eligible;
  }

  protected async selectSigner(spec: SelectSignerSpec): Promise<Wallet> {
    return this._withSignerSelection(async (ordered) => {
      // Eligibility by class. `rotatable-policy` filters to on-chain authorized
      // publishers for the CG; with no ContextGraphs surface every operational
      // wallet is a candidate (funding-aware over the whole pool, NOT a plain
      // pick). `rotatable-free` (RS) narrows to on-chain-registered operational
      // wallets, failing CLOSED. `rotatable-funded` uses the whole pool.
      let eligible: Wallet[];
      if (spec.txClass === 'rotatable-policy') {
        eligible = await this._authorizedPublisherSigners(ordered, spec.contextGraphId);
      } else if (spec.txClass === 'rotatable-free') {
        // FAIL CLOSED to registered operational wallets. An unregistered signer
        // resolves to identity 0 on `RandomSampling` and reverts, burning the
        // proof period, so a not-yet-confirmed wallet must NOT be selected.
        // `this.signer` (pool[0]) is always registered, so the fallback is safe
        // and never empty. See `registeredOperationalAddresses`.
        eligible = ordered.filter((w) => this.registeredOperationalAddresses.has(w.address.toLowerCase()));
        if (eligible.length === 0) eligible = [this.signer];
      } else {
        eligible = ordered;
      }

      const chosen = this.fundedWalletSelectionDisabled
        ? eligible[0]
        : await this.selectFundedSigner(
          eligible,
          spec.funding,
          { preferIdle: spec.preferIdle ?? false },
        );
      return chosen;
    });
  }

  /**
   * Thin publish wrapper over {@link selectSigner}: pick the operational wallet
   * that signs the next publish tx among the CG's on-chain authorized
   * publishers, funding-aware over native gas AND own-TRAC (or a covering PCA
   * agent). Idle preference is OFF for publish until soaked. Behaviour is
   * unchanged from the pre-`selectSigner` implementation.
   */
  protected async nextAuthorizedSigner(
    contextGraphId: bigint,
    requiredTracWei: bigint = 0n,
    options: {
      publishEpochs?: number;
    } = {},
  ): Promise<Wallet> {
    return this.selectSigner({
      txClass: 'rotatable-policy',
      contextGraphId,
      funding: {
        kind: 'native+trac',
        nativeFloorWei: this.minPublisherNativeWei,
        tracFloorWei: this.minPublisherTracWei,
        requiredTracWei,
        pca: options.publishEpochs === undefined
          ? { kind: 'provisional-publish' }
          : { kind: 'publish', epochs: options.publishEpochs },
      },
      preferIdle: false,
    });
  }

  /**
   * Thin random-sampling wrapper over {@link selectSigner}: pick a REGISTERED
   * operational wallet to sign the next `createChallenge` / `submitProof`.
   * `rotatable-free` because RS moves zero value (native gas only — the contract
   * has no TRAC transfer) and its score accrues to the node's identity via
   * `getIdentityId(msg.sender)` regardless of WHICH registered operational
   * wallet signs. `preferIdle` biases toward a wallet whose per-wallet lock is
   * free so a deadline-bound proof does not queue behind an in-flight publish on
   * the primary wallet (the wallet-#0 head-of-line contention this rotation
   * removes). Eligibility fails closed to the primary signer (see selectSigner).
   */
  protected async nextRandomSamplingSigner(): Promise<Wallet> {
    // Bounded loop: every failed revalidation EVICTS the chosen wallet from
    // the registered set (strictly shrinking pool) and the primary signer
    // returns unconditionally, so this cannot spin.
    for (;;) {
      const chosen = await this.selectSigner({
        txClass: 'rotatable-free',
        funding: { kind: 'native-only', nativeFloorWei: this.minPublisherNativeWei },
        preferIdle: true,
      });
      // The primary signer is the identity anchor (registered at profile
      // creation); if IT stopped resolving, the node is broken at a level
      // rotation cannot fix — keep existing behavior.
      if (chosen.address === this.signer.address) return chosen;
      // Durable close for the OUT-OF-BAND removal race:
      // `registeredOperationalAddresses` only observes same-process
      // add/remove, so a wallet removed from THIS identity (and possibly
      // re-registered to ANOTHER) by a second node instance or a direct admin
      // tx stays in the set — and an RS tx it signs would act for the OTHER
      // identity (`RandomSampling` keys off `getIdentityId(msg.sender)`),
      // silently burning that identity's proof period. Revalidate only the
      // CHOSEN wallet on-chain (one fresh read per RS selection). FAIL OPEN on
      // read errors (an RPC blip must not stall proofs); fail CLOSED on a
      // definitive mismatch: evict + re-select.
      let onChainId: bigint | null;
      try {
        onChainId = await this.refreshIdentityIdForAddress(chosen.address);
      } catch {
        onChainId = null;
      }
      if (onChainId === null) return chosen;
      const ourId = await this.getIdentityId().catch(() => 0n);
      if (ourId === 0n || onChainId === ourId) return chosen;
      this.registeredOperationalAddresses.delete(chosen.address.toLowerCase());
      console.warn(
        `[chain] RS signer ${chosen.address} no longer resolves to this node's identity ` +
        `(on-chain identityId=${onChainId}, ours=${ourId}) — evicted from RS rotation; re-selecting.`,
      );
    }
  }

  /**
   * Among `candidates` (already in round-robin order), return the first that is
   * fundable per `funding` — or, when `preferIdle` and idle-aware selection is
   * enabled, the first fundable wallet whose per-wallet lock is currently free.
   * Balance reads are short-TTL cached, run in parallel, and FAIL OPEN (a read
   * error / timeout counts the wallet as fundable) so a flaky RPC never blocks a
   * write. When none is fundable, return the best-funded wallet (max native,
   * then max TRAC) so the write still attempts and the contract gives the real
   * verdict.
   */
  private async _scanCandidateFunding<T extends { address: string }>(
    candidates: T[],
    fundingFor: (candidate: T) => FundingMode,
    forceRefresh = false,
  ): Promise<{
    fundings: Array<{ native: bigint | null; trac: bigint | null }>;
    fundableIdx: number[];
  }> {
    const fundingModes = candidates.map(fundingFor);
    const fundings = await Promise.all(
      candidates.map((candidate, index) => {
        const funding = fundingModes[index];
        return this.getWalletFunding(candidate.address, {
          forceRefresh,
          metrics: funding.kind,
        });
      }),
    );
    const fundable = await Promise.all(
      candidates.map((candidate, index) => this.isWalletFundable(
        candidate.address,
        fundings[index],
        fundingModes[index],
      )),
    );
    const fundableIdx: number[] = [];
    for (let index = 0; index < fundable.length; index += 1) {
      if (fundable[index]) fundableIdx.push(index);
    }
    return { fundings, fundableIdx };
  }

  private _preferredFundableCandidate<T extends { address: string }>(
    candidates: T[],
    fundableIdx: number[],
    preferIdle: boolean,
  ): T {
    if (preferIdle && !this.idleAwareSelectionDisabled) {
      const idle = fundableIdx.find((index) =>
        !this.signerTxSerializer.isActive(candidates[index].address));
      if (idle !== undefined) return candidates[idle];
    }
    return candidates[fundableIdx[0]];
  }

  protected async selectFundedSigner(
    candidates: Wallet[],
    funding: FundingMode,
    policy: { preferIdle: boolean },
  ): Promise<Wallet> {
    // Mode-aware read: native-only selections (RS) touch only the native slot
    // so their high-frequency probes can't poison the cached TRAC balance.
    const { fundings, fundableIdx } = await this._scanCandidateFunding(
      candidates,
      () => funding,
    );
    if (fundableIdx.length > 0) {
      // Idle preference is a SOFT, fail-open bias: among funded candidates,
      // prefer one whose per-wallet send lock is currently free so a
      // deadline-bound write doesn't queue behind a slow in-flight send. Falls
      // straight through to the first funded candidate when none is idle or the
      // preference is off — so it can never EXCLUDE a wallet, only reorder.
      return this._preferredFundableCandidate(candidates, fundableIdx, policy.preferIdle);
    }
    let bestIdx = 0;
    for (let i = 1; i < candidates.length; i += 1) {
      const a = fundings[i];
      const b = fundings[bestIdx];
      const an = a.native ?? -1n;
      const bn = b.native ?? -1n;
      if (an > bn || (an === bn && (a.trac ?? -1n) > (b.trac ?? -1n))) bestIdx = i;
    }
    return candidates[bestIdx];
  }

  /**
   * Fail-closed counterpart used only by explicit publisher reservation. The
   * common selector stays best-effort; this path verifies its cached choice and
   * force-refreshes every candidate before claiming that the pool is unfunded.
   */
  protected async selectFundedSignerOrThrow(
    candidates: Wallet[],
    funding: NativeAndTracFundingMode,
    policy: { preferIdle: boolean },
  ): Promise<Wallet> {
    return this._selectFundedCandidateOrThrow(candidates, () => funding, policy);
  }

  /**
   * Canonical fail-closed funded-candidate selector. Ordinary strict signer
   * reservation and publish-plan candidates share the same cached scan, fresh
   * terminal recheck, idle preference, diagnostics, and typed failure.
   */
  private async _selectFundedCandidateOrThrow<T extends { address: string }>(
    candidates: T[],
    fundingFor: (candidate: T) => NativeAndTracFundingMode,
    policy: { preferIdle: boolean },
  ): Promise<T> {
    const initial = await this._scanCandidateFunding(candidates, fundingFor);
    if (initial.fundableIdx.length > 0) {
      return this._preferredFundableCandidate(candidates, initial.fundableIdx, policy.preferIdle);
    }

    // Cached balances are appropriate for soft routing, but a terminal
    // whole-pool claim must be based on a fresh snapshot. Operators commonly
    // fund a wallet and retry immediately, inside the advisory cache TTL.
    const refreshed = await this._scanCandidateFunding(candidates, fundingFor, true);
    if (refreshed.fundableIdx.length > 0) {
      return this._preferredFundableCandidate(candidates, refreshed.fundableIdx, policy.preferIdle);
    }

    const diagnostics = candidates.map((candidate, index) => ({
      address: candidate.address,
      nativeWei: refreshed.fundings[index].native,
      tracWei: refreshed.fundings[index].trac,
    }));
    throw new InsufficientPublisherFundsError(
      formatNoFundedPublisherWalletMessage(diagnostics),
      diagnostics,
    );
  }

  /** Shared AskStorage quote used by both the public read and publish planning. */
  protected async quoteRequiredPublishTokenAmount(
    publicByteSize: bigint,
    epochs: number,
  ): Promise<bigint> {
    if (!this.contracts.askStorage) {
      throw new Error('AskStorage not available');
    }
    const ask = await this.readContract(
      this.contracts.askStorage,
      'askStorage.getStakeWeightedAverageAsk',
      'getStakeWeightedAverageAsk',
    );
    return (BigInt(ask) * publicByteSize * BigInt(epochs)) / 1024n;
  }

  /**
   * Optional typed PCA planning capability. The conviction mixin overrides
   * this hook; adapter assemblies without that mixin safely stay direct-spend.
   */
  protected publisherConvictionPlanReader(): PublisherConvictionPlanReader | undefined {
    return undefined;
  }

  private async _publisherCandidatePlan(
    signer: Wallet,
    request: PublisherPublishPlanRequest,
    quote: (epochs: number) => Promise<bigint>,
  ): Promise<PublisherCandidatePlan> {
    const pricing = await resolvePublisherCandidatePricing({
      publisherAddress: signer.address,
      explicitPublishEpochs: request.explicitPublishEpochs,
      defaultPublishEpochs: request.defaultPublishEpochs,
      quote,
      conviction: this.contracts.dkgPublishingConvictionNFT
        ? this.publisherConvictionPlanReader()
        : undefined,
    });
    const diagnostics = pricing.source === 'direct' ? pricing.diagnostics : undefined;
    if (diagnostics?.pcaProbeError !== undefined) {
      console.warn(
        `[chain] PCA publish-plan probe failed for signer=${signer.address}; ` +
        `using direct-spend lifetime=${pricing.publishEpochs}: ${errorMessage(diagnostics.pcaProbeError)}`,
      );
    }
    if (diagnostics?.quoteError !== undefined) {
      console.warn(
        `[chain] Publish-plan quote failed for byteSize=${request.effectiveByteSize}, ` +
        `epochs=${pricing.publishEpochs}; using protocol minimum ${pricing.tokenAmount}: ` +
        `${errorMessage(diagnostics.quoteError)}`,
      );
    }

    return {
      signer,
      address: signer.address,
      publisherAddress: signer.address,
      publishEpochs: pricing.publishEpochs,
      tokenAmount: pricing.tokenAmount,
    };
  }

  /**
   * Adapter-owned publish planning state machine. Candidate discovery, PCA
   * lifetime selection, exact quote validation, strict funding, and cursor
   * advancement happen atomically behind this boundary.
   */
  protected async resolveFundedPublisherPublishPlan(
    request: PublisherPublishPlanRequest,
  ): Promise<PublisherPublishPlan> {
    const quoteCache = new Map<number, Promise<bigint>>();
    const quote = (epochs: number): Promise<bigint> => {
      const cached = quoteCache.get(epochs);
      if (cached) return cached;
      const pending = this.quoteRequiredPublishTokenAmount(request.effectiveByteSize, epochs)
        .catch((error) => {
          // A transient PCA-lock quote failure must not poison the fallback
          // direct-spend quote for the same numeric lifetime.
          quoteCache.delete(epochs);
          throw error;
        });
      quoteCache.set(epochs, pending);
      return pending;
    };

    if (request.publisherAddress) {
      const signer = await this.resolvePinnedPublisherSigner(
        request.contextGraphId,
        request.publisherAddress,
      );
      const plan = await this._publisherCandidatePlan(signer, request, quote);
      await this.selectFundedSignerOrThrow(
        [signer],
        {
          kind: 'native+trac',
          nativeFloorWei: this.minPublisherNativeWei,
          tracFloorWei: this.minPublisherTracWei,
          requiredTracWei: plan.tokenAmount,
          pca: { kind: 'publish', epochs: plan.publishEpochs },
        },
        { preferIdle: false },
      );
      return {
        publisherAddress: plan.publisherAddress,
        publishEpochs: plan.publishEpochs,
        tokenAmount: plan.tokenAmount,
      };
    }

    const selectedPlan = await this._withSignerSelection(async (ordered) => {
      const authorized = await this._authorizedPublisherSigners(ordered, request.contextGraphId);
      const plans = await Promise.all(
        authorized.map((signer) => this._publisherCandidatePlan(signer, request, quote)),
      );
      return this._selectFundedCandidateOrThrow(
        plans,
        (plan) => ({
          kind: 'native+trac',
          nativeFloorWei: this.minPublisherNativeWei,
          tracFloorWei: this.minPublisherTracWei,
          requiredTracWei: plan.tokenAmount,
          pca: { kind: 'publish', epochs: plan.publishEpochs },
        }),
        { preferIdle: false },
      );
    });
    // Do not expose the internal Wallet carried only for cursor advancement.
    return {
      publisherAddress: selectedPlan.publisherAddress,
      publishEpochs: selectedPlan.publishEpochs,
      tokenAmount: selectedPlan.tokenAmount,
    };
  }

  /**
   * The single fundability predicate, parameterized by {@link FundingMode}:
   * native gas above the floor, AND — for `native+trac` — own-TRAC covers the
   * write (above the operator floor AND `>= requiredTracWei`, the cost — `0n`
   * when unknown, so only the floor applies), OR the wallet is a registered,
   * covering PCA agent (when `pca` is enabled). `native-only` (RS / relay / settle)
   * gates on gas ALONE — it never applies a TRAC floor, so a valid gas-funded
   * zero-TRAC wallet is not wrongly rejected. A `null` metric (read failed / no
   * token contract) is treated as satisfied so selection FAILS OPEN. The PCA
   * conviction reads run only when own-TRAC is short, so a normally funded
   * wallet pays no extra RPC.
   */
  protected async isWalletFundable(
    address: string,
    f: { native: bigint | null; trac: bigint | null },
    funding: FundingMode,
  ): Promise<boolean> {
    const nativeOk = f.native === null || f.native > funding.nativeFloorWei;
    if (!nativeOk) return false; // even a PCA agent needs gas
    if (funding.kind === 'native-only') return true;
    const ownTracOk = f.trac === null
      || (f.trac > funding.tracFloorWei && f.trac >= funding.requiredTracWei);
    if (ownTracOk) return true;
    if (funding.pca.kind === 'none') return false;
    return this.isConvictionFundedAgent(
      address,
      funding.requiredTracWei,
      funding.pca.kind === 'publish' ? funding.pca.epochs : undefined,
    );
  }

  /**
   * Thin publish wrapper over {@link isWalletFundable} preserving the original
   * `isWalletPublishFundable(address, f, requiredTracWei)` shape used by the
   * error-enrichment path. Native+TRAC with the operator floors and PCA fallback.
   */
  protected async isWalletPublishFundable(
    address: string,
    f: { native: bigint | null; trac: bigint | null },
    requiredTracWei: bigint,
  ): Promise<boolean> {
    return this.isWalletFundable(address, f, {
      kind: 'native+trac',
      nativeFloorWei: this.minPublisherNativeWei,
      tracFloorWei: this.minPublisherTracWei,
      requiredTracWei,
      pca: { kind: 'provisional-publish' },
    });
  }

  /**
   * True iff `address` is a registered Publishing Conviction Account agent whose
   * account can cover a publish costing `requiredCostWei` — i.e. it can publish
   * without holding its own TRAC. A `0n`/unknown cost falls back to a `1n`
   * liveness probe (account exists, not expired, has allowance). Cheap-exit when
   * the PCA NFT is not deployed; best-effort otherwise (any read failure ⇒
   * false, so the wallet then relies on its own-TRAC gate rather than being
   * optimistically selected and reverting). NOTE: with the `1n` liveness probe
   * (cost unknown), a tiny consent-free "squat" PCA (RFC-001 §3.6) whose
   * allowance rounds up to ≥1 wei but cannot cover a real publish can still pass;
   * that is an attacker-induced edge that degrades to a single retry, not a fund
   * loss. When the real cost is threaded (the createKnowledgeAssets paths) the
   * probe prices the actual publish and rejects such squats. The conviction
   * mixin supplies the concrete typed implementation; this base fallback keeps
   * adapter assemblies without that capability safely on own-TRAC funding.
   */
  protected async isConvictionFundedAgent(
    _address: string,
    _requiredCostWei: bigint,
    _publishEpochs?: number,
  ): Promise<boolean> {
    return false;
  }

  /**
   * Best-effort native (+ TRAC) balance read for one operational wallet,
   * per-metric cached for `PUBLISHER_FUNDING_CACHE_TTL_MS`. A read failure /
   * timeout yields `null` for that metric (callers fail open). `forceRefresh`
   * bypasses and warms the cache (used on the error-enrichment path).
   *
   * `metrics: 'native-only'` (RS / relay / settle selections) reads and
   * refreshes ONLY the native slot; the returned `trac` is whatever the cache
   * holds (possibly stale or null) and MUST NOT be consulted by native-only
   * callers (`isWalletFundable` returns before touching it). This keeps
   * high-frequency RS probes from poisoning the TRAC slot publish selections
   * rely on.
   */
  protected async getWalletFunding(
    address: string,
    opts?: { forceRefresh?: boolean; metrics?: 'native-only' | 'native+trac' },
  ): Promise<{ native: bigint | null; trac: bigint | null }> {
    const key = address.toLowerCase();
    const now = Date.now();
    const cached = this.fundingCache.get(key);
    const fresh = (ts: number | undefined) =>
      !opts?.forceRefresh && ts !== undefined && now - ts < PUBLISHER_FUNDING_CACHE_TTL_MS;
    const readNative = !fresh(cached?.nativeTs);
    const readTrac = (opts?.metrics ?? 'native+trac') === 'native+trac' && !fresh(cached?.tracTs);
    if (!readNative && !readTrac) {
      return { native: cached!.native, trac: cached!.trac };
    }
    const [nativeRead, tracRead] = await Promise.all([
      readNative ? this.readNativeBalance(address) : Promise.resolve(null),
      readTrac ? this.readTracBalance(address) : Promise.resolve(null),
    ]);
    const next = {
      native: readNative ? nativeRead : cached!.native,
      nativeTs: readNative ? now : cached!.nativeTs,
      trac: readTrac ? tracRead : cached?.trac ?? null,
      tracTs: readTrac ? now : cached?.tracTs ?? 0,
    };
    this.fundingCache.set(key, next);
    return { native: next.native, trac: next.trac };
  }

  private async readNativeBalance(address: string): Promise<bigint | null> {
    try {
      return await this.readProvider(
        'publish wallet native balance',
        (p) => p.getBalance(address),
        // Fail-open funding read: keep a HARD per-attempt cap even on the
        // last / single provider so a hung RPC can't stall wallet selection.
        { policy: 'failOpenFundingRead' },
      );
    } catch {
      return null;
    }
  }

  private async readTracBalance(address: string): Promise<bigint | null> {
    const token = this.contracts.token;
    if (!token) return null; // no token contract: TRAC does not gate selection
    try {
      return (await this.readContractWith(
        token, 'token.balanceOf', (c) => c.balanceOf(address),
        { policy: 'failOpenFundingRead' },
      )) as bigint;
    } catch {
      return null;
    }
  }

  /** Snapshot native+TRAC balances for every operational wallet (best-effort,
   *  force-refreshed) for the no-funded-wallet diagnostic. */
  protected async snapshotPublisherWalletBalances(): Promise<PublisherWalletBalance[]> {
    return Promise.all(
      this.signerPool.map(async (s) => {
        const f = await this.getWalletFunding(s.address, { forceRefresh: true });
        return { address: s.address, nativeWei: f.native, tracWei: f.trac };
      }),
    );
  }

  /**
   * If `err` is (or looks like) an insufficient-funds publish failure on
   * `signer`, replace it with an actionable {@link InsufficientPublisherFundsError}
   * carrying every operational wallet's balances; otherwise return `err`
   * unchanged. Best-effort — never lets the enrichment mask the original error.
   */
  protected async enrichInsufficientPublisherFundsError(
    err: unknown,
    signer: Wallet,
    contextGraphId: bigint,
    requiredTracWei: bigint = 0n,
  ): Promise<unknown> {
    try {
      let selectedShort = isInsufficientFundsError(err);
      if (!selectedShort && this.looksLikeFundsRevert(err)) {
        // A TRAC shortfall surfaces as a token transferFrom revert (not an
        // "insufficient funds" string). looksLikeFundsRevert is restricted to
        // funds-SHAPED reverts (not any CALL_EXCEPTION), so an unrelated contract
        // revert is never re-read as a funds problem. Reuse the SINGLE
        // isWalletPublishFundable predicate so selection and enrichment can't
        // drift on the funding rules.
        const f = await this.getWalletFunding(signer.address, { forceRefresh: true });
        selectedShort = !(await this.isWalletPublishFundable(signer.address, f, requiredTracWei));
      }
      // Only emit NO_FUNDED_PUBLISHER_WALLET — which asserts the WHOLE pool is
      // unfunded and maps downstream to a TERMINAL insufficient_funds failure —
      // when no wallet AUTHORIZED for this context graph can fund the cost. If the
      // selected wallet was short but another authorized wallet could cover it (a
      // cost-blind pre-pin, an explicit pinned address, or a stale cached
      // balance), preserve the original error so a retry can reroute to that
      // wallet instead of being told no wallet is funded.
      if (selectedShort && !(await this.poolHasFundableSigner(contextGraphId, requiredTracWei))) {
        const balances = await this.snapshotPublisherWalletBalances();
        return new InsufficientPublisherFundsError(
          formatNoFundedPublisherWalletMessage(balances),
          balances,
          { cause: err },
        );
      }
    } catch {
      /* never let enrichment mask the original failure */
    }
    return err;
  }

  /**
   * True iff some operational wallet AUTHORIZED for `contextGraphId` is fundable
   * for a publish costing `requiredTracWei` (own balance above floor+cost, or a
   * covering PCA agent). Only an authorized+funded wallet is a viable reroute, so
   * a funded-but-unauthorized wallet does NOT suppress NO_FUNDED. Used to
   * distinguish a whole-pool funding problem (→ NO_FUNDED, terminal) from the
   * selected wallet merely being the wrong, recoverable pick. Cached reads;
   * fail-open per wallet.
   */
  protected async poolHasFundableSigner(contextGraphId: bigint, requiredTracWei: bigint): Promise<boolean> {
    const contextGraphs = this.contracts.contextGraphs;
    const checks = await Promise.all(
      this.signerPool.map(async (s) => {
        // No ContextGraphs surface ⇒ every operational wallet is a candidate
        // (mirrors nextAuthorizedSigner); otherwise only authorized wallets are
        // viable reroutes.
        if (contextGraphs && !(await this.readContract(
          contextGraphs, 'contextGraphs.isAuthorizedPublisher',
          'isAuthorizedPublisher', contextGraphId, s.address,
        ))) return false;
        return this.isWalletPublishFundable(s.address, await this.getWalletFunding(s.address), requiredTracWei);
      }),
    );
    return checks.some(Boolean);
  }

  /**
   * True iff `err` is a FUNDS-SHAPED chain revert (a TRAC transfer / allowance
   * shortfall) worth a balance re-read in {@link enrichInsufficientPublisherFundsError}.
   * Deliberately NOT every `CALL_EXCEPTION` / "execution reverted" — a generic
   * contract revert (e.g. an InvalidAuthorAttestation) must never be re-read and
   * masked as an insufficient-funds error. Also excludes our own control-flow
   * sentinels (null/dropped receipt, write-ahead-hook failure).
   */
  protected looksLikeFundsRevert(err: unknown): boolean {
    const msg = errorMessage(err).toLowerCase();
    if (/receipt is null|receipt was null|replaced or dropped|write-?ahead/.test(msg)) {
      return false;
    }
    return /transfer amount exceeds balance|erc20insufficientbalance|insufficient allowance|toolowallowance|toolowbalance|insufficient funds/.test(msg);
  }

  /** All operational wallet addresses (for display / funding). */
  getSignerAddresses(): string[] {
    return this.signerPool.map((s) => s.address);
  }

  /** Primary operational private key (hex string with 0x prefix). */
  getOperationalPrivateKey(): string {
    return this.signer.privateKey;
  }

  protected walletKeyHash(address: string): string {
    return ethers.keccak256(ethers.solidityPacked(['address'], [ethers.getAddress(address)]));
  }

  protected async getIdentityStorage(options: { refresh?: boolean } = {}): Promise<Contract> {
    if (options.refresh || !this.contracts.identityStorage) {
      this.contracts.identityStorage = await this.resolveContract('IdentityStorage');
    }
    return this.contracts.identityStorage;
  }

  protected async getConvictionStakingStorage(): Promise<Contract | null> {
    if (!this.contracts.convictionStakingStorage) {
      try {
        this.contracts.convictionStakingStorage = await this.resolveContract('ConvictionStakingStorage');
      } catch { return null; }
    }
    return this.contracts.convictionStakingStorage;
  }

  protected async getStakingStorage(): Promise<Contract | null> {
    if (!this.contracts.stakingStorage) {
      try {
        this.contracts.stakingStorage = await this.resolveContract('StakingStorage');
      } catch { return null; }
    }
    return this.contracts.stakingStorage;
  }

  protected async hasAdminPurpose(
    identityStorage: Contract,
    identityId: bigint,
    address: string,
  ): Promise<boolean> {
    return this.readContract(
      identityStorage, 'identityStorage.keyHasPurpose',
      'keyHasPurpose', identityId, this.walletKeyHash(address), ADMIN_KEY_PURPOSE,
    );
  }

  protected async hasOperationalPurpose(
    identityStorage: Contract,
    identityId: bigint,
    address: string,
  ): Promise<boolean> {
    return this.readContract(
      identityStorage, 'identityStorage.keyHasPurpose',
      'keyHasPurpose', identityId, this.walletKeyHash(address), OPERATIONAL_KEY_PURPOSE,
    );
  }

  async isOperationalWalletRegistered(identityId: bigint, address: string): Promise<boolean> {
    await this.init();
    const identityStorage = await this.getIdentityStorage();
    return this.hasOperationalPurpose(identityStorage, identityId, address);
  }

  protected async resolveContract(name: string, abiName?: string): Promise<Contract> {
    const address = await this.resolveContractAddress(name);
    // Build the handle fresh every call — a cheap object build (no RPC). Only the
    // ADDRESS is memoized (#1583); reads use staticCall and writes .connect() an
    // explicit signer, so no stale-signer risk from the constant readonly signer.
    return new Contract(address, loadAbi(abiName ?? name), this.signer);
  }

  /**
   * #1583 — resolve a Hub-registered contract's proxy address, served from
   * `resolvedContractAddressCache` when memoizable. Names in
   * `RESOLVE_CONTRACT_ADDRESS_MEMO_EXCLUDED` always hit the Hub. The loader
   * (`readHubContractAddress`) throws on a missing/zero result so the memo only
   * ever holds a successfully-resolved non-zero address (a negative result must
   * not poison the cache — the next call re-tries).
   *
   * `private`: the only production caller is `resolveContract` (same class). The
   * memo is an implementation detail of `resolveContract`, not a subclass
   * extension point (review of PR #1615, round-2). Unit tests reach it via the
   * usual `any`-cast on the adapter under test.
   */
  private async resolveContractAddress(name: string): Promise<string> {
    if (RESOLVE_CONTRACT_ADDRESS_MEMO_EXCLUDED.has(name)) {
      return this.readHubContractAddress(name);
    }
    const key = `${this.hubAddress}:${this.chainId}:${name}`;
    return this.resolvedContractAddressCache.getOrLoad(
      key,
      key,
      () => this.readHubContractAddress(name),
    );
  }

  private async readHubContractAddress(name: string): Promise<string> {
    let address: string;
    try {
      address = await this.readContract(
        this.contracts.hub,
        `Hub.getContractAddress(${name})`,
        'getContractAddress',
        name,
      );
    } catch (err) {
      if (this.isContractMissingRevert(err)) {
        throw new Error(`Contract "${name}" not found in Hub at ${this.hubAddress}`, { cause: err });
      }
      throw err;
    }
    if (address === ethers.ZeroAddress) {
      throw new Error(`Contract "${name}" not found in Hub at ${this.hubAddress}`);
    }
    return address;
  }

  protected async resolveAssetStorage(name: string, abiName?: string): Promise<Contract> {
    let address: string;
    try {
      address = await this.readContract(
        this.contracts.hub,
        `Hub.getAssetStorageAddress(${name})`,
        'getAssetStorageAddress',
        name,
      );
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
  protected isContractMissingRevert(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    enrichEvmError(err);
    return err.message.includes('ContractDoesNotExist')
      || err.message.includes('AddressDoesNotExist');
  }

  protected async init(): Promise<void> {
    if (this.initialized) return;
    try {
      await this.initContracts();
    } catch (err) {
      // `init()` sits on the critical path of every chain write
      // (`createOnChainContextGraph`, publish, verify, …). If the Hub lookups
      // fail because the configured RPC endpoint(s) are exhausted (perpetual
      // 429 / unreachable), surface the same `RPC_ENDPOINTS_EXHAUSTED` contract
      // the tx-send path uses, so callers (e.g. `/api/context-graph/register`
      // → `classifyRegisterContextGraphError`) map it to a bounded 503 instead
      // of a generic 500 — and never hang waiting on it (#894 follow-up). A
      // non-RPC error (e.g. a genuine "contract not in Hub" misconfig) keeps
      // its original shape.
      if (isRetryableRpcError(err)) {
        throw new ChainRpcTransportError(
          'RPC_ENDPOINTS_EXHAUSTED',
          `chain initialisation failed on all configured RPC endpoints (${this.rpcUrls.map(rpcHost).join(', ')}): ${errorMessage(err)}`,
          { cause: err, rpcUrls: this.rpcUrls },
        );
      }
      throw err;
    }
  }

  protected async initContracts(): Promise<void> {
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

    // V10.1 KA storage. Legacy V8 KnowledgeCollection + V10.0 DKGKnowledgeAssets
    // are deleted in the rc.12 KC->KA rename — no fallback resolution.
    this.contracts.knowledgeAssetStorage = await this.resolveAssetStorage('DKGKnowledgeAssets');

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
      this.contracts.knowledgeAssetsLifecycle = await this.resolveContract('KnowledgeAssetsLifecycle');
    } catch {
      // Lifecycle not deployed — createKnowledgeAssets unavailable.
      // V10.0 KnowledgeAssetsLifecycle fallback was removed in the rc.12 rename.
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

    const tokenAddress: string = this.tokenAddress ?? await this.readContract(
      this.contracts.hub,
      'Hub.getContractAddress(Token)',
      'getContractAddress',
      'Token',
    );
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

  protected requireV9(): void {
    if (!this.contracts.knowledgeAssets || !this.contracts.knowledgeAssetsStorage) {
      throw new Error(
        'V9 contracts (KnowledgeAssets, KnowledgeAssetsStorage) not deployed. ' +
        'Deploy them first using the deploy scripts.',
      );
    }
  }

  protected async getBlockTimestamp(blockNumber: number): Promise<number> {
    // A CONCRETE (already-mined receipt) block — NOT the tip, so it uses normal
    // endpoint stickiness (the endpoint that produced the receipt is the one most
    // likely to already have the block). It is NOT a `skipPreferred` tip read:
    // forcing canonical/primary-first here would instead risk querying a lagging
    // primary that returns `null` for a block a healthy backup already has, and
    // `null` isn't a retryable transport error, so it would surface as a bogus
    // `blockTimestamp: 0`. Treat a `null` block as a FAILOVER condition so another
    // endpoint that has the block can serve it; only if EVERY endpoint lacks it (or
    // transport is down) do we fall back to the best-effort `0` callers tolerate.
    // A `null` block (this endpoint hasn't imported it yet) fails over to another
    // endpoint that has it; best-effort `0` only when EVERY endpoint lacks it and
    // no transport error occurred. Non-retryable / transport-exhaustion errors
    // propagate (never masked as a bogus `0`). Order-independent — see the helper.
    const block = await this.rpcFailover.read(
      'getBlock',
      (p) => p.getBlock(blockNumber),
      {
        rpcUsageConsumer: 'getBlock',
        isEmptyResult: (value) => value == null,
        endpointSetRetry: 'all-throttled',
      },
    );
    return block?.timestamp != null ? Number(block.timestamp) : 0;
  }

  // =====================================================================
  // Identity
  // =====================================================================

  async getIdentityId(): Promise<bigint> {
    return this.readIdentityIdForAddress(this.signer.address);
  }

  // =====================================================================
  // V10 Publish (KnowledgeAssetsLifecycle → DKGKnowledgeAssets)
  // =====================================================================

  async getDKGKnowledgeAssetsAddress(): Promise<string> {
    if (!this.contracts.knowledgeAssetStorage) {
      throw new Error('DKGKnowledgeAssets / DKGKnowledgeAssets not deployed on this chain.');
    }
    return this.contracts.knowledgeAssetStorage.target as string;
  }

  /**
   * OT-RFC-43 Option 1 — highest per-author KA `number` already minted on chain,
   * or `-1n` if `author` never minted. Backs the allocator's cold-start
   * reconciliation so a stale-local-DB / fresh device never re-hands a burned
   * `(author, number)`.
   *
   * Resolution order:
   *   1. `DKGKnowledgeAssets >= 10.0.4` exposes the O(1)
   *      `getMaxKaNumberForAuthor(address) -> int256` view — a single `eth_call`.
   *   2. Pre-10.0.4 deployments do not have that selector, so they fall back to
   *      a paginated `KnowledgeAssetCreated(id, author)` scan ANCHORED at the
   *      contract's deploy block. The original `queryFilter(filter, 0)` scanned
   *      `[0, latest]` in one RPC call and hit provider block-range caps (#1080);
   *      a naive from-genesis paginated scan is ~21k calls under a 2,000-block
   *      cap (e.g. Base Sepolia), so we start at the deploy block instead.
   *
   * An absent selector surfaces in two provider-dependent shapes: `BAD_DATA`
   * (empty `value="0x"`) on some RPCs, or `CALL_EXCEPTION` / "missing revert
   * data" on others (Base Sepolia). The former is unambiguous; the latter is
   * ambiguous with a genuine bare revert, so we only fall back for it once a
   * deployed-bytecode probe confirms the selector is genuinely missing —
   * otherwise the view exists and reverted for real, and we rethrow. Transient
   * RPC failures and decoded reverts are always rethrown, never hidden behind a
   * historical crawl. Empty selector-call responses only reach the scan after
   * confirming bytecode exists at the resolved storage address, so a bad Hub
   * address fails loudly instead of reconciling from empty logs.
   */
  async getMaxKaNumberForAuthor(author: string): Promise<bigint> {
    // Re-resolve contract handles first. The Hub rotation poller flips
    // `initialized` to false but leaves the old bindings in place, so without
    // this a long-lived adapter keeps querying the PRE-rotation
    // DKGKnowledgeAssets after the 10.0.4 redeploy this getter exists for.
    // Mirrors every other contract-reading method (e.g.
    // getKnowledgeAssetsLifecycleAddress).
    await this.init();
    const storage = this.contracts.knowledgeAssetStorage;
    if (!storage) {
      throw new Error('DKGKnowledgeAssets not deployed on this chain.');
    }
    const normalized = ethers.getAddress(author);

    // A CALL_EXCEPTION/"missing revert data" from the view is ambiguous between
    // "pre-10.0.4 contract lacks the selector" (→ scan) and "the view exists and
    // bare-reverted" (→ rethrow). Defer that decision until the deployed
    // bytecode is fetched below.
    let bareRevert: unknown;
    const getMax = (storage as any).getMaxKaNumberForAuthor;
    if (typeof getMax?.staticCall === 'function') {
      try {
        // Route through `readProvider` (which gives the per-attempt stall
        // timeout + endpoint failover for free) with a CUSTOM classifier: the
        // absent-view shapes (`BAD_DATA` empty-`0x`, bare `CALL_EXCEPTION`) are
        // DETERMINISTIC across endpoints and mean "pre-10.0.4 contract lacks the
        // selector", so they are NON-retryable here — `readProvider` rethrows
        // them straight to the catch below (→ scan / bytecode-confirm) instead of
        // failing over and masking them as `RPC_ENDPOINTS_EXHAUSTED`. ONLY a
        // genuine transient advances to the next endpoint. `isKaHighWaterViewUnavailable`
        // runs FIRST (it enriches the error) so the ordering invariant the catch
        // below also relies on is preserved.
        const max = await this.readProvider(
          'DKGKnowledgeAssets.getMaxKaNumberForAuthor',
          (p) => this.rebindContract(storage, p).getMaxKaNumberForAuthor.staticCall(normalized),
          {
            isRetryable: (err) =>
              isRetryableRpcError(err)
              && !isKaHighWaterViewUnavailable(err)
              && !isKaHighWaterBareRevert(err),
          },
        );
        return BigInt(max);
      } catch (err) {
        if (isKaHighWaterViewUnavailable(err)) {
          // Unambiguous absent-view shape → fall through to the bounded scan.
        } else if (isKaHighWaterBareRevert(err)) {
          bareRevert = err; // confirm against the deployed bytecode below
        } else {
          throw err; // transient exhaustion / decoded revert → never crawl
        }
      }
    }

    const storageAddress = await contractAddress(storage);
    const code = await this.readProvider(
      'DKGKnowledgeAssets getCode',
      (p) => p.getCode(storageAddress),
    );
    if (!code || code === '0x') {
      throw new Error(`DKGKnowledgeAssets resolved to ${storageAddress}, but no contract code is deployed there.`);
    }

    // A bare revert is only "view absent" when the selector is genuinely missing
    // from the deployed bytecode; if it IS present the view exists and the
    // revert was real, so rethrow rather than mask it behind a log crawl.
    if (bareRevert !== undefined && kaHighWaterViewSelectorInCode(storage, code)) {
      throw bareRevert;
    }

    // `fromBlock`, `head` and the candidate `scanProviders` come together so the
    // range is consistent (head is the freshest backend's tip) AND each page is
    // crawled on a backend whose tip covers it (querying a lagging backend for
    // blocks above its tip can reject the range or silently truncate it).
    const { fromBlock, head, scanProviders } = await this.resolveKaStorageDeployBlock(storageAddress);
    const pageSize = this.kaHighWaterScanPageSize; // default 2,000 = smallest common eth_getLogs cap
    const pages = Math.ceil((head - fromBlock + 1) / pageSize);
    if (pages > KA_HIGH_WATER_MAX_SCAN_PAGES) {
      throw new Error(
        `getMaxKaNumberForAuthor: the pre-10.0.4 KnowledgeAssetCreated fallback ` +
          `would need ${pages} eth_getLogs calls over blocks [${fromBlock}, ${head}] at a ` +
          `${pageSize}-block window (budget ${KA_HIGH_WATER_MAX_SCAN_PAGES} pages). The deployed ` +
          `DKGKnowledgeAssets (${storageAddress}) lacks the O(1) getMaxKaNumberForAuthor view. ` +
          `Remediations: use an archive RPC that serves historical eth_getCode so the scan ` +
          `anchors at the deploy block${fromBlock === 0 ? ' (it fell back to genesis here)' : ''}, ` +
          `or deploy DKGKnowledgeAssets >= 10.0.4 to remove the scan entirely (a single eth_call).`,
      );
    }

    const filter = storage.filters.KnowledgeAssetCreated(null, normalized);
    const connected = new Map<JsonRpcProvider, Contract>();
    const mask = (1n << 96n) - 1n;
    let max = -1n;
    // Sticky preferred backend: the one that served the previous page. It is tried
    // first for the next page (when it still covers it), so a backend that hung on
    // an earlier page (and was failed-over past) doesn't sit at the front of the
    // line re-stalling every subsequent page on its full timeout.
    let preferred: JsonRpcProvider | undefined;
    for (let lo = fromBlock; lo <= head; lo += pageSize) {
      const hi = Math.min(lo + pageSize - 1, head);
      const { logs, provider } = await this.queryKaCreatedPage(
        storage,
        filter,
        lo,
        hi,
        scanProviders,
        connected,
        preferred,
      );
      preferred = provider;
      for (const log of logs) {
        const args = (log as ethers.EventLog).args;
        const rawId = args?.id ?? args?.[0];
        if (rawId === undefined || rawId === null) continue;
        const num = BigInt(rawId) & mask;
        if (num > max) max = num;
      }
    }
    return max;
  }

  /**
   * Query one `[lo, hi]` page of `KnowledgeAssetCreated` logs, trying each
   * reachable backend whose tip COVERS the page (`backendHead >= hi`) — the
   * sticky `preferred` backend first (when it still covers the page), then the
   * rest freshest-first — and failing over to the next eligible backend on error.
   * This keeps FallbackProvider-style resilience for the scan while never asking a
   * backend for blocks above its own tip (which some nodes reject and others
   * silently truncate). The freshest backend always covers the page (`hi <= head`
   * = its tip), so there is always at least one candidate.
   *
   * Each attempt is bounded by `KA_HIGH_WATER_PAGE_TIMEOUT_MS` so a hung backend
   * fails over after a bounded wait instead of stalling the whole scan; the
   * serving backend is returned so the caller can stick to it for the next page.
   */
  private async queryKaCreatedPage(
    storage: Contract,
    filter: unknown,
    lo: number,
    hi: number,
    scanProviders: ReadonlyArray<ScanProvider>,
    connected: Map<JsonRpcProvider, Contract>,
    preferred?: JsonRpcProvider,
  ): Promise<{ logs: ReadonlyArray<ethers.EventLog | ethers.Log>; provider: JsonRpcProvider }> {
    return this.queryEventLogsPage(
      storage,
      filter,
      lo,
      hi,
      scanProviders,
      connected,
      'getMaxKaNumberForAuthor KnowledgeAssetCreated',
      preferred,
    );
  }

  protected async queryEventLogsPage(
    baseContract: Contract,
    filter: unknown,
    lo: number,
    hi: number,
    scanProviders: ReadonlyArray<ScanProvider>,
    connected: Map<JsonRpcProvider, Contract>,
    label: string,
    preferred?: JsonRpcProvider,
  ): Promise<{ logs: ReadonlyArray<ethers.EventLog | ethers.Log>; provider: JsonRpcProvider }> {
    return withSpan(
      'chain.eth_getLogs',
      async (span) => {
        const metrics = getMetrics();
        const startedAt = Date.now();
        // Eligible backends (tip covers the page), with the sticky preferred one moved
        // to the front when it still qualifies; the remainder keep their freshest-first
        // order from `scanProviders`.
        const eligible = scanProviders.filter(({ backendHead }) => backendHead >= hi);
        const ordered =
          preferred && eligible.some(({ provider }) => provider === preferred)
            ? [
                ...eligible.filter(({ provider }) => provider === preferred),
                ...eligible.filter(({ provider }) => provider !== preferred),
              ]
            : eligible;
        let pageError: unknown;
        for (const { provider } of ordered) {
          try {
            await withTimeout(
              this.ensureConfiguredStaticChainIdValidated(provider),
              RPC_READ_STALL_TIMEOUT_MS,
              `${label} chainId validation`,
            );
            let contract = connected.get(provider);
            if (!contract) {
              contract = baseContract.connect(provider) as Contract;
              connected.set(provider, contract);
            }
            const logs = await withTimeout(
              contract.queryFilter(filter as any, lo, hi),
              KA_HIGH_WATER_PAGE_TIMEOUT_MS,
              `${label} getLogs [${lo}, ${hi}]`,
            );
            metrics.chainRpcTotal.add(1, {
              rpc_method: 'eth_getLogs', outcome: 'ok', retryable: false, chain_id: this.chainId,
            });
            metrics.chainRpcDuration.record(Date.now() - startedAt, {
              rpc_method: 'eth_getLogs', chain_id: this.chainId,
            });
            return { logs, provider };
          } catch (err) {
            pageError = err; // hung or errored — fail over to the next eligible backend
          }
        }
        // Every eligible backend failed for this page → one error/timeout outcome.
        const outcome = pageError ? this._rpcOutcomeForError(pageError) : 'error';
        metrics.chainRpcTotal.add(1, {
          rpc_method: 'eth_getLogs', outcome, retryable: isRetryableRpcError(pageError), chain_id: this.chainId,
        });
        metrics.chainRpcDuration.record(Date.now() - startedAt, {
          rpc_method: 'eth_getLogs', chain_id: this.chainId,
        });
        throw new Error(
          `${label}: no configured RPC could serve the log range [${lo}, ${hi}]` +
            `${pageError ? `: ${errorMessage(pageError)}` : ''}.`,
          pageError ? { cause: pageError } : undefined,
        );
      },
      {
        attributes: {
          'rpc.method': 'eth_getLogs', 'dkg.chain_id': this.chainId,
          'dkg.block_lo': lo, 'dkg.block_hi': hi,
        },
      },
    );
  }

  /**
   * Resolve the pre-10.0.4 KnowledgeAssetCreated fallback's scan range — the
   * contract's deploy block (`fromBlock`, so the scan starts at the contract's
   * birth instead of genesis) and the chain `head` — returned together so the
   * caller's `[fromBlock, head]` is internally consistent (a separately-read head
   * could be a lagging backend BELOW the deploy block, yielding an empty range
   * and a wrong `-1n`).
   *
   * `head` is the FRESHEST block number across all reachable backends, so the
   * scan never stops at a slightly-stale backend and under-reports the current
   * max (which would re-hand a burned `(author, number)`). The deploy block is
   * immutable, so pairing it with the max head is safe.
   *
   * The deploy block is cached (immutable per address); otherwise it is binary-
   * searched on a backend that serves historical getCode, with each backend's
   * search pinned to ITS OWN head (a quorum-1 `FallbackProvider` could otherwise
   * mix block-number and getCode across backends and cache a stale head as the
   * "deploy block"). We fail over across backends, so a pruned/lagging endpoint
   * yields to a healthier archive secondary.
   *
   * If NO backend can pin the deploy block we DEGRADE to block 0 — the safe lower
   * bound (`<= deploy`, so the scan never misses an event), bounded by the page
   * budget — rather than hard-failing (pruned nodes still serve `queryFilter`).
   * The degraded `0` is NOT cached. A real outage / auth / timeout (not a
   * historical-state-unavailable shape) on every backend is RETHROWN, not masked
   * as a pre-10.0.4 fallback (see `isHistoricalStateUnavailable`).
   */
  protected async resolveKaStorageDeployBlock(
    address: string,
  ): Promise<{
    fromBlock: number;
    head: number;
    scanProviders: ReadonlyArray<ScanProvider>;
  }> {
    return this.resolveContractDeployBlock(
      address,
      'getMaxKaNumberForAuthor',
      'DKGKnowledgeAssets',
    );
  }

  protected async resolveLogScanHead(
    operationLabel: string,
  ): Promise<{
    head: number;
    scanProviders: ReadonlyArray<ScanProvider>;
  }> {
    let probeError: unknown;
    const reachable: ScanProvider[] = [];
    for (const provider of this.providers) {
      try {
        await withTimeout(
          this.ensureConfiguredStaticChainIdValidated(provider),
          RPC_READ_STALL_TIMEOUT_MS,
          `${operationLabel} chainId validation`,
        );
        const backendHead = await withTimeout(
          provider.getBlockNumber(),
          RPC_READ_STALL_TIMEOUT_MS,
          `${operationLabel} backend head probe`,
        );
        reachable.push({ provider, backendHead });
      } catch (err) {
        if (!isHistoricalStateUnavailable(err)) probeError = err;
      }
    }
    if (reachable.length === 0) {
      if (probeError !== undefined) throw probeError;
      throw new Error(`${operationLabel}: no RPC backend returned a block number to anchor the log scan.`);
    }
    reachable.sort((a, b) => b.backendHead - a.backendHead);
    return { head: reachable[0].backendHead, scanProviders: reachable };
  }

  protected async resolveContractDeployBlock(
    address: string,
    operationLabel: string,
    contractLabel: string,
  ): Promise<{
    fromBlock: number;
    head: number;
    scanProviders: ReadonlyArray<ScanProvider>;
    degradedFromGenesis?: boolean;
  }> {
    // 1. Probe every reachable backend for its head; order freshest-first. A
    //    head-probe failure on an UNREACHABLE backend is kept separate — it only
    //    matters when NO backend is reachable at all; it must NOT force a throw
    //    when a reachable (e.g. pruned) backend could still degrade to the scan.
    let probeError: unknown;
    const reachable: ScanProvider[] = [];
    for (const provider of this.providers) {
      try {
        await withTimeout(
          this.ensureConfiguredStaticChainIdValidated(provider),
          RPC_READ_STALL_TIMEOUT_MS,
          `${operationLabel} chainId validation`,
        );
        // Bound the probe: these are direct per-backend reads (not via the
        // FallbackProvider), so without a timeout a hung `getBlockNumber()` would
        // stall the whole resolution instead of failing over. A stall rejects and
        // is treated like any other unreachable-backend error below.
        const backendHead = await withTimeout(
          provider.getBlockNumber(),
          RPC_READ_STALL_TIMEOUT_MS,
          `${operationLabel} backend head probe`,
        );
        reachable.push({ provider, backendHead });
      } catch (err) {
        if (!isHistoricalStateUnavailable(err)) probeError = err;
      }
    }
    if (reachable.length === 0) {
      if (probeError !== undefined) throw probeError;
      throw new Error(`${operationLabel}: no RPC backend returned a block number to anchor the log scan.`);
    }
    reachable.sort((a, b) => b.backendHead - a.backendHead);
    // `head` is the FRESHEST backend's tip. The caller crawls each page on the
    // freshest backend whose tip COVERS that page (with failover), so it never
    // queries blocks above a backend's own tip. The deploy block is immutable, so
    // pairing it with this head is safe even when a different (archive) backend
    // resolves it below.
    const head = reachable[0].backendHead;

    // 2. Deploy block (immutable): cache hit, else binary-search a backend that
    //    serves historical getCode — each search uses ITS OWN head (self-
    //    consistent); fail over across backends, freshest-first.
    const cacheKey = address.toLowerCase();
    const cached = this.cachedContractDeployBlocks.get(cacheKey);
    if (cached !== undefined) return { fromBlock: cached, head, scanProviders: reachable };
    let throttle: unknown; // a transient rate-limit/throttle seen during the search
    const throttledProviders = new Set<JsonRpcProvider>();
    for (const { provider: searchProvider, backendHead } of reachable) {
      try {
        // Verify code at this backend's head before searching it; a head BEFORE
        // deploy on this backend is skipped (would otherwise cache a stale value).
        if ((await this.getContractCodeAtBlock(
          searchProvider,
          address,
          backendHead,
          operationLabel,
          contractLabel,
        )) === '0x') {
          continue;
        }
        let lo = 0;
        let hi = backendHead;
        while (lo < hi) {
          const mid = lo + Math.floor((hi - lo) / 2);
          const codeAtMid = await this.getContractCodeAtBlock(
            searchProvider,
            address,
            mid,
            operationLabel,
            contractLabel,
          );
          if (codeAtMid !== '0x') hi = mid;
          else lo = mid + 1;
        }
        this.cachedContractDeployBlocks.set(cacheKey, lo);
        // Drop any backend that throttled earlier in this search from the scan too
        // (same rationale as the degraded path below — a throttled endpoint must not
        // be re-queried by the log scan). The backend that just pinned the deploy
        // block isn't throttled, so this is always non-empty.
        return { fromBlock: lo, head, scanProviders: reachable.filter((r) => !throttledProviders.has(r.provider)) };
      } catch (err) {
        // Always fail over to the next backend FIRST (a healthy archive can still
        // pin the deploy block even if this one is denied/pruned/flaky). Track a
        // transient throttle per-backend: re-querying that endpoint in the scan
        // would only worsen its throttle, so it is dropped from the scan providers
        // below. Everything else — pruned state, a STATIC access/plan/archive
        // denial, a transient timeout/503, a hard 401 — is just dropped: the deploy
        // anchor is a scan-range optimization, not a liveness gate, and the genesis
        // scan still computes the answer on a non-archive backend (it needs no
        // archive state) or surfaces a total outage.
        if (isTransientThrottle(err)) {
          throttle = err;
          throttledProviders.add(searchProvider);
        }
      }
    }
    // No backend pinned the deploy block. Degrade to the genesis-anchored scan on
    // the NON-throttled backends: dropping a throttled endpoint keeps the scan from
    // worsening its throttle, while a healthy / non-archive backend still serves
    // `eth_getLogs` (the scan needs no archive state) and computes the high-water
    // mark — so one throttled archive must not abort a publish another backend can
    // complete. `head` stays the FRESHEST tip (never lowered to a stale backend),
    // so the scan can't under-report by skipping recent blocks: a page only a
    // dropped backend could cover instead surfaces via `queryKaCreatedPage`. Only if
    // EVERY reachable backend was throttled — nothing left to scan — do we surface
    // the throttle. A genuine total outage on the remaining backends is likewise
    // surfaced by the scan (page-1 throw with cause). The degraded `0` is not cached.
    const scanProviders = reachable.filter((r) => !throttledProviders.has(r.provider));
    if (scanProviders.length === 0) throw throttle;
    return { fromBlock: 0, head, scanProviders, degradedFromGenesis: true };
  }

  /**
   * `eth_getCode(address, block)` on a SPECIFIC `provider` (pinned to one backend
   * for the deploy-block search), normalised to `'0x'` when there is genuinely no
   * code, with a small retry so a transient blip is not misread as "no code"
   * (which would anchor the scan too high). A persistent failure throws a wrapped
   * error carrying the contract/block context, with the ORIGINAL error preserved
   * as `cause` so `resolveKaStorageDeployBlock` (and operators) can classify and
   * diagnose it — degrade only for historical-state-unavailable, surface real
   * outages/auth/timeouts.
   */
  private async getContractCodeAtBlock(
    provider: JsonRpcProvider,
    address: string,
    block: number,
    operationLabel: string,
    contractLabel: string,
  ): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        // Bound each attempt: this is a direct per-backend read (the deploy-block
        // search is pinned to one backend, so it bypasses the FallbackProvider's
        // own stall timeout). Without this, a hung `getCode` would block the search
        // forever instead of failing over to the next backend; a stall rejects and
        // is retried, then surfaced as the wrapped failure below. `getCode` is a
        // light single-block state lookup, so the adapter-wide read-stall bound
        // fits (the heavier getLogs scan page gets the larger
        // `KA_HIGH_WATER_PAGE_TIMEOUT_MS`); the 3 attempts also absorb a transient
        // blip before failing over.
        const code = await withTimeout(
          provider.getCode(address, block),
          RPC_READ_STALL_TIMEOUT_MS,
          `${operationLabel} eth_getCode at block ${block}`,
        );
        return code && code !== '0x' ? code : '0x';
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(
      `${operationLabel}: eth_getCode for ${contractLabel} ${address} at block ${block} ` +
        `failed after 3 attempts: ${errorMessage(lastErr)}`,
      { cause: lastErr },
    );
  }

  async getKnowledgeAssetsLifecycleAddress(): Promise<string> {
    // PR3 / RC11: TTL-cached. KAV10 address only changes on a contract
    // redeploy + Hub-rotation event; 1h staleness is harmless and the
    // ACK digest mismatch the contract would surface on actually-stale
    // input is loud enough that operators would notice immediately.
    const now = Date.now();
    if (EVMChainAdapterBase.preflightCacheFresh(this.cachedKav10Address, now)) {
      return this.cachedKav10Address!.value;
    }
    await this.init();
    if (!this.contracts.knowledgeAssetsLifecycle) {
      throw new Error('KnowledgeAssetsLifecycle / KnowledgeAssetsLifecycle contract not deployed on this chain.');
    }
    const addr = await this.contracts.knowledgeAssetsLifecycle.getAddress();
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
    if (EVMChainAdapterBase.preflightCacheFresh(this.cachedChainId, now)) {
      return this.cachedChainId!.value;
    }
    const chainId = this.configuredStaticChainId == null
      ? (await this.readProvider('getNetwork (chainId)', (p) => p.getNetwork())).chainId
      : await this.rpcFailover.read(
          'validate configured chainId',
          (p) => this.ensureConfiguredStaticChainIdValidated(p),
        );
    this.cachedChainId = { value: chainId, cachedAt: now };
    return chainId;
  }

  protected async ensureConfiguredStaticChainIdValidated(provider: JsonRpcProvider): Promise<bigint> {
    if (this.configuredStaticChainId == null) return 0n;
    const now = Date.now();
    const cached = this.configuredStaticChainIdsByProvider.get(provider);
    if (EVMChainAdapterBase.preflightCacheFresh(cached, now)) {
      return cached!.value;
    }

    let validation = this.configuredStaticChainIdValidationsByProvider.get(provider);
    if (!validation) {
      validation = withTimeout(
        (async () => {
          const raw = await provider.send('eth_chainId', []);
          const live = BigInt(raw);
          if (live !== this.configuredStaticChainId) {
            throw new Error(
              `Configured chainId ${this.configuredStaticChainId} does not match RPC chainId ${live}`,
            );
          }
          this.configuredStaticChainIdsByProvider.set(provider, { value: live, cachedAt: Date.now() });
          this.cachedChainId = { value: live, cachedAt: Date.now() };
          return live;
        })(),
        RPC_READ_STALL_TIMEOUT_MS,
        'configured chainId validation',
      ).finally(() => {
        this.configuredStaticChainIdValidationsByProvider.delete(provider);
      });
      this.configuredStaticChainIdValidationsByProvider.set(provider, validation);
    }

    return validation;
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
      const code = await this.readProvider('hasContractCode getCode', (p) => p.getCode(address));
      return code !== undefined && code !== null && code !== '0x' && code.length > 2;
    } catch {
      return false;
    }
  }

  async createKnowledgeAssets(params: V10PublishParams): Promise<OnChainPublishResult> {
    await this.init();

    if (!this.contracts.knowledgeAssetsLifecycle) {
      throw new Error('KnowledgeAssetsLifecycle / KnowledgeAssetsLifecycle contract not deployed.');
    }

    // Pre-tx validation of `contextGraphId`. The V10 contract rejects
    // `cgId == 0` at `KnowledgeAssetsLifecycle.sol:379` with `ZeroContextGraphId`;
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
      txSigner = await this.resolvePinnedPublisherSigner(
        params.contextGraphId,
        params.publisherAddress,
      );
    } else {
      // No pre-pinned publisher address: select cost-aware here, where the
      // publish `tokenAmount` IS known (unlike the publisher's pre-pin via
      // getAuthorizedPublisherAddress, which runs before the cost is sized).
      txSigner = await this.nextAuthorizedSigner(
        params.contextGraphId,
        floorPublishTokenAmount(params.tokenAmount),
        { publishEpochs: params.epochs },
      );
    }
    const ka = this.contracts.knowledgeAssetsLifecycle.connect(txSigner) as Contract;
    const kaAddress = await ka.getAddress();

    // Approval policy: always ensure the operational signer has the
    // allowance required by the configured `chain.approvalPolicy` for
    // this `tokenAmount`. RFC-001 unified `publish`/`publishDirect`
    // (KnowledgeAssetsLifecycle.sol): the contract auto-detects PCA discount
    // via `agentToAccountId[msg.sender] != 0` and falls through to
    // `token.transferFrom(msg.sender, CSS, fullCost)` for the
    // direct-spend branch. A redundant allowance is cheap and idle when
    // the PCA branch covers the cost. Helper handles the
    // `tokenAmount === 0n` floor (`transferFrom(..., 1n)` minimum), the
    // bounded-per-publish vs replenishing vs unlimited dispatch, and the
    // `this.contracts.token === undefined` no-op for read-only adapters.
    // #953: the approve runs INSIDE the per-wallet serialized window below
    // (it sends its own tx on `txSigner`), not here — see the buildSignedTx
    // closure passed to `dispatchSerializedV10Write`.

    // Build the on-chain PublishParams struct matching the field order +
    // types in `KnowledgeAssetsLifecycle.sol` (RFC-001 author-attestation
    // shape). ethers v6 encodes object literals to solidity structs
    // positionally by field name.
    // KAV10 10.1.1 strict-positive `tokenAmount` floor: the contract now
    // reverts on `tokenAmount == 0`. Free-publish flows (devnets where
    // `ask == 0`) used to round to 1 wei-TRAC silently inside the
    // direct-spend branch; clamp here so they keep working. Matches the
    // same floor inside `computePublishACKDigest`, so the on-chain ACK
    // recovery hashes the same `tokenAmount` the contract receives.
    const flooredTokenAmount = floorPublishTokenAmount(params.tokenAmount);

    // OT-RFC-43 Option 1 (variant 1a): the contract requires a packed
    // reservedKaId = (uint160(author) << 96) | number and reverts
    // KaIdNamespaceMismatch unless its high 160 bits equal the author. This code
    // path hits the real contract, so the id MUST be present and in the author's
    // namespace — fail loud here rather than as an opaque on-chain revert (and
    // before spending gas).
    if (params.reservedKaId === undefined) {
      throw new Error(
        'evm-adapter.createKnowledgeAssets: reservedKaId is required (OT-RFC-43 Option 1). ' +
        'Wire the KA-number allocator into the publish path so a packed ' +
        '(uint160(author)<<96)|number id is supplied.',
      );
    }
    if ((params.reservedKaId >> 96n) !== BigInt(ethers.getAddress(params.author.address))) {
      throw new Error(
        `evm-adapter.createKnowledgeAssets: reservedKaId ${params.reservedKaId} is not in author ` +
        `${params.author.address}'s namespace (high 160 bits must equal the author address); ` +
        `the contract would revert KaIdNamespaceMismatch.`,
      );
    }
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
      // OT-RFC-49 — curated `_catalog` commitment pair (REPLACED the stripped
      // ciphertext-chunks pair; same on-chain PublishParams struct slot).
      //
      // The two fields MUST be set together or omitted together.
      // - Both omitted (or root=ZeroHash + count=0) = legacy / public-KC
      //   path: picker skips this KC in the curated draw and RFC-39 random
      //   sampling never indexes it; safe wire-compatible default for
      //   public callers.
      // - Both set = curated publish: the publisher committed
      //   `computeCatalogRoot(catalogCommittedLeaves(...))` and the cores
      //   recomputed the same root over their locally-served `<cg>/_catalog`
      //   before signing the ACK; the prover proves the same tree.
      // Anything else is a programmer error — fail loud instead of silently
      // defaulting one side and producing an asymmetric commitment that
      // on-chain `_pickWeightedChallenge` would skip (count=0) or that the
      // prover could never satisfy (root=ZeroHash but count>0).
      catalogRoot: (() => {
        const haveRoot = !!params.catalogRoot && params.catalogRoot.length === 32;
        const haveCount = typeof params.catalogLeafCount === 'number' && params.catalogLeafCount > 0;
        if (haveRoot !== haveCount) {
          throw new Error(
            `evm-adapter.createKnowledgeAssets: catalogRoot and catalogLeafCount ` +
            `must both be set or both omitted; got root=${haveRoot ? 'set' : 'unset'}, ` +
            `count=${haveCount ? params.catalogLeafCount : 'unset'}. ` +
            `An asymmetric pair would leave RandomSampling._pickWeightedChallenge unable to ` +
            `verify the curated draw against the off-chain catalog.`,
          );
        }
        return haveRoot ? ethers.hexlify(params.catalogRoot!) : ethers.ZeroHash;
      })(),
      catalogLeafCount: params.catalogLeafCount ?? 0,
      publisherNodeIdentityId: params.publisherNodeIdentityId,
      authorAddress: params.author.address,
      authorR: ethers.hexlify(params.author.signature.r),
      authorVS: ethers.hexlify(params.author.signature.vs),
      authorSchemeVersion: params.author.schemeVersion,
      // OT-RFC-43 Option 1 (variant 1a): packed (uint160(author)<<96)|number.
      // MUST sit between authorSchemeVersion and identityIds to match the
      // on-chain PublishParams struct slot order.
      reservedKaId: params.reservedKaId,
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
    // #888: populate (which gas-estimates and can revert `TooLowAllowance`
    // on a stale RPC allowance read) + sign, with a one-shot forced-approve
    // recovery shared with `updateV10` — see
    // `populateAndSignV10WithAllowanceRecovery`. This runs strictly BEFORE
    // the `onBroadcast` WAL checkpoint and the broadcast below, so the
    // forced re-approve + single retry has no on-chain side effect.
    // #888 + #953: populate (gas-estimates; can revert `TooLowAllowance` on a
    // stale RPC allowance read) + sign with a one-shot forced-approve recovery,
    // then WAL-checkpoint + broadcast — the whole nonce-critical window is
    // serialized per operational wallet by `dispatchSerializedV10Write`. The
    // forced re-approve + single retry runs strictly before the broadcast, so
    // it has no on-chain side effect.
    const receipt = await this.dispatchSerializedV10Write(
      txSigner,
      'publish',
      params.onBroadcast,
      async (ctx) => {
        // #953: the initial allowance approve sends its OWN tx on `txSigner`,
        // so it must run INSIDE the per-wallet lock too. If it stayed before
        // the lock, two concurrent same-wallet publishes starting from
        // insufficient allowance would race on the approve nonce and the
        // second would revert `Nonce too low` before the publish even began.
        await this.ensureV10ApproveTrac(
          txSigner,
          kaAddress,
          params.tokenAmount,
          'approve V10 publish TRAC',
          false,
          ctx.sendContractTransaction,
        );
        return this.populateAndSignV10WithAllowanceRecovery(
          txSigner,
          ka as Contract,
          'publish',
          publishParamsStruct,
          kaAddress,
          params.tokenAmount,
          'approve V10 publish TRAC (forced re-approve, #888)',
          ctx.sendContractTransaction,
        );
      },
      () => {
        throw new Error('Transaction receipt is null');
      },
    ).catch(async (err: unknown) => {
      // Turn an insufficient-funds failure (native gas OR a zero-TRAC
      // transferFrom revert) on the selected wallet into an actionable
      // InsufficientPublisherFundsError listing every operational wallet's
      // balances, so the user is told which wallet to fund instead of seeing a
      // raw ethers "insufficient funds" string. Non-funds errors pass through.
      throw await this.enrichInsufficientPublisherFundsError(
        err,
        txSigner,
        params.contextGraphId,
        floorPublishTokenAmount(params.tokenAmount),
      );
    });

    let kaId = 0n;
    let startKAId = 0n;
    let endKAId = 0n;
    let publisherAddress = txSigner.address;
    let authorAddress: string | undefined;
    const kas = this.contracts.knowledgeAssetStorage;
    if (!kas) {
      throw new Error(
        `V10 publish tx ${receipt.hash} succeeded but DKGKnowledgeAssets ` +
        `contract is not available — cannot parse minted IDs from receipt`,
      );
    }
    const storageAddress = String(kas.target).toLowerCase();
    {
      let foundCreated = false;
      let foundLegacyMint = false;
      for (const log of receipt.logs) {
        const logAddr = typeof log.address === 'string' ? log.address.toLowerCase() : '';
        if (logAddr !== storageAddress) continue;
        try {
          const parsed = kas.interface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed?.name === 'KnowledgeAssetCreated' || parsed?.name === 'KnowledgeAssetCreated') {
            kaId = BigInt(parsed.args.id);
            authorAddress = String(parsed.args.author);
            startKAId = kaId;
            endKAId = kaId;
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
          `KnowledgeAssetCreated event not found in receipt logs — contract ABI may be stale`,
        );
      }
      if (!foundLegacyMint && startKAId === 0n) {
        startKAId = kaId;
        endKAId = kaId;
      }
    }

    // B8: when this publish drew on a PCA, decode the CostCovered event so the
    // daemon can return a CONFIRMED post-publish discount (vs the P0 predictive
    // estimate). Absent for a non-PCA publish → the UI badge degrades hidden.
    const convictionCostCovered = decodeConvictionCostCovered(receipt.logs);

    const blockTimestamp = await this.getBlockTimestamp(receipt.blockNumber);

    return {
      batchId: kaId,
      kaId: kaId,
      knowledgeAssetsContract: storageAddress,
      startKAId,
      endKAId,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      txIndex: receipt.index,
      blockTimestamp,
      publisherAddress,
      authorAddress,
      gasUsed: receipt.gasUsed ? BigInt(receipt.gasUsed) : undefined,
      effectiveGasPrice: receipt.gasPrice ? BigInt(receipt.gasPrice) : undefined,
      gasCostWei: receipt.gasUsed && receipt.gasPrice ? BigInt(receipt.gasUsed) * BigInt(receipt.gasPrice) : undefined,
      tokenAmount: params.tokenAmount,
      ...(convictionCostCovered ? { convictionCostCovered } : {}),
    };
  }

  // =====================================================================
  // Utilities
  // =====================================================================

  getSignerAddress(): string {
    return this.signer.address;
  }

  isV10Ready(): boolean {
    return !!this.contracts.knowledgeAssetsLifecycle;
  }

  isRandomSamplingReady(): boolean {
    return !!this.contracts.randomSampling && !!this.contracts.randomSamplingStorage;
  }

  async getBlockNumber(): Promise<number> {
    // TIP-SENSITIVE: the current head drives the event-lane cursor, proof-
    // challenge block, and finalization reads. A lagging sticky backend would
    // make the head non-monotonic across calls (poller moving backwards / re-
    // scanning), so read canonical-order + preference-transparent.
    return this.readTipProvider('getBlockNumber', (p) => p.getBlockNumber());
  }

  getProvider(): JsonRpcProvider {
    return this.primaryProvider;
  }

  /**
   * @deprecated Returns the bare PRIMARY provider, which does NOT fail over: the
   * ethers `FallbackProvider` was removed and reads now route through the
   * adapter's own read facades (`readContract`/`readProvider` over
   * `this.providers[]`). Call those read methods instead, or `getProvider()` if
   * you explicitly want the bare primary. Retained only for backward
   * compatibility — this adapter is a
   * published export, so removing a public method would be a breaking change.
   */
  getReadProvider(): JsonRpcProvider {
    return this.provider;
  }

  getRpcUrls(): string[] {
    return [...this.rpcUrls];
  }

  /**
   * Drain the raw JSON-RPC request counts accumulated since the previous drain
   * (delta window) — consumed by the daemon's minutely `rpc_usage` telemetry
   * log line. Part of the optional `ChainAdapter.drainRpcUsage` capability
   * (the mock adapter implements it as an always-empty window — it has no RPC
   * transport).
   */
  drainRpcUsage(): RpcUsageWindow {
    return this.rpcUsage.drainWindow();
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
  protected async getRandomSampling(): Promise<{ rs: Contract; rss: Contract }> {
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
  protected async resolveAndAssignRandomSamplingPair(): Promise<{ rs: Contract; rss: Contract }> {
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
  protected async withHubStaleRetry<T>(fn: () => Promise<T>): Promise<T> {
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
   * low-cadence Hub poller has not observed the rotation yet, or when
   * the RPC endpoint cannot serve log scans.
   *
   * Idempotency note: the wrapped closure MUST be safe to call twice.
   * That holds for our write paths because the on-chain side either
   * (a) reverted with the marker error, meaning no state changed, or
   * (b) succeeded, meaning no retry happens. The closure SHOULD
   * re-read `this.contracts.X` on each invocation (don't capture the
   * handle into a local outside the closure) so the retry uses the
   * fresh binding.
   */
  protected async withHubStaleRetryAny<T>(fn: () => Promise<T>): Promise<T> {
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
  protected invalidateRandomSamplingPair(): void {
    this.randomSamplingPairCache.invalidate();
    this.contracts.randomSampling = undefined;
    this.contracts.randomSamplingStorage = undefined;
    this.inflightDurationProbe = undefined;
    this.inflightDurationProbeContract = undefined;
    this.inflightDurationProbeStartedAt = 0;
  }

  /**
   * Poll Hub rotation events and invalidate the local cache for any
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
   *   2. Names in `HUB_BINDING_INVALIDATORS` may clear a lazy slot and
   *      dependent cache through `invalidateOnRotation`, then use the same
   *      rotation finalization as boot-bound bindings.
   *
   *   3. Any name in `HUB_BINDING_INVALIDATORS` without a rotation invalidator
   *      leaves the existing `this.contracts.X` field intact but flips
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
   *   4. Unknown name → ignored. We deliberately allowlist rather
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
   * / `NewAssetStorage` events. We poll all four event topics so the cache
   * invalidates regardless of which Hub set owns the name, and both the
   * RS-pair invalidation and the generic boot-bound invalidation are
   * idempotent so duplicate notifications are harmless.
   *
   * We deliberately avoid `Contract.on(...)` here. With `polling: true`,
   * ethers implements each subscription as its own steady `eth_getLogs`
   * poller. One adapter-owned poller with an OR-topic filter preserves
   * rotation detection without four hidden idle log streams.
   */
  protected async startHubRotationListener(): Promise<void> {
    if (this.hubRotationPoller.isStarted) return;
    try {
      await this.hubRotationPoller.start(
        this.contracts.hub,
        await contractAddress(this.contracts.hub),
      );
    } catch (err) {
      console.warn(
        `[chain] Hub rotation poller setup disabled: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  protected applyHubRotationEventName(name: string): void {
    // #1583 (review round-2) — flush the resolved-address memo on EVERY observed
    // Hub rotation, unconditionally and first. The memo caches the address of
    // any non-excluded name, including per-call names with no lazy binding and
    // so no `HUB_BINDING_INVALIDATORS` entry (`ShardingTableStorage`, resolved
    // fresh per ACK in `verifyACKIdentityDetailed`). The pre-round-2 code only
    // flushed inside `finalizeKnownHubRotation`, reached solely for names WITH a
    // policy — so an observed ShardingTableStorage rotation left `nodeExists`
    // pinned to the retired proxy for up to the 30s TTL. A memoized address is a
    // pure function of Hub-registry state, so any ContractChanged / NewContract /
    // AssetStorageChanged / NewAssetStorage event (all delivered here via the one
    // `onContractName` callback) is exactly the signal that some memoized address
    // may have moved; flushing all of them is correct and keeps the 30s TTL as a
    // pure missed-rotation backstop.
    this.resolvedContractAddressCache.invalidateAll();
    if (name === 'RandomSampling' || name === 'RandomSamplingStorage') {
      this.invalidateRandomSamplingPair();
      return;
    }
    const policy = HUB_BINDING_INVALIDATORS.get(name);
    if (!policy) return;
    this.invalidateHubBindingOnRotation(policy);
    this.finalizeKnownHubRotation();
  }

  protected invalidateHubBindingOnRotation(policy: HubBindingInvalidationPolicy): void {
    if (policy.invalidateOnRotation) this.invalidateHubBinding(policy);
  }

  protected invalidateHubBinding(policy: HubBindingInvalidationPolicy): void {
    if ('contractKey' in policy) {
      this.contracts[policy.contractKey] = undefined;
      return;
    }
    if (policy.special === 'identityStorage') this.invalidateIdentityStorageBinding();
  }

  protected finalizeKnownHubRotation(): void {
    this.invalidatePublishPreflightCache();
    // #1583 — redundant-but-harmless second flush (the unconditional flush at the
    // top of `applyHubRotationEventName` already cleared the memo for this event).
    // Kept so the memo stays invalidated if `finalizeKnownHubRotation` ever gains
    // another caller. `invalidateAll()` is idempotent.
    this.resolvedContractAddressCache.invalidateAll();
    // Force the next public-method entry through `init()` so it re-resolves
    // every binding. Do not clear boot-bound handles here: the callback can
    // fire between a public method's `await init()` and its first
    // `this.contracts.X` read.
    this.initialized = false;
  }

  /**
   * Drop every boot-bound contract handle, lazy binding, and dependent cache,
   * then re-arm `init()`.
   *
   * Used by `withHubStaleRetry` on the write-side self-heal path when
   * a Hub-rotated contract surfaces `UnauthorizedAccess(Only Contracts
   * in Hub)`: the poller may not have observed the rotation yet (HTTP-only
   * RPC, log-scan failure, etc.) so the failing operation can't tell
   * which specific name was rotated. Resetting everything is the safest
   * fallback — the next `await this.init()` re-resolves all 15+ bindings
   * in a single pass (still under a second on a healthy RPC) and the
   * caller's retry picks up the fresh handles.
   *
   * RS pair is handled separately because it owns side-channel state
   * (in-flight probe, ready flag) that `init()` alone won't reset.
   */
  protected invalidateAllBoundContracts(): void {
    for (const policy of HUB_BINDING_INVALIDATORS.values()) {
      this.invalidateHubBinding(policy);
    }
    this.invalidatePublishPreflightCache();
    // #1583 — the write-side self-heal cannot tell which name rotated, so drop
    // the entire resolved-address memo along with every bound handle.
    this.resolvedContractAddressCache.invalidateAll();
    this.invalidateRandomSamplingPair();
    this.initialized = false;
  }

  protected requireContextGraphStorage(): Contract {
    const cgs = this.contracts.contextGraphStorage;
    if (!cgs) {
      throw new Error(
        'ContextGraphStorage not deployed in this Hub. ' +
        'getKAContextGraphId requires a Hub with ContextGraphStorage registered.',
      );
    }
    return cgs;
  }

  /**
   * Release the underlying RPC providers and any keep-alive HTTP
   * sockets they hold open.
   *
   * Intended for test teardown — production daemons keep a single
   * adapter alive for the lifetime of the process, so leaks there
   * are bounded by SIGTERM. In tests, every `createEVMAdapter()`
   * spawns a fresh `JsonRpcProvider`, and ethers never closes the
   * keep-alive sockets on its own. After the test, those idle
   * sockets surface as `TCP.onStreamRead ECONNRESET` unhandled
   * rejections when Hardhat closes the connection (observed in
   * `chain-event-poller-extra.test.ts` running first in CI — see
   * the `ChainEventPoller.stop()` follow-up doc).
   *
   * Idempotent: calling twice is a no-op (ethers' `destroy()` is
   * itself idempotent and additional `Wallet`s share the provider
   * so destroying once flushes everything).
   */
  destroy(): void {
    this.hubRotationPoller.stop();
    for (const provider of this.providers) {
      try { provider.destroy(); } catch { /* already destroyed / not destroyable */ }
    }
  }
}
