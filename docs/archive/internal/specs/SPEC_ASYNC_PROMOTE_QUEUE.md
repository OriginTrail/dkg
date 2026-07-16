# SPEC — Async promote queue

**Status**: RFC (proposed). Not implemented.
**Date**: 2026-05-25
**Scope**: A durable, retryable, fire-and-forget queue for `WM → SWM` promotions, modelled on the existing `AsyncLiftPublisher` (SWM → VM).
**Related**:
- [ADR 0002 — Importer chunking contract](../adr/0002-importer-chunking-contract.md)
- [`packages/publisher/src/async-lift-publisher.ts`](../../packages/publisher/src/async-lift-publisher.ts) — the existing SWM → VM async machinery this proposal mimics
- [#596](https://github.com/OriginTrail/dkg/issues/596), [#602](https://github.com/OriginTrail/dkg/pull/602), [#642](https://github.com/OriginTrail/dkg/pull/642) — the Graphify-import experience that surfaced the need

---

## 0. TL;DR

The synchronous `POST /api/assertion/<name>/promote` call blocks the importer
for every promote — both on network IO (the daemon has to subtract finalized
quads, validate root URIs against the assertion's WM contents, and write to
SWM) and on contention with other writers. For a 10,000-partition import that's
10,000 promote calls in series, each adding 50-500 ms of round-trip latency on
top of the work the importer is doing.

The existing `AsyncLiftPublisher` already solves the analogous problem for the
**next** memory tier (`SWM → VM`): an importer enqueues a lift job, gets back
a job id, and queries the queue at its own cadence to check progress. The daemon
durably retries failed jobs across restarts, applies wallet-locking + claim
ordering, and exposes structured success/failure metadata.

This spec proposes a **direct analogue for `WM → SWM`** — `AsyncPromoteQueue` —
that lets importers fire-and-forget the promote step the same way they
fire-and-forget the publish step today. The expected wins are:

- **Throughput**: importers stop blocking on promotes; the daemon batches
  promote work in the background.
- **Resumability**: a promote that failed because the daemon restarted mid-call
  isn't lost — the queue persists across restarts (same durability story as
  `AsyncLiftPublisher`).
- **Symmetry**: the daemon's two outbound tier transitions follow the same
  shape (enqueue, status, recover), which simplifies importer code.

## 1. Motivation

### 1.1 The Graphify experience (PR #602)

The importer in PR #602 had a write loop roughly shaped like:

```
for each source file:
  create assertion
  write triples (5000-quad batches)
  promote (root URIs, sometimes thousands per assertion)
```

The promote step was the slowest per-iteration step (the daemon does
quad-subtraction + WM → SWM transfer + GraphManager bookkeeping inside the
synchronous request). On the throwaway 30k-file repository it tested against,
the cumulative promote latency dominated the import wall-clock.

The importer can't parallelize promotes across assertions safely (the daemon
serialises intra-assertion writes, and promote on one assertion can contend
with write on another). The importer can't skip the promote either —
unpromoted assertions never reach SWM and stay invisible to teammates.

The current escape hatch is "promote at the very end, as a single batch"
(passing every root URI to one promote). But that doesn't scale either:
the promote payload itself hits the sync route's `SMALL_BODY_BYTES` budget,
and a single failed
promote at the end loses ALL of the import's intermediate progress (because
the WM assertions are still there but no peer has seen them).

### 1.2 The mirror with `AsyncLiftPublisher`

`AsyncLiftPublisher` already solved this for the next tier. Importers that
want to publish to VM don't block on a multi-minute on-chain transaction —
they enqueue a lift job, get a job id, and continue. The same shape applied
one tier earlier would let importers do the same for the WM → SWM step
without touching the existing sync promote API (sync stays available for
small / interactive use).

## 2. Non-goals

- **Replace `POST /api/assertion/<name>/promote`.** The sync route stays.
  Small / interactive importers prefer the synchronous answer-or-error
  shape; this spec adds an alternative, not a replacement.
