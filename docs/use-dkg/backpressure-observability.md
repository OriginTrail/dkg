---
status: current
version: v10
audience: operator+developer
doc_type: how-to
---

# Backpressure observability

DKG exposes one common pressure model for its in-memory schedulers. It answers
four questions without requiring scheduler-specific log archaeology:

1. Which scheduler and lane are under pressure?
2. Is work waiting, rejected, or admitted but possibly stuck?
3. Which bounded operation classes account for that work?
4. Did the scheduler recover?

This is an observability layer only. It does not change queue ordering,
concurrency, reservation, displacement, timeout, or retry behavior.

## Architecture

```mermaid
flowchart LR
  subgraph Producers["Work producers"]
    SWM["SWM and store callers"]
    Sync["Sync requester stages"]
  end

  subgraph Schedulers["Existing scheduling policies"]
    Store["StorePriorityScheduler<br/>ack / health / normal / background"]
    Global["PriorityAdmissionQueue<br/>global sync admission"]
  end

  subgraph Core["Shared core observability"]
    Lifecycle["ObservableScheduler lifecycle<br/>enqueue / start / reject / finish"]
    Tracker["SchedulerPressureTracker<br/>ages, counts, bounded operation summaries"]
    Registry["BackpressureRegistry"]
    Monitor["BackpressureMonitor<br/>5 s samples, transition and recovery logs"]
    OTel["OpenTelemetry metrics"]
  end

  Status["Public /api/status<br/>state only"]
  Admin["Node-admin<br/>/api/diagnostics/backpressure"]
  Logs["Daemon log"]

  SWM --> Store
  Sync --> Global
  Store --> Lifecycle
  Global --> Lifecycle
  Lifecycle --> Tracker
  Tracker --> OTel
  Tracker --> Registry
  Registry --> Monitor
  Monitor --> OTel
  Monitor --> Logs
  Registry --> Status
  Registry --> Admin
```

The tracker records references to bounded labels and timestamps, not work
closures or payloads. A snapshot can contain a maximum of eight queued and
eight active operation summaries per lane. Labels are sanitized and truncated
before they reach metrics, logs, or the diagnostics response.

The first registered sources are:

- `store`: the external-store priority scheduler and its `ack`, `health`,
  `normal`, and `background` lanes;
- `sync-global`: the process-wide sync admission queue and its sync lanes.

The two divide capacity differently, and every lane row names the model it is
reported under in its `capacityModel` field:

| `capacityModel` | Meaning | Source |
| --- | --- | --- |
| `partitioned` | The lane holds a private queue allocation and fills independently of its neighbours. Nothing validates the scheduler-level limit against the lane allocations — a scheduler may publish their sum (`store` does), or cap its total lower — so read a lane's own limit for lane pressure and the scheduler's for the rollup, and derive neither from the other. | `store` |
| `shared` | Every lane draws on one queue and one concurrency pool. The lane's `queueLimit`/`inflightLimit` **are** that pool's ceilings — the same number on every lane, never to be summed. | `sync-global` |

Three counts sit on every lane row beside the two ceilings, and they differ only under `shared`:

| Field | Meaning |
| --- | --- |
| `queued` | This lane's own backlog — *who* is waiting. The attribution signal. |
| `pressureQueued` | The depth the lane's `state` was classified against, and the numerator that belongs with `queueLimit`. Equal to `queued` for a `partitioned` lane, and the whole pool's depth for a `shared` lane **that has work waiting against a ceiling**. Where no depth applies to a shared lane — an empty backlog, or a pool with no `queueLimit` — nothing was classified on depth and the lane reports its own `queued`, so it never reads as utilized. |
| `pressureInflight` | The count that belongs with `inflightLimit`: this lane's own under a `partitioned` allocation, and on a `shared` row the pool's occupancy, **always** — it has none of `pressureQueued`'s fallbacks, because no state is ever classified on concurrency, so a shared row's ratio is a pool ratio by construction and cannot contradict the row's own state. |

So compute utilization from **`pressureQueued / queueLimit`**, never from `queued`, and no consumer has
to special-case the model. All three are optional on the type, so a scheduler written against an older
`dkg-core` still satisfies it: absent `capacityModel` means `partitioned`, absent `pressureQueued` means
`queued`, and absent `pressureInflight` means `inflight`.

### Attributing `sync-global` pressure to a trigger

