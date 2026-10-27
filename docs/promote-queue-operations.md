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

The promote queue keeps its jobs in the node's triple store and never removes a finished one by itself: a job leaves only when someone clears it (`POST .../share-jobs/:jobId/clear`). A node that shares continuously therefore grows the share control graph without bound, and every read that walks the whole graph grows with it (the retained-share reconciliation answers `incomplete_inventory` above 1,000 retained rows, see [share-reconciliation.md](api/share-reconciliation.md)). Retention is an opt-in sweep that removes the finished jobs the policy below allows. **It is off by default, and nothing in this section changes a node that does not set it.** This part of the page describes the share queue; the publisher queue (`dkg publisher`, `/api/publisher/...`) has its own sweep with its own rules, described under [Retention of finished publisher jobs](#retention-of-finished-publisher-jobs). Both are set in the one `queueRetention` section below and run on one timer in the daemon.

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
| `succeededMaxAgeMs` | 7 days | share only. At least 24 hours (86,400,000) |
| `benignFailedMaxAgeMs` | 7 days | share only. At least 24 hours, or `null` to keep the two harmless failed classes (the cancelled class and the retired no-effect rejection) as well |
| `finalizedMaxAgeMs` | 7 days | publisher only. At least 24 hours (86,400,000) |
| `rescanIntervalMs` | 3,600,000 | 60,000 to 7 days. How often a finished pass starts again from the oldest row |

`mode`, `intervalMs`, `batchSize` and `rescanIntervalMs` exist in both sections with the same defaults and limits.

