# The `async_admission_usage` and `resource_usage` lines: field reference

This is the full field reference for two logfmt lines the daemon writes every
five minutes, and once at start. It is kept in the repository and is not
published. The operator guide,
[Monitor Store and Queue Pressure](../../../docs/use-dkg/backpressure-observability.md),
maps each question to the fields that answer it and links here for the detail.

- `async_admission_usage` shows whether the slow part of async share and async
  publish is admission, the store or the workers
  (`packages/cli/src/daemon/async-admission-usage-log.ts`).
- `resource_usage` shows the daemon's memory and the store and sync slots in use
  (`packages/cli/src/daemon/resource-usage-log.ts`).

OpenTelemetry export is opt-in and the store scheduler's timeout warning is
rate-limited. `async_admission_usage` is neither, and it is logged when the node
is idle, so it is the primary signal.

## Reading the line

```text
async_admission_usage interval_s=300 store_rejections=store/background/publisher.asyncLift/queue_full:3 store_max_wait_ms=store/ack:80,store/background:812,store/health:0,store/normal:120 store_wait_n=store/ack:40,store/background:10,store/health:0,store/normal:1 store_wait_p95_ms=store/ack:4,store/background:869,store/health:0,store/normal:129 store_wait_buckets=store/ack:4x38|80x2,store/background:31x9|869x1,store/health:-,store/normal:129x1 http=publish_async/enqueue/202/-:41,publish_async/snapshot_preflight/503/STORE_SCHEDULER_BUSY:2,share_async/enqueue/200/-:120 http_share_n=120 http_share_p50_ms=40 http_share_p95_ms=211 http_share_max_ms=900 ...
```

- **Counters are cumulative since the process started** and reset on restart.
  Subtract two lines to get a rate; divide two counters to get a ratio (for
  example share `503`s over share requests).
- **Latency, wait and pick-up figures cover the five minutes before the line**,
  each with its sample count (`*_n`). An empty window prints `-` for its
  percentiles. A cumulative P95 over days would hide a regression, so the
  windows are not cumulative; the OpenTelemetry histograms give the cumulative
  view.
- **Depths and gauges are read when the line is built.**
- Lists are `a/b/c:n,...`, sorted by key, with `-` when empty. Millisecond values
  are whole milliseconds.

## Fields

