// SPDX-License-Identifier: Apache-2.0

/**
 * Module-scope timing / key-purpose constants extracted from evm-adapter.ts
 * during the structural split. Imported by evm-adapter-base.ts and the
 * per-domain holder modules. Pure values — no behaviour change.
 */

/**
 * Default TTL for re-resolving `RandomSampling` / `RandomSamplingStorage`
 * from the Hub. Matches the daemon auto-update poll cadence — small
 * enough that a missed `Hub.ContractChanged` event still self-heals
 * within ~5 min, large enough that the steady-state RPC overhead is
 * effectively zero (one extra `eth_call` every 5 min for the two
 * names, vs. the prover's per-tick reads). Override per-adapter via
 * `EVMAdapterConfig.randomSamplingHubRefreshMs`.
 */
export const DEFAULT_RANDOM_SAMPLING_HUB_REFRESH_MS = 5 * 60 * 1000;

/**
 * Hard ceiling for the best-effort live `getActiveProofingPeriodDurationInBlocks()`
 * read inside `getActiveProofPeriodStatus()`. The status read itself is one
 * `eth_call`; the duration probe is a sibling `eth_call` on the same provider
 * and should typically resolve in <100ms. If it hasn't returned in 2s the
 * provider is slow or hanging — fall back to `undefined` and let the prover
 * use the cached `existing.proofingPeriodDurationInBlocks` rather than
 * stalling the whole tick. Codex round 5 on PR #369.
 */
export const DURATION_PROBE_TIMEOUT_MS = 2000;

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
export const MAX_PROBE_AGE_MS = 30_000;

export const RPC_READ_STALL_TIMEOUT_MS = 4_000;

/**
 * TTL (ms) for the `RpcFailoverClient` endpoint-stickiness "primary re-probe"
 * cadence (Mechanism B, #1340 retry residual + #1337 policy-read fail-close).
 * Once a read/write has failed over to a backup, the client prefers that
 * last-good backend for subsequent ops, but re-probes the CONFIGURED PRIMARY at
 * most once every `STICKY_PREFERRED_TTL_MS` of degraded operation (bounded to one
 * re-stall per window) so a recovered primary resumes automatically. Chosen at
 * 30s: comfortably spans #1340's seconds-long CG-register recovery burst and
 * #1337's back-to-back policy-read burst, while keeping the steady-state
 * re-probe cost to one extra primary attempt per 30s. Deliberately equal to the
 * hub-rotation poll cadence — but the poller's head probe is `skipPreferred`
 * (preference-transparent), so the two never interfere. Overridable per-client
 * via the constructor stickiness options (used by tests) and killable via
 * `DKG_DISABLE_RPC_STICKINESS=1`.
 */
export const STICKY_PREFERRED_TTL_MS = 30_000;

/**
 * Per-attempt deadline for WIDE `eth_getLogs` reads (the `evm-adapter-events.ts`
 * `queryFilter` scans, which run over `[fromBlock ?? 0, toBlock]` — up to the
 * event poller's 9,000-block window, and the full chain on a cold-start
 * backfill). These legitimately take tens of seconds on a busy/slow chain, so
 * the 4s `RPC_READ_STALL_TIMEOUT_MS` point-read cap would abort a healthy scan
 * and fail it over across every endpoint → spurious `RPC_ENDPOINTS_EXHAUSTED`
 * (which, in the poller, escapes before the cursor advances → a permanent
 * stall). 30s still hard-bounds a genuinely hung backend on a multi-RPC node;
 * it is consumed via the `wideLogScan` ReadPolicy in `resolveCapMs`
 * (rpc-failover-client.ts), so single-RPC stays uncapped (#894).
 * Larger than `KA_HIGH_WATER_PAGE_TIMEOUT_MS` (15s) because that bounds smaller
 * 2,000-block pages, whereas this covers the wider 9,000-block poller window.
 */
export const RPC_LOG_SCAN_TIMEOUT_MS = 30_000;

export const RPC_TRANSACTION_POPULATION_ATTEMPT_TIMEOUT_MS = 10_000;

export const RPC_BROADCAST_ATTEMPT_TIMEOUT_MS = 10_000;

export const RPC_RECEIPT_ATTEMPT_TIMEOUT_MS = 5_000;

export const RPC_RECEIPT_POLL_INTERVAL_MS = 2_000;

export const RPC_RECEIPT_TIMEOUT_MS = 180_000;

/**
 * Bounded "retry the whole endpoint set" for the BROADCAST phase (S2). After a
 * full per-endpoint broadcast pass exhausts with a retryable error (e.g. a brief
 * window where ALL endpoints 429), `sendSignedTransactionAndWait` re-broadcasts
 * the SAME already-signed/already-WAL-checkpointed tx up to this many extra full
 * passes, with `RPC_ENDPOINT_SET_RETRY_BACKOFF_MS` between passes, before
 * surfacing `RPC_ENDPOINTS_EXHAUSTED`. Default `1` (one extra pass) keeps the
 * "ride out a brief all-down blip" property without per-endpoint latency; `0`
 * fails fast on the first full-pass exhaustion. Re-broadcasting the identical
 * signed tx is idempotent (`isKnownTransactionError`), so this cannot double-
 * submit or change the nonce — it is scoped to broadcast ONLY (receipt waiting
 * owns its own deadline), so total lock-hold stays bounded.
 */
export const RPC_ENDPOINT_SET_RETRIES = 1;

export const RPC_ENDPOINT_SET_RETRY_BACKOFF_MS = 500;

export const ADMIN_KEY_PURPOSE = 1;

export const OPERATIONAL_KEY_PURPOSE = 2;

/**
 * TTL (ms) for the per-operational-wallet funding cache used by funding-aware
 * publish signer selection (`nextAuthorizedSigner`). Short enough that a
 * just-funded wallet is picked up quickly and a draining wallet self-corrects,
 * long enough that a sequential bulk "Publish All" loop reuses one
 * native+TRAC balance read per wallet instead of re-reading on every iteration.
 */
export const PUBLISHER_FUNDING_CACHE_TTL_MS = 15_000;
