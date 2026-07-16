> **Status**: Draft implementation plan companion to
> [SPEC_ASYNC_PROMOTE_QUEUE.md](./SPEC_ASYNC_PROMOTE_QUEUE.md). Not a
> formal spec; meant to give an implementing engineer (or agent) enough
> structural decisions to land the work without re-litigating the RFC.

# Async Promote Queue — implementation plan

## Goal

Translate the [RFC](./SPEC_ASYNC_PROMOTE_QUEUE.md) (PR #643, merged
2026-05-25) into a working `packages/publisher/src/async-promote-queue-impl.ts`
sibling of [`async-lift-publisher-impl.ts`](../../packages/publisher/src/async-lift-publisher-impl.ts),
plus the surrounding daemon routes / agent wiring / tests.

The RFC pins the surface (`POST /api/assertion/<name>/promote-async`,
GET status, DELETE/recover), the state machine (`queued → running →
{succeeded, failed_retrying → queued, failed}`), the persistence
(dedicated control graph), and the concurrency rules (`(cgId,
subGraphName, assertionName)` uniqueness, max-N workers). Empirical
motivation from the rc.10 Graphify import (200× write degradation past
~100k SWM triples; ~15 min wall-clock in `entities: "all"` halve-and-
retry across 4 partitions) lives in §10 of the RFC.

This plan covers **how** to build that.

## 1. Reference pattern: `TripleStoreAsyncLiftPublisher`

The RFC is explicit that this queue mirrors the existing
`AsyncLiftPublisher` for SWM→VM. Everything below copies that file's
shape unless the §differences-from-AsyncLift section calls out a
specific divergence.