| Field | Kind | Meaning |
| --- | --- | --- |
| `interval_s` | seconds | Time since the previous line (`0` for the first) |
| `store_rejections=<scheduler>/<lane>/<family>/<reason>:<n>` | cumulative | Store scheduler rejections by the lane, the operation family (the first two segments of the caller's `source`, such as `publisher.asyncLift`) and the reason (`queue_full`, `queue_wait_timeout`), for every registered scheduler. The store control path's schedulers appear as `store-control-share/control/...` and `store-control-publisher/control/...` while the path is on |
| `store_max_wait_ms=<scheduler>/<lane>:<ms>` | window | The longest queue wait that ended in the interval, per lane; `0` for a lane with none |
| `store_wait_n=<scheduler>/<lane>:<n>` | window | How many queue waits ended in the interval, per lane. Every started operation counts, including one that starts at once, as a wait of about 0 ms; so do operations that timed out in the queue or were cancelled there. A rejection on a full queue never queued and is not counted. It is the sample count behind `store_wait_p95_ms`; on a quiet lane most of it is those instant starts, so read a P95 of a handful of waits with care |
| `store_wait_p95_ms=<scheduler>/<lane>:<ms>` | window | The 95th-percentile queue wait that ended in the interval, per lane, over the same waits as `store_wait_n` (instant starts included), as a **bucket upper bound** (see below); `0` for a lane with none. `store/ack` is the **storage-ACK queue-wait P95**; watch it after the control path is switched on |
| `store_wait_buckets=<scheduler>/<lane>:<bound>x<n>\|<bound>x<n>...` | window | The wait counts behind the P95: for each bucket that holds a wait, its upper bound in ms and the count, ascending; `infx<n>` for waits past 10000 ms; `-` for a lane with none. Counts of several lines add up, so they give the P95 of a longer window (see below) |
| `http=<route>/<phase>/<status>/<code>:<n>` | cumulative | Admission requests by route (`share_async`, `publish_async`), answering phase, HTTP status and error code (`-` for none). Every outcome is counted, 2xx included, so rates have a denominator. Status `0` is a client that left before any answer (`client_closed`). After 64 distinct series, a new code counts as `other` for its route, phase and status, so the list can exceed 64 entries (bounded) |
| `http_share_*`, `http_publish_*` (`_n`, `_p50_ms`, `_p95_ms`, `_max_ms`) | window | Admission latency per route, request start to response, every outcome |
| `share_depth=<state>:<n>` | gauge | Share jobs per state (`queued`, `running`, `failed_retrying`, `succeeded`, `failed`); `-` if unreadable |
| `lift_depth=<state>:<n>` | gauge | Publisher jobs per state; `accepted` is the accepted-but-unclaimed backlog; `-` if unreadable |
| `lift_journal` | gauge | Entries in the append-only publisher admission journal |
| `depth_errors` | cumulative | Depth reads that failed or timed out (15 s), plus lines whose read was skipped because an earlier read was still running; every `-` in the depth fields adds at least one |
| `share_reclaimed`, `share_abandoned` | cumulative | Expired share leases the sweep requeued, and ones it gave up on (the job failed for inspection). Share lease expiries are `share_reclaimed + share_abandoned` |
| `lift_reclaimed` | cumulative | Publisher jobs reset to accepted by recovery, for any recovery reason (not only an expired lease), so it is not the publisher's lease-expiry count |
| `lift_stale_claims` | cumulative | Publisher workers that found their claim no longer matched |
| `share_hb_n`, `_p95_ms`, `_p99_ms`, `_max_ms` | window | Share lease renewals: from the timer's call until `heartbeat` settles, so a renewal waiting behind the queue's mutex counts as late |
| `share_hb_pending`, `share_hb_oldest_pending_ms` | gauge | Renewals still waiting at line time, and the age of the oldest; a renewal stuck behind the mutex is invisible until it settles otherwise |
| `share_claim_n`, `_p50_ms`, `_p95_ms`, `_max_ms` | window | Share `claimNext` duration, mutex wait and idle polls included |
| `share_attempted`, `share_succeeded`, `share_failed_terminal`, `share_failed_retrying` | cumulative | The share worker's own counters (since the worker started); `-` while no worker runs |
| `lift_wallets` | gauge | Wallets that run publisher workers |
| `lift_pickup_n`, `_p50_ms`, `_p95_ms` | window | Publisher pick-up: ready to claimed, every job |
| `lift_pickup_free_n`, `_p50_ms`, `_p95_ms` | window | The same, only for jobs that became ready while a configured wallet held no lock (worker-free pick-up) |
| `lift_pickup_unclassified` | cumulative | Jobs whose wallet state at ready time could not be determined, and which are left out of the worker-free sample |
| `lift_c2f_n`, `_p50_ms`, `_p95_ms` | window | Claim-to-finish: claimed to finalized |
| `lift_finalized`, `lift_failed` | cumulative | Publisher jobs that reached a terminal state through a worker; with the share counters these give completions per minute |
| `preflight_flights` | cumulative | Write preflight probes started for a request that could share one: the probes the store was actually asked for. The second pass of a write that waited for its graph starts one too |
| `preflight_joins` | cumulative | Requests that joined a probe already in flight instead of starting one |
| `preflight_cache_hits`, `preflight_cache_stores` | cumulative | Requests served from the fast-accept result cache, and probes kept in it (one probe shared by several requests is kept once). Both stay `0` while the cache is off, which is the default |
| `preflight_direct` | cumulative | Requests probed outright: sharing is switched off, or the agent gives no identity to share by (including the unresolved-write window after a policy write ended with an unknown outcome: two minutes by default, the rest of the process when `DKG_WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_MS=0`; see [write-preflight-coalescing.md](write-preflight-coalescing.md)) |
| `share_retention*`, `lift_retention*` | cumulative, gauge | Only while finished-job cleanup runs for that queue; see [Cleanup fields](#cleanup-fields) |

## Write preflight sharing

Every share and publish request probes its target context graph before it is
admitted. Concurrent requests for the same graph and the same caller can share
one probe, and the `preflight_*` counters say how often they did. Each request is
counted once, as a start, a join, a cache hit or a direct probe, so between two
lines:

```text
join rate = Δpreflight_joins / (Δpreflight_flights + Δpreflight_joins + Δpreflight_cache_hits + Δpreflight_direct)
```

is the share of requests that did not read the store themselves. A low rate
under load means the requests rarely overlap on one graph and caller, or that
writes to the policy graphs and subscription changes keep ending the probes in
flight. The counters start at zero when the daemon starts.

## Cleanup fields

Finished-job cleanup (`queueRetention.share.mode` and
`queueRetention.publisher.mode`, see
[Async Queue Operations](../../../docs/use-dkg/async-queue-operations.md#clean-up-finished-jobs))
appends these fields at the end of the line while a sweep runs (mode `report` or
`delete`). With cleanup off the line has none of them. The share sweep uses the
prefix `share_retention`; the publisher sweep uses `lift_retention`, after the
share fields. In `_kept`, `_skipped` and `_errors` a `-` means none; in the
`_pass_` fields it means no pass has completed yet.

| Field (share prefix shown) | Meaning |
| --- | --- |
| `share_retention` | The mode, `report` or `delete` |
| `share_retention_ticks` | Ticks since the sweep started (after the API is listening), each counted when it ends, whatever it did. Skipped ticks (`_skipped`) and failed ones (`_errors`) are counted too: subtract both for the ticks that ran a batch to the end |
| `share_retention_deleted` | Jobs removed since the start, by class |
| `share_retention_kept` | Judgments that kept a job, by reason. Cumulative, so a job kept by one pass is counted again by the next; only non-zero reasons are listed |
| `share_retention_skipped` | Ticks that did nothing, by reason (`clock_jump`, `clock_backwards`, `clock_invalid`, `overlap`) |
| `share_retention_errors` | Failures by phase (`scan`, `verify`, `delete`), and `tick` for a batch that threw |
| `share_retention_pass_scanned`, `_pass_would_delete`, `_pass_deleted` | A gauge of the **latest complete pass** (`-` until one completes). In `report` mode `_pass_would_delete`, by class, is the count that "Before you switch to delete" asks you to check |

The classes and reasons:

| Queue | Classes | `_kept` reasons |
| --- | --- | --- |
| Share (`share_retention`) | `succeeded`, `cancelled`, `retired_no_effect` | `unreadable`, `index_mismatch`, `unknown_state`, `newer_format`, `not_terminal`, `unfinished_bound_obligation`, `failed_retained`, `post_commit_recoverable`, `pending_admission`, `too_recent`, `future_dated`, `vanished` |
| Publisher (`lift_retention`) | `finalized` | `unreadable`, `unknown_state`, `index_mismatch`, `not_terminal`, `bound_obligation`, `too_recent`, `future_dated`, `older_sibling_kept`, `older_sibling_pending`, `siblings_unreadable`, `siblings_too_many`, `binding_would_change`, `vanished` |

A growing `older_sibling_kept` count means older failed publish jobs of the same
Knowledge Asset hold newer finalized ones back; clear them with
`dkg publisher clear failed`. It keeps held jobs, which may have sent a
transaction (see Held jobs in `docs/use-dkg/async-publisher-wallets.md`).

Each sweep also writes its own lines, apart from the usage line:

| Line | When |
| --- | --- |
| `async_promote_retention_pass`, `async_lift_retention_pass` | Once per completed pass, in `report` and `delete` alike: mode, scanned, and `wouldDelete`, `deleted` and `kept` by class or reason |
| `async_promote_retention skipped=<reason>`, `async_lift_retention skipped=<reason>` | A warning for every tick the clock guard skips (`clock_jump`, `clock_backwards`, `clock_invalid`). An `overlap` skip is only counted |
| `async_promote_retention action=deleted`, `async_lift_retention action=deleted` | In `delete` mode, one line per hold, with each job's id, class, finish time and age, and no payload |

The publisher journal is never touched, so `lift_journal` does not shrink when
jobs are removed.

## Queue-wait P95 is a bucket upper bound

The scheduler does not keep every wait; it counts them in fixed buckets and the
line reports the P95 from those counts. A lane's `store_wait_p95_ms` is the upper
bound of the bucket that holds the 95th-percentile wait (rank `ceil(0.95 * n)` of
the interval's `n` waits). The inclusive upper bounds are these 83 values in
milliseconds, plus an overflow bucket for anything longer. They grow by about
10 % per step (`round(1.1 ** k)`, duplicates dropped, then 10000, the default
queue-wait timeout):

```text
1 2 3 4 5 6 7 8 9 10 11 12 13 14 16 17 19 21 23 26 28 31 34 37 41 45 50 55 60 66 73 80
88 97 107 117 129 142 156 172 189 208 229 252 277 304 335 368 405 446 490 539 593 653
718 790 869 956 1051 1156 1272 1399 1539 1693 1862 2048 2253 2479 2726 2999 3299 3629
3992 4391 4830 5313 5844 6429 7072 7779 8557 9412 10000
```

The list does not change between builds, so a figure from one build compares
with a figure from another.

- The true P95 is **at most** the printed value and up to one step lower. From
  7 ms up a step is at most 15 %, so a printed value is within 15 % above the
  truth, and two printed values can be held to a margin such as "not worse than
  25 %" with that much slack. Below 7 ms the steps are whole milliseconds, so a
  relative margin on a P95 of a few milliseconds is a difference of a millisecond
  or two, within clock noise; pair it with an absolute floor.
- A lane whose waits all took 3 ms prints `3`, and a lane with one 120 ms wait
  prints `129`, which is above its `store_max_wait_ms` of `120`. Do not read a
  printed value as "exactly that many ms". A threshold between two bounds
  behaves like the bound above it, so set P95 thresholds on a bound.
- **Work that starts at once counts**, as a wait of about 0 ms, as it does in the
  `dkg.storage_ack.queue_wait_ms` OpenTelemetry histogram. On a quiet ACK lane
  most of `store_wait_n` is such instant starts, and the P95 then prints `1`, the
  first bound. The P95 is over all operations that ended a wait, not only over
  the ones that actually queued.
- Past `10000` ms the rank falls in the overflow bucket and the value is that
  lane's longest wait of the interval, the same figure as `store_max_wait_ms`. The
  default queue-wait timeout is also 10 s, so a wait that times out in the queue
  ends here or in the last bucket.
- An interval with no waits prints `0` for the P95 and for `store_wait_n`, and `-`
  for `store_wait_buckets`.
- Like `store_max_wait_ms`, these fields cover the five minutes before the line
  and start over after each one. The max stays on the line because it shows the
  one slow wait that a P95 hides.

**The P95 of a longer window** (a 30-minute test, a 7-day monitoring window)
comes from the counts, not from the lines' P95s. P95s of different intervals
cannot be averaged, and the largest of them is not the window's P95 either. For
one lane, over the lines whose interval lies inside the window:

1. Add the counts of each bound over the lines (`store_wait_buckets`). Let `n` be
   the sum of all counts.
2. Walk the bounds upward, adding their counts, until the running total reaches
   `ceil(0.95 * n)`. That bound is the window's P95.
3. If the walk ends in `inf`, the P95 is the largest `store_max_wait_ms` of that
   lane over the lines.

`estimateQueueWaitPercentileMs` in `@origintrail-official/dkg-storage` does steps 2
and 3 on the summed counts. The first line after a restart has `interval_s=0` and
covers the time since the process started; leave it out when the window should
not include start-up.

For example, three lines of `store/ack` with `store_wait_p95_ms` of `1`, `718` and
`41` and these counts:

```text
store/ack:1x400
store/ack:1x70|718x30
store/ack:1x90|41x10
```

add up to `1x560|41x10|718x30`: `n` is 600, the rank is 570, and the running
total passes it at the bound `41`. The window's P95 is `41`, which is neither the
mean (253) nor the largest (718) of the three printed P95s.

## Admission phases

The phase in `http=` is the step that answered the request, so a rejection can be
pinned on one pre-queue read:

| Phase | Covers |
| --- | --- |
| `request` | Everything before the first read: rate limiting, in-flight load shedding, authentication, body and option validation, the worker or publisher availability `503`, and, on the share route, the storage-lane read for a node-level token that names an author |
| `write_preflight` | The context-graph write preflight and its readiness wait (both routes) |
| `intent_resolution` | The publish route's finalized-assertion intent resolution reads |
| `snapshot_preflight` | The publish route's workspace snapshot reads |
| `enqueue` | The enqueue itself, and every 2xx answer |

## Pick-up definitions

- **Ready** is the latest of `acceptedAt`, `lastRetriedAt` and `lastRecoveredAt`,
  so a job that was retried or recovered is measured from that moment.
- **Worker-free** counts a job only if, when it became ready, at least one of the
  configured wallets held no wallet lock (each wallet runs one publisher worker).
  Busy intervals come from wallet-lock writes and deletes, not job finish times.
  Slow pick-up while every wallet is busy is worker capacity, not queue admission,
  and stays out of this figure.
- **Unclassified** jobs became ready before the node had seen the lock state of
  enough wallets to say (for example right after a restart, when locks written
  before the restart are only learned at the first claim attempt). They are counted
  in `lift_pickup_unclassified` and never in the worker-free sample.
- **Claim-to-finish** is sampled on the worker's normal transition to `finalized`.
  `lift_finalized` and `lift_failed` count terminal transitions made through that
  same path; a failed job has no claim-to-finish sample, and a job finalized or
  failed by recovery or chain-proof resolution is not counted at all.

## Trace switches

Two opt-in traces add detail for one investigation. Both are off by default; set
the variable in the daemon's environment and restart.

| Variable | Log line | What it records |
| --- | --- | --- |
| `DKG_ASYNC_PROMOTE_ADMISSION_TRACE=1` | `async_promote_admission {...}` | Share admission phases: event kind (`phase_settled` or `deadline`), phase, elapsed ms and outcome. No names, IDs or payloads |
| `DKG_ASYNC_PUBLISH_TRACE=1` | `async_publish_claim_trace {...}` | Publisher claim-lock wait and hold, wallet-ownership decisions, lock changes and worker outcomes. Wallets are hashed; job IDs are kept |

## OpenTelemetry

When metrics export is enabled, each recorder also feeds an instrument:

| Instrument | Type | Attributes |
| --- | --- | --- |
| `dkg.async_admission.outcomes_total` | counter | `route`, `phase`, `status`, `code` |
| `dkg.async_admission.latency_ms` | histogram | `route` |
| `dkg.async_queue.lease_recoveries_total` | counter | `queue` (`share`, `lift`), `outcome` (`reclaimed`, `abandoned`) |
| `dkg.async_queue.stale_claims_total` | counter | `queue` |
| `dkg.async_queue.heartbeat_lateness_ms` | histogram | none |
| `dkg.async_share.claim_next_ms` | histogram | none |
| `dkg.async_lift.pickup_ms` | histogram | `worker_free` (`true`, `false`, `unknown`) |
| `dkg.async_lift.claim_to_finish_ms` | histogram | none |
| `dkg.async_queue.depth` | gauge | `queue`, `state` |
| `dkg.async_queue.journal_entries` | gauge | none |
| `dkg.async_lift.configured_wallets` | gauge | none |

The store scheduler's `dkg.store.scheduler_rejections_total` carries the same
`operation_family` as `store_rejections`.

## Monitoring reads

The depth reads are `COUNT ... GROUP BY` queries on the store's background lane
under their own sources (`publisher.queueUsage.share`, `.lift`, `.liftJournal`),
apart from the queues' own sources, so a monitoring read the scheduler refuses
does not inflate the queue-source rejection counts it is there to measure. They
take neither the share mutex nor the publisher claim lock.

## The `resource_usage` line

Every five minutes, and once at start, the daemon also logs `resource_usage`
(logfmt, logger `resources`):

```text
resource_usage rss_mb=1806 heap_used_mb=812 heap_limit_mb=4144 external_mb=95 store_ack=0/4 store_ack_queued=0 store_health=0/3 store_health_queued=0 store_normal=1/2 store_normal_queued=3 store_normal_active=agent.query.select:0.4s store_background=1/1 store_background_queued=12 store_background_active=agent.durableSync.graphScopedMaterialization:9.8s store_control_publisher=1/2 store_control_publisher_queued=0 store_control_publisher_active=publisher.asyncLift.claim:0.2s store_control_share=0/1 store_control_share_queued=0 sync=3/3 sync_queued=0/16 sync_active=durable:vm-recovery:62.0s,durable:control-plane*2:0.3s
```

| Field | Meaning |
| --- | --- |
| `rss_mb`, `heap_used_mb`, `heap_limit_mb`, `external_mb` | The process's resident memory, V8 heap in use, V8 heap limit and external memory, in MiB |
| `store_<lane>=<running>/<ceiling>` | For each lane of the shared store scheduler (`ack`, `health`, `normal`, `background`, in that order): operations running against the lane's ceiling. The value is the running count alone when the lane has no ceiling |
| `store_<lane>_queued` | Operations waiting for that lane |
| `store_<lane>_active=<operation>[*n]:<age>s,...` | Each operation holding a slot, with `*n` when n of it run, and the age of its oldest run; oldest first, at most 8. Left out when nothing runs |
| `store_control_share`, `store_control_publisher` (with `_queued` and `_active`) | The same three fields for each store control path scheduler (one lane; the ceiling is that queue's slots, on top of the shared scheduler's). **Left out while that queue's control path is off** |
| `sync=<running>/<ceiling>`, `sync_queued=<queued>/<limit>`, `sync_active=...` | The process-wide sync admission queue. The figures count its reserved slots too |
