// SPDX-License-Identifier: Apache-2.0

/**
 * `RpcFailoverClient` — the pure per-endpoint RPC transport mechanism extracted
 * from `EVMChainAdapterBase`. It owns the read-failover loop, the contract
 * rebind helper, the contract-view retryable classifier, the named
 * timeout-policy matrix, and the typed-exhaustion / host-only-logging concerns.
 *
 * SAFETY BOUNDARY: this module holds NO transaction-safety state — no WAL, no
 * per-wallet serializer, no approval latch. The adapter's tx-orchestration owns
 * all of that and calls into this surface. The ONLY mutable state it owns is a
 * TRANSPORT-ORDERING preference (endpoint stickiness), fully delegated to the
 * `EndpointStickiness` state machine (see endpoint-stickiness.ts): a "prefer the
 * last-good backend, re-probe the primary at most once per TTL" model, keyed on
 * `rpcUrl` (survives a live pool rebind), that also tracks whether the preference
 * is nonce-safe for writes (a read-only-established backend must not drive a
 * write's nonce). Each loop asks it for an order (by intent) and reports success.
 * That is pure ordering — it only decides which endpoint each loop TRIES FIRST;
 * it never signs, never gates a broadcast, never re-orders the tx-safety
 * guards, and every loop still falls through to the full endpoint set. The
 * module never references the adapter; it is constructed with two required
 * capabilities and one optional per-endpoint transport preflight:
 *   1. `getEndpoints()` — a LIVE thunk over the RPC endpoints, each a
 *      `{ provider, rpcUrl }` pair. One object per endpoint keeps the
 *      `provider ↔ rpcUrl` pairing explicit inside every failover loop (not an
 *      index invariant across two parallel arrays); reading it live lets a
 *      mid-flight rebind of the pool take effect. The `rpcUrl` is
 *      host-only-reduced before it reaches any log or error message.
 *   2. `signPopulated` — signing is reached ONLY through this injected callback;
 *      this module holds no signer state. Used by `populateAndSign`; the read
 *      family never signs.
 *
 * The read family (`read` / `readContract`) and receipt lookups share one private
 * `runAcrossProviders` core. Transaction preparation and broadcast stay explicit
 * so their tx-critical divergences remain visible. Receipt-specific behavior is
 * expressed as policy on that same provider loop (absolute deadline, benign-null
 * handling, write stickiness, and the receipt exhaustion code); direct CLI waits
 * construct this concrete transport too, so endpoint ordering, failover, and
 * telemetry have one owner.
 */

import type { SignedTransactionEnvelope } from './chain-adapter.js';
import { JsonRpcProvider, Wallet, Contract, ethers } from 'ethers';
import { withSpan, getMetrics } from '@origintrail-official/dkg-core';
import { withTimeout, isRetryableRpcError, isThrottleRpcError, isKnownTransactionError, assertSuccessfulReceipt, sleep } from './evm-adapter-rpc.js';
import { errorCode, errorMessage } from './evm-adapter-errors.js';
import { noteRpcFailover, noteRpcExhaustion, notePreferredEndpoint, noteRpcServed, rpcHost } from './rpc-failover-log.js';
import { EndpointStickiness, type StickinessIntent } from './endpoint-stickiness.js';
import { ChainRpcTransportError, createRpcTimeoutError } from './chain-rpc-transport-error.js';
import { withRpcUsageConsumer } from './rpc-usage.js';
import { withRpcRequestAbortSignal } from './rpc-request-transport.js';
import {
  RPC_READ_STALL_TIMEOUT_MS,
  RPC_LOG_SCAN_TIMEOUT_MS,
  RPC_BROADCAST_ATTEMPT_TIMEOUT_MS,
  RPC_TRANSACTION_POPULATION_ATTEMPT_TIMEOUT_MS,
  RPC_RECEIPT_ATTEMPT_TIMEOUT_MS,
  RPC_RECEIPT_POLL_INTERVAL_MS,
  STICKY_PREFERRED_TTL_MS,
  resolveReceiptTimeoutMs,
} from './evm-adapter-constants.js';
import { waitForReceiptWithDeadline } from './receipt-wait.js';

/**
 * One RPC endpoint as a SINGLE boundary: the bare per-endpoint provider paired
 * with its configured URL. Modeling the pair as one object (instead of two
 * parallel `providers[]` / `rpcUrls[]` arrays indexed in lockstep) makes the
 * `provider ↔ rpcUrl` invariant explicit and unbreakable inside every failover
 * loop. The `rpcUrl` is host-only-reduced before it reaches any log / error.
 */
export interface RpcEndpoint {
  provider: JsonRpcProvider;
  rpcUrl: string;
}

/**
 * Named per-attempt timeout policy for a failover read: callers pick an intent,
 * not a millisecond value. The exact cap each policy yields is in
 * {@link resolveCapMs}.
 *   - `pointRead`           — a single `eth_call` / point provider read.
 *   - `wideLogScan`         — a multi-thousand-block `eth_getLogs` scan.
 *   - `watchdogPointRead`   — a background point read that must not wedge a
 *     one-RPC node.
 *   - `watchdogWideLogScan` — a background log scan that must not wedge a
 *     one-RPC node.
 *   - `failOpenFundingRead` — a fail-open funding/allowance read that must never
 *     stall selection (capped on EVERY attempt, including single-RPC).
 */
export type ReadPolicy =
  | 'pointRead'
  | 'wideLogScan'
  | 'watchdogPointRead'
  | 'watchdogWideLogScan'
  | 'failOpenFundingRead';

/** Per-read options: timeout/failover behavior plus an explicit low-cardinality
 *  telemetry consumer key for `eth_call` attribution. `label` remains a human
 *  failover/span label and is not implicitly part of the daemon log contract. */
