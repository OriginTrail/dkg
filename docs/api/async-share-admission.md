# Async SWM share admission under pressure

`POST /api/knowledge-assets/:name/swm/share-async` accepts a native promotion job. A successful `200 { jobId, state: "queued" }` acknowledges queue persistence and flush. It does not mean promotion has finished. Observe the native job at `GET /api/knowledge-assets/swm/share-jobs/:jobId`.

## Admission budget and evidence

Queue admission has a ten-second budget covering mutex wait, graph initialization, conflict lookup, persistence and flush. Authentication, context-graph readiness, selected-author resolution, body transfer and HTTP response delivery are outside this queue budget. This is not a ten-second end-to-end HTTP guarantee. Ordinary store capacity, the `ack`, `health`, `normal` and `background` lanes and store deadlines are unchanged; the one change to which scheduler the queue's own store calls use is described in [Store scheduler of the queue's own calls](#store-scheduler-of-the-queues-own-calls).

An admission that expires **before persistence starts** is prevented from later writing a job. The server returns HTTP 503 with `Retry-After: 1` and:

```json
{
  "code": "PROMOTE_ADMISSION_UNAVAILABLE",
  "retryable": true,
  "admissionScope": "async_promote_job",
  "admissionOutcome": "not_admitted",
  "phase": "conflict"
}
```

The phase is `lock`, `graph`, `conflict` or `persist`. Non-admission describes this queue attempt only. It does not assert that another request for the same selector, or every operation before queue admission, never ran.

Once persistence starts, a deadline or failure may hide a committed job. The sole exception is a canonical `replaceSubject/not_started` proof returned at the primary persistence boundary before flush; that proves non-admission and releases the attempt for retry. The response instead carries `admissionOutcome: "indeterminate"`, `jobId` and its `statusPath`. It never promotes an inner store operation's `not_started` into whole-admission evidence. Observe that ID or repeat the **same selector** (context graph, sub-graph, name and storage-author lane). Do not invent a different name or operation to escape uncertainty. A missing/failed status response, including an absent row after a transport failure, is not proof that a dispatched write cannot still commit.

A pending same-selector admission is shared. A replay during persistence promptly returns the same tentative handle with indeterminate evidence. If the original write subsequently succeeds, the original native job is the one workers process. A settled ambiguous failure retains its handle until a fresh durable read observes the job; it does not automatically start another write. At most 64 unresolved/in-flight admissions are retained per store/control graph; further new admissions are rejected without dispatch. Pending entries survive caller timeout until their underlying operation settles, so a blocked mutex cannot accumulate unlimited detached admissions.

## Existing job observations

A same-selector replay can return HTTP 409 with `existingJobId` and `observedAdmission: true` without another conflict query or mutex wait. This is a bounded positive observation of a previously acknowledged/read owner, **not a fresh statement of its job state**. Check the status endpoint for current state. Cached observations never authorize a new job or bypass authorization, readiness or selected-author checks.

The process remembers at most 1,024 owners for five minutes from their last acknowledged transition or durable observation. Local writes invalidate the old observation before mutation and refresh it only after persistence and flush; ordinary terminal jobs cease to be owners. Failed bound shares remain owners until #3300's recovery obligation is completed or certified retired. Cancellation and terminal clear preserve their existing semantics. A validated terminal clear settles retained admission uncertainty before removing the record; an absent, malformed or unrecognized record cannot provide that proof. A fresh status read also removes an observation if an external writer cleared that job.

An external writer can make an observation stale until a fresh read or expiry; `observedAdmission` explicitly identifies this case. A process restart, expiry or eviction requires the normal durable conflict lookup, which can itself be unavailable under store pressure. No cached absence is used and no durable record format changes.

## Duplicate check

Before persisting, admission looks for a durable owner of the same selector. The lookup reads the jobs stored under the selector's uniqueness key spellings (the current key, the pre-canonical lower-cased lane key, the default-lane key and the legacy key; several of these are the same string for most selectors) by key constant, so its cost follows the number of jobs under **that** selector and not the length of the whole queue history. It leaves out the rows that cannot decide the check: jobs whose stored state is `succeeded`, and `failed` jobs whose payload carries no recovery binding. Every other row (queued, running, retrying, a failed bound share, or a row with no or an unrecognized state) is decoded and judged as before, and an unreadable one of those still fails closed with `KA_PROMOTE_RECOVERY_REQUIRED`. A job that the store reaches through two key spellings is counted once. The same lookup serves lifecycle ownership reads and the recovery sweeps. A selector with a long history of its own (many retained jobs under one key) is still scanned for that key's rows inside the store, and only its undecided rows come back. **That per-selector growth is not bounded yet.** Terminal-job retention (OT-RFC-73 P10a/P10b) has not shipped and is off by default, so finished jobs under one selector accumulate until they are cleared explicitly, and this lookup does not limit that.

The admission decision is unchanged, except for the narrowings below (D1/D2 and D4 of OT-RFC-73 decision D-5), which only affect corrupted records, and a note on D3:

- **Unreadable payload on a finished row (D1/D2).** A row whose stored state is `succeeded`, or `failed` without a recovery binding, is no longer decoded, so a corrupt payload there no longer makes the lookup throw `KA_PROMOTE_RECOVERY_REQUIRED`. Such a row cannot own the selector. Unreadable rows in every other class keep failing closed.
- **State and payload that disagree (D3, a note).** The stored state decides which rows are read. A record whose state triple disagrees with its payload cannot be produced by the queue (both are written in one atomic replace) and is judged by the state triple.
- **Stale owner observations (D4).** A conflict lookup used to observe every row it returned, terminal ones included, which dropped this process's remembered owner observation of a job that another process had finished. Terminal rows are no longer returned, so such an entry is no longer cleared by a lookup. It still expires after five minutes, and a status read of that job still drops it (see Existing job observations).

## Store scheduler of the queue's own calls

Every store call the share queue makes **inside its mutex** (OT-RFC-73 S1) names the share queue in its options: the conflict lookup, the job record write (one atomic replace, or its delete-and-insert fallback), the `claimNext` candidate read and the lease-recovery read, heartbeats, commit markers, success and failure records, status reads, listings, statistics, cancel, recover, the post-commit recovery sweep, terminal clear and the retained-share reconcile read. The tag sets no priority.

- **Control path off** (`DKG_STORE_CONTROL_RESERVED_SLOTS` unset in this release, or `0`): the tag changes nothing. Each call is scheduled in exactly the lane it used before, the ambient default lane of its caller or `normal`, so the lane choice and the error text are as they were.
- **Control path on** (`DKG_STORE_CONTROL_RESERVED_SLOTS=share:1`, see [Queue control schedulers](../use-dkg/backpressure-observability.md#queue-control-schedulers)): these calls run on a small scheduler of their own with one slot, beside the shared store scheduler, instead of waiting in its ordinary lanes behind data-plane work and client reads. No priority and no ambient lane moves a call there; only the share tag does. The shared scheduler's `ack`, `health`, `normal` and `background` capacity is not reduced. A refusal on that scheduler is the same retryable `503` with `"priority": "control"`. At the share enqueue route it arrives as the admission verdict, not as the store error: `503` with `admissionOutcome: "not_admitted"` and the phase that was refused (`conflict` for the lookup, `persist` for the job write; a refused write never reached the store, so no job exists). The control-lane scheduler error is that verdict's cause and is not part of the response body.

**Reversal of the #3331 decision.** The merged plan for #3331 (`agent-docs/plans/2026-10-18-3331-share-admission-pressure.md`) rejected moving admission onto reserved health or ACK capacity, because that takes capacity from critical work, and rejected raising timeouts or concurrency, because that hides overload. Earlier text in this document said that priorities are unchanged. With the control path on, that is no longer true for the queue's own calls: they have a lane of their own. It takes nothing from ACK, health or ordinary work (the slot is added beside them and is the hard cap), it raises no timeout and no general concurrency, and it is for queue bookkeeping only. The reversal needs the sign-off of that plan's maintainers (OT-RFC-73 decision D-12). In this release the control path is off by default.

What stays where it was, on the caller's lane:

- the lock-free lifecycle ownership reader (`publisher.asyncPromote.ownershipReader`; before OT-RFC-73 P4 it shared the label `publisher.asyncPromote.findActiveConflict` with the in-mutex lookup), which runs outside the mutex for assertion lifecycle writes;
- the reads before admission (context-graph write preflight, author selection), the promote the worker executes for a claimed job and everything else it reads or writes, and client `/api/query` reads;
- the monitoring reads behind the `async_admission_usage` queue depth, which stay `background`.

The worker wake that `enqueue`, `recover` and `resume` raise is issued with no lane scope: the worker tick it starts inherits no ambient lane from the caller, whichever lane the caller was scoped to, and carries no control tag. The mutex and the lease semantics are unchanged.

## Diagnostics

Set `DKG_ASYNC_PROMOTE_ADMISSION_TRACE=1` to emit fixed-shape `async_promote_admission` events containing only event kind (`phase_settled` or `deadline`), phase, elapsed milliseconds and outcome. A write that settles after the response deadline emits its eventual phase duration separately. Phase duration for graph/conflict/persist includes both scheduler waiting and admitted store work; it is **not** admitted execution time alone. Correlate it with native scheduler source/queue diagnostics (`publisher.asyncPromote.findActiveConflict`, `publisher.asyncPromote.writeJob`; with the control path on they report the `control` lane) and external HTTP timings. The events contain no asset names, graph/job IDs, addresses, payloads or arbitrary exception messages. Tracing is opt-in; it does not change queue outcomes.

If all enqueue/replay replies are lost, [exact share reconciliation](share-reconciliation.md) can associate a retained successful job with producer-owned immutable execution evidence. Diagnostic list results and matching names alone cannot establish that association; missing evidence never authorizes another mutation.
