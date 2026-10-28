# Async queue internals

Maintainer reference for the two async queues: the share queue (`TripleStoreAsyncPromoteQueue`, also called the promote queue) and the publish queue (`TripleStoreAsyncLiftPublisher`). This file is not published on GitBook.

- Operators read [Async Queue Operations](../../../docs/use-dkg/async-queue-operations.md): the four settings, their defaults and the cleanup checklist.
- Client authors read [Async Share and Publish Jobs](../../../docs/build/async-jobs.md): the responses and what to do next.
- The fields of the `async_admission_usage` log line, `share_retention` and `lift_retention` included, are in [`packages/cli/docs/async-admission-usage-line.md`](../../cli/docs/async-admission-usage-line.md).
- Write preflight coalescing, which runs before both queues' admission, is in [`packages/cli/docs/write-preflight-coalescing.md`](../../cli/docs/write-preflight-coalescing.md).

Code comments and tests in the retention code that cite "the delete gate" or "delete-gate item 1" refer to the public checklist "Before you switch to delete" on the operator page. "Item 1" there is the would-delete count of the latest complete `report` pass (`_pass_would_delete` on the usage line, `wouldDelete` on the pass line), which the checklist reads.

## Share queue retries

The daemon configures the share queue before its first access (`promoteQueue` in `config.json`, resolved by `resolveDaemonPromoteQueueConfig`). Five attempts are the default. Each job keeps the attempt budget it was enqueued with (`attempt.maxRetries`, shown as `maxAttempts`), so a changed budget affects new jobs only. The one-hour retry window for typed prerequisite failures (`PROMOTE_PREREQUISITE_RETRY_WINDOW_MS`) can keep those jobs retrying beyond the budget; these settings do not change that window. A bound (durable synchronous) share keeps retrying recognized transient failures beyond the budget too.

```json
{
  "promoteQueue": {
    "enabled": true,
    "maxRetries": 5,
    "retryBaseMs": 60000,
    "retryMaxMs": 900000,
    "retryJitterRatio": 0.2
  }
}
```

The retry delay doubles from `retryBaseMs`, with symmetric multiplicative jitter, capped at `retryMaxMs`. Delay and budget values must be positive safe integers, the maximum delay must be at least the base delay, and jitter must be in `[0, 1]`. An invalid policy stops the daemon at start.

Local enqueue, recovery, resume and job writes invalidate the worker's idle claim hint. When no job can run, full scans occur at most once per second, with an earlier scan for a known retry or lease deadline. Out-of-process writes are discovered by the bounded poll. Queue state remains authoritative.

Automatic post-commit recovery is bounded by each job's persisted budget. Exhausted shares stay visible for operator recovery: inspect `GET /api/knowledge-assets/swm/share-jobs/{jobId}`, correct the prerequisite, then `POST /api/knowledge-assets/swm/share-jobs/{jobId}/recover`. Recovery follows the existing replay-safety checks; configuration never resets exhausted jobs or bypasses an ambiguous started promote.

## Retention of finished jobs

Both queues keep their jobs in the node's triple store (the control graphs `urn:dkg:promote-queue:control-plane` and `urn:dkg:publisher:control-plane`) and never remove a finished job by themselves. Without retention a job leaves only when someone clears it: `POST /api/knowledge-assets/swm/share-jobs/{jobId}/clear` for a share job; `dkg publisher clear`, `POST /api/publisher/clear` or `POST /api/publisher/clear-job` for a publish job. A node that shares or publishes continuously therefore grows its control graphs without bound, and every read that walks the whole history grows with it. The retained-share reconciliation, for example, answers `incomplete_inventory` above 1,000 retained rows.

Retention is an opt-in sweep per queue that removes the finished jobs its policy allows. It is off by default, and nothing below changes a node that does not set it. Both sweeps are configured in one `queueRetention` section and run on one timer in the daemon (`retention-timer.ts`).

### Modes and defaults

`queueRetention` in `config.json`, one section per queue. Every key is optional. `packages/cli/src/retention-config.ts` validates it.

```json
{
  "queueRetention": {
    "share": {
      "mode": "off",
      "intervalMs": 60000,
      "batchSize": 100,
      "succeededMaxAgeMs": 604800000,
      "benignFailedMaxAgeMs": 604800000,
      "rescanIntervalMs": 3600000
    },
    "publisher": {
      "mode": "off",
      "intervalMs": 60000,
      "batchSize": 100,
      "finalizedMaxAgeMs": 604800000,
      "rescanIntervalMs": 3600000
    }
  }
}
```

| Key | Default | Allowed |
| --- | --- | --- |
| `mode` | `off` | `off`, `report`, `delete` |
| `intervalMs` | 60,000 | 1,000 to 3,600,000. The pause between two ticks; the first tick comes one interval after the start |
| `batchSize` | 100 | 1 to 1,000. Rows one tick judges at most |
| `succeededMaxAgeMs` | 7 days | Share only. At least 24 hours (86,400,000) |
| `benignFailedMaxAgeMs` | 7 days | Share only. At least 24 hours, or `null` to keep the two harmless failed classes (the cancelled class and the retired no-effect rejection) as well |
| `finalizedMaxAgeMs` | 7 days | Publisher only. At least 24 hours (86,400,000) |
| `rescanIntervalMs` | 3,600,000 | 60,000 to 7 days. How often a finished pass starts again from the oldest row |

