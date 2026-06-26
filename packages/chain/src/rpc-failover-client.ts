// SPDX-License-Identifier: Apache-2.0

/**
 * `RpcFailoverClient` — the pure per-endpoint RPC transport mechanism extracted
 * from `EVMChainAdapterBase` (#1336, follow-up to #1335). It owns the read
 * failover loop, the contract rebind helper, the contract-view retryable
 * classifier, the named timeout-policy matrix, and the typed-exhaustion /
 * host-only-logging concerns — so they leave the 3,000-line base class and
 * become directly unit-testable.
 *
 * THE SAFETY BOUNDARY: this module holds NO transaction-safety state. There is
 * no WAL, no per-wallet serializer, and no approval latch here; the adapter's
 * tx-orchestration owns all of that and calls into this surface. The module
 * never sees the adapter — it is constructed with exactly three injected
 * capabilities (PLAN §0 D1/D2):
 *   1. `getProviders()` — a LIVE thunk over the adapter's bare `providers[]`
 *      (read live so tests that reassign `(a as any).providers` still propagate,
 *      and so a mid-flight rebind of the array is observed).
 *   2. `getRpcUrls()`   — a LIVE thunk over the adapter's `rpcUrls[]` (host-only
 *      reduced before it ever reaches a log or an error message).
 *   3. `signPopulated`  — the adapter's `signPopulatedTransaction` reached via a
 *      callback (it STAYS on the adapter — it carries the #870 signer stub and
 *      is pure, so its placement is a deliberate choice). Used by `populateAndSign`;
 *      the read family never signs.
 *
 * Surface: the read family (`read` / `readContract`, backed by the shared private
 * `runAcrossProviders` core, plus the policy matrix) and the write transport
 * (`populateAndSign` / `broadcast` / `getReceipt`). Each write method is kept
 * EXPLICIT and separate (PLAN §0 D8) — NOT folded into `runAcrossProviders` —
 * so its tx-critical divergences (the `isKnownTransactionError` idempotent
 * short-circuit; the estimate-failover-only-if-more-providers nuance; the
 * `sawNonErrorResponse`/null/`RPC_RECEIPT_LOOKUP_FAILED` shape) stay visible and
 * individually testable. The adapter's tx-orchestration calls these; the module
 * still owns NO tx-safety state (no WAL, no serializer, no approval latch).
 */

import { JsonRpcProvider, Wallet, Contract, ethers } from 'ethers';
import { withTimeout, isRetryableRpcError, isKnownTransactionError } from './evm-adapter-rpc.js';
import { errorCode, errorMessage } from './evm-adapter-errors.js';
import { noteRpcFailover, noteRpcExhaustion, rpcHost } from './rpc-failover-log.js';
import { ChainRpcTransportError } from './chain-rpc-transport-error.js';
import {
  RPC_READ_STALL_TIMEOUT_MS,
  RPC_LOG_SCAN_TIMEOUT_MS,
  RPC_BROADCAST_ATTEMPT_TIMEOUT_MS,
  RPC_RECEIPT_ATTEMPT_TIMEOUT_MS,
  RPC_TRANSACTION_POPULATION_ATTEMPT_TIMEOUT_MS,
} from './evm-adapter-constants.js';

/**
 * Named per-attempt timeout policy for a failover read (refactor #3) — replaces
 * the two raw knobs (`attemptTimeoutMs` / `multiAttemptTimeoutMs`) so callers
 * pick an intent, not a millisecond value, and can't misuse the matrix. The
 * exact cap each policy yields is in {@link resolveCapMs}.
 *   - `pointRead`           — a single `eth_call` / point provider read.
 *   - `wideLogScan`         — a multi-thousand-block `eth_getLogs` scan.
 *   - `failOpenFundingRead` — a fail-open funding/allowance read that must never
 *     stall selection (capped on EVERY attempt, including single-RPC).
 */
export type ReadPolicy = 'pointRead' | 'wideLogScan' | 'failOpenFundingRead';

/** Per-read options: a named timeout policy + an optional failover classifier
 *  override (a read whose error shape carries domain meaning). */
