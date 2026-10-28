---
status: current
version: v10
audience: operator+developer
doc_type: how-to
---

# Monitor Store and Queue Pressure

A node does its work through queues. Store reads and writes wait for a store slot. Sync with peers waits for a sync slot. Async share and publish jobs wait for a worker. When a node is slow, the useful question is where the work waits. This page shows how to find out.

It answers four questions:

1. Which scheduler and lane are under pressure?
2. Is work waiting, refused, or admitted but stuck?
3. What kind of work is it?
4. Did the node recover?

Everything on this page only observes. It changes no limits, no ordering and no retries. The settings that change how the async queues use the store are on [Async Queue Operations](async-queue-operations.md).

## Read current pressure

`GET /api/status` is public and shows only the overall state:

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

The detailed route needs the node-level admin token. Agent-scoped tokens are refused, because the answer describes node-wide work.

```bash
TOKEN=$(dkg auth show)
curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:9200/api/diagnostics/backpressure | jq
```

It reports queued and in-flight counts, their limits, oldest ages, rejection counts and short summaries of the operations involved. It never shows request bodies, SPARQL text, graph or peer IDs, or queue payloads.

## Pressure states

| State | Meaning |
| --- | --- |
| `healthy` | No age, utilization, rejection or active-duration threshold is crossed. |
| `degraded` | A queue is old or at least 75% full, but not full. |
| `saturated` | A queue is full, or a rejection happened recently. |
| `stalled` | The oldest admitted operation has run past the scheduler's limit. |

The order is `stalled` > `saturated` > `degraded` > `healthy`. A rejection stays visible for 60 seconds, so a short burst is not missed between samples.

On `sync-global` every lane shares one pool. When the pool is full, every lane with queued work reads `saturated`, because its next admission would be refused. A lane with nothing queued stays `healthy`. Those rows carry `stateReasons` (`depth`, `age`, `rejection`, `active_age`), which say which signals fired.

A state is evidence, not a root cause. A stalled store operation can come from Blazegraph, Oxigraph, the disk or a caller that never finishes. Use the operation summaries and the nearby store log lines to go further.

## Log lines

The daemon samples every scheduler every five seconds. It logs:

- a warning when a lane enters or changes a non-healthy state;
- one summary warning per minute while that state lasts;
- an info line when the lane recovers.

Each message starts with `[backpressure]` and carries a JSON object:

```text
[warn] [backpressure] {"event":"transition","scheduler":"store","lane":"normal","state":"degraded","previousState":"healthy","queued":3,"queueLimit":4,"inflight":4,"inflightLimit":4,"oldestQueuedAgeMs":15234,"oldestActiveAgeMs":19310,"rejectedTotal":0,"queuedOperations":[{"operation":"blazegraph.query","count":3,"oldestAgeMs":15234}],"activeOperations":[{"operation":"publisher.swm.graphScopedReplace","count":4,"oldestAgeMs":19310}]}
```

## Async admission usage line

Every five minutes, and once at start, the daemon logs one `async_admission_usage` line. It shows whether the slow part of async share and publish is admission, the store or the workers. It is never rate-limited, and it is logged when the node is idle too, so it is the first place to look.

```text
async_admission_usage interval_s=300 store_rejections=store/background/publisher.asyncLift/queue_full:3 store_max_wait_ms=store/ack:80,store/background:812,store/health:0,store/normal:120 ... http=publish_async/enqueue/202/-:41,publish_async/snapshot_preflight/503/STORE_SCHEDULER_BUSY:2,share_async/enqueue/200/-:120 ...
```

Read it like this:

- **Counters** count since the daemon started. Subtract two lines to get a rate.
- **Latency and wait figures** cover the five minutes before the line. Each comes with its sample count (`_n`), and `-` means no samples.
- **Depths** are read when the line is written.