export interface ReadOpts {
  policy?: ReadPolicy;
  isRetryable?: (err: unknown) => boolean;
  rpcUsageConsumer?: string;
  /**
   * Opt this read OUT of endpoint stickiness — it always uses the canonical
   * (configured) endpoint order AND never mutates the preferred pointer
   * (fully preference-transparent). Set on TIP-SENSITIVE reads (current head /
   * latest block) where a lagging preferred backend could return a stale/lower
   * head and make the tip non-monotonic across calls. A `skipPreferred` read on
   * a selectively-healthy primary must NOT clear the preference the heavy
   * read/write paths rely on — hence transparent, not merely canonical-ordered.
   */
  skipPreferred?: boolean;
  /**
   * Marks a read whose result may be a benign "not on this endpoint (yet)" EMPTY
   * value (e.g. `eth_getTransactionReceipt` / `getBlock` returning `null`) rather
   * than a definitive answer. When set, an empty result is NOT a transport
   * failure: the loop tries the next endpoint WITHOUT de-preferring it or emitting
   * failover/exhaustion telemetry, and if EVERY endpoint returns empty (and none
   * errored) the empty value itself is returned. A real transport error still
   * fails over / exhausts / propagates as usual. This keeps nullable reads
   * (receipt/tx/block lookups) failing over on a lagging endpoint without a thrown
   * sentinel polluting stickiness or telemetry.
   */
  isEmptyResult?: (value: unknown) => boolean;
  /** Retry a complete endpoint pass only when every failure was a throttle. */
  endpointSetRetry?: 'all-throttled';
  /** Cancels the active raw ethers FetchRequest for this read. */
  signal?: AbortSignal;
  /** Absolute operation deadline shared by every endpoint attempt. */
  deadlineMs?: number;
}

/** Optional absolute deadline and low-cardinality label for one receipt pass. */
export interface ReceiptLookupOptions {
  deadlineMs?: number;
  /** Defaults to `receipt lookup`; direct transports use their caller label. */
  logLabel?: string;
  /** Cancels the active raw ethers FetchRequest for this receipt lookup. */
  signal?: AbortSignal;
}

/**
 * Policy for the single provider-pass state machine. Read callers resolve their
 * named timeout policy here; receipt callers add an absolute operation deadline
 * and use `any-empty` because one real `null` response means the transaction is
 * simply not mined yet even if another endpoint had a transient failure.
 */
interface ProviderPassOptions<T> {
  isRetryable: (err: unknown) => boolean;
  intent: StickinessIntent;
  attemptTimeoutMs: (providerCount: number) => number | undefined;
  deadlineMs?: number;
  isEmptyResult?: (value: T) => boolean;
  emptyResultPolicy?: 'all-empty' | 'any-empty';
  onAttempt?: (attempt: number) => void;
  onServed: (endpoint: RpcEndpoint, value: T) => void;
}

type ProviderSetExhaustionKind = 'all-throttled' | 'mixed';

/** Internal exhaustion detail used only while deciding whether to retry a pass. */
class ProviderSetExhaustedError extends ChainRpcTransportError {
  constructor(
    message: string,
    readonly exhaustionKind: ProviderSetExhaustionKind,
    opts: { cause: unknown; rpcUrls: readonly string[] },
  ) {
    super('RPC_ENDPOINTS_EXHAUSTED', message, opts);
  }
}

/**
 * The adapter's transaction-signing helper, injected as a callback so signing is
 * reached only through this thunk and the module holds no signer state. Used by
 * `populateAndSign`.
 */
export type SignPopulatedFn = (
  signer: Wallet,
  populated: ethers.TransactionRequest,
) => Promise<SignedTransactionEnvelope>;

/** Optional per-endpoint transport preflight, e.g. static-network chain-id validation. */
export type ValidateEndpointFn = (endpoint: RpcEndpoint) => Promise<void>;

/**
 * Optional transport hooks + config for `RpcFailoverClient`, grouped in ONE
 * object so the constructor boundary stays readable as knobs are added (no
 * positional `undefined` placeholders for unrelated optional concerns).
 */
export interface RpcFailoverClientOptions {
  /** Optional per-endpoint transport preflight, e.g. static-network chain-id validation. */
  validateEndpoint?: ValidateEndpointFn;
  /** Endpoint-stickiness configuration (Mechanism B). */
  stickiness?: StickinessOptions;
  /** Full-pool retries after every endpoint reports a transient throttle. */
  readThrottleRetries?: number;
  readThrottleBackoffMs?: number;
}

export interface StickinessOptions {
  /** Force stickiness on/off (tests). Ignored if `isEnabled` is given. */
  enabled?: boolean;
  /** Kill-switch predicate, evaluated LIVE per check. OWNERSHIP: the config
   *  boundary owns env resolution — the production adapter injects
   *  `() => process.env.DKG_DISABLE_RPC_STICKINESS !== '1'` here, so the transport
   *  core carries no process-global dependency. Takes precedence over `enabled`.
   *  When NEITHER `isEnabled` nor `enabled` is supplied, stickiness defaults to
   *  ENABLED and the env kill-switch is NOT consulted by the core — only the
   *  adapter-injected predicate honors it (a bare `new RpcFailoverClient(...)` is a
   *  test/non-production path). */
  isEnabled?: () => boolean;
  ttlMs?: number;
  now?: () => number;
}

/**
 * Failover classifier for CONTRACT VIEW reads (`readContract`'s default): the
 * generic `isRetryableRpcError` transient set MINUS `BAD_DATA`. A view `BAD_DATA`
 * ("could not decode result data") is a DETERMINISTIC client-side decode of an
 * empty / wrong-shape return for the ABI type — not an RPC outage — so failing
 * over would re-hit the same decode on every endpoint and mask it as
 * `RPC_ENDPOINTS_EXHAUSTED`; it is rethrown instead. (Direct provider reads —
 * getCode/getBalance/getNetwork — never produce BAD_DATA, so they keep the
 * unmodified `isRetryableRpcError`.)
 */
