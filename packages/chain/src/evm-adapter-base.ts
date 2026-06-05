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

import { JsonRpcProvider, FallbackProvider, Wallet, Contract, ethers } from 'ethers';
import { createFilterErrorSilencer, installFilterNotFoundConsoleSuppressor, formatProviderError } from './filter-error-silencer.js';
import type { FilterErrorSilencer } from './filter-error-silencer.js';
import { DEFAULT_APPROVAL_POLICY } from './chain-adapter.js';
import type { ApprovalPolicy, V10PublishParams, OnChainPublishResult } from './chain-adapter.js';
import { HubResolutionCache } from './hub-resolution-cache.js';
import { KeyedSerializer } from './keyed-mutex.js';
import { floorPublishTokenAmount } from '@origintrail-official/dkg-core';
import { loadAbi } from './evm-adapter-abi.js';
import { errorMessage, isTooLowAllowanceError, enrichEvmError, HUB_STALE_ERROR_MARKERS } from './evm-adapter-errors.js';
import { resolveRpcUrls, boundedRetryFetchRequest, withTimeout, isKnownTransactionError, isRetryableRpcError, assertSuccessfulReceipt, sleep } from './evm-adapter-rpc.js';
import { computeApprovalAction, effectivePublishAllowance, V10_PUBLISH_ONCHAIN_MIN_ALLOWANCE } from './evm-adapter-allowance.js';
import { formatProviderContext } from './evm-adapter-types.js';
import type { ContractCache, EVMAdapterConfig } from './evm-adapter-types.js';
import { RPC_READ_STALL_TIMEOUT_MS, DEFAULT_RANDOM_SAMPLING_HUB_REFRESH_MS, RPC_BROADCAST_ATTEMPT_TIMEOUT_MS, RPC_RECEIPT_ATTEMPT_TIMEOUT_MS, RPC_RECEIPT_TIMEOUT_MS, RPC_RECEIPT_POLL_INTERVAL_MS, RPC_TRANSACTION_POPULATION_ATTEMPT_TIMEOUT_MS, ADMIN_KEY_PURPOSE, OPERATIONAL_KEY_PURPOSE } from './evm-adapter-constants.js';

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
const BOUND_CONTRACT_INVALIDATORS = new Map<string, (adapter: EVMChainAdapterBase) => void>([
  ['Identity',                   (a) => { (a as any).contracts.identity = undefined; }],
  ['Profile',                    (a) => { (a as any).contracts.profile = undefined; }],
  ['ProfileStorage',             (a) => { (a as any).contracts.profileStorage = undefined; }],
  ['ParametersStorage',          (a) => { (a as any).contracts.parametersStorage = undefined; }],
  ['Staking',                    (a) => { (a as any).contracts.staking = undefined; }],
  ['Token',                      (a) => { (a as any).contracts.token = undefined; }],
  ['AskStorage',                 (a) => { (a as any).contracts.askStorage = undefined; }],
  ['KnowledgeAssets',            (a) => { (a as any).contracts.knowledgeAssets = undefined; }],
  ['KnowledgeAssetsStorage',     (a) => { (a as any).contracts.knowledgeAssetsStorage = undefined; }],
  ['KnowledgeAssetsLifecycle',   (a) => { (a as any).contracts.knowledgeAssetsLifecycle = undefined; }],
  ['DKGKnowledgeAssets',         (a) => { (a as any).contracts.knowledgeAssetStorage = undefined; }],
  ['ContextGraphNameRegistry',   (a) => { (a as any).contracts.contextGraphNameRegistry = undefined; }],
  ['ContextGraphs',              (a) => { (a as any).contracts.contextGraphs = undefined; }],
  ['ContextGraphStorage',        (a) => { (a as any).contracts.contextGraphStorage = undefined; }],
  ['DKGPublishingConvictionNFT', (a) => { (a as any).contracts.dkgPublishingConvictionNFT = undefined; }],
  ['Chronos',                    (a) => { (a as any).contracts.chronos = undefined; }],
]);

export class EVMChainAdapterBase {
  /** See `ChainAdapter.deploymentId`. */
  get deploymentId(): string {
    return `${this.chainId}:hub=${this.hubAddress.toLowerCase()}`;
  }

  readonly chainType = 'evm' as const;

  readonly chainId: string;

  protected readonly provider: JsonRpcProvider | FallbackProvider;

