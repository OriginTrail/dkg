# Promote queue operations

The daemon configures the promote queue before its first access. Five attempts remain the default. Existing jobs retain the budget persisted when they were enqueued; changing configuration affects new jobs. The existing one-hour retry window for typed prerequisite failures can keep those jobs retrying beyond the attempt budget; these settings do not change that window.

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

The retry delay doubles from `retryBaseMs`, with symmetric multiplicative jitter, capped at `retryMaxMs`. Delay and budget values must be positive safe integers, the maximum delay must be at least the base delay, and jitter must be in `[0, 1]`. Invalid policy prevents daemon startup.

Local enqueue, recovery, resume and job writes invalidate the worker's idle claim hint. When no job can run, full scans occur at most once per second, with an earlier scan for a known retry or lease deadline. Out-of-process writes are discovered by the bounded poll. Queue state remains authoritative.

Automatic post-commit recovery is bounded by each job's persisted budget. Exhausted shares remain visible for operator recovery: inspect `GET /api/knowledge-assets/swm/share-jobs/:jobId`, correct the prerequisite, then use `POST /api/knowledge-assets/swm/share-jobs/:jobId/recover`. Recovery follows the existing replay-safety checks; configuration does not automatically reset exhausted jobs or bypass an ambiguous started promote.

## Retention of finished jobs

The promote queue keeps its jobs in the node's triple store and never removes a finished one by itself: a job leaves only when someone clears it (`POST .../share-jobs/:jobId/clear`). A node that shares continuously therefore grows the share control graph without bound, and every read that walks the whole graph grows with it (the retained-share reconciliation answers `incomplete_inventory` above 1,000 retained rows, see [share-reconciliation.md](api/share-reconciliation.md)). Retention is an opt-in sweep that removes the finished jobs the policy below allows. **It is off by default, and nothing in this section changes a node that does not set it.**

### Modes and defaults