The `lane` of a `sync-global` entry says *what kind of work* is queued
(`durable`, `changelog`, `shared_memory`, `swm_recovery`), but every trigger
funnels into the same few lanes. Its `operation` label therefore pairs the
collapsed work class with the **admission source** — the trigger that enqueued
it — as `<work class>:<source>`:

| Source | Trigger |
| --- | --- |
| `catchup-foreground` | explicit Context Graph catch-up (`POST /api/context-graph/subscribe`) |
| `catchup-background` | automatic post-approval / reconcile catch-up |
| `on-connect` | sync-on-connect after a peer dial |
| `reconcile` | the periodic sync reconciler |
| `vm-recovery` | foreground repair of specific missing Knowledge Assets |
| `swm-recovery` | curator-targeted shared-memory recovery |
| `unspecified` | a caller that did not declare an origin |

### Tuning foreground catch-up

Two knobs govern the foreground Context Graph catch-up that most often shows up
as `catchup-foreground` pressure. Both are read once at daemon start.

| Variable | Default | Effect |
| --- | --- | --- |
| `DKG_CATCHUP_STOP_ON_PROOF` | on | The catch-up walks peers in escalating waves and stops once the resolved curator has settled every requested plane. Set to `0`, `false`, `no`, or `off` to restore the previous behaviour: every sync-capable peer, both requested planes, no early stop. Use this if a graph ever lands short — foreground catch-up optimises for one authoritative payload, while breadth remains the background reconcile lane's job. |
| `DKG_CATCHUP_BACKPRESSURE_MAX_WAIT_MS` | `180000` | Wall-clock budget one foreground plane may spend being **refused** by local `sync-global` admission before the job reports a retryable `deferred`. Measured from before the first attempt, so an attempt's own queue time counts against it. It does not cancel a round the scheduler has already accepted — that one is doing real work and is bounded by `SYNC_TOTAL_TIMEOUT_MS`. The default sits above both a full head-of-line round (120 s) and the queue waits that motivated it. An explicit `0` disables retries; a blank value is treated as unset. |
| `DKG_CATCHUP_MAX_CONCURRENT_PEERS` | `4` | Caps in-flight per-peer sync rounds, and therefore the widest escalation wave. Raising it above the `sync-global` queue depth lets a single catch-up saturate the scheduler against itself. |

So `{"operation":"durable:catchup-foreground","count":4,"oldestAgeMs":109000}`
in a `queuedOperations` summary reads as "four explicit catch-up durable
admissions are queued, the oldest for 109 seconds", and the matching
`activeOperations` entry gives the same view for admitted work. Both halves are
closed sets, so the label space stays bounded (5 × 8) and, as before, no Context
Graph id or peer id ever reaches a metric, log line, or diagnostics response —
an unrecognized source is clamped to `unspecified`.

The sync **responder** limiter is a separate queue and is not instrumented, so
its `pre_authorization` and `responder` lanes appear in no snapshot, metric, or
log line. `sync-global` covers requester-side admission only.

Other schedulers can extend `ObservableScheduler` and call its protected
lifecycle methods at their existing admission boundaries. They keep complete
ownership of policy, and declare how their lanes divide capacity through
`capacityModel` — a scheduler that declares nothing is `partitioned`, and a lane
of a partitioned scheduler that publishes no limit of its own is simply not
classified on depth.

## Pressure states

| State | Meaning |
| --- | --- |
| `healthy` | No age, utilization, rejection, or active-duration threshold is crossed. |
| `degraded` | A queue is old or at least 75% utilized, but is not full. |
| `saturated` | A queue is full or an admission rejection occurred in the recent visibility window. |
| `stalled` | The oldest admitted operation crossed the scheduler's active-duration threshold. |

State precedence is `stalled` > `saturated` > `degraded` > `healthy`. A recent
rejection remains visible for 60 seconds so a short full-queue event is not
missed between monitor samples.

"A queue is full" means the queue that lane's work is actually waiting behind.
For a `partitioned` lane that is its own allocation. For a `shared` lane it is
the pool, so **every lane holding queued work reports the pool's pressure** —
one lane at 1 of a full pool of 4 is `saturated`, because the next admission in
that lane is the one that gets rejected. A lane with nothing queued stays
`healthy` however full the pool is: it is not being held back, and per-lane
`queued` and `queuedOperations` remain the attribution signal for who is. A log
line whose `pressureQueued` differs from its `queued` carries both for this
reason, and because the scheduler's own `lane: "all"` line is emitted only while
the rollup outranks every lane — which, on an all-shared scheduler, it never
does.