export function isContractViewRetryable(err: unknown): boolean {
  return isRetryableRpcError(err) && errorCode(err) !== 'BAD_DATA';
}

/**
 * The timeout-policy matrix — the per-attempt cap each named policy yields:
 *
 *   | policy              | multi-RPC cap            | single-RPC cap          |
 *   |---------------------|--------------------------|-------------------------|
 *   | pointRead           | RPC_READ_STALL (4s)      | uncapped (#894)         |
 *   | wideLogScan         | RPC_LOG_SCAN (30s)       | uncapped (#894)         |
 *   | watchdogPointRead   | RPC_READ_STALL (4s)      | RPC_READ_STALL (4s)    |
 *   | watchdogWideLogScan | RPC_LOG_SCAN (30s)       | RPC_LOG_SCAN (30s)     |
 *   | failOpenFundingRead | RPC_READ_STALL (4s)      | RPC_READ_STALL (4s)    |
 *
 * `pointRead` / `wideLogScan` leave single-RPC uncapped (nothing to fail over
 * to; #894). The watchdog policies are for background reads that must clear
 * their scheduler gate even on one-RPC nodes, without imposing a poll-level
 * deadline over a multi-RPC failover sequence.
 */
export function resolveCapMs(policy: ReadPolicy, providerCount: number): number | undefined {
  if (policy === 'failOpenFundingRead' || policy === 'watchdogPointRead') {
    return RPC_READ_STALL_TIMEOUT_MS;
  }
  if (policy === 'watchdogWideLogScan') return RPC_LOG_SCAN_TIMEOUT_MS;
  if (providerCount <= 1) return undefined;
  return policy === 'wideLogScan' ? RPC_LOG_SCAN_TIMEOUT_MS : RPC_READ_STALL_TIMEOUT_MS;
}

export class RpcFailoverClient {
  /** Transport-ordering preference state machine — the ONLY mutable state this
   *  module owns (see SAFETY BOUNDARY + endpoint-stickiness.ts). */
  private readonly stickiness: EndpointStickiness;
  /** Optional per-endpoint transport preflight (from `options.validateEndpoint`). */
  private readonly validateEndpoint?: ValidateEndpointFn;
  private readonly readThrottleRetries: number;
  private readonly readThrottleBackoffMs: number;

  constructor(
    private readonly getEndpoints: () => RpcEndpoint[],
    private readonly signPopulated: SignPopulatedFn,
    // The chain id (e.g. `evm:31337`) carried on every chain-RPC metric label so
    // a multi-chain node's series stay separable. A LIVE thunk so the adapter can
    // construct this client BEFORE its own `chainId` field is assigned and still
    // have the label resolve correctly at metric-record time.
    private readonly chainId: () => string,
    // Optional transport hooks/config in ONE object (preflight + stickiness) so
    // adding a knob never appends another positional `undefined`.
    options?: RpcFailoverClientOptions,
  ) {
    this.validateEndpoint = options?.validateEndpoint;
    this.readThrottleRetries = options?.readThrottleRetries ?? 2;
    this.readThrottleBackoffMs = options?.readThrottleBackoffMs ?? 250;
    const stickiness = options?.stickiness;
    const isEnabled = stickiness?.isEnabled
      ?? (stickiness?.enabled !== undefined ? () => stickiness.enabled as boolean : () => true);
    this.stickiness = new EndpointStickiness({
      now: stickiness?.now ?? Date.now,
      ttlMs: stickiness?.ttlMs ?? STICKY_PREFERRED_TTL_MS,
      isEnabled,
      onEstablished: (url) => notePreferredEndpoint('rpc failover', url),
    });
  }

  /**
   * Classify an RPC error for low-cardinality metric labels: `timeout` for the
   * synthetic `withTimeout` TIMEOUT code, else `error`. Keeps the `outcome` label
   * bounded at the metric record sites.
   */
  private rpcOutcome(err: unknown): 'error' | 'timeout' {
    return errorCode(err) === 'TIMEOUT' ? 'timeout' : 'error';
  }

  private servedWriteKey(phase: 'tx-preparation' | 'tx-broadcast' | 'receipt-lookup'): string {
    return `${this.chainId()}|write|${phase}`;
  }

  private servedReadBucketKey(policy: ReadPolicy, skipPreferred: boolean): string {
    const preference = skipPreferred ? 'transparent' : 'sticky';
    return `${this.chainId()}|read-bucket|${policy}|${preference}`;
  }

  /**
   * Single chain-RPC outcome boundary: records `dkg.chain.rpc.total` (and the
   * `dkg.chain.rpc.failover.total` exhaustion counter) with ONE identical,
   * bounded label shape `{rpc_method, outcome, retryable, chain_id}` for every
   * method, so broadcast/getReceipt/readContract don't each hand-roll the label
   * object. Duration stays in each method's `finally` (already uniform). The
   * caller decides the per-path outcome (a success vs the receipt null-pending
   * skip vs a typed exhaustion) — this owns only the recording.
   */
  private recordRpcOutcome(
    method: string,
    outcome: 'ok' | 'error' | 'timeout',
    opts?: { retryable?: boolean; exhausted?: boolean },
  ): void {
    const chain_id = this.chainId();
    const m = getMetrics();
    m.chainRpcTotal.add(1, { rpc_method: method, outcome, retryable: opts?.retryable ?? false, chain_id });
    if (opts?.exhausted) {
      m.chainRpcFailoverTotal.add(1, { rpc_method: method, chain_id, reason: 'exhausted' });
    }
  }