  protected readonly primaryProvider: JsonRpcProvider;

  protected readonly providers: JsonRpcProvider[];

  protected readonly rpcUrls: string[];

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
   * See `HubResolutionCache` for the semantics; the listener
   * installed in `init()` invalidates this cache on
   * `Hub.ContractChanged` / `Hub.NewContract` for **either** name,
   * and `withHubStaleRetry()` invalidates it when a write surfaces
   * `UnauthorizedAccess(Only Contracts in Hub)`.
   */
  protected readonly randomSamplingPairCache: HubResolutionCache<{ rs: Contract; rss: Contract }>;

  /**
   * OT-RFC-39 — per-process cache for `getIdentityIdForAddress`.
   * Only positive (non-zero) hits are memoised; see the method body
   * for the rationale (negative-hit invalidation hazard).
   */
  protected readonly identityIdByAddressCache: Map<string, bigint> = new Map();

  protected hubRotationListenerStarted = false;

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

  protected cachedKav10Address: { value: string; cachedAt: number } | undefined;

  protected cachedMinRequiredSignatures: { value: number; cachedAt: number } | undefined;

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

  protected static preflightCacheFresh(
    entry: { cachedAt: number } | undefined,
    now: number,
  ): boolean {
    if (!entry) return false;
    return now - entry.cachedAt < EVMChainAdapterBase.PREFLIGHT_TTL_MS;
  }

  constructor(config: EVMAdapterConfig) {
    this.rpcUrls = resolveRpcUrls(config.rpcUrl, config.rpcUrls);
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
    this.providers = this.rpcUrls.map(
      (url) => new JsonRpcProvider(boundedRetryFetchRequest(url), undefined, {
        cacheTimeout: -1,
        polling: true,
        batchMaxCount: 1,
      }),
    );
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
    if (config.tokenAddress && !ethers.isAddress(config.tokenAddress)) {
      throw new Error(`Invalid tokenAddress: ${config.tokenAddress}`);
    }
    this.tokenAddress = config.tokenAddress ? ethers.getAddress(config.tokenAddress) : undefined;
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
  protected nextSigner(): Wallet {
    const s = this.signerPool[this.signerIndex % this.signerPool.length];
    this.signerIndex++;
    return s;
  }

  protected findSignerByAddress(address: string): Wallet | undefined {
    const normalized = ethers.getAddress(address).toLowerCase();
    return this.signerPool.find((signer) => signer.address.toLowerCase() === normalized);
  }

  protected async broadcastSignedTransactionWithFailover(
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

  protected async getTransactionReceiptWithFailover(txHash: string): Promise<ethers.TransactionReceipt | null> {
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
      (err as any).txHash = txHash;
      throw err;
    }
    return null;
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
    const err = new Error(
      `${label} tx ${txHash} timed out waiting for a receipt after ${RPC_RECEIPT_TIMEOUT_MS}ms` +
      (lastError ? ` (last RPC error: ${errorMessage(lastError)})` : ''),
      { cause: lastError },
    );
    (err as any).code = 'TIMEOUT';
    (err as any).txHash = txHash;
    throw err;
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
   * #888: populate + sign a V10 write tx with one-shot recovery for a
   * stale-RPC `TooLowAllowance` revert, shared by BOTH V10 write paths
   * (`createKnowledgeAssets` publish and `updateV10` — incl. metadata-only
   * updates). ethers estimates gas while populating; on an internally
   * load-balanced RPC that estimate can read a stale TRAC allowance and
   * revert `TooLowAllowance` even though the approve above succeeded
   * (post-approve propagation lag) or was skipped on a stale-high read of an
   * allowance the prior write already consumed. This is strictly
   * pre-broadcast (before the `onBroadcast` WAL checkpoint), so on that one
   * revert we force a fresh approve up to the publish floor — confirming it
   * is visible on the same read path via `ensureV10ApproveTrac(force=true)` —
   * and retry populate+sign exactly once. Any other error, or a second
   * `TooLowAllowance`, propagates unchanged.
   */
  protected async populateAndSignV10WithAllowanceRecovery(
    signer: Wallet,
    kaContract: Contract,
    method: 'publish' | 'update',
    methodParams: unknown,
    kav10Address: string,
    tokenAmount: bigint,
    reapproveLabel: string,
  ): Promise<{ signedTx: string; txHash: string }> {
    let forcedReapprove = false;
    for (;;) {
      try {
        const populated = await (kaContract as any)[method].populateTransaction(
          methodParams,
        );
        return await this.signPopulatedTransaction(signer, populated);
      } catch (err) {
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
          );
          continue;
        }
        throw err;
      }
    }
  }