These states describe evidence, not root cause. For example, a stalled store
operation can be caused by Blazegraph, Oxigraph, disk, or a caller that never
settles. Use the operation summary and surrounding store logs to continue the
investigation.

## Read current pressure

`GET /api/status` is public and includes only the aggregate state:

```json
{
  "backpressure": {
    "state": "degraded",
    "schedulers": [
      { "scheduler": "store", "state": "degraded" },
      { "scheduler": "sync-global", "state": "healthy" }
    ],
    "diagnosticsAvailable": "/api/diagnostics/backpressure"
  }
}
```

The detailed route requires the node-level admin token. Agent-scoped tokens are
rejected because the response describes node-wide work.

```bash
TOKEN=$(dkg auth show)
curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:9200/api/diagnostics/backpressure | jq
```

The response reports current queue/inflight counts and limits, oldest ages,
cumulative lifecycle/rejection counts, and bounded operation summaries. It
does not expose request bodies, SPARQL text, graph or peer identifiers, work
closures, or durable queue payloads.

## Log behavior

The daemon samples registered sources every five seconds. It emits:

- a warning immediately when a lane enters or changes a non-healthy state;
- one warning summary per minute while that state persists;
- an info message when the lane recovers.

All messages start with `[backpressure]` and carry a JSON object:

```text
[warn] [backpressure] {"event":"transition","scheduler":"store","lane":"normal","state":"degraded","previousState":"healthy","queued":3,"queueLimit":4,"inflight":4,"inflightLimit":4,"oldestQueuedAgeMs":15234,"oldestActiveAgeMs":19310,"rejectedTotal":0,"queuedOperations":[{"operation":"blazegraph.query","count":3,"oldestAgeMs":15234}],"activeOperations":[{"operation":"publisher.swm.graphScopedReplace","count":4,"oldestAgeMs":19310}]}
```

Per-item enqueue/start logs are deliberately avoided. Transition and periodic
summary logging make sustained pressure visible without creating a log storm
that competes with the overloaded scheduler.

## Metrics

The common OpenTelemetry instruments use bounded `scheduler` and `lane`
attributes:

| Metric | Type | Purpose |
| --- | --- | --- |
| `dkg.backpressure.queue_depth` | gauge | Current waiting work in this lane — the attribution signal |
| `dkg.backpressure.pressure_depth` | gauge | The depth this lane's state was classified against. **Divide this by `queue_limit` for utilization**, not `queue_depth`: on a `shared` lane the limit is the pool's, so pairing it with the lane's own backlog underreports. Equal to `queue_depth` on a `partitioned` lane |
| `dkg.backpressure.queue_limit` | gauge | Configured queue capacity |
| `dkg.backpressure.inflight` | gauge | Current admitted work in this lane — attribution |
| `dkg.backpressure.pressure_inflight` | gauge | The admitted count `inflight_limit` bounds — this lane's own under `partitioned`, the pool's under `shared` |
| `dkg.backpressure.inflight_limit` | gauge | Configured concurrency |
| `dkg.backpressure.oldest_queued_age_ms` | gauge | Head-of-line age |
| `dkg.backpressure.oldest_active_age_ms` | gauge | Oldest admitted duration |
| `dkg.backpressure.events_total` | counter | Lifecycle and rejection events |
| `dkg.backpressure.queue_wait_ms` | histogram | Completed queue waits |
| `dkg.backpressure.active_duration_ms` | histogram | Completed admitted durations |

Like the lane `queueLimit`/`inflightLimit` they pair with, `pressure_depth` and
`pressure_inflight` **must never be summed across lanes** on a `shared`
scheduler: every lane reports the same pool figure, and the `lane="all"` row
carries the scheduler's own totals under the same instrument names, so a `sum()`
without a lane filter double-counts on every scheduler.

Operation names are intentionally excluded from the common current-value
gauges. They remain available in bounded diagnostic/log summaries, while
metrics retain predictable cardinality.

## Async admission usage line

The daemon logs one `async_admission_usage` line every five minutes (and once at
start), so an operator can tell whether the slow part of async share and async
publish is admission, the store, or the workers. The line is the primary signal:
OpenTelemetry export is opt-in, and the store scheduler's timeout warning is
rate-limited. The line is never rate-limited and is logged when the node is idle.
It is logfmt, like `resource_usage`:

```text
async_admission_usage interval_s=300 store_rejections=store/background/publisher.asyncLift/queue_full:3 store_max_wait_ms=store/ack:0,store/background:812,store/health:0,store/normal:120 http=publish_async/enqueue/202/-:41,publish_async/snapshot_preflight/503/STORE_SCHEDULER_BUSY:2,share_async/enqueue/200/-:120 http_share_n=120 http_share_p50_ms=40 http_share_p95_ms=211 http_share_max_ms=900 ...
```

### Cumulative counters and interval windows

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

### Fields

| Field | Kind | Meaning |
| --- | --- | --- |
| `interval_s` | seconds | Time since the previous line (`0` for the first) |
| `store_rejections=<scheduler>/<lane>/<family>/<reason>:<n>` | cumulative | Store scheduler rejections by the lane, the operation family (the first two segments of the caller's `source`, such as `publisher.asyncLift`) and the reason (`queue_full`, `queue_wait_timeout`), for every registered scheduler |
| `store_max_wait_ms=<scheduler>/<lane>:<ms>` | window | The longest queue wait that ended in the interval, per lane; `0` for a lane with none |
| `http=<route>/<phase>/<status>/<code>:<n>` | cumulative | Admission requests by route (`share_async`, `publish_async`), answering phase, HTTP status and error code (`-` for none). Every outcome is counted, 2xx included, so rates have a denominator. Status `0` is a client that left before any answer (`client_closed`). At most 64 distinct code series are kept; later ones count under `other` |
| `http_share_*`, `http_publish_*` (`_n`, `_p50_ms`, `_p95_ms`, `_max_ms`) | window | Admission latency per route, request start to response, every outcome |
| `share_depth=<state>:<n>` | gauge | Share jobs per state (`queued`, `running`, `failed_retrying`, `succeeded`, `failed`); `-` if unreadable |
| `lift_depth=<state>:<n>` | gauge | Publisher jobs per state; `accepted` is the accepted-but-unclaimed backlog; `-` if unreadable |
| `lift_journal` | gauge | Entries in the append-only publisher admission journal |
| `depth_errors` | cumulative | Depth reads that failed or timed out (15 s); the affected field prints `-` |
| `share_reclaimed`, `share_abandoned` | cumulative | Expired share leases the sweep requeued, and ones it gave up on (the job failed for inspection) |
| `lift_reclaimed` | cumulative | Publisher jobs reset to accepted by recovery |
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

### Admission phases

The phase is the step that answered the request, so a rejection can be pinned on one
pre-queue read:

| Phase | Covers |
| --- | --- |
| `request` | Everything before the first read: rate limiting, in-flight load shedding, authentication, body and option validation, the worker or publisher availability `503`, and, on the share route, the storage-lane read for a node-level token that names an author |
| `write_preflight` | The context-graph write preflight and its readiness wait (both routes) |
| `intent_resolution` | The publish route's finalized-assertion intent resolution reads |
| `snapshot_preflight` | The publish route's workspace snapshot reads |
| `enqueue` | The enqueue itself, and every 2xx answer |

### Pick-up definitions

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

### OpenTelemetry

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

### Monitoring reads

The depth reads are `COUNT ... GROUP BY` queries on the store's background lane
under their own sources (`publisher.queueUsage.share`, `.lift`, `.liftJournal`), apart
from the queues' own sources, so a monitoring read the scheduler refuses does not
inflate the queue-source rejection counts it is there to measure. They take neither
the share mutex nor the publisher claim lock.

## Failure containment

Instrumentation is fail-open:

- metric recording failures do not alter admission or completion;
- one broken source is reported in the registry's `failures` array without
  hiding healthy sources;
- log callback failures do not stop the monitor;
- the monitor timer is unreferenced and is stopped during daemon shutdown.

### Shared-pool lane triage

Shared-pool lane rows include `stateReasons`: all active `depth`, `age`, `rejection`, and `active_age` signals. A full pool can make several lanes `saturated`, but only a lane whose oldest queued operation exceeds the configured age threshold includes `age`. Read this field in `/api/diagnostics/backpressure` and `[backpressure]` log records to distinguish delayed lanes without calculating thresholds. State precedence and partitioned store rows are unchanged.