export interface ReadOpts {
  policy?: ReadPolicy;
  isRetryable?: (err: unknown) => boolean;
}

/**
 * The adapter's `signPopulatedTransaction`, injected as a callback (PLAN §0 D2).
 * It STAYS on the adapter (it carries the #870 signer-address stub) and the
 * module's write transport reaches it only through this thunk. Used by P2's
 * `populateAndSign`.
 */
export type SignPopulatedFn = (
  signer: Wallet,
  populated: ethers.TransactionRequest,
) => Promise<{ signedTx: string; txHash: string }>;

/**
 * Failover classifier for CONTRACT VIEW reads (`readContract`'s default): the
 * generic `isRetryableRpcError` transient set MINUS `BAD_DATA`. A view `BAD_DATA`
 * ("could not decode result data") is a DETERMINISTIC client-side decode of an
 * empty / wrong-shape return for the ABI type — not an RPC outage — so failing
 * over would re-hit the same decode on every endpoint and mask it as
 * `RPC_ENDPOINTS_EXHAUSTED`. The pre-PR FallbackProvider never failed over on a
 * post-decode error; this restores that. (Direct provider reads —
 * getCode/getBalance/getNetwork — never produce BAD_DATA, so they keep the
 * unmodified `isRetryableRpcError`.)
 */
export function isContractViewRetryable(err: unknown): boolean {
  return isRetryableRpcError(err) && errorCode(err) !== 'BAD_DATA';
}

/**
 * The timeout-policy matrix (refactor #3) — the EXACT semantic of the former
 * `capMs = attemptTimeoutMs ?? (providers>1 ? (multiAttemptTimeoutMs ?? 4s) : undefined)`
 * expression (evm-adapter-base.ts:878–881), re-expressed as three named buckets:
 *
 *   | policy              | multi-RPC cap            | single-RPC cap          |
 *   |---------------------|--------------------------|-------------------------|
 *   | pointRead           | RPC_READ_STALL (4s)      | uncapped (#894)         |
 *   | wideLogScan         | RPC_LOG_SCAN (30s)       | uncapped (#894)         |
 *   | failOpenFundingRead | RPC_READ_STALL (4s)      | RPC_READ_STALL (4s)     |
 *
 * `pointRead` / `wideLogScan` leave single-RPC uncapped (nothing to fail over
 * to; #894); `failOpenFundingRead` caps EVERY attempt incl. single so a fail-open
 * funding read can never stall publish-signer selection.
 */
export function resolveCapMs(policy: ReadPolicy, providerCount: number): number | undefined {
  if (policy === 'failOpenFundingRead') return RPC_READ_STALL_TIMEOUT_MS;
  if (providerCount <= 1) return undefined;
  return policy === 'wideLogScan' ? RPC_LOG_SCAN_TIMEOUT_MS : RPC_READ_STALL_TIMEOUT_MS;
}

export class RpcFailoverClient {
  constructor(
    private readonly getProviders: () => JsonRpcProvider[],
    private readonly getRpcUrls: () => string[],
    private readonly signPopulated: SignPopulatedFn,
  ) {}