  /**
   * Per-endpoint read-failover primitive over the bare endpoints (no
   * FallbackProvider). Runs `fn` against each provider in turn; on a RETRYABLE
   * error advances to the next (host-only `noteRpcFailover` per hop) and, once
   * all are exhausted, throws the typed `RPC_ENDPOINTS_EXHAUSTED` (→ bounded
   * 503). A NON-retryable error is rethrown AT ONCE (failing over a deterministic
   * chain error would only mask it). The default classifier is
   * `isRetryableRpcError`; override it via `opts.isRetryable` for reads whose
   * error shapes carry domain meaning (e.g. `getMaxKaNumberForAuthor`'s
   * absent-view). `fn` receives the active provider (`p => p.getCode(addr)`) and
   * MUST be a PURE read — no sign / broadcast / WAL — since it may execute on
   * more than one provider.
   */
  read<T>(
    label: string,
    fn: (provider: JsonRpcProvider) => Promise<T>,
    opts?: ReadOpts,
  ): Promise<T> {
    const policy = opts?.policy ?? 'pointRead';
    const skipPreferred = opts?.skipPreferred ?? false;
    const runPass = () => this.runAcrossProviders(
      label,
      fn,
      {
        isRetryable: error => !opts?.signal?.aborted && (
          opts?.isRetryable ?? isRetryableRpcError
        )(error),
        intent: skipPreferred ? 'transparentRead' : 'stickyRead',
        attemptTimeoutMs: providerCount => resolveCapMs(policy, providerCount),
        ...(opts?.deadlineMs === undefined ? {} : { deadlineMs: opts.deadlineMs }),
        isEmptyResult: opts?.isEmptyResult as ((value: T) => boolean) | undefined,
        onServed: endpoint => noteRpcServed(label, endpoint.rpcUrl, {
          mode: 'read',
          key: this.servedReadBucketKey(policy, skipPreferred),
        }),
      },
    );
    const run = () => this.runReadPasses(label, runPass, opts?.endpointSetRetry);
    const runWithAbort = () => opts?.signal
      ? withRpcRequestAbortSignal(opts.signal, run)
      : run();
    return opts?.rpcUsageConsumer
      ? withRpcUsageConsumer(opts.rpcUsageConsumer, runWithAbort)
      : runWithAbort();
  }

  /**
   * `read` for a CONTRACT VIEW: runs `fn` against `contract` rebound to each
   * provider in turn (failover), leaving the caller's boot-bound handle
   * untouched. `fn` MUST be a pure view read. The default classifier is
   * `isContractViewRetryable` (the transient set MINUS `BAD_DATA`, which on a
   * view is a deterministic decode, not an outage, so it is rethrown rather than
   * failed over and masked as exhaustion); a caller may pass its own
   * `opts.isRetryable`.
   */
  readContract<T>(
    label: string,
    contract: Contract,
    fn: (c: Contract) => Promise<T>,
    opts?: ReadOpts,
  ): Promise<T> {
    const chainId = this.chainId();
    const policy = opts?.policy ?? 'pointRead';
    const skipPreferred = opts?.skipPreferred ?? false;
    // Single telemetry choke-point for every CONTRACT VIEW read (eth_call): one
    // `chain.eth_call` span + RPC metric spanning the whole failover sequence.
    // `dkg.read=label` (e.g. 'token.allowance') rides the SPAN only — kept OFF
    // the metric so its label set stays low-cardinality.
    const run = () => withSpan(
      'chain.eth_call',
      async () => {
        const metrics = getMetrics();
        const startedAt = Date.now();
        try {
          const out = await this.runReadPasses(
            label,
            () => this.runAcrossProviders(
              label,
              (p) => fn(this.rebindContract(contract, p)),
              {
                isRetryable: error => !opts?.signal?.aborted && (
                  opts?.isRetryable ?? isContractViewRetryable
                )(error),
                intent: skipPreferred ? 'transparentRead' : 'stickyRead',
                attemptTimeoutMs: providerCount => resolveCapMs(policy, providerCount),
                ...(opts?.deadlineMs === undefined ? {} : { deadlineMs: opts.deadlineMs }),
                isEmptyResult: opts?.isEmptyResult as ((value: T) => boolean) | undefined,
                onServed: endpoint => noteRpcServed(label, endpoint.rpcUrl, {
                  mode: 'read',
                  key: this.servedReadBucketKey(policy, skipPreferred),
                }),
              },
            ),
            opts?.endpointSetRetry,
          );
          this.recordRpcOutcome('eth_call', 'ok');
          return out;
        } catch (err) {
          this.recordRpcOutcome('eth_call', this.rpcOutcome(err), { retryable: isRetryableRpcError(err) });
          throw err;
        } finally {
          metrics.chainRpcDuration.record(Date.now() - startedAt, {
            rpc_method: 'eth_call', chain_id: chainId,
          });
        }
      },
      { attributes: { 'rpc.method': 'eth_call', 'dkg.chain_id': chainId, 'dkg.read': label } },
    );
    const runWithAbort = () => opts?.signal
      ? withRpcRequestAbortSignal(opts.signal, run)
      : run();
    return opts?.rpcUsageConsumer
      ? withRpcUsageConsumer(opts.rpcUsageConsumer, runWithAbort)
      : runWithAbort();
  }

  // --- write transport (called by the adapter's tx-orchestration; this layer
  // owns NO WAL / serializer / approval latch — it only runs the bare
  // per-endpoint loop and returns/raises) ---