- **`off`** creates nothing and makes no store call.
- **`report`** judges and counts what `delete` would remove and removes nothing. On the publisher queue it can count fewer when two jobs of one key finished in the same millisecond, never more (see "Limits of the publisher sweep" and [#3554](https://github.com/OriginTrail/dkg/issues/3554)). It writes one summary line per completed pass, not one per job.
- **`delete`** removes the jobs the policy allows once they are past their window. **Deletes cannot be undone.**

A value that is wrong, or a key that is not recognised (`queueRetention.share.mod`), stops `dkg start` and the daemon with a message that names the key; there is no silent fallback to a default. Changes need a restart. Each queue has its own section and its own mode, and a mode on one queue never starts the other: `queueRetention.publisher.mode` runs the publisher sweep and nothing for the share queue, and the other way round. A node that wrote a `queueRetention.publisher.mode` before a build had the publisher sweep (such a build validated it and ignored it) runs that sweep from the first start on a build that has it, so check the setting before an upgrade, and on a node that has it set to `delete` take the delete gate's export and sign-off (items 3 and 4) first.

A tick judges at most `batchSize` rows, so a large backlog drains at about `batchSize` per `intervalMs` (100 per minute by default); raise `batchSize` (at most 1,000) or lower `intervalMs` to drain faster. Each tick works in small holds of the queue's mutation lock (at most 10 jobs, 50 ms) so admissions, claims and heartbeats interleave.

### When it may be turned on

- **No live node runs `report` until the G2 retention step has passed** (OT-RFC-73 D-17: the step run on the first build that contains the share and publisher retention, on a backed-up, seeded local node). The step gates turning retention on at all; it does not gate the release that ships the code.
- **`delete` runs only through the delete gate**, and every item must hold:
  1. `report` has run for at least 14 days on at least one live node, and throughout, the share jobs the 7-day window would keep stay below the 1,000-row bound of the share reconciliation query. The estimate is an upper bound: the share jobs admitted in any trailing 7 days (the accepted `share_async` submissions in the `http=` counters) plus the failed share jobs the policy keeps (the `failed` count of `share_depth`, minus the `cancelled` and `retired_no_effect` figures of `share_retention_pass_would_delete`). If it would not stay below the bound, the window is shortened or the bound revisited before any delete runs.
  2. The would-delete set has been independently reviewed against the policy below and shows an empty diff against the offline oracle.
  3. A CONSTRUCT export of both control graphs was taken immediately before the first delete run.
  4. The named retention owner signed off immediately before the first delete run, having read the two limits of the cancelled class under "Limits to know about" (recovering and then cancelling a job erases its history; "proven unstarted" covers only `promoteStarted` and `swmInserted`).
- Starting a node in `delete` mode logs a warning saying so. Never turn `delete` on to "see what happens": use `report`.
- The gate is per queue sweep. A node that turns the **publisher** sweep to `delete` passes the same four items for it, read for that queue: 14 days of `report` (the 1,000-row bound of item 1 belongs to the share reconciliation query and does not apply to the publisher queue), a would-delete set reviewed against the publisher policy and the sibling rule below, with an empty diff against the offline oracle, an export of the publisher control graph (`urn:dkg:publisher:control-plane`) as well as the share one, and a sign-off by the retention owner who has read the publisher limits below, the liveness trade-off first.

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

No other runtime reads `queueRetention`: a standalone agent or library use, a worker or runner process, the offline CLI inspector and scripts ignore the setting, and none of them starts a sweep. The starter itself (`startRetention`) refuses, with an error, any caller but the daemon's admission instance when a mode is not `off`, and a test pins that only the daemon calls it. The cores (`createShareRetention` and `createPublisherRetention`, exported from `@origintrail-official/dkg-publisher`) have no such check, so code that calls them directly is bound by the next limit without being stopped. The reason is that limit. The publisher sweep's own wiring is described under "Where the publisher sweep runs" below.

### Limits to know about

- **Exclusion between verifying a job and deleting it is only the daemon's in-process queue lock.** A second process that writes the share control graph while a daemon runs (another daemon on the same store, the offline CLI inspector, a script or any tool that opens the store directly) is not excluded and could revive a job between the two steps. Do not write the share control graph from anything but the daemon while retention is on.
- **No clock baseline on the first tick after a start.** The sweep guards against a wall clock that stepped, but it can only compare a tick with an earlier one. Start a node with retention on once the host clock is synchronized (NTP).
- **After a real forward clock step the sweep stays skipped until the daemon restarts.** A clock that jumps ahead of the monotonic clock by more than three intervals is counted as `clock_jump`, logged as a warning, and every later tick is skipped too, because nothing proves the clock came back. The rows simply stay. A clock stepped backwards resumes once it has caught up. The tolerance is three times `intervalMs` and the comparison is strict, so at the smallest allowed `intervalMs` (1,000 ms) a step of more than 3 seconds switches retention off until the restart, and at the default (60,000 ms) a step of more than 3 minutes does. A host or VM suspend counts as a forward step, because the monotonic clock does not advance while the host sleeps (on most hosts): a laptop or VM that sleeps for longer than the tolerance and wakes stays skipped until the daemon restarts. The core logs one warning for every skipped tick (about 1,440 lines a day at the default interval) until then. A restart takes the clock as it then is as the new baseline. If the clock is still wrong and ahead, `delete` mode would remove jobs younger than the window. **Check the host clock before restarting a node that logged `clock_jump`.**
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
| `share_retention_ticks` | Ticks since the sweep started (after the API is listening), each counted when it ends, whatever it did. Skipped ticks (`_skipped`) and failed ones (`_errors`) are counted too: subtract both for the ticks that ran a batch to the end |
| `share_retention_deleted` | Jobs removed since the start, by class: `cancelled`, `retired_no_effect`, `succeeded` |
| `share_retention_kept` | Judgments that kept a job, by reason (`failed_retained`, `too_recent`, `pending_admission`, ...). Cumulative; only non-zero reasons are listed |
| `share_retention_skipped` | Ticks that did nothing, by reason (`clock_jump`, `clock_backwards`, `clock_invalid`, `overlap`) |
| `share_retention_errors` | Failures by phase (`scan`, `verify`, `delete`), and `tick` for a batch that threw |
| `share_retention_pass_scanned`, `_pass_would_delete`, `_pass_deleted` | A gauge of the **latest complete pass** (`-` until one completes). In `report` mode `_pass_would_delete`, by class, is the figure delete-gate item 1 subtracts |

Every removal in `delete` mode also writes one `async_promote_retention action=deleted` line per hold, with each job's id, class, `updatedAt` and age and no payload.

A running publisher sweep adds the same fields under the prefix `lift_retention`, after the share ones; see "Reading the `lift_retention` fields" under the publisher section below.

## Retention of finished publisher jobs

The publisher queue keeps its jobs in the node's triple store too (the control graph `urn:dkg:publisher:control-plane`) and never removes a finished one by itself: a job leaves only when someone clears it (`dkg publisher clear`, `POST /api/publisher/clear`, `POST /api/publisher/clear-job`). A node that publishes continuously accumulates its history, and every read that walks the whole history grows with it. The publisher sweep removes the finished jobs the policy below allows. **It is off by default** (`queueRetention.publisher.mode`; the modes, defaults and limits are the share sweep's, see "Modes and defaults" above) and changes nothing until it is set. One thing is not opt-in: the sibling guard of bulk `clear`, described next.

The publisher queue differs from the share queue in one way that shapes everything below. A publish job belongs to a **lifecycle key**, the Knowledge Asset it publishes (context graph, name, sub-graph and agent lane), and the jobs of one key are **siblings**. Whether a job still binds its Knowledge Asset (whether a re-submit re-accepts it or starts a new job) is not a property of the job alone: a failed job older than the newest job of its key is history and binds nothing. If the newest job is deleted, that older failed job becomes the newest and can bind again, and a re-submit would then re-accept an old failed job its successor had superseded. Everything that deletes finished publisher jobs in bulk therefore keeps every such binding decision as it was.

### The bulk `clear` guard (always on)

`dkg publisher clear finalized|failed` and `POST /api/publisher/clear` apply the sibling rule whatever the retention mode, and this is the one change of default behavior in this work:

- a **finalized** job is kept while an **older failed** job of its key is kept, because removing it would make that failed job the newest;
- no removal is made that would make a different, kept job bind the key (removing the binding job itself, which vacates the key, is what clearing a failed job is for);
- a key whose job records cannot be decoded is skipped (admission cannot read that key either), and the clear carries on with the others;
- each job is judged and removed under the queue's claim lock and its own job lock, oldest first, so every intermediate state keeps the key's newest job.

The count in the response is the number of jobs removed. It can be smaller than before, and a large clear takes longer because each removal now takes the claim lock as clearing one job by id does. `POST /api/publisher/clear-job` for one job is unchanged and stays the deliberate override: clearing the newest job of a key by id can make an older failed job bind it again.

### What the publisher sweep removes, and what it never removes

Removed, 7 days (`finalizedMaxAgeMs`) after the job finished (its `finalizedAt`): a **`finalized`** job. That is the only class. **Every failed job is kept until an operator clears it** (the queue has no harmless failed class), and so is every job that is not finished.

Never removed, whatever its age:

- a job that is not `finalized` (`accepted`, `claimed`, `validated`, `broadcast`, `included`, and every `failed` job);
- a job a wallet lock still names (an obligation that is still bound);
- a job whose payload is unreadable, ambiguous (several payload records), another job's, a format this build does not understand, a legacy payload written by a much older version, or without a finish time;
- a job whose stored status, finish time or lifecycle key disagrees with its payload, or whose stored finish time is not an integer (the scan reads `xsd:integer` finish times only, as the share scan does, so it never meets such a job; it is not counted, and it holds the newer jobs of its key);
- a job dated after the current time (`finalizedAt` or `updatedAt`);
- **a job with an older sibling that is kept** (the rule below).

**The sibling rule.** The jobs of a key are taken oldest first, in the order that decides which one is the newest, and the sweep deletes only an unbroken run from the oldest. An older job that is failed, not finished, too young, bound, unreadable or otherwise kept **ends the run**, and every newer job of the key stays behind it, finalized or not. The newest job itself goes when it is finalized, old enough and nothing older is kept (a finalized job binds nothing, so the key is vacant either way). The jobs are read exactly as admission reads them, inside the claim transaction that serializes admission, claims, retries and clears, and removed **one at a time, oldest first, each under its own job lock from a fresh read**. After any number of deletes, even a crash in the middle of a key, what is left of the key is a suffix of its history that still holds its newest job, so the key binds exactly what it bound before. As a last check the sweep asks the queue's own binding rule whether the run it is about to delete leaves the key's binding list unchanged, and keeps the key if it does not (`binding_would_change`; a safety net that is not expected to fire). Every decision is made again from the job's payload, under the lock, immediately before the delete. The publisher queue's journal is never touched.

### After a publisher job is removed

- `GET /api/publisher/job` for it answers `404`.
- `GET /api/publisher/job-by-intent` answers `none`, or lists one job fewer as `superseded`.
- A client that lost every reply and re-submits after the window is admitted as a new job. The window therefore has to be longer than any client's polling and replay horizon.

### Where the publisher sweep runs

Retention starts only in the **daemon's admission instance**, after the API is listening, next to the share sweep, and stops before the agent on shutdown. The publisher sweep is built after the publisher queue's admission instance (the one that serves the API and the boot backfill), from that instance's own `retentionAccess()` and over its own store object, and from nothing else: not the standalone runner's instance, not the offline inspector, not a second queue made on the side. That instance hands the sweep the queue's claim transaction and nothing more, so the sweep has no claim machinery of its own and no second way to remove a job. If the sweep cannot be built (a missing instance, or a setting the core refuses), the daemon logs an error that starts `[error] [retention] publisher retention (mode=...) was NOT started`, names the cause, and keeps running **with publisher retention off**: nothing is judged or deleted, and the share sweep is not affected.

No other runtime reads `queueRetention`, and the starter refuses any caller but the daemon's admission instance when a mode is not `off` (see "Where it runs" under the share section above). The offline inspector goes further, because it writes: **`dkg publisher cancel`, `retry` and `clear` fall back to the node's store directly when the daemon cannot be reached, and they now refuse to do that while the node home names a running daemon process.** The error names the process (`DKG_DAEMON_RUNNING`) and says what to do: try again once the daemon answers, or stop it (`dkg stop`). "Cannot be reached" is not "not running" (a daemon that is starting, stalled or restarting is as alive as before), and a second process that writes the control graph next to the daemon is not excluded by the daemon's locks. If the process named is not a DKG daemon, remove the stale `daemon.pid` file. `dkg publisher jobs`, `job` and `stats` change no queue state and still fall back. They are not free of writes, though. With the file-backed Oxigraph backends, closing the inspector's store rewrites the store file from what the inspector loaded ([#3551](https://github.com/OriginTrail/dkg/issues/3551)). Run them next to a stalled daemon only when you need to.

### Limits of the publisher sweep

- **An older job the sweep cannot get past holds every newer job of its key (the liveness trade-off).** The sibling rule is chosen so that nothing is ever deleted when in doubt, and the price is that a key can stay whole for good. A failed job does it until an operator clears it, but so does a finalized job the sweep cannot read or reach: a pre-upgrade payload, a stored index that disagrees with the payload (`index_mismatch`), a key one of whose jobs cannot be decoded at all (`siblings_unreadable`). Every job newer than it stays too, however old, and the key's history grows until the blocking job is cleared by hand (`POST /api/publisher/clear-job` with its job id, or `dkg publisher clear failed` for failed jobs that are not held and not in the recovery lane). A pass that keeps many jobs as `older_sibling_kept` or `index_mismatch` points at such keys. This costs disk and a longer history read; a wrong delete would change which job binds a Knowledge Asset.
- **Failed jobs are never swept.** A node whose failed jobs pile up has an operator task, not a retention one: inspect them, retry or clear them.
- **Exclusion between verifying a job and deleting it is only the daemon's in-process claim lock and the job locks.** A second process that writes the publisher control graph while a daemon runs (another daemon on the same store, a script or any tool that opens the store directly) is not excluded and could change a key between the judgement and the delete. The offline inspector's refusal narrows that, but it is not a lock: it reads the node home's pid file once, when the command starts, and a daemon that starts after that check, or one in another home over the same store, is not seen. Do not write the publisher control graph from anything but the daemon while retention is on.
- **A key whose jobs finished in another order than they were accepted needs a second pass.** The scan walks by finish time and the sweep deletes a key oldest first (by acceptance), so a job accepted earlier but finished later makes the younger ones wait; they are judged again when the pass starts over, within `rescanIntervalMs`. The same holds for a key whose blocking job an operator has just cleared, and for two jobs of a key that finished in the same millisecond: the scan may meet the newer one first, so it waits for the next pass. In that last case `report` can count fewer jobs than `delete` removes in its first pass ([#3554](https://github.com/OriginTrail/dkg/issues/3554)). When the scan meets the older job a slice or a batch before the newer one, `delete` has removed it by then and removes the newer one too, while `report`, which removes nothing, still finds the older job in front and keeps the newer one. When both are judged in the same hold, the newer one is kept in both modes. `report` never counts a job that `delete` would keep.
- **The clock limits of the share sweep apply unchanged**: no baseline on the first tick after a start; a real forward clock step, or a host suspend longer than three intervals, keeps the sweep skipped until the daemon restarts (counted as `clock_jump`, logged as a warning for every skipped tick); a clock stepped back resumes once it has caught up. A restart takes the clock as it then is as the new baseline, so a clock that is still ahead would let `delete` remove jobs younger than the window. Check the host clock before restarting a node that logged `clock_jump`.
- **The journal keeps growing.** It is append-only and never touched, so `lift_journal` in the usage line does not shrink when jobs are removed.
- **The `kept` counters are cumulative judgments:** a job kept by one pass is counted again by the next. Only the `lastCompletePass` figures are per pass.

### Reading the `lift_retention` fields

While a publisher sweep runs (mode not `off`) the five-minute `async_admission_usage` line gains the same fields as the share sweep's, under the prefix `lift_retention`, after the share ones. With retention off the line is exactly what it was. The one class is `finalized`; the reasons in `_kept` are `unreadable`, `unknown_state`, `index_mismatch`, `not_terminal`, `bound_obligation`, `too_recent`, `future_dated`, `older_sibling_kept`, `older_sibling_pending`, `siblings_unreadable`, `binding_would_change` and `vanished`.

| Field | Meaning |
| --- | --- |
| `lift_retention` | The mode, `report` or `delete` |
| `lift_retention_ticks` | Ticks since the sweep started (after the API is listening), each counted when it ends, whatever it did. Skipped ticks (`_skipped`) and failed ones (`_errors`) are counted too: subtract both for the ticks that ran a batch to the end |
| `lift_retention_deleted` | Jobs removed since the start: `finalized:<n>` |
| `lift_retention_kept` | Judgments that kept a job, by reason. Cumulative; only non-zero reasons are listed |
| `lift_retention_skipped` | Ticks that did nothing, by reason (`clock_jump`, `clock_backwards`, `clock_invalid`, `overlap`) |
| `lift_retention_errors` | Failures by phase (`scan`, `verify`, `delete`), and `tick` for a batch that threw |
| `lift_retention_pass_scanned`, `_pass_would_delete`, `_pass_deleted` | A gauge of the **latest complete pass** (`-` until one completes). In `report` mode `_pass_would_delete` is the figure the delete gate reads |

`report` mode writes one `async_lift_retention_pass` line per completed pass, not one per job. Every removal in `delete` mode also writes one `async_lift_retention action=deleted` line per hold, with each job's id, class, finish time and age and no payload.