- **Cross-CG batching.** Each enqueued promote targets one full assertion
  identity: `(contextGraphId, subGraphName, assertionName)`. Multi-CG bulk
  promotes are out of scope (importers that want them can enqueue many jobs).
- **Promote-side validation changes.** The async path applies the same
  permissive root handling as the sync path: `entities: "all"` is accepted,
  non-empty explicit URI arrays are filtered to whatever quads are present in
  WM, and a missing requested root can produce `promotedCount: 0` rather than a
  hard validation failure. `entities: []` is rejected, matching the existing
  promote contract; callers that want every root must send `"all"`.

## 3. Proposal — surface

### 3.1 Enqueue

```http
POST /api/assertion/<name>/promote-async
{
  "contextGraphId": "<cg>",
  "subGraphName": "<sg>",
  "entities": [ "<root-uri>", ... ]  // or "all", matching sync /promote
}
```

Response: `200 OK`

```json
{
  "jobId": "promote-job:01HXXXXXXXXXXXXXXXXX",
  "state": "queued",
  "enqueuedAt": "2026-05-25T13:00:00.000Z"
}
```

`entities` follows the same request contract as sync `/promote`: callers may
send `"all"` or a non-empty explicit URI array. The current daemon reads
promote bodies with `SMALL_BODY_BYTES` (256 KB), so practical explicit arrays
should stay near ADR 0002's `ROOT_CHUNK ≤ 1000` guidance even though the sync
route does not currently enforce a URI-count cap server-side. Async must not
silently widen that body budget or reject roots more strictly than sync; if
sync later gains a hard root-count limit, async should adopt it at the same
time so the contracts stay aligned.

### 3.2 Status

```http
GET /api/assertion/promote-async/<jobId>
```

Response: `200 OK`

```json
{
  "jobId": "promote-job:01HXXXXXXXXXXXXXXXXX",
  "state": "queued | running | failed_retrying | succeeded | failed",
  "contextGraphId": "<cg>",
  "assertionName": "<name>",
  "subGraphName": "<sg>",
  "enqueuedAt": "...",
  "startedAt": "...",
  "finishedAt": "...",
  "entitiesPromoted": 873,
  "attempts": 2,
  "nextRetryAt": "2026-05-25T13:05:00.000Z",
  "lastError": { "code": "...", "message": "...", "retryable": true }
}
```

`state` transitions:

```
queued → running ⇄ failed_retrying → running → (succeeded | failed)
                                              ↘
                                                failed   (terminal)
```

- `queued` — accepted, not yet claimed by a worker.
- `running` — claimed by a worker; lease is being held (see §4.3).
- `failed_retrying` — last attempt failed with a retryable error; the
  daemon **will** schedule another attempt (`nextRetryAt`) without
  operator intervention. Polling clients **MUST keep waiting** while a
  job sits in this state.
- `succeeded` — terminal; assertion is in SWM.
- `failed` — terminal; retry budget exhausted (or the daemon classified
  the error as non-retryable). The only way out is an explicit
  `recover`.

Splitting `failed_retrying` (transient) from `failed` (terminal) is
deliberate: importers should not stop polling on a transient error
just because the daemon happens to log it as a "failure". This is the
single most common foot-gun in similar APIs we've seen.

### 3.3 List + filter

```http
GET /api/assertion/promote-async?contextGraphId=<cg>&state=running,queued,failed_retrying&limit=50
```

Response shape mirrors `/api/publisher/jobs` (the `AsyncLiftPublisher`
analogue). `state` accepts a comma-separated list, including the
transient `failed_retrying` value.

### 3.4 Cancel / requeue

```http
DELETE /api/assertion/promote-async/<jobId>             # cancel queued
POST   /api/assertion/promote-async/<jobId>/recover     # requeue failed
```

`DELETE` only succeeds on `queued` state. `recover` is the explicit-retry
hook for failed jobs whose retry budget was exhausted.

