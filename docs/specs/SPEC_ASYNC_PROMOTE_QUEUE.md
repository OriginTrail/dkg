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
the promote payload itself hits `MAX_BODY_BYTES`, and a single failed
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
- **Cross-CG batching.** Each enqueued promote targets one
  `(contextGraphId, assertionName)`. Multi-CG bulk promotes are out of
  scope (importers that want them can enqueue many jobs).
- **Promote-side validation changes.** The async path applies the same
  validation as the sync path; no relaxation of "root URI must exist in
  the assertion's WM body".

## 3. Proposal — surface

### 3.1 Enqueue

```http
POST /api/assertion/<name>/promote-async
{
  "contextGraphId": "<cg>",
  "subGraphName": "<sg>",
  "entities": [ "<root-uri>", ... ]
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

`entities` is bounded by the [ADR 0002 importer chunking
contract](../adr/0002-importer-chunking-contract.md) — typically
`ROOT_CHUNK ≤ 1000` — for symmetry with the sync route's request-size
budget. Note that the **sync** `/promote` route does not currently
enforce a per-call root cap server-side (it accepts `entities: "all"`
and any explicit array that fits under `MAX_BODY_BYTES`); the async
route adopts the same lenient acceptance. We deliberately do not raise
the cap unilaterally for async: if sync grows a hard limit later (which
the queue saturation behaviour in §4.3 will make easier), async should
adopt it at the same time so the contracts stay aligned.

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
  entities: string[];
  state: PromoteJobState;
  enqueuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  entitiesPromoted?: number;
  attempts: number;
  claimedBy?: string;          // worker id of the current lease holder
  claimToken?: string;         // opaque renew token (see §4.3)
  claimLeaseExpiresAt?: string; // ISO-8601 — lease wall-clock deadline
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
   the lease model). Calls the existing `assertion.promote(...)` logic
   internally (the SAME code path the sync route uses — we share
   implementation, not just shape), and writes `succeeded` or
   transitions to `failed_retrying`/`failed` based on the result.

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
   - **At most 1 active job per `(contextGraphId, assertionName)` pair.**
     This is the same guarantee the sync `/promote` route gives today,
     and it's enforced in two places to be defence-in-depth:
     - **At enqueue** (`POST /api/assertion/promote-async`): if a job
       with the same `(cgId, name)` is already in `queued` / `running`
       / `failed_retrying` state, return `409 Conflict` with the
       existing `jobId` in the body, so the importer can resume polling
       that one. (Alternative: silently coalesce to the existing job;
       the spec leaves this to implementation, but MUST NOT enqueue a
       second concurrent job.)
     - **At claim** (the CAS in step 2): the runnable-job query MUST
       exclude rows whose `(cgId, name)` already has a running sibling.
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

- **Daemon crash mid-job**: the job's lease expires (because nothing
  is renewing it). On startup — or on the next scheduling tick of a
  peer daemon, if/when we support multi-daemon queues — the worker
  scans for `running` jobs with `claimLeaseExpiresAt < now`, clears
  the claim atomically, and the job becomes eligible for re-claim.
  No fixed `runningTimeoutMs`; the lease is the source of truth.
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

2. **Drain semantics on shutdown.** Two options:
   - **Wait for running jobs to finish.** Cleanest, but a 5-min running
     job blocks `dkg stop` for 5 min. Bad for ops.
   - **Mark running → queued + exit.** Some jobs run twice. The promote
     operation is idempotent (writing the same triples to SWM twice is a
     no-op), so this should be safe. Pick this.

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