| Concern | AsyncLiftPublisher pattern | Reuse / diverge? |
|---|---|---|
| Class shape | `TripleStoreAsyncLiftPublisher implements AsyncLiftPublisher` | Reuse: `TripleStoreAsyncPromoteQueue implements AsyncPromoteQueue` |
| Persistence | Jobs stored as RDF in a dedicated control graph in the same `TripleStore`; `claimQueues = new Map<walletId, Promise<void>>` for in-process serialization | Reuse with different graph URI: `urn:dkg:promote-queue:control-plane` per RFC §4.1 |
| Claim/lease | `walletId`-scoped CAS via `lockExpiresAt`, `claimToken`; lease ~5 min; `withClaimLock` mutex per wallet | Reuse, but lease holder is "worker id" not "wallet id" (promotes aren't wallet-scoped — see §differences-1) |
| State machine | `accepted → claimed → broadcast → included → finalized` (+ `failed`) | Replace with RFC §3.2 states: `queued → running → {succeeded, failed_retrying → queued, failed}` |
| Retry policy | `maxRetries = 10`, exponential backoff via `nextRetryAt` | Reuse default; per RFC §4.2 retries gated by `attempt.retryable` classification |
| ID generation | `config.idGenerator ?? () => crypto.randomUUID()` | Reuse |
| Time source | `config.now ?? () => Date.now()` | Reuse — tests need deterministic time |
| Pause/resume | Boolean flag stops `claimNext` from picking new work | Reuse |
| Recovery | On startup, lease-expired `claimed` jobs are reset to `accepted` | Diverge: expired `running` promotes are parked for operator inspection unless a future reconciler can prove no SWM side effect happened |

## 2. Differences from AsyncLiftPublisher

1. **Not wallet-scoped.** AsyncLift's lock is per `walletId` because each
   wallet has its own chain-tx pipeline. Promote workers compete only for
   I/O on the same triple store, so the lock is per `(cgId, subGraphName,
   assertionName)` — one promote per assertion at a time, but N workers
   total (default 4). The claim-queue map keys on full assertion identity,
   not wallet id.

2. **No private staging.** AsyncLift's `stampCanonicalAnchorsInWorkspace`
   exists because lift transforms source IRIs to canonical IRIs and has to
   pre-stage private content for the eventual finalize. Promote-async has
   no equivalent — it just calls the existing `agent.publisher.assertionPromote`
   inside the worker, end of story.

3. **Job payload is tiny.** AsyncLift carries a full `LiftRequest` with
   roots, namespace, scope, authority proof, seal, allowed peers, etc.
   Promote-async carries `{ contextGraphId, subGraphName, assertionName,
   entities, enqueuedAt }`. The whole control-graph RDF for a job fits in
   ~10 triples vs lift's ~50.

4. **Single recovery resolver, no chain.** AsyncLift has a
   `chainRecoveryResolver` for `broadcast/included` → on-chain lookup
   reconciliation. Promote has no chain interaction; v1 therefore parks
   expired running attempts as ambiguous instead of guessing from a stale
   marker or an imprecise SWM graph probe.

5. **Idempotency story.** `agent.publisher.assertionPromote` writes
   SWM, mutates WM cleanup, and stamps lifecycle metadata in three
   separate stages (see `packages/publisher/src/dkg-publisher.ts` L3102).
   The RFC §4.4 attempt commit marker is operator-facing evidence for
   partial commits; automatic rerun waits for a stronger idempotency hook
   or on-store reconciler. This is the **single biggest implementation
   risk** and gets its own section below (§7).

## 3. File layout

Mirror the AsyncLift four-file split:

```
packages/publisher/src/
├── async-promote-queue.ts            (~10 LOC) — re-export entrypoint
├── async-promote-queue-types.ts      (~80 LOC) — interface + types
├── async-promote-queue-utils.ts      (~100 LOC) — helpers (literal, jobSubject, claim constants)
└── async-promote-queue-impl.ts       (~800 LOC) — TripleStoreAsyncPromoteQueue class

packages/publisher/test/
├── async-promote-queue.test.ts       (~800 LOC) — unit tests, in-memory store
└── e2e-promote-queue.test.ts         (~300 LOC) — full daemon round-trip

packages/cli/src/daemon/routes/
└── assertion.ts                      — add 4 new route handlers (~150 LOC)

packages/agent/src/
└── dkg-agent.ts                      — wire the queue into the agent (~30 LOC)
```

Total new code: roughly **2,000 LOC** plus the route handlers + wiring,
matching the RFC's §9 sizing estimate.

## 4. Interface (`async-promote-queue-types.ts`)

```ts
export type PromoteJobState =
  | 'queued'
  | 'running'
  | 'failed_retrying'
  | 'succeeded'
  | 'failed';

export interface PromoteRequest {
  contextGraphId: string;
  subGraphName?: string;
  assertionName: string;
  entities: string[] | 'all';
  // Per the RFC §3.1 these come in via the HTTP route's body validation;
  // the queue stores them verbatim for the worker to replay.
}

export interface PromoteJob {
  jobId: string;
  request: PromoteRequest;
  state: PromoteJobState;
  enqueuedAt: number;
  // Lease metadata (only present in `running` / `failed_retrying`).
  lease?: {
    workerId: string;
    acquiredAt: number;
    expiresAt: number;
    lastHeartbeatAt: number;
    claimToken: string;
  };
  attempt: {
    count: number;
    maxRetries: number;
    nextRetryAt?: number;        // populated when entering failed_retrying
    lastError?: {
      message: string;
      retryable: boolean;
      classification: 'transient' | 'cap_exceeded' | 'fatal';
      recordedAt: number;
    };
  };
  result?: {
    promotedCount: number;
    succeededAt: number;
    gossipMessageSize?: number;   // for ops telemetry (informational only)
  };
  // RFC §4.4 attempt commit marker — written after `assertionPromote`
  // returns successfully but BEFORE the job row is moved to `succeeded`.
  // Recovery uses this as operator-facing evidence, not as proof that an
  // unmarked expired attempt is safe to rerun.
  commitMarker?: {
    swmInserted: boolean;
    wmCleaned: boolean;
    lifecycleStamped: boolean;
    gossiped: boolean;
  };
}

export interface AsyncPromoteQueue {
  // RFC §3.1
  enqueue(request: PromoteRequest): Promise<string>;
  // RFC §3.2
  getStatus(jobId: string): Promise<PromoteJob | null>;
  // RFC §3.3
  list(filter?: { state?: PromoteJobState[]; contextGraphId?: string; limit?: number }): Promise<PromoteJob[]>;
  // RFC §3.4
  cancel(jobId: string): Promise<void>;     // only valid in `queued`
  recover(jobId: string): Promise<void>;    // only valid in `failed`
  // Worker-side (called by the in-process worker loop, not exposed via HTTP)
  claimNext(workerId: string): Promise<PromoteJob | null>;
  heartbeat(jobId: string, workerId: string): Promise<void>;
  recordCommitMarker(jobId: string, step: keyof NonNullable<PromoteJob['commitMarker']>): Promise<void>;
  succeed(jobId: string, result: PromoteJob['result']): Promise<void>;
  fail(jobId: string, error: NonNullable<PromoteJob['attempt']['lastError']>): Promise<void>;
  // Startup / lifecycle
  recoverOnStartup(): Promise<{ reclaimed: number; abandoned: number }>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  getStats(): Promise<Record<PromoteJobState, number>>;
}

export interface AsyncPromoteQueueConfig {
  graphUri?: string;              // default 'urn:dkg:promote-queue:control-plane'
  maxRetries?: number;            // default 5 (lower than lift's 10 — promote retries are cheap)
  leaseLeaseMs?: number;          // default 5 * 60_000
  workerConcurrency?: number;     // default 4 — RFC §4.5 importLimits hint
  now?: () => number;
  idGenerator?: () => string;
  // Injected by the daemon — the actual promote operation to run.
  promoteExecutor: (request: PromoteRequest) => Promise<{ promotedCount: number; gossipMessageSize?: number }>;
}
```

## 5. Tests-first plan

Tests come BEFORE code for every block below. Use the same dual-shape
the AsyncLift suite uses: most tests against an in-memory `TripleStore`
mock; one end-to-end test against a live daemon with the real Oxigraph
store.

### 5.1 Unit tests (`async-promote-queue.test.ts`)

Strictly ordered by the test plan; each test names the RFC section /
behavior it pins. Implementation is "make the next test pass" until all
are green.

| # | Test name | Pins |
|---|---|---|
| 1 | `enqueue() returns a fresh jobId and persists the job in 'queued' state` | §3.1 happy path |
| 2 | `enqueue() rejects body too large via SMALL_BODY_BYTES error` | §3.1 body cap (route-level, but tested here for the validator) |
| 3 | `enqueue() returns 409 with existing jobId when (cgId, subGraphName, assertionName) has an active job` | §4.5 uniqueness key |
| 4 | `getStatus() returns null for an unknown jobId` | §3.2 |
| 5 | `getStatus() returns the full PromoteJob including attempt count and lease (when running)` | §3.2 |
| 6 | `list({state: ['queued']}) returns only queued jobs` | §3.3 filter |
| 7 | `list({contextGraphId}) scopes correctly` | §3.3 filter |
| 8 | `cancel() on 'queued' job moves to 'failed' with reason="cancelled"` | §3.4 |
| 9 | `cancel() on 'running' job rejects with 409 (worker is mutating it)` | §3.4 |
| 10 | `claimNext() picks the oldest queued job and sets state=running with lease` | §4.3 FIFO + lease |
| 11 | `claimNext() returns null when paused` | §4.3 |
| 12 | `claimNext() returns null when no queued jobs match worker id constraints` | §4.3 |
| 13 | `claimNext() does NOT pick a second job for the same (cgId, subGraphName, assertionName) while one is running` | §4.5 per-assertion lock |
| 14 | `heartbeat() extends the lease without changing state` | §4.3 |
| 15 | `heartbeat() rejects when called by a worker that doesn't hold the lease` | §4.3 lease ownership |
| 16 | `succeed() moves running → succeeded; records promotedCount` | §3.2 |
| 17 | `succeed() rejects if the job's commitMarker.swmInserted is false` | §4.4 invariant |
| 18 | `fail() with retryable=true moves running → failed_retrying with nextRetryAt = now + backoff(attempt)` | §3.2, §4.2 |
| 19 | `fail() with retryable=false moves running → failed (terminal)` | §3.2 |
| 20 | `fail() in failed_retrying when attempt.count >= maxRetries moves to failed (terminal)` | §4.2 retry budget |
| 21 | `claimNext() picks up a failed_retrying job once nextRetryAt has passed` | §4.4 worker pickup |
| 22 | `claimNext() does NOT pick up failed_retrying before nextRetryAt` | §4.4 backoff respected |
| 23 | `recover(jobId)` on 'failed' resets attempt counter and moves to 'queued' | §3.4 explicit recover |
| 24 | `recover(jobId)` on non-'failed' state rejects with 400 | §3.4 |
| 25 | `recoverOnStartup() abandons claimed jobs whose lease expired more than 2× lease ago` | §4.4 lease-expiry |
| 26 | `recoverOnStartup() parks expired claimed jobs even when commitMarker.swmInserted=false` | §4.4 ambiguous crash window |
| 27 | `recoverOnStartup() parks claimed jobs whose lease expired recently AND commitMarker.swmInserted=true into 'failed' with reason="partial promote ambiguity"` | §4.4 unsafe rerun |
| 28 | `recoverOnStartup() returns counts of {reclaimed, abandoned}` | §4.4 observability |
| 29 | `getStats() returns the queue depth per state` | observability |
| 30 | `pause() prevents claimNext() from picking new work; resume() restores` | §3.4 ops control |

Roughly 30 tests; ~500 LOC. Each test exercises one RFC behavior in
isolation. The `promoteExecutor` is mocked per test (sometimes resolves,
sometimes throws with a specific error classification, sometimes hangs
to test heartbeats).

### 5.2 End-to-end test (`e2e-promote-queue.test.ts`)

One test, real daemon, real Oxigraph:

```
1. Start daemon with auto-enabled async-promote queue + 2 workers.
2. Create assertion `bench-1` with 100k synthetic triples.
3. POST /api/assertion/bench-1/promote-async with entities:"all" → jobId.
4. Poll GET /api/assertion/promote-async/<jobId> until succeeded.
5. Assert: SWM contains all 100k triples; WM no longer contains them;
   promotedCount matches; getStats() shows queued=0, running=0, succeeded=1.
6. Concurrent run: enqueue 10 async promotes targeting 10 different
   assertions. Assert: all 10 succeed; running gauge tops out at
   workerConcurrency=2, not 10.
7. Failure-injection run: inject one transient error into one job.
   Assert: state transitions running → failed_retrying → running →
   succeeded; final attempt.count == 2.
```

This is the test that would have caught the cascading-slowdown
problem if it existed today — write throughput stays flat while
promotes drain in the background.

## 6. HTTP route handlers (`packages/cli/src/daemon/routes/assertion.ts`)

Four new handlers, all under SMALL_BODY_BYTES (256 KB body cap, same
as sync `/promote`):

```ts
// POST /api/assertion/<name>/promote-async
// Body: { contextGraphId, subGraphName?, entities? }
// Response 200: { jobId, state: 'queued', enqueuedAt }
// Response 409 (existing job): { error, jobId, existingJobId }
// Response 413 (body cap): { error: 'Request body too large (>262144 bytes)' }

// GET /api/assertion/promote-async/<jobId>
// Response 200: PromoteJob (full shape)
// Response 404: { error: 'Job not found' }

// GET /api/assertion/promote-async?contextGraphId=<cg>&state=running,queued,failed_retrying&limit=50
// Response 200: { jobs: PromoteJob[] }

// DELETE /api/assertion/promote-async/<jobId>          # cancel queued
// POST   /api/assertion/promote-async/<jobId>/recover  # requeue failed
// Response 200: { jobId, state }
// Response 4xx with reason
```

The handlers are thin: they validate body, call into
`agent.assertion.promoteAsync` (a new agent surface), and serialise the
result. No business logic at this layer.

## 7. The single biggest risk: idempotency of `assertionPromote`

[`packages/publisher/src/dkg-publisher.ts` `assertionPromote`](../../packages/publisher/src/dkg-publisher.ts)
runs four side-effects:

1. SWM-side insert (`store.insert` into `<cg>/<sub>/_shared_memory`).
2. WM cleanup (move-or-delete the source quads).
3. Lifecycle metadata stamp (`<cg>/_meta` / assertion lifecycle URI).
4. Gossip broadcast to the libp2p gossipsub topic.

If the worker crashes between #1 and #2, re-running the job WOULD double-
insert the SWM triples (set semantics in Oxigraph means it's a no-op for
the SWM data itself, but the gossip broadcast in #4 would re-fire on the
retry, peer-side noise).

RFC §4.4 specifies the attempt commit marker. Implementation:

```ts
// Worker loop, simplified:
async function runJob(job: PromoteJob): Promise<void> {
  await queue.heartbeat(job.jobId, workerId);
  try {
    const result = await dkgPublisher.assertionPromote(...);
    // result.gossipMessage was already broadcast inside assertionPromote;
    // BUT we mark commit phases as we observe them.
    await queue.recordCommitMarker(job.jobId, 'swmInserted');
    await queue.recordCommitMarker(job.jobId, 'wmCleaned');
    await queue.recordCommitMarker(job.jobId, 'lifecycleStamped');
    await queue.recordCommitMarker(job.jobId, 'gossiped');
    await queue.succeed(job.jobId, { promotedCount: result.promotedCount, succeededAt: now() });
  } catch (err) {
    const classification = classifyPromoteError(err);
    await queue.fail(job.jobId, { message: err.message, retryable: classification.retryable, classification: classification.kind, recordedAt: now() });
  }
}
```

The catch: `assertionPromote` is a single TypeScript call today; it
doesn't expose progress between its internal phases. To make the commit
marker meaningful, **one of**:

(a) **Modify `assertionPromote`** to take an optional progress callback
   that fires after each internal step. Lower-risk for promote, but
   spreads the queue's bookkeeping into the publisher.

(b) **Add the marker only at the OUTER boundary** — single
   `commitMarker.completed = true` set after `assertionPromote` returns.
   Coarser, but matches what we can observe from outside.

(c) **Detect partial commits via SWM probe on recovery.** Run a
   `SELECT (COUNT(*) AS ?n) WHERE { GRAPH <swmUri> { ... } }` and compare
   to expected triple count. Most accurate but slowest.

Recommend (b) for v1 + (c) on recovery. Migrate to (a) only if (b)+(c)
prove inadequate in practice — and that judgment needs at least one full
production run's worth of telemetry before reopening.

## 8. Sequencing

1. **Land the queue class + unit tests in isolation.** No daemon wiring
   yet. PR #1: `packages/publisher/src/async-promote-queue-*.ts` +
   `packages/publisher/test/async-promote-queue.test.ts`. ~1,000 LOC.
   Reviewable as a standalone library; no behaviour change for any
   existing caller.

2. **Wire the queue into the agent + add HTTP routes.** PR #2:
   `packages/agent/src/dkg-agent.ts` + `packages/cli/src/daemon/routes/
   assertion.ts` (4 new handlers) + agent-level unit tests for the new
   `assertion.promoteAsync` surface. ~400 LOC.

3. **Add the worker loop + startup recovery.** PR #3:
   `packages/cli/src/daemon/worker/async-promote-worker.ts` (new) +
   startup hook in the daemon supervisor + the `recoverOnStartup` call
   chain. Wire in the existing daemon shutdown ordering so workers drain
   gracefully (see RFC §6.2 — DO NOT mark `running → queued` on shutdown).
   ~300 LOC + tests.

4. **End-to-end test + ops surface.** PR #4: the
   `e2e-promote-queue.test.ts` from §5.2 + an `importLimits.promoteWorkerConcurrency`
   field on `/api/status` (this is also outstanding for ADR 0002 follow-
   up, so the same PR can close both). ~200 LOC.

Each PR builds on the previous; #1 → #2 → #3 → #4 is the dependency
order. Each one is reviewable in its own right.

## 9. What's NOT in this plan

- **`graphSuffix`-aware client helpers in `scripts/lib/dkg-daemon.mjs`.**
  PR #642's round-4 fix already added `graphSuffix` / `view` to
  `DkgClient.query`. No client-side change is needed to read the queue
  state — agents will use the new `/api/assertion/promote-async/*`
  routes directly, which return JSON, not SPARQL bindings.
- **Migrating in-tree importers to use async promote.** Out of scope.
  Importers should opt in PR-by-PR after the queue lands; their existing
  sync `/promote` calls keep working.
- **Cross-daemon queue sharing.** RFC §8 explicit non-goal; each daemon
  owns its own queue.
- **A UI for the queue.** RFC §8 non-goal.

## 10. Open questions for the implementer

The RFC didn't decide these because they're implementation details, but
they need answers before code lands:

1. **Worker model.** In-process `setInterval(claimNext, 100ms)` loop is
   simplest. AsyncLift uses on-demand `processNext` driven by external
   triggers. Pick one and document.
2. **Backoff curve.** RFC §4.2 says "exponential"; pick a concrete:
   `min(60_000 * 2^attempt, 15 * 60_000)` (1 min, 2 min, 4 min, 8 min,
   15 min cap)?
3. **Error classification source.** `classifyPromoteError(err)` needs a
   concrete table of `err.message` patterns → `retryable / cap_exceeded
   / fatal`. The rc.10 import surfaced three patterns to seed it
   (gossip-cap, 256 KB body, transient `fetch failed`); the rest comes
   from running.
4. **Telemetry.** Should the queue emit `memoryGraphChanged` events
   (matching sync `/promote`)? Probably yes for `succeeded` jobs;
   probably no for state transitions.

These should be resolved in PR #1's description / first review round,
not blocked on a separate spec update.

## 11. Empirical exit criterion

Re-run the rc.10 Graphify import (see
[`/Users/aleatoric/dev/dkg-graphify-rc10-test/FINDINGS_v2.md`](file:///Users/aleatoric/dev/dkg-graphify-rc10-test/FINDINGS_v2.md))
against a daemon with the queue enabled and demonstrate:

- All 17 partitions promote without manual halve-and-retry (no
  `entities: "all"` 500-gossip failures surfaced to the importer).
- Write latency stays under 100 ms/batch across the full import
  (vs the ~200× degradation past 100k SWM triples observed today).
- Total wall-clock under 5 minutes (vs ~20+ minutes today, dominated
  by the four oversized-promote retry cycles).

If those three numbers don't move, the queue isn't doing its job and
something in the worker / agent wiring needs rethinking before the
implementation lands.