  /**
   * Per-endpoint read-failover primitive over the bare `providers[]` (no
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
    return this.runAcrossProviders(
      label,
      fn,
      opts?.isRetryable ?? isRetryableRpcError,
      opts?.policy ?? 'pointRead',
    );
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
    return this.runAcrossProviders(
      label,
      (p) => fn(this.rebindContract(contract, p)),
      opts?.isRetryable ?? isContractViewRetryable,
      opts?.policy ?? 'pointRead',
    );
  }

  // --- write transport (called BY the adapter's tx-orchestration through the
  // D3 thin delegators; this layer owns NO WAL / serializer / approval latch —
  // it only runs the bare per-endpoint loop and returns/raises) ---

  /**
   * Per-endpoint populate+sign loop (PLAN §0 D8: explicit, NOT the read core).
   * Reached by the adapter's `populateAndSignAcrossProviders` delegator (shared
   * by `sendContractTransaction` and the V10 publish/update path). Iterates the
   * bare `providers[]` (signer + contract rebound to each), populates
   * (gas/nonce/chainId reads, optional OOG-buffer gas estimate) + signs via the
   * injected `signPopulated` callback (#870 stub stays on the adapter, PLAN §0
   * D2), and returns the FIRST successful `{signedTx,txHash}`. Advances ONLY on
   * `isRetryableRpcError`; a non-retryable error (a decoded revert — e.g.
   * `TooLowAllowance`) propagates AT ONCE so the caller can react. Exhaustion →
   * typed `RPC_ENDPOINTS_EXHAUSTED`.
   *
   * STRICTLY pre-broadcast: signs once on the winning provider, does NOT broadcast
   * or fire the WAL — the caller broadcasts the single returned tx. This keeps the
   * WAL split intact (onBroadcast between sign and broadcast).
   */
  async populateAndSign(
    contract: Contract,
    method: string,
    args: readonly unknown[],
    signer: Wallet,
    label: string,
    opts?: { gasLimitBufferBps?: number },
  ): Promise<{ signedTx: string; txHash: string }> {
    const providers = this.getProviders();
    const rpcUrls = this.getRpcUrls();
    let lastRetryable: unknown;
    for (let i = 0; i < providers.length; i += 1) {
      const rpcSigner = this.rebindSigner(signer, providers[i]);
      try {
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
            const hasMoreProviders = i < providers.length - 1;
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
        return await withTimeout(
          this.signPopulated(rpcSigner, populated),
          RPC_TRANSACTION_POPULATION_ATTEMPT_TIMEOUT_MS,
          `${label} transaction signing via RPC #${i + 1}`,
        );
      } catch (err) {
        if (!isRetryableRpcError(err)) throw err;
        lastRetryable = err;
        if (i < providers.length - 1) {
          noteRpcFailover(`${label} preparation`, rpcUrls[i], err, rpcUrls[i + 1]);
        }
      }
    }
    if (lastRetryable) noteRpcExhaustion(`${label} preparation`, rpcUrls);
    // Single provider → carry the code on a new error but keep the message
    // byte-identical (no second endpoint, so the raw message reads cleaner and
    // any message-inspecting caller keeps seeing it). Multiple providers → the
    // HOST-ONLY aggregate (never full URLs — a configured rpcUrl may carry an API
    // key and this message reaches HTTP clients via response paths that echo
    // err.message, e.g. the create+publish 207 tail). Asserted by
    // evm-adapter.unit.test.ts.
    const message = providers.length <= 1
      ? errorMessage(lastRetryable)
      : `${label} transaction preparation failed on all configured RPC endpoints ` +
        `(${rpcUrls.map(rpcHost).join(', ')}): ${errorMessage(lastRetryable)}`;
    throw new ChainRpcTransportError('RPC_ENDPOINTS_EXHAUSTED', message, {
      cause: lastRetryable,
      rpcUrls,
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
    const providers = this.getProviders();
    const rpcUrls = this.getRpcUrls();
    let lastRetryable: unknown;
    for (let i = 0; i < providers.length; i += 1) {
      const provider = providers[i];
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
        if (i < providers.length - 1) {
          noteRpcFailover(`${label} broadcast`, rpcUrls[i], err, rpcUrls[i + 1]);
        }
      }
    }
    if (lastRetryable) noteRpcExhaustion(`${label} broadcast`, rpcUrls);
    // Typed transport error (mirroring the preparation loop + CLI path) so a
    // broadcast-time all-endpoints-exhausted failure maps to a retryable 503 at
    // the HTTP boundary, not a generic 500 — an exhaustion after a provider
    // populated/signed would otherwise surface code-less.
    throw new ChainRpcTransportError(
      'RPC_ENDPOINTS_EXHAUSTED',
      `${label} broadcast failed on all configured RPC endpoints for tx ${txHash}: ${errorMessage(lastRetryable)}`,
      { cause: lastRetryable, rpcUrls },
    );
  }

  /**
   * Per-endpoint receipt fetch. A provider that RESPONDS (even with a `null`
   * "not yet mined" receipt) sets `sawNonErrorResponse` and the method yields
   * `null` rather than an exhaustion — only an all-endpoints-ERRORED lookup throws
   * the typed `RPC_RECEIPT_LOOKUP_FAILED` (kept DISTINCT from
   * `RPC_ENDPOINTS_EXHAUSTED` so the receipt-wait poll can tell "no receipt yet"
   * from "transport down"). Polled by the adapter's `waitForReceiptWithFailover`
   * deadline.
   */
  async getReceipt(txHash: string): Promise<ethers.TransactionReceipt | null> {
    const providers = this.getProviders();
    const rpcUrls = this.getRpcUrls();
    let lastRetryable: unknown;
    let sawNonErrorResponse = false;
    for (let i = 0; i < providers.length; i += 1) {
      const provider = providers[i];
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
        if (i < providers.length - 1) {
          noteRpcFailover('receipt lookup', rpcUrls[i], err, rpcUrls[i + 1]);
        }
      }
    }
    if (lastRetryable && !sawNonErrorResponse) {
      noteRpcExhaustion('receipt lookup', rpcUrls);
      throw new ChainRpcTransportError(
        'RPC_RECEIPT_LOOKUP_FAILED',
        `Receipt lookup for tx ${txHash} failed on all configured RPC endpoints: ${errorMessage(lastRetryable)}`,
        { cause: lastRetryable, txHash },
      );
    }
    return null;
  }