- **`off`** creates nothing and makes no store call.
- **`report`** judges and counts what `delete` would remove and removes nothing. On the publish queue it can count fewer than `delete` removes when two jobs of one key finished in the same millisecond, never more (see the publisher limits and [#3554](https://github.com/OriginTrail/dkg/issues/3554)).
- **`delete`** removes the jobs the policy allows once they are past their window. Deletes cannot be undone. Starting a node in `delete` mode logs a warning saying so.

A wrong value, or a key that is not recognised (`queueRetention.share.mod`), stops `dkg start` and the daemon with a message that names the key; there is no silent fallback to a default. Changes need a restart. A mode on one queue never starts the other queue's sweep.

A tick judges at most `batchSize` rows, so a large backlog drains at about `batchSize` per `intervalMs` (100 per minute by default). Raise `batchSize` (at most 1,000) or lower `intervalMs` to drain faster. Each tick works in small holds of the queue's mutation lock (at most 10 jobs, 50 ms; `retention-sweep-core.ts`) so admissions, claims and heartbeats interleave. For the publish sweep the budget limits the candidates one hold judges, not the older jobs each candidate brings; see "A hold can run past its budget" under the publisher limits.

**Upgrades.** A node whose `config.json` already sets a `queueRetention` mode runs that sweep from the first start of a build that has it. Releases up to v10.0.26 ignore the whole `queueRetention` section, and testnet-canary builds between #3549 and #3555 validated `queueRetention.publisher` but ignored it. Check both modes before an upgrade.

**Sizing the share window.** The share jobs the window keeps should stay below the 1,000-row bound of the share reconciliation query, or reconciliation answers `incomplete_inventory`. An upper bound for that count: the share jobs admitted in any trailing window (the accepted `share_async` submissions in the usage line's `http=` counters) plus the failed share jobs the policy keeps (the `failed` count of `share_depth`, minus the `cancelled` and `retired_no_effect` figures of `share_retention_pass_would_delete`). If it would not stay below the bound, shorten the window. The bound does not apply to the publish queue.

### Where it runs

Retention starts only in the daemon's admission instance (`startRetention` in `packages/cli/src/daemon/retention-sweeps.ts`, `runtime: 'daemon-admission'`), after the API is listening, and stops before the agent on shutdown.

- **Share sweep.** Built after the share queue, over the very store object the queue was built with, so it sees the queue's pending admissions. If that wiring is ever broken, the daemon logs an error naming `SHARE_RETENTION_ADMISSION_UNAVAILABLE` and keeps running with share retention off (nothing is judged or deleted). That is a defect to report, not something to configure around.
- **Publisher sweep.** Built after the publish queue's admission instance (the one that serves the API and the boot backfill), from that instance's own `retentionAccess()` and over its own store object, and from nothing else: not the standalone runner's instance, not the offline inspector, not a second queue made on the side. The instance hands the sweep the queue's claim transaction and nothing more, so the sweep has no claim machinery of its own and no second way to remove a job. If the sweep cannot be built (a missing instance, or a setting the core refuses), the daemon logs an error that starts `[error] [retention] publisher retention (mode=...) was NOT started`, names the cause, and keeps running with publisher retention off. The share sweep is not affected.

No other runtime reads `queueRetention`: a standalone agent or library use, a worker or runner process, the offline CLI inspector and scripts ignore it and start no sweep. `startRetention` refuses, with `RETENTION_RUNTIME_REFUSED`, any caller but the daemon's admission instance when a mode is not `off`, and a test pins that only the daemon calls it. The cores (`createShareRetention` and `createPublisherRetention`, exported from `@origintrail-official/dkg-publisher`) have no such check, so code that calls them directly is bound by the exclusion limit below without being stopped.

The offline publisher inspector writes, so it has a guard of its own. `dkg publisher cancel`, `retry` and `clear` open the node's store directly when the daemon's API cannot be reached, and they refuse to do that while the node home's `daemon.pid` names a live process. The command exits 1 with `Refusing to run "dkg publisher <command>" offline: a daemon appears to be running (PID <pid>) but did not answer the API. ...`, which says what to do: try again once the daemon answers, or stop it (`dkg stop`); if that PID is not a DKG daemon, remove the stale `daemon.pid` file. The thrown `DaemonRunningError` carries `code: "DKG_DAEMON_RUNNING"` for code that calls the CLI module; the CLI does not print it. "Cannot be reached" is not "not running": a daemon that is starting, stalled or restarting is as alive as before. `dkg publisher jobs`, `job` and `stats` change no queue state and still fall back. They are not free of writes, though: with the file-backed Oxigraph backends, closing the inspector's store rewrites the store file from what the inspector loaded ([#3551](https://github.com/OriginTrail/dkg/issues/3551)).

### Share queue: what the sweep removes

Removed, each 7 days (the configured window) after the job finished (its `updatedAt`): a **succeeded** job, an **operator-cancelled** job in which **every attempt is proven unstarted** and that has no recovery binding, and a **certified retired no-effect rejection**. Every other failed job is kept until an operator clears it, because it may be needed for inspection or `recover`. The policy is `async-promote-retention-policy.ts`.

**The cancelled class is the narrowest.** A job's commit marker, format and last error describe only its **last** attempt (every claim resets the marker, a reclaim drops it, a later failure overwrites the error). So a job whose first attempt entered promote and whose last attempt was reclaimed reads, once cancelled, like a job that never ran. The sweep therefore deletes a cancelled job only when both of these hold:

- **Every attempt is proven unstarted.** Either the job was never claimed (`attempt.count` is 0 and no preparation attempt is recorded), or `attempt.count` equals `preparationAttempts`, the number of attempts that ended with `promoteStarted` and `swmInserted` both false (recorded from queue format 4). A count the evidence does not cover, one that exceeds it, and one that is not a non-negative integer prove nothing, and the job is kept. A commit marker, when the job has one, must hold all five flags as booleans, and none of them may be set.
- **Its `formatVersion` is an integer of 2 or more**, the first format whose workers record the whole commit marker before they enter promote. A job written by an older queue format (no `formatVersion`, 0 or 1) may have started promote and its history is uncertain, so legacy formats are kept, as is any `formatVersion` that is not an integer from 0 up to this build's (a string, `null`, a fraction, a negative number).

Never removed, whatever its age: a job that is not terminal (`queued`, `running`, `failed_retrying`); one that still owns an unfinished bound share obligation; one an uncertain admission (a lost acknowledgement) still refers to; one a post-commit failure could replay; one written by a newer queue format than this build understands; a cancelled job that fails either condition above; one whose payload is unreadable or disagrees with its stored index; and one dated after the current time. Every decision is made again from the job's payload, under the queue's lock, immediately before the delete.

### Publish queue: lifecycle keys and siblings

A publish job belongs to a **lifecycle key**: the Knowledge Asset it publishes (context graph, name, sub-graph and agent lane). The jobs of one key are **siblings**. Whether a job still binds its Knowledge Asset (whether a re-submit re-accepts it or starts a new job) is not a property of the job alone: a failed job older than the newest job of its key is history and binds nothing. If the newest job is deleted, that older failed job becomes the newest and can bind again, and a re-submit would then re-accept an old failed job its successor had superseded. Everything that deletes finished publish jobs in bulk therefore keeps every binding decision as it was. Two agents' jobs for the same Knowledge Asset name are not siblings.

#### The bulk clear guard (always on)

`dkg publisher clear finalized|failed` and `POST /api/publisher/clear` apply the sibling rule whatever the retention mode (`async-lift-guarded-clear.ts`). Unlike the sweep, it is not opt-in:

- a **finalized** job is kept while an **older failed** job of its key is kept, because removing it would make that failed job the newest;
- no removal is made that would make a different, kept job bind the key (removing the binding job itself, which vacates the key, is what clearing a failed job is for);
- a key whose job records cannot be decoded is skipped (admission cannot read that key either), and the clear carries on with the others;
- a held job, or one in the recovery lane, is never removed;
- each job of that status, oldest first, is judged under the queue's claim lock and its own job lock, as clearing one job by id is, whether or not it is removed. Every intermediate state keeps the key's newest job.
- known gap, for damaged records only: a job stored with a second lifecycle-key triple is judged under its payload's key alone, so clearing it can change what the other key binds ([#3562](https://github.com/OriginTrail/dkg/issues/3562)). The retention sweep keeps such a job (`index_mismatch`, `keyedIndexAgrees` in `async-lift-retention.ts`).

The count in the response is the number of jobs removed. It can be smaller than the number of jobs listed in that status, and a large clear takes longer because every listed job opens a claim and job transaction. `POST /api/publisher/clear-job` for one job is unguarded and stays the deliberate override: clearing the newest job of a key by id can make an older failed job bind it again.

#### What the publisher sweep removes

Removed, 7 days (`finalizedMaxAgeMs`) after the job finished (its `finalizedAt`): a **`finalized`** job. That is the only class. Every failed job is kept until an operator clears it (the queue has no harmless failed class), and so is every job that is not finished.

Never removed, whatever its age:

- a job that is not `finalized` (`accepted`, `claimed`, `validated`, `broadcast`, `included`, and every `failed` job);
- a job a wallet lock still names (an obligation that is still bound);
- a job whose payload is unreadable, ambiguous (several payload records), another job's, a format this build does not understand, a legacy payload written by a much older version, or without a finish time;
- a job whose stored status, finish time or lifecycle key disagrees with its payload, or whose stored finish time is not an integer (the scan reads `xsd:integer` finish times only, as the share scan does, so it never meets such a job; it is not counted, and it holds the newer jobs of its key);
- a job dated after the current time (`finalizedAt` or `updatedAt`);
- a job with an older sibling that is kept (the sibling rule below).

**The sibling rule.** The jobs of a key are taken oldest first, in the order that decides which one is the newest, and the sweep deletes only an unbroken run from the oldest. An older job that is failed, not finished, too young, bound, unreadable or otherwise kept **ends the run**, and every newer job of the key stays behind it, finalized or not. The newest job itself goes when it is finalized, old enough and nothing older is kept (a finalized job binds nothing, so the key is vacant either way). The jobs are read exactly as admission reads them, inside the claim transaction that serializes admission, claims, retries and clears, and removed one at a time, oldest first, each under its own job lock from a fresh read. After any number of deletes, even a crash in the middle of a key, what is left of the key is a suffix of its history that still holds its newest job, so the key binds exactly what it bound before. As a last check the sweep asks the queue's own binding rule whether the run it is about to delete leaves the key's binding list unchanged, and keeps the key if it does not (`binding_would_change`; a safety net that is not expected to fire). Every decision is made again from the job's payload, under the lock, immediately before the delete. The publish queue's journal is never touched.

### After a job is removed

- Share: `GET /api/knowledge-assets/swm/share-jobs/{jobId}` answers `404`. Share reconciliation answers `absent_or_pruned`, which never authorizes a retry: a never-admitted share and a pruned one cannot be told apart.
- Publish: `GET /api/publisher/job` answers `404`, and `GET /api/publisher/job-by-intent` answers `none`, or lists one job fewer as `superseded`.
- A replay after a job finished is never joined to it, removed or not: a share replay is admitted as a new job, and a publish replay is refused at intent resolution (`409 PUBLISH_INTENT_STALE` or `PUBLISH_NOT_FULL_SHARE`). The window only sets how long status reads, `job-by-intent` and reconciliation can find the job, so it has to be longer than any client's polling and reconciliation horizon. It never protects a replay.

### Limits

Both sweeps:

- **Exclusion between verifying a job and deleting it is only the daemon's in-process locks** (the share queue's mutation lock; the publish queue's claim lock and job locks). A second process that writes a control graph while a daemon runs (another daemon on the same store, the offline CLI inspector, a script, any tool that opens the store directly) is not excluded and could revive or change a job between the two steps. The offline inspector's refusal narrows that for the publish queue, but it is not a lock: it reads the node home's pid file once, when the command starts, and a daemon that starts after that check, or one in another home over the same store, is not seen. Do not write a control graph from anything but the daemon while retention is on.
- **No clock baseline on the first tick after a start.** The sweep guards against a wall clock that stepped, but it can only compare a tick with an earlier one. Start a node with retention on once the host clock is synchronized (NTP).
- **After a real forward clock step the sweep stays skipped until the daemon restarts.** A clock that jumps ahead of the monotonic clock by more than three intervals is counted as `clock_jump`, logged as a warning, and every later tick is skipped too, because nothing proves the clock came back. The rows simply stay. A clock stepped backwards resumes once it has caught up. The tolerance is three times `intervalMs` and the comparison is strict, so at the smallest `intervalMs` (1,000 ms) a step of more than 3 seconds switches retention off until the restart, and at the default (60,000 ms) a step of more than 3 minutes does. A host or VM suspend counts as a forward step, because the monotonic clock does not advance while the host sleeps (on most hosts). The core logs one warning for every skipped tick (about 1,440 lines a day at the default interval) until then. A restart takes the clock as it then is as the new baseline: if the clock is still wrong and ahead, `delete` mode would remove jobs younger than the window. Check the host clock before restarting a node that logged `clock_jump`.
- **The `kept` counters are cumulative judgments:** a row kept by one pass is counted again by the next. Only the `lastCompletePass` figures are per pass.

Share sweep:

- **Retention never calls `observe()`.** An admission whose outcome is uncertain stays kept (`pending_admission`) until some other durable read of the job settles it, such as a status read through the queue. A sweep never settles it, so such a job can outlive its window.
- **`held` has no share-queue representation.** A share job a worker holds under a lease is `running`, which the sweep keeps as `not_terminal`.
- **`recover()` followed by `cancel()` erases the history the cancelled class rests on.** An operator `recover` resets `attempt.count` to 0 and drops the commit marker, the last error and `preparationAttempts`. A job that did run (a fatal error, a post-commit failure) and was then recovered and cancelled looks exactly like a job nobody ever claimed, and is deleted once the window has passed. The cancelled class is "no attempt visible on the row", not "no attempt ever". To keep cancelled jobs regardless, set `benignFailedMaxAgeMs` to `null` (which keeps the retired no-effect rejections too).
- **"Proven unstarted" is narrower than "had no effect".** It means only that `promoteStarted` and `swmInserted` were false when the attempt ended. Effects of the preparation phase (sealing the share, clearing a prepared completion, the VM cleanup of an assertion's promote recovery) still count as unstarted: the same evidence the queue uses to certify a retired no-effect rejection.

Publisher sweep:

- **A hold can run past its budget on a key with a long history.** The hold budget (10 jobs, 50 ms) limits how many candidates one hold judges, not how many older jobs of the same Knowledge Asset each candidate brings. The key's sibling read, the stored-index check of its older jobs and the binding check all run inside one claim-lock hold (`planDeletions` and `refusedSiblings` in `async-lift-retention.ts`), so a candidate behind thousands of jobs of one key can hold admissions and claims for seconds, in `report` as in `delete` ([#3563](https://github.com/OriginTrail/dkg/issues/3563) measured about 2 s behind 20,000 siblings). The usage line does not show the longest hold. A real key holds a few jobs (the retries and updates of one Knowledge Asset). Do not run the publisher sweep on a node with an unusually long publish history for one Knowledge Asset until #3563 is fixed.
- **An older job the sweep cannot get past holds every newer job of its key (the liveness trade-off).** The sibling rule deletes nothing when in doubt, and the price is that a key can stay whole for good. A failed job does it until an operator clears it, but so does a finalized job the sweep cannot read or reach: a pre-upgrade payload, a stored index that disagrees with the payload (`index_mismatch`), a key one of whose jobs cannot be decoded at all (`siblings_unreadable`). `siblings_unreadable` also covers a key whose sibling read holds two records of one job id (a job's payload stored under another job's subject, or one job stored with two payloads): that is a damaged store, repaired in the store itself and not by `clear-job`, which acts only on the job id's own subject and can leave the other record to bind the key. Every job newer than the blocking one stays too, however old, until it is cleared by hand (`POST /api/publisher/clear-job` with its job id, or `dkg publisher clear failed` for failed jobs that are not held and not in the recovery lane). A pass that keeps many jobs as `older_sibling_kept` or `index_mismatch` points at such keys. This costs disk and a longer history read; a wrong delete would change which job binds a Knowledge Asset.
- **Failed jobs are never swept.** A node whose failed jobs pile up has an operator task: inspect them, retry or clear them.
- **A key whose jobs finished in another order than they were accepted may need several passes, up to one per job.** The scan walks by finish time and the sweep deletes a key oldest first (by acceptance), so a job met before an older job of its key that finished later waits, with every job behind it, and is judged again when the pass starts over, within `rescanIntervalMs`. Each pass removes at least the oldest job of such a key when nothing else keeps it, so a key of n such jobs is gone only after n passes. The same holds for a key whose blocking job an operator has just cleared, and for two jobs of a key that finished in the same millisecond: the scan may meet the newer one first, so it waits for the next pass. In that last case `report` can count fewer jobs than `delete` removes in its first pass ([#3554](https://github.com/OriginTrail/dkg/issues/3554)). When the scan meets the older job a slice or a batch before the newer one, `delete` has normally removed it by then and removes the newer one too, while `report`, which removes nothing, still finds the older job in front and keeps the newer one. Not when the hold budget deferred the older job's removal: a deferred job is judged again at the front of the next hold, and if that hold also judges the newer one, the newer one is kept, as when both are judged in the same hold. `report` never counts a job that `delete` would keep.
- **The journal keeps growing.** It is append-only and never touched, so `lift_journal` in the usage line does not shrink when jobs are removed.

### Log lines

At start each sweep logs `[retention] <queue> retention started in report mode (...)`, or a `[warn]` line for `DELETE mode` that names the operator page's checklist.

Each completed pass writes one pass line, in `report` and `delete` alike, never one line per job:

```text
async_promote_retention_pass mode=<mode> scanned=<n> wouldDelete={...} deleted={...} kept={...}
async_lift_retention_pass mode=<mode> scanned=<n> wouldDelete={...} deleted={...} kept={...}
```

Every tick the clock guard skips writes an `async_promote_retention skipped=<reason>` (or `async_lift_retention skipped=<reason>`) warning: `clock_jump`, `clock_backwards` or `clock_invalid`. An `overlap` skip is only counted. Every removal in `delete` mode also writes one `async_promote_retention action=deleted` (or `async_lift_retention action=deleted`) line per hold, with each job's id, class, finish time and age and no payload.

While a sweep runs, the five-minute `async_admission_usage` line gains its `share_retention_*` or `lift_retention_*` fields; with retention off the line is unchanged. The fields are in the [usage-line reference](../../cli/docs/async-admission-usage-line.md).

## Share admission and listing

`POST /api/knowledge-assets/{name}/swm/share-async` accepts a native promotion job. A `200 { jobId, state: "queued" }` acknowledges queue persistence and flush; it does not mean promotion has finished.

### Admission budget and evidence

Queue admission has a ten-second budget covering mutex wait, graph initialization, conflict lookup, persistence and flush. Authentication, context-graph readiness, selected-author resolution, body transfer and HTTP response delivery are outside it, as is the write preflight before admission. This is not a ten-second end-to-end HTTP guarantee.

An admission that expires **before persistence starts** is prevented from later writing a job. The server returns `503` with `Retry-After: 1` and:

```json
{
  "code": "PROMOTE_ADMISSION_UNAVAILABLE",
  "retryable": true,
  "admissionScope": "async_promote_job",
  "admissionOutcome": "not_admitted",
  "phase": "conflict"
}
```

The phase is `lock`, `graph`, `conflict` or `persist` (`promote-admission-response.ts`). Non-admission describes this queue attempt only. It does not assert that another request for the same selector, or every operation before queue admission, never ran.

Once persistence starts, a deadline or failure may hide a committed job. The one exception is a canonical `replaceSubject/not_started` proof returned at the primary persistence boundary before flush, which proves non-admission and releases the attempt for retry. Otherwise the response carries `admissionOutcome: "indeterminate"`, `jobId` and its `statusPath`. It never promotes an inner store operation's `not_started` into whole-admission evidence. The client polls that ID and does not resend. A replay with the **same selector** (context graph, sub-graph, name and storage-author lane) joins the admission only while it is unresolved: once any read has seen the job, or after a restart, a replay after the job finished is admitted as a new job. A missing or failed status response, including an absent row after a transport failure, is not proof that a dispatched write cannot still commit.

A pending same-selector admission is shared. A replay during persistence promptly returns the same tentative handle with indeterminate evidence. If the original write then succeeds, the original job is the one workers process. A settled ambiguous failure keeps its handle until a fresh durable read observes the job; it does not start another write. At most 64 unresolved or in-flight admissions are retained per store and control graph; further new admissions are rejected without dispatch. Pending entries survive caller timeout until their underlying operation settles, so a blocked mutex cannot accumulate unlimited detached admissions.

With the store control path on, a refusal on the share control scheduler arrives at the enqueue route as this verdict, not as the store error: `503` with `admissionOutcome: "not_admitted"` and the phase that was refused (`conflict` for the lookup, `persist` for the job write; a refused write never reached the store, so no job exists). The scheduler error is the verdict's cause and is not part of the body.

Set `DKG_ASYNC_PROMOTE_ADMISSION_TRACE=1` to emit fixed-shape `async_promote_admission` events containing only the event kind (`phase_settled` or `deadline`), phase, elapsed milliseconds and outcome. A write that settles after the response deadline emits its eventual phase duration separately. Phase duration for graph, conflict and persist includes scheduler waiting and admitted store work; it is not admitted execution time alone. Correlate it with the scheduler source diagnostics (`publisher.asyncPromote.findActiveConflict`, `publisher.asyncPromote.writeJob`; with the control path on they report the `control` lane). The events contain no asset names, graph or job IDs, addresses, payloads or exception messages. Tracing does not change queue outcomes.

### Existing job observations

A same-selector replay can return `409` with `existingJobId` and `observedAdmission: true` without another conflict query or mutex wait. This is a bounded positive observation of a previously acknowledged or read owner, **not a fresh statement of its job state**. Cached observations never authorize a new job or bypass authorization, readiness or selected-author checks.

The process remembers at most 1,024 owners for five minutes from their last acknowledged transition or durable observation. Local writes invalidate the old observation before mutation and refresh it only after persistence and flush; ordinary terminal jobs stop being owners. Failed bound shares remain owners until their recovery obligation is completed or certified retired. A validated terminal clear settles retained admission uncertainty before removing the record; an absent, malformed or unrecognized record cannot provide that proof. A fresh status read also removes an observation if an external writer cleared that job. An external writer can make an observation stale until a fresh read or expiry; `observedAdmission` identifies this case. A restart, expiry or eviction requires the normal durable conflict lookup, which can itself be unavailable under store pressure. No cached absence is used.

### Duplicate check

Before persisting, admission looks for a durable owner of the same selector. The lookup reads the jobs stored under the selector's uniqueness key spellings (the current key, the pre-canonical lower-cased lane key, the default-lane key and the legacy key; for most selectors several are the same string) by key constant, so its cost follows the number of jobs under that selector and not the length of the queue history. It leaves out the rows that cannot decide the check: jobs whose stored state is `succeeded`, and `failed` jobs whose payload carries no recovery binding. Every other row (queued, running, retrying, a failed bound share, or a row with no or an unrecognized state) is decoded and judged, and an unreadable one of those fails closed with `KA_PROMOTE_RECOVERY_REQUIRED`. A job that the store reaches through two key spellings is counted once. The same lookup serves lifecycle ownership reads and the recovery sweeps (`async-promote-ownership.ts`).

A selector with a long history of its own is still scanned for that key's rows inside the store, and only its undecided rows come back. **This lookup does not bound that per-selector growth.** Finished jobs under one selector accumulate until they are cleared or removed by share retention, which is off by default; see [Retention of finished jobs](#retention-of-finished-jobs).

The admission decision is unchanged by the bounded lookup, except for narrowings that affect corrupted records only:

- **Unreadable payload on a finished row.** A row whose stored state is `succeeded`, or `failed` without a recovery binding, is not decoded, so a corrupt payload there no longer makes the lookup throw `KA_PROMOTE_RECOVERY_REQUIRED`. Such a row cannot own the selector. Unreadable rows in every other class keep failing closed.
- **State and payload that disagree (a note).** The stored state decides which rows are read. A record whose state triple disagrees with its payload cannot be produced by the queue (both are written in one atomic replace) and is judged by the state triple.
- **Stale owner observations.** A conflict lookup used to observe every row it returned, terminal ones included, which dropped this process's remembered observation of a job another process had finished. Terminal rows are no longer returned, so such an entry is no longer cleared by a lookup. It still expires after five minutes, and a status read of that job still drops it.

### Listing, paging, statistics and the post-commit sweep

These reads used to be one complete read of every job the queue ever stored, taken inside the mutex that every admission, claim and heartbeat also needs. They are now bounded reads. `claimNext`, its lane-conflict guard and startup recovery are not part of this: they keep their complete read of the active jobs, in the same order.

**Keyset pages.** A page is the jobs after a cursor in `(enqueuedAt, jobId)` order, oldest first and then by job ID in code point order (job IDs are ASCII), with `LIMIT n + 1` and no `OFFSET`; the extra row only says that more follow. The key read is `SELECT DISTINCT`, so a record with a second state triple is one row, not one per triple. Both fields never change for a job, so a walk stays correct when jobs change state or arrive between pages. The key read carries no payload; the payloads are read for the page's own rows by subject, in the same hold of the mutex, and a job that stopped matching the filter between the two reads is left out. Every read of a page is tagged for the share control path.

**What a page costs.** The engine scans and orders the rows that match the filter before it cuts the page, so a page costs the matching rows, not the page size ([measurements](../../../docs/investigations/async-queue-share-page-bound.md)). On the pinned Blazegraph image, a page of up to 1,000 jobs with a filter that matches the whole retained history takes 0.04 s at 0, 0.11 s at 10,000 and 0.35 s at 50,000 retained jobs (median, end to end); a filter that matches few rows (the live states, `failed`, one small context graph) stays at about 0.03 s at every size.

**Paged call** (`listPage`). Opt-in: a cursor and a page size. The page size is 100 when absent and at most 1,000. `nextCursor` is present exactly when more rows followed the page at the time it was read; `complete` is its negation and never proof that nothing arrived since. The cursor is opaque: a version prefix, then a schema-checked body that decodes only if it is the exact text the queue wrote. A malformed cursor or page size is a `PromoteListRequestError` (code `PROMOTE_LIST_CURSOR_INVALID` or `PROMOTE_LIST_PAGE_SIZE_INVALID`) raised before any read. A page the stored rows cannot support is a `PromoteListStoredRowError` (code `unreadable_row`, `unordered_page` or `unresumable_page`, as `LiftJobPageError` does for the publish queue): the fault is in the store, not in the request. A caller tells the two apart by type and code, never by the message. Under concurrent changes no job is returned twice, and every job that matched the filter for the whole walk is returned exactly once. A job inserted at the cursor's timestamp with a lower job ID than the cursor's job is behind the walk and is not returned.

**The list route** (`GET /api/knowledge-assets/swm/share-jobs`). A request with neither `cursor` nor `pageSize` is the complete call below, and its answer is unchanged. `pageSize` (alone it asks for the first page) or `cursor` makes it a paged call: the route calls `listPage` with the `state` and `contextGraphId` filters and answers `{ jobs, nextCursor, complete }` (`nextCursor` is `null` on the last page). The route maps the two request errors to `400` with those codes (`{ error, code }`; a cursor of the publisher listing is a `PROMOTE_LIST_CURSOR_INVALID` too), refuses `limit` together with a paging parameter (`400 LIST_PAGING_LIMIT_CONFLICT`), checks the caller's read authority for the context graph before the page is read, and leaves everything else to the daemon's error mapping: store pressure on the share control path is the retryable `503` (`"priority": "control"` while that path is on), and a `PromoteListStoredRowError` is a `500` with a fixed message that names no job (the node logs one `[list-paging]` warn line for it). The parameters, order and walk guarantees are in [Listing async jobs](../../../docs/references/api.md#listing-async-jobs).

**Complete call** (`list`, the route without a cursor or page size). It returns every matching job, sorted by ready time (`nextRetryAt` when set, else `enqueuedAt`, then `jobId.localeCompare`), with `limit` applied after the sort. The ordered keys are read in key pages of 10,000 (one scan of the matching rows each, so about five at 50,000 retained jobs), then the payloads of those keys by subject in batches of at most 1,000, and **the mutex is released between every key read and every batch**; no hold reads a full payload set. With a `limit` it stops as soon as no unread job can rank among the first `limit` rows: the keys arrive in enqueue order and the result is in ready order, so it keeps the best `limit` rows read and stops once the last of them is strictly earlier than the next unread enqueue time and than every unread job's `nextRetryAt` (a retry time can precede its job's enqueue time after a clock step, and a failing job gets one while the listing runs). The retry times are read, in one small query in a hold of its own, only when the rows read so far would let the walk stop, and the walk stops only if the bound still holds with the values that query returned. A retry time written before that read is therefore seen, and one written after it is a change after the walk. Which jobs `limit` keeps is unchanged, and `?limit=10` reads one small batch of a long queue and the retry times instead of the whole history.

A complete listing is not a snapshot: a job that starts matching after the key read that covers its position is not seen, a job that changes but still matches is returned as its batch read it, a job that arrives behind the walk is not seen, a job whose payload no longer matches the filter when its batch is read is left out, and a job that matched the filter for the whole walk is returned exactly once. The longest hold is one key read or one batch (about 0.3 s at 50,000 retained jobs, against about 1.3 s for the single read before). The whole call takes about 0.5 s at 10,000 and about 3.2 s at 50,000 retained jobs, against about 0.2 s and 1.3 s for that single read ([measurements](../../../docs/investigations/async-queue-share-page-bound.md#what-the-complete-listing-costs-and-how-its-cost-was-cut)); with a `limit` it takes about 0.1 s and 0.2 s. A complete listing that read more than 5,000 rows logs `async_promote_list_complete rows=<n> threshold=5000: ...` (at most once a minute per queue); page with a cursor, or filter by state, instead.

**Statistics.** `getStats` is one `COUNT(?job) ... GROUP BY ?state` over the state triples (about 0.015 s at 0 and 10,000 and 0.04 s at 50,000 retained jobs), not a read of every payload. It counts the same as before for every record the queue wrote; the differences for corrupted records are listed below.

**Post-commit sweep.** The sweep asks the engine for the `failed` jobs whose payload text names the post-commit diagnostic code or the producer's fixed message (the two ways the recovery policy recognizes a row), 50 at a time in keyset order, one hold of the mutex per page, and keeps only the ranking fields (`jobId`, `enqueuedAt`, `nextRetryAt`) of the rows the recovery policy accepts. It then sorts those with the queue's own order (ready time, then `jobId.localeCompare`) and decides them 50 at a time in that order, one hold per turn: the turn reads its rows again by subject and judges each with the recovery policy and the conflict lookup, so a candidate that left the failed state since it was found is judged as it is now and never overwritten from an older copy. The order matters because requeuing a job makes it the owner of its assertion and defers every later candidate of that assertion. The sort holds a few small records for the accepted candidates only, never their payloads. A lookalike that merely contains the text is left alone. A candidate that appears after the find pass waits for the next sweep. Each decide turn reads the clock in its own hold, so with a moving clock the `nextRetryAt` of a later turn's requeues is slightly later than an earlier turn's.

**Durable synchronous share.** When a stale prepared admission loses to a winner, the route looks for the winner's job under the selector's own uniqueness key (the four spellings the conflict lookup reads, in any state) instead of listing every job of the context graph. A selector with a long history of its own is still read in full, as for the duplicate check.

**Observations.** `getStats` and the sweep do not call `observe()` on every job they list: `getStats` reads no payload, and the sweep shows the admission coordinator only the candidate rows it reads. Besides refreshing or dropping an owner observation, `observe()` **settles a retained ambiguous admission** whose job it sees, so a statistics call or a sweep does not settle one as a side effect. The reads that return a job still observe it and settle its retained handle: `claimNext`, status reads, listing pages and complete listings (for the rows they read), the selector lookup and the conflict lookup. A retained handle that none of them reaches stays until one does; it is bounded (64 per control graph) and never starts a second write.

**Corruption-only narrowings** (records the queue cannot write; nothing changes for records it wrote):

- **Two state triples.** A record with a second state triple is listed once, by the state its payload names (the key read is `DISTINCT`). It used to come back once per triple, which made every walk of an unfiltered queue fail the "out of order or at/before the cursor" check; that check still fails a genuine reordering. `getStats` counts such a record once per state triple.
- **Two enqueue-time triples.** A record with a second `enqueuedAt` triple has two keys, so `list()` and `listPage()` return it once per key. The post-commit sweep keeps one candidate per job ID, so it still judges such a job once.
- **Undecodable payload.** `getStats` counts a record by its state triple, so one whose payload cannot be decoded is counted; a record whose state triple disagrees with its payload is counted by the triple. Listings and the sweep skip a record they cannot decode.
- **A row that cannot be put in a cursor.** A stored enqueue time below zero (or a job ID the grammar refuses) cannot be named by a cursor. A complete listing returns the row; a page that ends on it fails with a `PromoteListStoredRowError` (code `unreadable_row`), not a `PromoteListRequestError`, because the fault is in the stored data.

## Publish admission

Admission looks for an existing job for the same lifecycle key (context graph, name, sub-graph and agent lane) under the global claim lock (`findActiveKnowledgeAssetVmPublishJob`). An identical re-submit returns the existing job, and re-accepts it when it is a failed job that is safe to re-run; a submit with a different share intent is refused with `409` and `existingJobId`. The lookup is bound by the lifecycle key, so its cost follows the jobs under that key, not the retained history of every other asset.

Jobs admitted before the lifecycle index existed (#1828) have no index row. The first admission after a node starts therefore also scans for such rows (`LiftLegacyScanMemo`). When it finds none that could match an admission, the node remembers that for the rest of the process, and later admissions use the key-bound lookup alone. The boot backfill (`ensureVmPublishIntentIndex`) indexes any such row it finds, so a restart scans once more and then stops again. Raw-lift rows and rows that cannot form a lifecycle key never match an admission and do not keep the scan on. One narrowing follows: a pre-index publish row that appears after the node has cleared the scan is not seen by admission until the next backfill or restart. Nothing in the current code writes such a row, and each node has its own queue store. If you restore an old queue into a running node, restart it so the backfill and the first scan see the restored rows.

## Store control path

The operator setting (default, how to switch it, the startup line) is on the operator page. This section is the detail behind it (`packages/storage/src/store-control-path.ts`).

### Settings in detail

The path is set by `DKG_STORE_CONTROL_RESERVED_SLOTS` or the node config's `store.controlReservedSlots`, both read once at daemon start. The variable wins when it is set; otherwise the config value applies when the key is present; with neither, the default applies. Only the daemon passes the config value and the backend (`configureStoreControlPath`); any other process that uses the store (the `dkg publisher` commands while the daemon is unreachable, scripts, benchmarks) honours the variable alone and otherwise keeps the path off.

The default is on (share 1, publisher 2) when `store.backend` is in `STORE_CONTROL_DEFAULT_BACKENDS` (`blazegraph`, `oxigraph-server`) and the host has more than 2 CPUs (`os.availableParallelism()`). It is off on hosts with 2 or fewer CPUs, with `sparql-http` (any other SPARQL store, a Blazegraph reached through it included) and with any other backend. The embedded backends (`oxigraph`, `oxigraph-persistent`, `oxigraph-worker`; a config without a `store` block runs `oxigraph-worker`) have no store scheduler: with an explicit value the startup line still says `on` and the control schedulers appear in the diagnostics with no work, because only the `blazegraph` and `sparql-http` adapters call `selectStoreScheduler`. Their line adds `the embedded <backend> store never uses it`.

| Value (variable or config) | Effect |
| --- | --- |
| not set (no variable, no config key) | The default above |
| `0` (in the config also the number `0`) | Off. No scheduler is built or registered, and a call that names its queue behaves exactly like one that does not |
| `share:1,publisher:2` | The slots per queue, up to a cap of 1 for `share` and 2 for `publisher`. A queue left out gets 0. Honoured on any host and with any backend |
| a number above a queue's cap | Clamped to the cap, with a warning |
| set but blank | Refused with a warning; the path stays off. A blank value is a typo, never the default |
| anything else (in the config also `null`, `true` or any number but `0`) | Refused with a warning that names the setting (`Invalid config store.controlReservedSlots=...` or `Invalid DKG_STORE_CONTROL_RESERVED_SLOTS=...`), and the startup line says `... refused as malformed`. The path stays off. A malformed value never falls through to the other setting or the default, so a mistyped rollback can never leave the path on |

`dkg init` and `dkg openclaw|hermes|mcp setup --store ...` keep `controlReservedSlots` when they rewrite the `store` block. Only a switch to the embedded store removes the block, and the key with it.

The control schedulers take nothing from the shared `store` scheduler: its lanes, limits and totals are unchanged. Each control scheduler reports one lane, `control`; its `inflightLimit` is its slots, its queue limit is the shared scheduler's `normal`-lane limit, and its wait timeout is `DKG_STORE_QUEUE_WAIT_TIMEOUT_MS`. A refusal is the same retryable, not-started `503` (`STORE_SCHEDULER_BUSY`) as on `store`, with `"priority": "control"`. Queue-wait timeout warnings are rate-limited per scheduler instance (at most 16 per 60 s, and one per priority and operation per 60 s), so with the path on a node can log up to 48 such warnings a minute from its three schedulers, not 16 in total.

Design rationale: queue admission used to share the store's ordinary lanes. With the path on, the queue's own calls have a lane of their own. It takes nothing from ACK, health or ordinary work (the slots are added beside them and are a hard cap), it raises no timeout and no general concurrency, and it serves queue bookkeeping only.

### Share queue calls on the control path

A call reaches a control scheduler only when its options name the queue (`controlStoreOptions(queue, source)`, `QueryOptions.controlQueue`); no priority and no ambient lane moves a call there. Every store call the share queue makes **inside its mutex** names the share queue: the conflict lookup, the job record write (one atomic replace, or its delete-and-insert fallback), the `claimNext` candidate read and the lease-recovery read, heartbeats, commit markers, success and failure records, status reads, listings, statistics, cancel, recover, the post-commit recovery sweep, terminal clear, the retained-share reconcile read (`publisher.asyncPromote.reconcile`) and, while share retention runs, its verify and delete holds (`publisher.asyncPromote.retention.verify`, `publisher.asyncPromote.retention.delete`). The tag sets no priority. With the path off, each call is scheduled in exactly the lane it used before (the ambient default lane of its caller, or `normal`), so the lane choice and the error text are as they were.

What stays on the caller's lane:

- the lock-free lifecycle ownership reader (`publisher.asyncPromote.ownershipReader`), which runs outside the mutex for assertion lifecycle writes;
- the reads before admission (context-graph write preflight, author selection), the promote the worker executes for a claimed job and everything else it reads or writes, and client `/api/query` reads;
- the share retention sweep's index scan (`publisher.asyncPromote.retention.scan`), which runs outside the mutex on `background`;
- the monitoring reads behind the `async_admission_usage` queue depth, which stay `background`.

The worker wake that `enqueue`, `recover` and `resume` raise carries no lane scope and no control tag: the worker tick it starts inherits no ambient lane from the caller. The mutex and the lease semantics are unchanged.

### Publish queue calls on the control path

With the path on, every store call on the publish queue's three graphs (`urn:dkg:publisher:control-plane`, `urn:dkg:publisher:wallet-locks` and `urn:dkg:publisher:journal`) that holds a queue lock runs on the publisher's control scheduler (up to two slots):

- admission (the duplicate check `publisher.asyncLift.findActiveVmPublish`, the job write);
- job and wallet-lock reads and writes, claim candidate selection, and the stale-lock sweep;
- the admission journal (sequence allocation and append);
- the point reads (`GET /api/publisher/job`, `/job-payload`, `/job-by-intent` and `/journal`);
- cancel and the removal of one job (`clear-job`);
- the job listing that a bulk `POST /api/publisher/retry` takes while it holds the claim lock;
- the per-job work of a bulk `POST /api/publisher/clear`: the job read under its locks, the sibling read (`publisher.asyncLift.clear.siblings`) and the removal;
- the publisher retention sweep's verify, wallet-lock and sibling reads (`publisher.asyncLift.retention.verify`, `.walletLocks`, `.siblings`) and its deletes.

Everything else keeps its lane. The unlocked reads stay on the normal lane, because they hold no lock and the control slots are for the calls that do. Some of them read the whole history: `GET /api/publisher/jobs` without `pageSize` or `cursor`, the job listing of a bulk `POST /api/publisher/clear`, the reconciliation inventory and the boot backfill. The others are bounded: `GET /api/publisher/stats` (one `COUNT` grouped by state) and the paged job read (`listPage`). The publisher retention sweep's scan of finished jobs (`publisher.asyncLift.retention.scan`) runs on `background`, and so do the queue-depth counts behind the `async_admission_usage` line. The claimed job's own work (workspace reads, validation, the publish, post-confirmation store work) never carries the control tag, whatever lane the claim ran in.

## Share reconciliation

`GET /api/knowledge-assets/swm/share-jobs/reconcile` (`packages/publisher/src/share-reconciliation.ts`, route `packages/cli/src/daemon/routes/share-reconciliation.ts`) answers whether a retained successful share job ran a given immutable share. It does not enqueue, recover, clear or retry a job, and ordinary share conflict exclusion is unchanged. The client-facing parameters and outcomes are on the client page.

**Who may call.** An accepted agent credential may read only its own storage lane and must have read access to the context graph. An authenticated node operator may select a lane. Anonymous access is refused (`403`), including tokenless authentication-disabled mode. Rejected requests do not disclose candidate job IDs or private metadata.

**What `proven` proves.** A `200` with `outcome: "proven"` identifies one retained successful `jobId` and its versioned `evidence`: the actual `shareOperationId`, the exact selector and the canonical author seal (native UAL, version, content root, author and attestation). The publisher captures eligible evidence before commit under the lifecycle lock and returns it only after completion; the worker persists it with the successful queue result under its lease. Client correlation fields are not copied into the evidence. An explicit share-author expectation must match the finalized seal; the publisher rejects a mismatch under its lifecycle lock before durable ownership admission and again before sharing, and HTTP sharing reports it as `409 KA_SHARE_AUTHOR_MISMATCH`. A proof says the retained job executed the specified immutable share. It does not identify a unique historical HTTP submission, prove current Shared Working Memory availability, or certify that no other job existed before retention removed it. Current atomic sharing supports only the full selector, so a partial reconciliation selector cannot match full-share evidence.

**The inventory.** The query must examine the complete retained queue inventory within its 1,000-row bound and find exactly one matching successful record, with no potentially competing legacy or unfinished record for the same selector. Discovery scans every subject in the queue control graph before filtering canonical payloads by context, so missing or inconsistent indexes cannot hide a competing retained job. The bound applies across contexts: a large queue can answer `incomplete_inventory` even when the requested context is small. The read holds the queue mutation lock, so a fallback delete-and-insert replacement cannot hide a competing record, and it runs on the share control path (`publisher.asyncPromote.reconcile`). The query has a ten-second store cancellation signal; lock wait, authentication and context-authority work are outside that budget. A process restart preserves stored evidence. A replay of the same committed operation keeps its operation identity. A different native version, content root, author, lane or sub-graph does not match. Several matching retained jobs remain `ambiguous` even if they replayed the same operation.

**Evidence format.** Evidence schema version 1 is an optional addition to queue format 4. Existing records stay readable by the job API. Older jobs, earlier seals missing canonical evidence fields, successful no-op paths without a verified operation, and jobs that crashed before recording completion are not backfilled from their current descriptor; they may stay unproven and need operator confirmation. Clearing or retention removes this evidence; no historical completeness or tombstone is promised. Unknown evidence versions fail conservatively.

**Failures.** Context-authority unavailability returns `503` before evidence is read. Store failure answers `unproven` with `reason: "unavailable"` and HTTP `503`. The SDK (`ApiClient.knowledgeAssetReconcileShare`) throws its normal HTTP error on a non-2xx response; neither an exception nor a transport timeout is evidence of non-admission.