`queueRetention` in `config.json`, one section per queue. Every key is optional.

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
    "publisher": { "mode": "off" }
  }
}
```

| Key | Default | Allowed |
| --- | --- | --- |
| `mode` | `off` | `off`, `report`, `delete` |
| `intervalMs` | 60,000 | 1,000 to 3,600,000. The pause between two ticks; the first tick comes one interval after the start |
| `batchSize` | 100 | 1 to 1,000. Rows one tick judges at most |
| `succeededMaxAgeMs` | 7 days | at least 24 hours (86,400,000) |
| `benignFailedMaxAgeMs` | 7 days | at least 24 hours, or `null` to keep the two harmless failed classes (the cancelled class and the retired no-effect rejection) as well |
| `rescanIntervalMs` | 3,600,000 | 60,000 to 7 days. How often a finished pass starts again from the oldest row |

- **`off`** creates nothing and makes no store call.
- **`report`** judges and counts what `delete` would remove and removes nothing. It writes one summary line per completed pass, not one per job.
- **`delete`** removes the jobs the policy allows once they are past their window. **Deletes cannot be undone.**

A value that is wrong, or a key that is not recognised (`queueRetention.share.mod`), stops `dkg start` and the daemon with a message that names the key; there is no silent fallback to a default. Changes need a restart. Both queues have a section so that they share one set of settings and one timer, but only the **share** queue has a sweep today. `queueRetention.publisher` is validated and otherwise inert until the publisher queue's retention ships; a publisher mode other than `off` is logged at startup as having no effect **yet**. It is not refused, so it takes effect on the first node start after an upgrade to a release that ships the publisher sweep: leave the publisher mode `off` until you want that queue swept, and take the delete gate's export and sign-off (items 3 and 4) immediately before such an upgrade on any node that has it set to `delete`.

A tick judges at most `batchSize` rows, so a large backlog drains at about `batchSize` per `intervalMs` (100 per minute by default); raise `batchSize` (at most 1,000) or lower `intervalMs` to drain faster. Each tick works in small holds of the queue's mutation lock (at most 10 jobs, 50 ms) so admissions, claims and heartbeats interleave.

### When it may be turned on

- **No live node runs `report` until the G2 retention step has passed** (OT-RFC-73 D-17: the step run on the first build that contains the share and publisher retention, on a backed-up, seeded local node). The step gates turning retention on at all; it does not gate the release that ships the code.
- **`delete` runs only through the delete gate**, and every item must hold:
  1. `report` has run for at least 14 days on at least one live node, and throughout, the share jobs the 7-day window would keep stay below the 1,000-row bound of the share reconciliation query. The estimate is an upper bound: the share jobs admitted in any trailing 7 days (the accepted `share_async` submissions in the `http=` counters) plus the failed share jobs the policy keeps (the `failed` count of `share_depth`, minus the `cancelled` and `retired_no_effect` figures of `share_retention_pass_would_delete`). If it would not stay below the bound, the window is shortened or the bound revisited before any delete runs.
  2. The would-delete set has been independently reviewed against the policy below and shows an empty diff against the offline oracle.
  3. A CONSTRUCT export of both control graphs was taken immediately before the first delete run.
  4. The named retention owner signed off immediately before the first delete run, having read the two limits of the cancelled class under "Limits to know about" (recovering and then cancelling a job erases its history; "proven unstarted" covers only `promoteStarted` and `swmInserted`).
- Starting a node in `delete` mode logs a warning saying so. Never turn `delete` on to "see what happens": use `report`.

### What it removes, and what it never removes

Removed, each 7 days (the configured window) after the job finished (its `updatedAt`): a **succeeded** job, an **operator-cancelled** job in which **every attempt is proven unstarted** (below) that has no recovery binding, and a **certified retired no-effect rejection**. Every other failed job is kept until an operator clears it, because it may be needed for inspection or `recover`.

**The cancelled class is the narrowest.** A job's commit marker, format and last error describe only its **last** attempt (every claim resets the marker, a reclaim drops it, a later failure overwrites the error), so a job whose first attempt entered promote and whose last attempt was reclaimed reads, once cancelled, like a job that never ran. The sweep therefore deletes a cancelled job only when both of these hold:

- **Every attempt is proven unstarted.** Either the job was never claimed (`attempt.count` is 0 and no preparation attempt is recorded), or `attempt.count` equals `preparationAttempts`, the number of attempts that ended with `promoteStarted` and `swmInserted` both false (recorded from queue format 4). A count the evidence does not cover, one that exceeds it, and one that is not a non-negative integer prove nothing, and the job is kept. A commit marker, when the job has one, must hold all five flags as booleans and none of them may be set.
- **Its `formatVersion` is an integer of 2 or more**, the first format whose workers record the whole commit marker before they enter promote. A job written by an older queue format (no `formatVersion`, 0 or 1) may have started promote and its history is uncertain, so legacy formats are kept, as is any `formatVersion` that is not an integer from 0 up to this build's (a string, `null`, a fraction, a negative number).

Never removed, whatever its age: a job that is not terminal (`queued`, `running`, `failed_retrying`), one that still owns an unfinished bound share obligation, one an uncertain admission (a lost acknowledgement) still refers to, one a post-commit failure could replay, one written by a newer queue format than this build understands, a cancelled job that fails either condition above, one whose payload is unreadable or disagrees with its stored index, and one dated after the current time. Every decision is made again from the job's payload, under the queue's lock, immediately before the delete. The publisher queue's journal is never touched.

### After a job is removed

- `GET /api/knowledge-assets/swm/share-jobs/:jobId` returns 404 for it.
- Share reconciliation answers `absent_or_pruned`, which never authorizes a retry: a never-admitted share and a pruned one cannot be told apart.
- A client that lost every reply and replays the same share after the window is admitted as new. (A succeeded job never blocked a replay in the first place.) The window therefore has to be longer than any client's polling and replay horizon.

### Where it runs

Retention starts only in the **daemon's admission instance**, after the API is listening, and stops before the agent on shutdown. The sweep is built after the share queue, over the very store object the queue was built with, so that it sees the queue's pending admissions. If that wiring is ever broken the daemon logs an error naming `SHARE_RETENTION_ADMISSION_UNAVAILABLE` and keeps running **with share retention off** (nothing is judged or deleted); this is a defect to report, not something to configure around.

No other runtime reads `queueRetention`: a standalone agent or library use, a worker or runner process, the offline CLI inspector and scripts ignore the setting, and none of them starts a sweep. The starter itself (`startRetention`) refuses, with an error, any caller but the daemon's admission instance when a mode is not `off`, and a test pins that only the daemon calls it. The core (`createShareRetention`, exported from `@origintrail-official/dkg-publisher`) has no such check, so code that calls it directly is bound by the next limit without being stopped. The reason is that limit.

### Limits to know about

- **Exclusion between verifying a job and deleting it is only the daemon's in-process queue lock.** A second process that writes the share control graph while a daemon runs (another daemon on the same store, the offline CLI inspector, a script or any tool that opens the store directly) is not excluded and could revive a job between the two steps. Do not write the share control graph from anything but the daemon while retention is on.
- **No clock baseline on the first tick after a start.** The sweep guards against a wall clock that stepped, but it can only compare a tick with an earlier one. Start a node with retention on once the host clock is synchronized (NTP).
- **After a real forward clock step the sweep stays skipped until the daemon restarts.** A clock that jumps ahead of the monotonic clock by more than three intervals is counted as `clock_jump`, logged as a warning, and every later tick is skipped too, because nothing proves the clock came back. The rows simply stay. A clock stepped backwards resumes once it has caught up. The tolerance is three times `intervalMs` and the comparison is strict, so at the smallest allowed `intervalMs` (1,000 ms) a step of more than 3 seconds switches retention off until the restart, and at the default (60,000 ms) a step of more than 3 minutes does. A host or VM suspend counts as a forward step, because the monotonic clock does not advance while the host sleeps (on most hosts): a laptop or VM that sleeps for longer than the tolerance and wakes stays skipped until the daemon restarts. The core logs one warning for every skipped tick (about 1,440 lines a day at the default interval) until then.
- **Retention never calls `observe()`.** An admission whose outcome is uncertain stays kept (`pending_admission`) until some other durable read of the job settles it, such as a status read through the queue. A sweep never settles it, so such a job can outlive its window.
- **`held` has no share-queue representation.** A share job a worker holds under a lease is `running`, which the sweep keeps as `not_terminal`.
- **The `kept` counters are cumulative judgments:** a row kept by one pass is counted again by the next. Only the `lastCompletePass` figures are per pass.
- **`recover()` followed by `cancel()` erases the history the cancelled class rests on.** An operator `recover` resets `attempt.count` to 0 and drops the commit marker, the last error and `preparationAttempts`. A job that did run (a fatal error, a post-commit failure) and was then recovered and cancelled therefore looks exactly like a job nobody ever claimed, and is deleted once the window has passed. The row cannot tell the two apart: the cancelled class is "no attempt visible on the row", not "no attempt ever". An operator who recovers a job to inspect it and then cancels it should expect it to age out; to keep cancelled jobs regardless, set `benignFailedMaxAgeMs` to `null` (which keeps the retired no-effect rejections too).
- **"Proven unstarted" is narrower than "had no effect".** It means only that `promoteStarted` and `swmInserted` were false when the attempt ended. Effects of the preparation phase (sealing the share, clearing a prepared completion, the VM cleanup of an assertion's promote recovery) still count as unstarted, the same evidence the queue uses to certify a retired no-effect rejection.

### Reading the `async_admission_usage` line

While a share sweep runs (mode not `off`), the five-minute `async_admission_usage` line gains these fields at its end. With retention off the line is exactly what it was. In `_kept`, `_skipped` and `_errors` a `-` means none; in the `_pass_` fields it means no pass has completed yet.

| Field | Meaning |
| --- | --- |
| `share_retention` | The mode, `report` or `delete` |
| `share_retention_ticks` | Ticks that ran to the end since the daemon started |
| `share_retention_deleted` | Jobs removed since the start, by class: `cancelled`, `retired_no_effect`, `succeeded` |
| `share_retention_kept` | Judgments that kept a job, by reason (`failed_retained`, `too_recent`, `pending_admission`, ...). Cumulative; only non-zero reasons are listed |
| `share_retention_skipped` | Ticks that did nothing, by reason (`clock_jump`, `clock_backwards`, `clock_invalid`, `overlap`) |
| `share_retention_errors` | Failures by phase (`scan`, `verify`, `delete`), and `tick` for a batch that threw |
| `share_retention_pass_scanned`, `_pass_would_delete`, `_pass_deleted` | A gauge of the **latest complete pass** (`-` until one completes). In `report` mode `_pass_would_delete`, by class, is the figure delete-gate item 1 subtracts |

Every removal in `delete` mode also writes one `async_promote_retention action=deleted` line per hold, with each job's id, class, `updatedAt` and age and no payload.