## 4. Proposal — internals

### 4.1 Job model (sketch)

```ts
type PromoteJobState =
  | 'queued'           // accepted, not yet claimed
  | 'running'          // claim lease active (see §4.3)
  | 'failed_retrying'  // last attempt failed retryably; will retry at nextRetryAt
  | 'succeeded'        // terminal
  | 'failed';          // terminal — retry budget exhausted / non-retryable

interface PromoteJob {
  jobId: string;                       // ULID-shaped
  contextGraphId: string;
  assertionName: string;
  subGraphName: string;
  entities: string[] | 'all';
  state: PromoteJobState;
  enqueuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  entitiesPromoted?: number;
  attempts: number;
  claimedBy?: string;          // worker id of the current lease holder
  claimToken?: string;         // opaque renew token (see §4.3)
  claimLeaseExpiresAt?: string; // ISO-8601 — lease wall-clock deadline
  attemptOperationId?: string; // deterministic idempotency key for current attempt
  attemptPhase?: 'pending' | 'applying' | 'committed';
  nextRetryAt?: string;
  lastError?: { code: string; message: string; retryable: boolean };
}
```

The `PromoteJobState` enum is the single source of truth — every API
surface that lists states (status payload, list-endpoint filter, internal
worker code) MUST reference it. Earlier drafts of this spec omitted
`failed_retrying` from the TS enum even though §3.2 and the importer
example both relied on it; implementers who took the enum literally would
have made retryable failures unrepresentable in the public API.

Persisted in a **dedicated control graph** (`urn:dkg:promote-queue:control-plane`),
**not** in any project's `meta` sub-graph. This mirrors the existing
`AsyncLiftPublisher`, which keeps its `LiftJob` records under
`urn:dkg:publisher:control-plane` (see
[`async-lift-control-plane.ts`](../../packages/publisher/src/async-lift-control-plane.ts)).

Rationale for the dedicated graph:

- **No circular dependency.** Routing queue bookkeeping through any
  project's regular assertion-write path would couple the queue's
  durability to the same code-path it's supposed to recover when
  promote calls fail. The control graph uses the daemon's lower-level
  triple-store write API directly.
- **Control-plane / data-plane separation.** Job state is daemon
  internals; it should not show up in user `dkg_query` results scoped
  to a context graph, and it should not gossip to peers.