The [full field reference](https://github.com/OriginTrail/dkg/blob/main/packages/cli/docs/async-admission-usage-line.md) explains every field.

### Which fields answer which question

| Question | Fields | What to look for |
| --- | --- | --- |
| Is the store the slow part? | `store_wait_p95_ms`, `store_max_wait_ms`, `store_rejections` | Long waits or rejections on one lane. `store/ack` is the storage-ACK queue wait. |
| Are submissions refused? | `http` | `503` entries, with the phase and code that refused them. |
| Is admission slow? | `http_share_p95_ms`, `http_publish_p95_ms` | Time from request to answer on `share-async` and `publish-async`. |
| Is a backlog building? | `share_depth`, `lift_depth` | `queued` share jobs or `accepted` publish jobs that keep growing. |
| Are the workers keeping up? | `share_claim_*`, `lift_pickup_*`, `lift_pickup_free_*`, `lift_c2f_*` | Slow pick-up while a wallet is free (`lift_pickup_free_*`) points at the queue. Slow pick-up only while all wallets are busy means too few wallets. |
| Are jobs finishing? | `share_succeeded`, `lift_finalized`, `lift_failed` | Completions per minute, from the change between two lines. |
| Did share leases expire? | `share_reclaimed`, `share_abandoned`, `share_hb_*` | Any rise, or late lease renewals. |
| Is the store control path busy? | `store-control-share/control` and `store-control-publisher/control` in the store fields | Long waits or rejections there. They appear only while the path is on. |
| Are write checks shared? | `preflight_flights`, `preflight_joins`, `preflight_cache_hits`, `preflight_direct` | The join rate: `Δpreflight_joins` over all four `preflight_*` request counts. |
| Is job cleanup running? | `share_retention*`, `lift_retention*` | Present only while cleanup is on. `_pass_would_delete` counts what a pass would remove. |

The daemon also logs a `resource_usage` line every five minutes, with memory and the store and sync slots in use. It includes the control path's slots while the path is on.

For one investigation, two traces add detail. Start the daemon with `DKG_ASYNC_PROMOTE_ADMISSION_TRACE=1` for share admission, or `DKG_ASYNC_PUBLISH_TRACE=1` for publisher claims. Both are off by default.

## Tuning foreground catch-up

On `sync-global`, the operation label reads `<work class>:<source>`. The source is what started the work:

| Source | Started by |
| --- | --- |
| `catchup-foreground` | an explicit catch-up (`POST /api/context-graph/subscribe`) |
| `catchup-background` | automatic catch-up after approval or reconcile |
| `on-connect` | sync after a peer connects |
| `reconcile` | the periodic sync reconciler |
| `vm-recovery` | repair of specific missing Knowledge Assets |
| `swm-recovery` | targeted Shared Working Memory recovery |
| `unspecified` | a caller that named no source |

So `durable:catchup-foreground` with `count: 4` means four explicit catch-ups are waiting. No graph or peer ID ever reaches a label.

Three variables tune foreground catch-up, which shows up as `catchup-foreground` pressure. The daemon reads them once at start, so restart after a change. No startup line names them.

| Variable | Default | Effect |
| --- | --- | --- |
| `DKG_CATCHUP_STOP_ON_PROOF` | on | Asks peers in growing waves and stops once the curator has settled every requested plane. Set `0`, `false`, `no` or `off` to ask every sync-capable peer instead, if a graph lands short. |
| `DKG_CATCHUP_BACKPRESSURE_MAX_WAIT_MS` | `180000` | How long one plane may be refused by `sync-global` before the job reports a retryable `deferred`. `0` turns retries off; a blank value counts as unset. |
| `DKG_CATCHUP_MAX_CONCURRENT_PEERS` | `4` | The most per-peer sync rounds at once. Above the `sync-global` queue depth, one catch-up can fill the scheduler by itself. |

## Metrics and OpenTelemetry

Metrics export is off until you set an OTLP metrics endpoint, either `telemetry.metrics.endpoint` in `config.json` or `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`. Restart after setting it.

The scheduler gauges carry `scheduler` and `lane` attributes:

| Metric | Shows |
| --- | --- |
| `dkg.backpressure.queue_depth`, `dkg.backpressure.inflight` | This lane's own waiting and running work |
| `dkg.backpressure.pressure_depth`, `dkg.backpressure.pressure_inflight` | The counts the lane's state is judged on |
| `dkg.backpressure.queue_limit`, `dkg.backpressure.inflight_limit` | The configured ceilings |
| `dkg.backpressure.oldest_queued_age_ms`, `dkg.backpressure.oldest_active_age_ms` | Head-of-line age and oldest running work |
| `dkg.backpressure.events_total` | Lifecycle and rejection events |
| `dkg.backpressure.queue_wait_ms`, `dkg.backpressure.active_duration_ms` | Histograms of finished waits and run times |

Compute utilization as `pressure_depth / queue_limit`, not `queue_depth / queue_limit`. On `sync-global` every lane reports the same pool figures, so never sum them across lanes.

The store scheduler adds `dkg.store.scheduler_queue_wait_ms`, `dkg.store.scheduler_operation_duration_ms` and `dkg.store.scheduler_rejections_total`, labelled by `priority`. The control path's schedulers report `priority="control"`. The async queues add `dkg.async_admission.*`, `dkg.async_queue.*`, `dkg.async_share.*` and `dkg.async_lift.*` instruments; the field reference lists them.

## How it works

The node registers these schedulers:

- `store`: the external-store scheduler, with the lanes `ack`, `health`, `normal` and `background`;
- `sync-global`: the process-wide sync admission queue;
- `store-control-share` and `store-control-publisher`: the store control path's schedulers, one `control` lane each. They exist only while the path is on.

Each scheduler keeps its own policy. A shared tracker records counts, ages and short operation labels, never payloads. The registry feeds `/api/status`, the diagnostics route, the monitor's log lines and OpenTelemetry. The sync responder limiter is not instrumented. The architecture diagram and the capacity-model details are in the [`dkg-core` README](https://github.com/OriginTrail/dkg/blob/main/packages/core/README.md).

## Failure containment

Observation never blocks the work it observes:

- a metric that fails to record does not change admission or completion;
- one broken source shows in the registry's `failures` list and does not hide healthy sources;
- a failing log callback does not stop the monitor;
- the monitor's timer stops when the daemon shuts down.