  /**
   * Per-endpoint populate+sign loop, shared by the non-V10 and V10 publish/update
   * write paths. Iterates the bare endpoints (signer + contract rebound to each),
   * populates (gas/nonce/chainId reads, optional OOG-buffer gas estimate) + signs
   * via the injected `signPopulated` callback, and returns the FIRST successful
   * `{signedTx,txHash}`. Advances ONLY on `isRetryableRpcError`; a non-retryable
   * error (a decoded revert — e.g. `TooLowAllowance`) propagates AT ONCE so the
   * caller can react. Exhaustion → typed `RPC_ENDPOINTS_EXHAUSTED`.
   *
   * STRICTLY pre-broadcast: signs once on the winning provider, does NOT broadcast
   * or fire the WAL — the caller broadcasts the single returned tx, keeping the
   * WAL checkpoint between sign and broadcast intact.
   */
  async populateAndSign(
    contract: Contract,
    method: string,
    args: readonly unknown[],
    signer: Wallet,
    label: string,
    opts?: { gasLimitBufferBps?: number },
  ): Promise<SignedTransactionEnvelope> {
    const canonical = this.getEndpoints();
    // 'nonceWrite': the state machine starts a fresh-nonce populate on a backend
    // ONLY if a prior populate proved it (else canonical primary-first = the
    // authoritative nonce source) — the nonce-staleness guard.
    const attempts = this.stickiness.attempts(canonical, 'nonceWrite');
    let lastRetryable: unknown;
    for (let i = 0; i < attempts.length; i += 1) {
      const attempt = attempts[i];
      const endpoint = attempt.endpoint;
      try {
        await this.validateEndpointForAttempt(
          endpoint,
          RPC_TRANSACTION_POPULATION_ATTEMPT_TIMEOUT_MS,
          `${label} chainId validation via RPC #${i + 1}`,
        );
        const rpcSigner = this.rebindSigner(signer, endpoint.provider);
        const connected = this.rebindContract(contract, rpcSigner) as any;
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
            // headroom: if another RPC is left, re-throw so the loop fails over
            // to it (it may estimate fine and apply the buffer). Only on the LAST
            // provider — or for a non-retryable estimate error, where failover
            // can't help — fall back to ethers' own unbuffered estimate during
            // signing, leaving a breadcrumb so a recurring OOG isn't a mystery.
            const hasMoreProviders = i < attempts.length - 1;
            if (isRetryableRpcError(estErr) && hasMoreProviders) {
              throw estErr;
            }
            console.warn(
              `[chain] ${label}: buffered gas estimation failed; falling back to ` +
              `ethers' unbuffered estimate (no OOG headroom applied): ` +
              `${estErr instanceof Error ? estErr.message : String(estErr)}`,
            );
          }
        }
        const signed = await withTimeout(
          this.signPopulated(rpcSigner, populated),
          RPC_TRANSACTION_POPULATION_ATTEMPT_TIMEOUT_MS,
          `${label} transaction signing via RPC #${i + 1}`,
        );
        // Signed on this endpoint → 'nonceWrite' marks it WRITE-proven (nonce-safe)
        // so it's preferred for the read-your-write ops that follow (the caller's
        // broadcast + receipt + confirming re-reads) AND for subsequent populates.
        attempt.recordSuccess();
        noteRpcServed(`${label} preparation`, endpoint.rpcUrl, { mode: 'read', key: this.servedWriteKey('tx-preparation') });
        return signed;
      } catch (err) {
        if (!isRetryableRpcError(err)) throw err;
        lastRetryable = err;
        attempt.recordFailure(); // de-prefer a failed backend
        if (i < attempts.length - 1) {
          noteRpcFailover(`${label} preparation`, endpoint.rpcUrl, err, attempts[i + 1].endpoint.rpcUrl);
        }
      }
    }
    if (lastRetryable) noteRpcExhaustion(`${label} preparation`, canonical.map((e) => e.rpcUrl));
    // Single provider → carry the code on a new error but keep the message
    // byte-identical (no second endpoint, so the raw message reads cleaner and
    // any message-inspecting caller keeps seeing it). Multiple providers → the
    // HOST-ONLY aggregate (never full URLs — a configured rpcUrl may carry an API
    // key and this message reaches HTTP clients via response paths that echo
    // err.message, e.g. the create+publish 207 tail).
    const message = canonical.length <= 1
      ? errorMessage(lastRetryable)
      : `${label} transaction preparation failed on all configured RPC endpoints ` +
        `(${canonical.map((e) => rpcHost(e.rpcUrl)).join(', ')}): ${errorMessage(lastRetryable)}`;
    // Populate+sign exhausted every endpoint. This is the PREPARE phase
    // (populateTransaction / eth_estimateGas), NOT the broadcast — label it
    // eth_estimateGas so it doesn't collide with the genuine
    // eth_sendRawTransaction failover counter in the broadcast loop.
    getMetrics().chainRpcFailoverTotal.add(1, {
      rpc_method: 'eth_estimateGas', chain_id: this.chainId(), reason: 'exhausted',
    });
    throw new ChainRpcTransportError('RPC_ENDPOINTS_EXHAUSTED', message, {
      cause: lastRetryable,
      rpcUrls: canonical.map((e) => e.rpcUrl),
    });
  }

  /**
   * Per-endpoint broadcast of an ALREADY-SIGNED tx (signer-free — never
   * re-signs). IDEMPOTENT: an `isKnownTransactionError` (the tx is already
   * known/pending/mined) is treated as success (`return`) so a set-retry
   * re-broadcast of the byte-identical tx cannot fail. A non-retryable error
   * propagates AT ONCE; all-endpoints exhaustion → typed `RPC_ENDPOINTS_EXHAUSTED`
   * (→ retryable 503), mirroring the preparation loop + CLI path.
   */
  async broadcast(signedTx: string, txHash: string, label: string): Promise<void> {
    const chainId = this.chainId();
    return withSpan(
      'chain.tx_submit',
      async (span) => {
        const metrics = getMetrics();
        const startedAt = Date.now();
        try {
          const canonical = this.getEndpoints();
          const attempts = this.stickiness.attempts(canonical, 'write');
          let lastRetryable: unknown;
          for (let i = 0; i < attempts.length; i += 1) {
            const attempt = attempts[i];
            const endpoint = attempt.endpoint;
            const provider = endpoint.provider;
            span.addEvent('broadcast.attempt', { attempt: i + 1 });
            try {
              await this.validateEndpointForAttempt(
                endpoint,
                RPC_BROADCAST_ATTEMPT_TIMEOUT_MS,
                `${label} chainId validation via RPC #${i + 1}`,
              );
              await withTimeout(
                provider.broadcastTransaction(signedTx),
                RPC_BROADCAST_ATTEMPT_TIMEOUT_MS,
                `${label} broadcast via RPC #${i + 1}`,
              );
              span.setAttribute('dkg.tx_hash', txHash);
              this.recordRpcOutcome('eth_sendRawTransaction', 'ok');
              attempt.recordSuccess();
              noteRpcServed(`${label} broadcast`, endpoint.rpcUrl, { mode: 'write' });
              return;
            } catch (err) {
              if (isKnownTransactionError(err)) {
                // Already-known / already-mined tx is success for our purposes.
                span.setAttribute('dkg.tx_hash', txHash);
                span.addEvent('broadcast.already_known', { attempt: i + 1 });
                this.recordRpcOutcome('eth_sendRawTransaction', 'ok');
                attempt.recordSuccess();
                noteRpcServed(`${label} broadcast`, endpoint.rpcUrl, { mode: 'write' });
                return;
              }
              if (!isRetryableRpcError(err)) {
                this.recordRpcOutcome('eth_sendRawTransaction', this.rpcOutcome(err), { retryable: false });
                throw err;
              }
              lastRetryable = err;
              attempt.recordFailure(); // de-prefer a failed backend
              if (i < attempts.length - 1) {
                noteRpcFailover(`${label} broadcast`, endpoint.rpcUrl, err, attempts[i + 1].endpoint.rpcUrl);
              }
            }
          }
          // All configured endpoints exhausted.
          this.recordRpcOutcome('eth_sendRawTransaction', this.rpcOutcome(lastRetryable), { retryable: true, exhausted: true });
          if (lastRetryable) noteRpcExhaustion(`${label} broadcast`, canonical.map((e) => e.rpcUrl));
          // Typed transport error (mirroring the preparation loop + CLI path) so a
          // broadcast-time all-endpoints-exhausted failure maps to a retryable 503 at
          // the HTTP boundary, not a generic 500 — an exhaustion after a provider
          // populated/signed would otherwise surface code-less.
          throw new ChainRpcTransportError(
            'RPC_ENDPOINTS_EXHAUSTED',
            `${label} broadcast failed on all configured RPC endpoints for tx ${txHash}: ${errorMessage(lastRetryable)}`,
            { cause: lastRetryable, rpcUrls: canonical.map((e) => e.rpcUrl), txHash },
          );
        } finally {
          metrics.chainRpcDuration.record(Date.now() - startedAt, {
            rpc_method: 'eth_sendRawTransaction', chain_id: chainId,
          });
        }
      },
      { attributes: { 'rpc.method': 'eth_sendRawTransaction', 'dkg.chain_id': chainId } },
    );
  }

  /**
   * Per-endpoint receipt fetch. A provider that RESPONDS (even with a `null`
   * "not yet mined" receipt) sets `sawNonErrorResponse` and the method yields
   * `null` rather than an exhaustion — only an all-endpoints-ERRORED lookup throws
   * the typed `RPC_RECEIPT_LOOKUP_FAILED` (kept DISTINCT from
   * `RPC_ENDPOINTS_EXHAUSTED` so the shared receipt-wait primitive can tell "no
   * receipt yet" from "transport down"). When supplied, `deadlineMs` caps the
   * COMPLETE endpoint pass so no per-attempt timer outlives the operation.
   */
  async getReceipt(
    txHash: string,
    options: ReceiptLookupOptions = {},
  ): Promise<ethers.TransactionReceipt | null> {
    const chainId = this.chainId();
    const logLabel = options.logLabel ?? 'receipt lookup';
    const run = () => withSpan(
      'chain.tx_wait',
      async (span) => {
        const metrics = getMetrics();
        const startedAt = Date.now();
        try {
          const receipt = await this.runAcrossProviders(
            logLabel,
            provider => provider.getTransactionReceipt(txHash),
            {
              isRetryable: error => !options.signal?.aborted && isRetryableRpcError(error),
              intent: 'receiptRead',
              attemptTimeoutMs: () => RPC_RECEIPT_ATTEMPT_TIMEOUT_MS,
              ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
              isEmptyResult: value => value == null,
              emptyResultPolicy: 'any-empty',
              onAttempt: attempt => span.addEvent('receipt.attempt', { attempt }),
              onServed: endpoint => {
                noteRpcServed(logLabel, endpoint.rpcUrl, {
                  mode: 'read',
                  key: this.servedWriteKey('receipt-lookup'),
                });
              },
            },
          );

          if (receipt) {
            span.setAttribute('dkg.tx_hash', txHash);
            this.recordRpcOutcome('eth_getTransactionReceipt', 'ok');
            return receipt;
          }
          // At least one backend answered but the tx is not yet mined (null
          // receipt). This is a benign poll tick, not a terminal outcome, so we
          // intentionally do NOT emit an outcome metric here (the surrounding
          // poll loop calls this repeatedly until mined/timeout).
          span.setAttribute('dkg.receipt_pending', true);
          return null;
        } catch (err) {
          if (err instanceof ProviderSetExhaustedError) {
            const cause = (err as Error & { cause?: unknown }).cause ?? err;
            noteRpcExhaustion(logLabel, err.rpcUrls ?? []);
            this.recordRpcOutcome('eth_getTransactionReceipt', this.rpcOutcome(cause), {
              retryable: true,
              exhausted: true,
            });
            throw new ChainRpcTransportError(
              'RPC_RECEIPT_LOOKUP_FAILED',
              `Receipt lookup for transaction ${txHash} failed on all configured RPC endpoints: ${errorMessage(cause)}`,
              { cause, txHash },
            );
          }
          this.recordRpcOutcome('eth_getTransactionReceipt', this.rpcOutcome(err), {
            retryable: false,
          });
          throw err;
        } finally {
          metrics.chainRpcDuration.record(Date.now() - startedAt, {
            rpc_method: 'eth_getTransactionReceipt', chain_id: chainId,
          });
        }
      },
      { attributes: { 'rpc.method': 'eth_getTransactionReceipt', 'dkg.chain_id': chainId } },
    );
    return options.signal
      ? withRpcRequestAbortSignal(options.signal, run)
      : run();
  }

  /**
   * The single per-endpoint state machine backing `read`, `readContract`, and
   * `getReceipt`. It owns endpoint ordering, validation+request attempt budgets,
   * retry classification, benign-empty semantics, stickiness transitions, and
   * failover selection. Receipt lookups add an absolute deadline and accept any
   * real null response; ordinary nullable reads retain their stricter all-empty
   * contract. Keeping both policies here prevents CLI and adapter receipt paths
   * from growing a second transport loop beside the canonical failover core.
   */
  private async runAcrossProviders<T>(
    label: string,
    fn: (provider: JsonRpcProvider) => Promise<T>,
    options: ProviderPassOptions<T>,
  ): Promise<T> {
    // `canonical` = the configured order (index 0 = primary), used for the cap,
    // the exhaustion aggregate, and the "which is the primary" check. `attempts`
    // = the per-op iteration order (preferred-first when sticky), each entry
    // binding its endpoint + outcome recorders. Same members, possibly reordered —
    // so the cap/exhaustion contract stays canonical while only the try-order changes.
    const canonical = this.getEndpoints();
    const attempts = this.stickiness.attempts(canonical, options.intent);
    const configuredAttemptTimeoutMs = options.attemptTimeoutMs(canonical.length);
    let lastRetryable: unknown;
    let allEndpointsThrottled = true;
    let sawEmpty = false;
    let lastEmpty: T | undefined;
    let deadlineExpiredBeforeAttempt = false;
    for (let i = 0; i < attempts.length; i += 1) {
      const attempt = attempts[i];
      const endpoint = attempt.endpoint;
      const isLast = i === attempts.length - 1;
      const attemptStartedAt = Date.now();
      const deadlineRemainingMs = options.deadlineMs === undefined
        ? undefined
        : options.deadlineMs - attemptStartedAt;
      if (deadlineRemainingMs !== undefined && deadlineRemainingMs <= 0) {
        deadlineExpiredBeforeAttempt = true;
        break;
      }
      const attemptBudgetMs = deadlineRemainingMs === undefined
        ? configuredAttemptTimeoutMs
        : configuredAttemptTimeoutMs === undefined
          ? deadlineRemainingMs
          : Math.min(configuredAttemptTimeoutMs, deadlineRemainingMs);
      const attemptDeadlineMs = attemptBudgetMs === undefined
        ? undefined
        : attemptStartedAt + attemptBudgetMs;
      try {
        options.onAttempt?.(i + 1);
        if (this.validateEndpoint) {
          await this.runProviderAttemptStage(
            () => this.validateEndpoint!(endpoint),
            attemptDeadlineMs,
            `${label} chainId validation via RPC #${i + 1}`,
          );
        }
        const out = await this.runProviderAttemptStage(
          () => fn(endpoint.provider),
          attemptDeadlineMs,
          `${label} via RPC #${i + 1}`,
        );
        if (options.isEmptyResult?.(out)) {
          // A BENIGN "no result on this endpoint (yet)" — a nullable read whose
          // endpoint hasn't imported the tx/block. This is NOT a transport failure:
          // it must NOT de-prefer the endpoint (recordFailure) or emit failover
          // telemetry. Try the next endpoint; if EVERY endpoint is empty (and none
          // errored) the empty value itself is the honest answer.
          sawEmpty = true;
          allEndpointsThrottled = false;
          lastEmpty = out;
          continue;
        }
        attempt.recordSuccess();
        options.onServed(endpoint, out);
        return out;
      } catch (err) {
        if (!options.isRetryable(err)) throw err;
        lastRetryable = err;
        if (!isThrottleRpcError(err)) allEndpointsThrottled = false;
        attempt.recordFailure(); // de-prefer a failed backend
        const canTryNext = options.deadlineMs === undefined || Date.now() < options.deadlineMs;
        if (!isLast && canTryNext) {
          noteRpcFailover(label, endpoint.rpcUrl, err, attempts[i + 1].endpoint.rpcUrl);
        }
      }
    }
    // Ordinary nullable reads require an all-empty pass, so any real transport
    // error still exhausts. Receipt polls opt into `any-empty`: one endpoint's
    // real null response is enough to report "not mined yet" despite a transient
    // peer failure, matching their long-standing saw-non-error contract.
    if (lastRetryable && !(sawEmpty && options.emptyResultPolicy === 'any-empty')) {
      // Single provider → carry the typed code but keep the original message
      // byte-identical (there is no second endpoint, so the raw message reads
      // cleaner and any message-inspecting caller keeps seeing it). Multiple
      // providers → the host-only "all endpoints" aggregate (never full URLs —
      // a configured rpcUrl may carry an API key and this message can reach HTTP
      // clients via response paths that echo err.message). Mirrors the write
      // preparation loop's single-vs-multi message handling. Built from CANONICAL
      // order so the error's `rpcUrls` stays a stable configured-order contract
      // regardless of the per-op reorder.
      const message = canonical.length <= 1
        ? errorMessage(lastRetryable)
        : `${label} read failed on all configured RPC endpoints ` +
          `(${canonical.map((e) => rpcHost(e.rpcUrl)).join(', ')}): ${errorMessage(lastRetryable)}`;
      throw new ProviderSetExhaustedError(message, allEndpointsThrottled ? 'all-throttled' : 'mixed', {
        cause: lastRetryable,
        rpcUrls: canonical.map((e) => e.rpcUrl),
      });
    }
    // Either every endpoint returned empty with no errors, or the caller's
    // `any-empty` policy accepted at least one empty response.
    if (sawEmpty) return lastEmpty as T;
    if (deadlineExpiredBeforeAttempt) {
      throw createRpcTimeoutError(`${label} exceeded its operation deadline`);
    }
    // Unreachable when >=1 endpoint is configured (each iteration returns,
    // continues on empty, or throws / sets lastRetryable). Guard the 0-endpoint case.
    throw new ChainRpcTransportError(
      'RPC_ENDPOINTS_EXHAUSTED',
      `${label} read failed: no configured RPC endpoints`,
      { rpcUrls: [] },
    );
  }

  /**
   * Run one validation/request stage inside the SAME per-attempt budget. The
   * stage thunk is invoked only after checking the remaining budget, so a slow
   * validation can time out without a detached receipt lookup starting later.
   */
  private async runProviderAttemptStage<T>(
    stage: () => Promise<T>,
    attemptDeadlineMs: number | undefined,
    label: string,
  ): Promise<T> {
    if (attemptDeadlineMs === undefined) return stage();
    const remainingMs = attemptDeadlineMs - Date.now();
    if (remainingMs <= 0) {
      throw createRpcTimeoutError(`${label} exceeded its endpoint-attempt deadline`);
    }
    return withTimeout(stage(), remainingMs, label);
  }

  /**
   * Shared endpoint-set orchestration for provider and contract reads. A
   * recoverable all-throttled pass stays internal; terminal exhaustion is
   * reported exactly once only after the retry policy has settled.
   */
  private async runReadPasses<T>(
    label: string,
    runPass: () => Promise<T>,
    endpointSetRetry?: ReadOpts['endpointSetRetry'],
  ): Promise<T> {
    try {
      return endpointSetRetry === 'all-throttled'
        ? await this.withThrottleRetries(runPass)
        : await runPass();
    } catch (error) {
      if (error instanceof ProviderSetExhaustedError) {
        noteRpcExhaustion(label, error.rpcUrls ?? []);
      }
      throw error;
    }
  }

  private async withThrottleRetries<T>(run: () => Promise<T>): Promise<T> {
    for (let retry = 0; ; retry += 1) {
      try {
        return await run();
      } catch (error) {
        // A raw 429 from a caller-supplied non-retryable classifier must retain
        // its no-failover/no-retry contract. Only retry a typed FULL-POOL
        // exhaustion produced by runAcrossProviders.
        if (!(error instanceof ProviderSetExhaustedError)
          || error.exhaustionKind !== 'all-throttled'
          || retry >= this.readThrottleRetries) throw error;
        await sleep(this.readThrottleBackoffMs * (2 ** retry));
      }
    }
  }

  /**
   * Rebind a CONTRACT to `runner` (a provider for a view read) for one
   * per-endpoint attempt, leaving the caller's boot-bound handle untouched. The
   * `as Contract` recovers the dynamic-method index signature ethers'
   * `BaseContract.connect` drops.
   */
  private rebindContract(contract: Contract, runner: JsonRpcProvider | Wallet): Contract {
    return contract.connect(runner) as Contract;
  }

  private async validateEndpointForAttempt(
    endpoint: RpcEndpoint,
    timeoutMs: number | undefined,
    timeoutLabel: string,
  ): Promise<void> {
    if (!this.validateEndpoint) return;
    const validation = this.validateEndpoint(endpoint);
    if (timeoutMs == null) {
      await validation;
      return;
    }
    await withTimeout(validation, timeoutMs, timeoutLabel);
  }

  /** Rebind a SIGNER to `provider` for one per-endpoint populate+sign attempt. */
  private rebindSigner(signer: Wallet, provider: JsonRpcProvider): Wallet {
    return signer.connect(provider);
  }
}