- **Free durability either way.** The dedicated graph rides the same
  atomic-write guarantees that protect WM (#640) — fsync + rename + dir
  fsync on the persisted store — so persistence is not lost by
  bypassing the assertion API.

### 4.2 Worker loop

A single `AsyncPromoteWorker` runs in-process inside the daemon (no
separate worker thread — promote is not CPU-bound). It:

1. **Polls the control graph for runnable jobs**, ordered by
   `enqueuedAt`. A job is runnable when:
   - `state = 'queued'`, OR
   - `state = 'failed_retrying' AND nextRetryAt <= now()`.

   Earlier drafts of this spec only polled `queued`; that left
   `failed_retrying` jobs stuck forever because nothing flipped them
   back to `queued`. Two implementation options are equivalent and
   either is acceptable:
   - (a) the scheduler picks up `failed_retrying` rows directly when
     their `nextRetryAt` has expired, OR
   - (b) a tiny tick task flips eligible `failed_retrying` rows back to
     `queued` and the scheduler only sees `queued`.
   Pick whichever fits the storage shape; the user-visible state
   machine is the same.

2. **Claims** a job (atomic compare-and-swap on
   `state: queued|failed_retrying → running`, writes `claimedBy`,
   `claimToken`, `claimLeaseExpiresAt = now + leaseTtlMs`; see §4.3 for
   the lease model). It then calls the existing `assertion.promote(...)`
   logic through the idempotency wrapper in §4.4 (the SAME promote code
   path the sync route uses — we share implementation, not just shape),
   and writes `succeeded` or transitions to `failed_retrying`/`failed`
   based on the result.

3. While the promote is running, the worker renews its lease every
   `leaseTtlMs / 2` (default 30s) so a long-running but healthy
   promote is not reclaimed (see §4.3).

4. On retryable error, transitions to `failed_retrying`, sets
   `nextRetryAt = now + backoff(attempts)` (matches
   `AsyncLiftPublisher`'s exponential backoff policy), and clears the
   claim (`claimedBy = null`, `claimToken = null`,
   `claimLeaseExpiresAt = null`) so the job becomes eligible for
   re-pickup per step 1 at `nextRetryAt`.

5. On `attempts >= maxAttempts` (default 5) or non-retryable error,
   transitions to terminal `failed`. Requires explicit `recover` to
   retry.

6. **Concurrency caps**:
   - At most N (default 4) running jobs per daemon, matching ADR 0002's
     "max concurrent assertions" guidance.
   - **At most 1 active job per full assertion identity
     `(contextGraphId, subGraphName, assertionName)`.** This is the same
     guarantee the sync `/promote` route gives today,
     and it's enforced in two places to be defence-in-depth:
     - **At enqueue** (`POST /api/assertion/promote-async`): if a job
       with the same `(contextGraphId, subGraphName, assertionName)` is
       already in `queued` / `running` / `failed_retrying` state, return
       `409 Conflict` with the existing `jobId` in the body, so the
       importer can resume polling that one. (Alternative: silently
       coalesce to the existing job; the spec leaves this to implementation,
       but MUST NOT enqueue a second concurrent job.)
     - **At claim** (the CAS in step 2): the runnable-job query MUST
       exclude rows whose full assertion identity already has a running
       sibling.
       This catches the race where two enqueues arrive simultaneously
       and the enqueue-time check sees nothing on either side; whoever
       loses the CAS races stays `queued` and waits.

   This avoids the "two workers, one assertion, concurrent promote"
   foot-gun the earlier draft would have allowed — without it, a client
   firing `promote-async` twice for the same assertion (e.g. after a
   timeout-and-retry on the enqueue request itself) would have ended up
   with two workers stepping on each other's quads.

### 4.3 Lease-based reclaim (no fixed timeouts)

Naïve "any `running` job older than 60s is reclaimable" timers
duplicate work: a perfectly healthy promote of a large assertion can
legitimately spend longer than 60s in subtraction / gossip /
backpressure, and a second worker firing against the same assertion
while the first one is still running is exactly the kind of
double-write we want to avoid.

Instead, the queue uses a **renewable lease** (same pattern as
`AsyncLiftPublisher`'s `claimToken` + `claimLeaseExpiresAt`):

- When a worker claims a job, it writes `claimToken = <opaque>` and
  `claimLeaseExpiresAt = now + leaseTtlMs` (default 60s) atomically
  with the `queued → running` transition.
- While processing, the worker **renews** the lease every
  `leaseTtlMs / 2` by extending `claimLeaseExpiresAt`. The renew is a
  conditional write: it only succeeds if `claimToken` still matches.
  If the renew fails, the worker abandons the job (some other worker
  reclaimed it after a perceived stall) without writing `succeeded`.
- A job is **reclaimable** only when `now > claimLeaseExpiresAt`,
  i.e. the lease has truly lapsed (worker crashed, daemon crashed, GC
  pause longer than the lease). Long-but-healthy promotes keep
  renewing and stay claimed.
- The "60s reclaim" knob becomes the **lease TTL**, not a fixed
  job-age timeout. Operators can tune it per workload (longer for
  slow disks, shorter for tight-SLA imports) without changing the
  worker logic.

### 4.4 Failure modes + recovery

Crash recovery is **lease expiry plus an idempotency / commit marker**, not a
blind `running → queued` rewrite. The current sync promote flow performs
multiple durable side effects (SWM insert, WM cleanup, assertion lifecycle
metadata, workspace-operation metadata, gossip notification). A daemon can
crash after some of those have happened and before others have. Re-running the
whole promote blindly can duplicate control-plane metadata or gossip even when
the RDF set insert itself is idempotent.

Async promote therefore needs an attempt-level idempotency guard before it can
reclaim lapsed `running` jobs:

1. When a worker starts an attempt it writes
   `attemptOperationId = "${jobId}:${attempts}"` and
   `attemptPhase = "applying"` into the control graph before invoking the
   shared promote code path.
2. The shared promote implementation must either accept that operation id and
   make every non-RDF side effect idempotent under it, **or** the async wrapper
   must write a durable commit marker only after all promote side effects have
   completed successfully.
3. On success the worker sets `attemptPhase = "committed"` and then marks the
   job `succeeded`.
4. On startup / scheduler tick, a lapsed `running` job is reconciled:
   - `attemptPhase = "committed"` → mark `succeeded`; do not rerun.
   - `attemptPhase = "pending"` (no promote side effects started) → clear the
     claim and let the scheduler retry.
   - `attemptPhase = "applying"` with no durable commit marker → run an
     implementation-specific reconciliation check. If the implementation cannot
     prove the previous attempt is safe to resume/retry idempotently, park the
     job as terminal `failed` with `code: "ambiguous_partial_promote"` and
     surface operator recovery instructions instead of guessing.

This is stricter than the initial draft, but it is the safe contract: the
implementation PR must either make promote attempts idempotent under an
operation id or explicitly park ambiguous partial attempts.

- **Daemon crash mid-job**: the job's lease expires (because nothing
  is renewing it). On startup — or on the next scheduling tick of a
  peer daemon, if/when we support multi-daemon queues — the worker
  scans for `running` jobs with `claimLeaseExpiresAt < now` and applies
  the reconciliation rules above. No fixed `runningTimeoutMs`; the
  lease plus commit marker is the source of truth.
- **Permanent failure** (e.g. an assertion that was discarded between
  enqueue and run): mark `failed` with `retryable: false`. Surface
  through `GET /api/assertion/promote-async/<jobId>` with a structured
  `code: 'assertion_not_found'` etc.
- **Queue saturation**: if the queue grows beyond a configured limit
  (default 10k jobs), `POST /api/assertion/<name>/promote-async` returns
  `503 Service Unavailable` with a `Retry-After` header. Importers handle
  this the same way they handle 413 (see ADR 0002): back off and retry.

## 5. Importer pattern

```ts
import { DkgClient } from './scripts/lib/dkg-daemon.mjs';
import { createImportManifest, markPartitionStatus } from './scripts/lib/manifest.mjs';

const client = new DkgClient({ ... });
const jobs = new Map(); // partitionKey → jobId

for (const part of partitions) {
  const assertionName = `import-${part.slug}`;
  await client.request('POST', '/api/assertion/create', { contextGraphId, name: assertionName, subGraphName });
  await client.writeAssertion({ contextGraphId, assertionName, subGraphName, triples: triplesFor(part) });
  const { jobId } = await client.request('POST', `/api/assertion/${assertionName}/promote-async`, {
    contextGraphId,
    subGraphName,
    entities: rootUrisFor(part),
  });
  jobs.set(part.key, jobId);
  await markPartitionStatus({ client, importId, partitionKey: part.key, status: 'promote_enqueued', subGraphName: 'meta' });
}

// Poll outstanding jobs once per minute until they all settle on
// a TERMINAL state (succeeded | failed). `failed_retrying` means the
// daemon will retry on its own — clients must keep polling.
const TERMINAL = new Set(['succeeded', 'failed']);
while (jobs.size > 0) {
  await sleep(60_000);
  for (const [key, jobId] of jobs) {
    const status = await client.request('GET', `/api/assertion/promote-async/${jobId}`);
    if (!TERMINAL.has(status.state)) continue; // queued | running | failed_retrying
    const finalStatus = status.state === 'succeeded' ? 'done' : 'failed';
    await markPartitionStatus({ client, importId, partitionKey: key, status: finalStatus, subGraphName: 'meta' });
    jobs.delete(key);
  }
}
```

The importer never blocks on a single slow promote. If the daemon
restarts mid-import, both the manifest (PR #642) and the promote queue
survive — the importer just keeps polling.

## 6. Open questions

1. **Cross-importer fairness.** If importer A enqueues 50k jobs and
   importer B enqueues 100 jobs, importer B can starve behind A.
   Options: FIFO (simple, the proposal above), per-importer round-robin
   (needs an importer identity, which we don't have today), or priority
   classes (operator-set). FIFO is the right v1; the others wait for a
   problem report.

2. **Drain semantics on shutdown.** Recommended v1 behaviour:
   - Stop accepting new async-promote requests.
   - Stop claiming new queued / retryable jobs.
   - Give currently running jobs a short graceful window to finish and write
     their commit markers.
   - On timeout, exit without rewriting `running` jobs to `queued`; their
     leases expire and startup recovery follows §4.4.

   Do **not** mark `running → queued` during shutdown. Promote is not a single
   atomic set insert today; it mutates SWM, WM cleanup, lifecycle metadata, and
   workspace-operation metadata in separate steps. Lease-expiry reconciliation
   plus the attempt commit marker is the only safe automatic recovery story
   until the implementation proves every side effect is idempotent under an
   operation id.

3. **Worker count tuning via `/api/status`.** The same `importLimits`
   hint added in ADR 0002 should grow a `promoteWorkerConcurrency` field
   so importers know the daemon's capacity. Non-binding hint, like the
   chunk values.

4. **Sync `/promote` keeps working unchanged.** Confirm with reviewers
   that we're not deprecating the sync route — small importers still
   prefer the inline answer-or-error shape.

## 7. Rejected alternatives

- **"Just parallelise sync `/promote` from the client side."** Doesn't
  help — the daemon serialises the work anyway, and client-side
  concurrency just inflates retry-on-collision noise.

- **"Add a `batched` flag to sync `/promote` that internally chunks."**
  Hides the chunking from the importer but doesn't solve the blocking
  problem (the request still doesn't return until everything is done).
  Also conflicts with the ADR 0002 "clients chunk" decision.

- **"Daemon-side promote-after-write hook."** The idea: when a write to
  an assertion completes, the daemon auto-promotes the roots it can
  infer. Two problems: (a) the daemon can't always infer the roots (the
  importer chose them), (b) failure surfaces become invisible to the
  importer. Rejected.

## 8. Out of scope (for the implementation PR)

- A UI for the queue. The `/api/assertion/promote-async` routes are the
  v1 surface; if a UI is wanted, that's a separate PR.
- Cross-daemon queue sharing. Each daemon owns its own queue.

## 9. Sequencing

This RFC is independent of #640 (WM persistence fix), #641 (ADRs), and
#642 (importer helpers). It does, however, **depend on #640 having
landed**: the queue's durability rests on WM-store persistence, and that
must be solid before we start persisting structured job state alongside
WM data.

Implementation work is intentionally NOT part of this PR. Sign-off on
the spec first; implementation follows in a subsequent PR sized to fit
under [`packages/publisher/src/async-lift-publisher-impl.ts`](../../packages/publisher/src/async-lift-publisher-impl.ts) (~1000 lines) — likely
a sibling `async-promote-queue-impl.ts` of similar size.

## 10. Empirical motivation (rc.10 Graphify import)

The numbers below come from importing a real codebase graph (Graphify
output for this repository: 26,960 nodes / 63,003 edges, partitioned into
17 sub-graph-scoped assertions) against an rc.10 sandbox daemon on a
local SSD, single worker. Two importer variants were measured: a
hand-rolled `fetch` client written from the `dkg-node` SKILL.md alone
(~330 LOC, no library) and the same workload using the existing rc.10
`scripts/lib/dkg-daemon.mjs` `DkgClient` library. Both ran the same
write/promote pattern documented in ADR 0002.

### 10.1 Cascading write degradation under SWM load

The most visible signal that sync `/promote` competes with the same
worker doing writes is how write latency itself degrades as SWM grows.
Each row is a single `client.writeAssertion(...)` call:

| Partition | Triples | Write ms | Promote ms | Notes |
|---|---:|---:|---:|---|
| `.codex` | 450 | 241 | 129 | first write; warm-up |
| `.cursor` | 131 | **5** | 66 | steady state, small |
| `bench` | 1,812 | **20** | 2,310 | still ~10 µs/triple |
| `ccl_v0_1` | 3,232 | **41** | 3,562 | linear |
| `devnet` | 4,095 | **597** | 10,707 | first slowdown signal |
| `packages-adapter-hermes` | 12,991 | 127 | 8,555 | recovers briefly |
| `packages-chain` | 12,762 | **230** | 39,395 | promote getting slow |
| `packages-cli` | 72,079 | **178,801** | 290,150 | **3 min write alone** |
| `packages-core` | 33,742 | **31,610** | 73,322 | 30 s for 33k triples |

After ~100k SWM triples ingested cumulatively, write latency degrades
roughly **200× from baseline** (5-7 ms/batch → 1.2 s/batch and worse)
because the single worker thread is interleaving writes with the
SWM-side gossip/lifecycle work from previous promotes. The async queue
in this spec moves promote work to dedicated background workers, so
foreground writes stay flat regardless of how much promote pressure is
queued behind them — that's the §1 "lift one tier earlier" claim in
concrete numbers.

### 10.2 10 MB gossip cap failures under sync `/promote`

Four of 17 partitions exceeded the 10 MB gossip-message cap when promoted
with `entities: "all"` (the convenient default for resumable importers).
Each failure costs an entire halve-and-retry cycle:

| Partition | Triples | Assertion size | Wall-clock in retry |
|---|---:|---:|---:|
| `packages-adapter-openclaw` | 36,618 | 10,788 KB | ~2 min |
| `packages-agent` | 41,724 | 11,993 KB | ~3.5 min |
| `packages-cli` | 72,079 | 20,686 KB | ~5 min |
| `docs` | 69,792 | 24,599 KB | ~4 min |

Total wall-clock spent in adaptive halving across these four:
**~15 minutes**. The daemon error message is

```
HTTP 500 "Promoted assertion too large for gossip
(<size> KB, limit 10 MB). Promote fewer entities per call."
```

This is a sync-route problem the async queue solves trivially: a
background worker can promote one root at a time without blocking the
client; the importer just polls a job id. The 15 min retry cost
collapses to "enqueue, get a job id back in <50 ms, poll until
`succeeded`". The hand-rolled adaptive-halving logic the rc.10
importer needs (256 KB body cap + 10 MB gossip cap, two separate
discovery loops) ceases to be part of the importer's job.

### 10.3 Production importer reliability

The rc.10 importer crashed once with a generic `fetch failed` socket
error during a multi-minute promote call. There is no retry
classification in the sync path; the importer either implements one
itself or loses progress. The §3.3 `failed_retrying` state and §4.4
attempt commit marker move that responsibility into the daemon, where
it has the lease information and persistence to do it correctly.

### 10.4 Why "in front of" instead of "underneath"

A counter-proposal during review was to make sync `/promote` itself
internally async with a `batched` flag. The numbers above show why
that's the wrong layer: the importer's pain is **wall-clock per
partition**, not request shape. A 5-minute sync call that quietly
chunks is still a 5-minute sync call from the importer's perspective —
it can't pipeline the next partition's write, it can't show progress,
and a transient TCP reset still kills the operation. The async queue
addresses the actual cost, not the symptom.