  /**
   * The shared read-family core (PLAN §0 D8): one per-endpoint loop backing both
   * `read` and `readContract`. The per-attempt `withTimeout` is a hard deadline
   * that ABORTS and fails over a hung backend; the cap comes from the named
   * `policy` via {@link resolveCapMs} (multi-RPC caps the attempt; single-RPC is
   * uncapped for `pointRead`/`wideLogScan` — #894, nothing to fail over to —
   * UNLESS `failOpenFundingRead`, which caps every attempt). `providers` and
   * `rpcUrls` are read LIVE from the injected thunks so a test or a mid-flight
   * reassignment is observed.
   */
  private async runAcrossProviders<T>(
    label: string,
    fn: (provider: JsonRpcProvider) => Promise<T>,
    isRetryable: (err: unknown) => boolean,
    policy: ReadPolicy,
  ): Promise<T> {
    const providers = this.getProviders();
    const rpcUrls = this.getRpcUrls();
    const capMs = resolveCapMs(policy, providers.length);
    let lastRetryable: unknown;
    for (let i = 0; i < providers.length; i += 1) {
      const isLast = i === providers.length - 1;
      try {
        const attempt = fn(providers[i]);
        return await (capMs == null
          ? attempt
          : withTimeout(attempt, capMs, `${label} via RPC #${i + 1}`));
      } catch (err) {
        if (!isRetryable(err)) throw err;
        lastRetryable = err;
        if (!isLast) {
          noteRpcFailover(label, rpcUrls[i], err, rpcUrls[i + 1]);
        }
      }
    }
    if (lastRetryable) noteRpcExhaustion(label, rpcUrls);
    // Single provider → carry the typed code but keep the original message
    // byte-identical (there is no second endpoint, so the raw message reads
    // cleaner and any message-inspecting caller keeps seeing it). Multiple
    // providers → the host-only "all endpoints" aggregate (never full URLs —
    // a configured rpcUrl may carry an API key and this message can reach HTTP
    // clients via response paths that echo err.message). Mirrors the write
    // preparation loop's single-vs-multi message handling.
    const message = providers.length <= 1
      ? errorMessage(lastRetryable)
      : `${label} read failed on all configured RPC endpoints ` +
        `(${rpcUrls.map(rpcHost).join(', ')}): ${errorMessage(lastRetryable)}`;
    throw new ChainRpcTransportError('RPC_ENDPOINTS_EXHAUSTED', message, {
      cause: lastRetryable,
      rpcUrls,
    });
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

  /** Rebind a SIGNER to `provider` for one per-endpoint populate+sign attempt. */
  private rebindSigner(signer: Wallet, provider: JsonRpcProvider): Wallet {
    return signer.connect(provider);
  }
}