export interface TransactionReceiptWaitOptions {
  /** Overall submitted-transaction receipt deadline (default 10 minutes). */
  receiptTimeoutMs?: number;
  /** Low-cardinality transport label. Defaults to `direct transaction`. */
  logLabel?: string;
}

/** One direct receipt endpoint with optional telemetry metadata kept in-band. */
export interface TransactionReceiptEndpoint {
  provider: JsonRpcProvider;
  rpcUrl?: string;
}

/**
 * Stable direct-write receipt boundary used by CLI commands after broadcast.
 * It constructs the same concrete `RpcFailoverClient` the adapter uses, leaving
 * `receipt-wait.ts` responsible only for operation-level polling/deadline logic.
 */
export async function waitForTransactionReceiptWithFailover(
  endpoints: readonly TransactionReceiptEndpoint[],
  txHash: string,
  options: TransactionReceiptWaitOptions = {},
): Promise<ethers.TransactionReceipt> {
  const receiptTimeoutMs = resolveReceiptTimeoutMs(options.receiptTimeoutMs);
  const logLabel = options.logLabel ?? 'direct transaction';
  const rpcEndpoints: RpcEndpoint[] = endpoints.map((endpoint, index) => ({
    provider: endpoint.provider,
    // URL is telemetry/stickiness metadata only. Keep URL-less endpoints in the
    // pass with a non-secret stable label rather than filtering them out.
    rpcUrl: endpoint.rpcUrl ?? `dkg-direct-rpc://endpoint-${index + 1}`,
  }));
  const receiptTransport = new RpcFailoverClient(
    () => rpcEndpoints,
    async () => { throw new Error('receipt-only RPC transport cannot sign'); },
    () => 'direct',
    // This helper owns one transaction wait, so cross-operation preference has
    // no value; disabling it preserves the configured endpoint order per poll.
    { stickiness: { enabled: false } },
  );

  return waitForReceiptWithDeadline({
    txHash,
    receiptTimeoutMs,
    pollIntervalMs: RPC_RECEIPT_POLL_INTERVAL_MS,
    getReceipt: (hash, { deadlineMs }) => receiptTransport.getReceipt(hash, {
      deadlineMs,
      logLabel: `${logLabel} receipt lookup`,
    }),
    assertSuccessfulReceipt: receipt => assertSuccessfulReceipt(receipt, logLabel),
    formatTimeoutMessage: () =>
      `Transaction ${txHash} was broadcast but no receipt was found within ${receiptTimeoutMs}ms`,
  });
}