  protected async sendSignedTransactionAndWait(
    signedTx: string,
    txHash: string,
    label: string,
  ): Promise<ethers.TransactionReceipt> {
    await this.broadcastSignedTransactionWithFailover(signedTx, txHash, label);
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
    buildSignedTx: () => Promise<{ signedTx: string; txHash: string }>,
    onNullReceipt: (preBroadcastTxHash: string) => never,
  ): Promise<ethers.TransactionReceipt> {
    return this.signerTxSerializer.run(signer.address, async () => {
      const { signedTx, txHash: preBroadcastTxHash } = await buildSignedTx();
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

  protected async sendContractTransaction(
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
    let lastRetryable: unknown;
    for (let i = 0; i < this.providers.length; i += 1) {
      const rpcSigner = signer.connect(this.providers[i]);
      let prepared: { signedTx: string; txHash: string } | undefined;
      try {
        const connected = contract.connect(rpcSigner) as any;
        const populated = await withTimeout<ethers.TransactionRequest>(
          connected[method].populateTransaction(...args) as Promise<ethers.TransactionRequest>,
          RPC_TRANSACTION_POPULATION_ATTEMPT_TIMEOUT_MS,
          `${label} transaction population via RPC #${i + 1}`,
        );
        if (opts?.gasLimitBufferBps && populated.gasLimit == null) {
          try {
            const est = (await withTimeout<bigint>(
              connected[method].estimateGas(...args) as Promise<bigint>,
              RPC_TRANSACTION_POPULATION_ATTEMPT_TIMEOUT_MS,
              `${label} gas estimation via RPC #${i + 1}`,
            ));
            populated.gasLimit = (est * BigInt(10_000 + opts.gasLimitBufferBps)) / 10_000n;
          } catch (estErr) {
            // A RETRYABLE estimate failure must not silently drop the OOG
            // headroom: if another RPC is left, re-throw so the outer loop
            // fails over to it (it may estimate fine and apply the buffer).
            // Swallowing here would sign against the failing provider with no
            // headroom and could reintroduce the exact OOG this guards
            // against (Codex review). Only on the LAST provider — or for a
            // non-retryable estimate error, where failover can't help — do we
            // fall back to ethers' own unbuffered estimate during signing.
            const hasMoreProviders = i < this.providers.length - 1;
            if (isRetryableRpcError(estErr) && hasMoreProviders) {
              throw estErr;
            }
            // Best-effort fallback, but DON'T swallow silently: leave a
            // breadcrumb that the headroom was never applied so a recurring
            // intermittent OOG isn't a mystery.
            console.warn(
              `[chain] ${label}: buffered gas estimation failed; falling back to ` +
              `ethers' unbuffered estimate (no OOG headroom applied): ` +
              `${estErr instanceof Error ? estErr.message : String(estErr)}`,
            );
          }
        }
        prepared = await withTimeout(
          this.signPopulatedTransaction(rpcSigner, populated),
          RPC_TRANSACTION_POPULATION_ATTEMPT_TIMEOUT_MS,
          `${label} transaction signing via RPC #${i + 1}`,
        );
      } catch (err) {
        if (!isRetryableRpcError(err)) throw err;
        lastRetryable = err;
        continue;
      }
      if (!prepared) continue;
      return this.sendSignedTransactionAndWait(prepared.signedTx, prepared.txHash, label);
    }
    // A retryable error from the only configured RPC is still an "endpoints
    // exhausted" condition: downstream classifiers (e.g.
    // `/api/context-graph/register` → `classifyRegisterContextGraphError`)
    // key the transient-outage 503 off the `RPC_ENDPOINTS_EXHAUSTED` code, so
    // the code MUST be present even for a single-provider adapter (Codex
    // PR #901). What we must NOT do for one provider is REWRITE the
    // `.message` into the multi-endpoint "failed on all endpoints (url1,
    // url2): ..." aggregate — there is no second endpoint, so the original
    // message (e.g. a plain `connect ECONNREFUSED`) reads cleaner and any
    // message-inspecting caller keeps seeing it verbatim. So: single provider
    // → carry the code on a new error but keep the message byte-identical;
    // multiple providers → the aggregated "all endpoints" message is
    // meaningful and is asserted by evm-adapter.unit.test.ts.
    const message = this.providers.length <= 1
      ? errorMessage(lastRetryable)
      : `${label} transaction preparation failed on all configured RPC endpoints ` +
        `(${this.rpcUrls.join(', ')}): ${errorMessage(lastRetryable)}`;
    const err = new Error(message, { cause: lastRetryable });
    (err as any).code = 'RPC_ENDPOINTS_EXHAUSTED';
    (err as any).rpcUrls = [...this.rpcUrls];
    throw err;
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
      await this.sendContractTransaction(
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
        current = (await withTimeout(
          token.allowance(owner, spender),
          RPC_READ_STALL_TIMEOUT_MS,
          'allowance visibility poll',
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
   * Pick the next signer in the pool that the on-chain ContextGraphs contract
   * authorizes for the target context graph. Falls back to round-robin only
   * when the auth surface is unavailable.
   */
  protected async nextAuthorizedSigner(contextGraphId: bigint): Promise<Wallet> {
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

  protected async getIdentityStorage(): Promise<Contract> {
    if (!this.contracts.identityStorage) {
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
    return identityStorage.keyHasPurpose(
      identityId,
      this.walletKeyHash(address),
      ADMIN_KEY_PURPOSE,
    );
  }

  protected async hasOperationalPurpose(
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

  protected async resolveContract(name: string, abiName?: string): Promise<Contract> {
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

  protected async resolveAssetStorage(name: string, abiName?: string): Promise<Contract> {
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
        const wrapped = new Error(
          `chain initialisation failed on all configured RPC endpoints (${this.rpcUrls.join(', ')}): ${errorMessage(err)}`,
          { cause: err },
        );
        (wrapped as any).code = 'RPC_ENDPOINTS_EXHAUSTED';
        (wrapped as any).rpcUrls = [...this.rpcUrls];
        throw wrapped;
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

    const tokenAddress: string = this.tokenAddress ?? await this.contracts.hub.getContractAddress('Token');
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
   * or `-1n` if `author` never minted. Enumerates `KnowledgeAssetCreated(id,
   * author, ...)` logs filtered by the indexed `author` topic and returns
   * `max(id & ((1<<96)-1))`. Backs the allocator's cold-start reconciliation so
   * a stale-local-DB / fresh device never re-hands a burned `(author, number)`.
   */
  async getMaxKaNumberForAuthor(author: string): Promise<bigint> {
    const storage = this.contracts.knowledgeAssetStorage;
    if (!storage) {
      throw new Error('DKGKnowledgeAssets not deployed on this chain.');
    }
    const normalized = ethers.getAddress(author);
    // KnowledgeAssetCreated(uint256 indexed id, address indexed author, ...):
    // filter by the second indexed topic (author). fromBlock 0 — devnets are
    // cheap; a production fromBlock = deployment block is a future optimization
    // (there is no per-author counter view on-chain under variant 1a).
    const filter = storage.filters.KnowledgeAssetCreated(null, normalized);
    const logs = await storage.queryFilter(filter, 0);
    const MASK = (1n << 96n) - 1n;
    let max = -1n;
    for (const log of logs) {
      const args = (log as ethers.EventLog).args;
      const rawId = args?.id ?? args?.[0];
      if (rawId === undefined || rawId === null) continue;
      const num = BigInt(rawId) & MASK;
      if (num > max) max = num;
    }
    return max;
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
            `evm-adapter.createKnowledgeAssets: ciphertextChunksRoot and ciphertextChunkCount ` +
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
      async () => {
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
        );
        return this.populateAndSignV10WithAllowanceRecovery(
          txSigner,
          ka as Contract,
          'publish',
          publishParamsStruct,
          kaAddress,
          params.tokenAmount,
          'approve V10 publish TRAC (forced re-approve, #888)',
        );
      },
      () => {
        throw new Error('Transaction receipt is null');
      },
    );

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
  protected async startHubRotationListener(): Promise<void> {
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
  protected invalidateAllBoundContracts(): void {
    for (const invalidator of BOUND_CONTRACT_INVALIDATORS.values()) {
      invalidator(this);
    }
    this.invalidatePublishPreflightCache();
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
    for (const provider of this.providers) {
      try { provider.destroy(); } catch { /* already destroyed / not destroyable */ }
    }
  }
}
