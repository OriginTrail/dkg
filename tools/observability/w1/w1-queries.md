<!-- GENERATED FILE — do not edit. Source: tools/observability/lib/w1.mjs
     Regenerate with: node tools/observability/generate-observability.mjs
     Verified by: node tools/observability/verify-w1-render.mjs tools/observability
     Parsed by:   promtool check rules tools/observability/w1/w1-rules.yaml -->

# W1 — sync measurement decision queries

Attributes sync cost to its trigger on two axes — **network volume** (encoded
payload bytes and actual send attempts) and **node strain** (source-attributed
active wall-clock occupancy inside the admitted work boundary). If the two axes
rank lanes differently the result is `inconclusive`.

W1 measures cost and an upper bound on opportunity. It cannot measure
addressable savings.

## How to run these

Every selector carries the node filter `instance=~"${node:regex}"`, built from
the shared Prometheus node-identity profile (`--prom-node-label`, default
`instance`). Paste a query into a Grafana panel or Explore with a
`$node` variable, or substitute the interpolation with a concrete matcher such
as `instance="my-node"`.

The identical expressions are emitted as a Prometheus rule group in
`w1-rules.yaml` beside this file, and CI parses that fixture with a pinned
`promtool check rules` — so every query here is proven to be valid PromQL, not
merely regex-plausible.

## Instruments

| # | Instrument (OTLP) | Type | Unit | Prometheus spellings | Labels |
|---|---|---|---|---|---|
| I1 | `dkg.sync.attempt.total` | counter | `1` | `dkg_sync_attempt_total` | `transport`, `plane`, `phase`, `source`, `outcome` |
| I2 | `dkg.sync.attempt.request_bytes` | counter | `By` | `dkg_sync_attempt_request_bytes`<br>`dkg_sync_attempt_request_bytes_bytes_total` | `transport`, `plane`, `phase`, `source` |
| I3 | `dkg.sync.attempt.response_bytes` | counter | `By` | `dkg_sync_attempt_response_bytes`<br>`dkg_sync_attempt_response_bytes_bytes_total` | `transport`, `plane`, `phase`, `source`, `outcome` |
| I4 | `dkg.sync.operation.duration_ms` | histogram | `ms` | `dkg_sync_operation_duration_ms`<br>`dkg_sync_operation_duration_ms_milliseconds`<br>+ `_bucket` / `_sum` / `_count` | `lane`, `source`, `outcome` |
| I5 | `dkg.sync.operation.rejected_total` | counter | `1` | `dkg_sync_operation_rejected_total` | `lane`, `source`, `reason` |
| I6 | `dkg.sync.singleflight.joins_total` | counter | `1` | `dkg_sync_singleflight_joins_total` | `scope`, `owner_source`, `joiner_source` |
| I7 | `dkg.context_graph.catchup.requests_total` | counter | `1` | `dkg_context_graph_catchup_requests_total` | `result`, `include_shared_memory` |
| I8 | `dkg.context_graph.catchup.jobs_total` | counter | `1` | `dkg_context_graph_catchup_jobs_total` | `status`, `admission` |
| I9 | `dkg.context_graph.catchup.job_duration_ms` | histogram | `ms` | `dkg_context_graph_catchup_job_duration_ms`<br>`dkg_context_graph_catchup_job_duration_ms_milliseconds`<br>+ `_bucket` / `_sum` / `_count` | `admission` |

Corroborating instruments (pre-existing, not part of the W1 inventory):

| # | Instrument (OTLP) | Type | Unit | Prometheus spellings | Labels |
|---|---|---|---|---|---|
| P1 | `dkg.sync.scheduler.queue_wait_ms` | histogram | `ms` | `dkg_sync_scheduler_queue_wait_ms`<br>`dkg_sync_scheduler_queue_wait_ms_milliseconds`<br>+ `_bucket` / `_sum` / `_count` | `scheduler`, `lane`, `priority_class` |
| P2 | `dkg.backpressure.oldest_queued_age_ms` | gauge | `ms` | `dkg_backpressure_oldest_queued_age_ms`<br>`dkg_backpressure_oldest_queued_age_ms_milliseconds` | `scheduler`, `lane` |

**Two spellings, always.** A DKG node's metrics reach a Prometheus-compatible
store either natively (dots → underscores only) or through the OTel Prometheus
naming convention (unit suffix, `_total` on monotonic counters). A selector
naming one spelling comes back empty on the other route — indistinguishable
from "no traffic". Selectors below therefore match both, the same way the
metrics dashboard already writes `dkg_publish_duration(_milliseconds)?_bucket`.

## Source families (§5.5)

`SYNC_ADMISSION_SOURCES` has exactly eight members and this table is
exhaustive over them. The `invalidating` family is the **negation** of the
seven classified sources, so `unspecified` and any future member added without
updating this table both surface in the gate instead of vanishing.

| Family | Classification | Sources | Runnable predicate |
|---|---|---|---|
| `foreground` | user-triggered catch-up | `catchup-foreground` | `source=~"catchup-foreground"` |
| `recurring` | recurring peer contact | `on-connect`, `reconcile` | `source=~"on-connect\|reconcile"` |
| `excluded` | excluded / reported separately | `catchup-background`, `vm-recovery`, `swm-recovery`, `control-plane` | `source=~"catchup-background\|vm-recovery\|swm-recovery\|control-plane"` |
| `invalidating` | invalidates the window | `unspecified` | `source!~"catchup-foreground\|on-connect\|reconcile\|catchup-background\|vm-recovery\|swm-recovery\|control-plane"` |

`control-plane` is reported separately rather than counted as eligible cost:
curator meta refresh issues `plane=durable`/`phase=meta` fetches from outside
any admission boundary, so it is real durable traffic that no trigger the
decision rule reasons about is responsible for.

Eligible (materiality numerator): `source=~"catchup-foreground|on-connect|reconcile"`

## Filters (§7.2)

- **I1–I3 (attempts and bytes):** `plane="durable"`, `phase=~"data|meta|delta"` — excludes `snapshot` and `catalog`
- **I4/I5 (operations):** `lane=~"durable|changelog"` — requester lanes only, not the full scheduler lane union

## Decision rule (fixed before collection, §7.3)

Evidence gates — any unmet ⇒ `inconclusive`:

| Query | Threshold | Meaning |
|---|---|---|
| `completed_durable_operations` | `≥ 200` | I4 count — completed durable/changelog operations |
| `attributed_durable_payload_bytes` | `≥ 50 MB` | I2 + I3 over the durable filter |
| `cross_family_singleflight_joins` | `= 0` | I6 — any cross-family join invalidates the window |
| `invalidating_source_samples` | `= 0` | no `unspecified` / unclassified source sample |
| `counter_resets` | `= 0` | no counter reset inside the window |
| `export_coverage_min_samples` | `window ÷ scrape interval` | no export gap |

Materiality — **both axes**, with a strain floor:

| Query | Threshold | Meaning |
|---|---|---|
| `eligible_active_share_of_all_source` | `≥ 0.30` | strain floor — eligible active ms as a share of ALL-SOURCE durable active ms |
| `<family>_share_of_eligible_durable_bytes` | `≥ 0.60` | winning family, bytes axis |
| `<family>_share_of_eligible_durable_active_ms` | `≥ 0.60` | winning family, strain axis |
| `<family>_durable_bytes_per_hour` | `≥ 25 MB/h` | absolute floor, bytes axis |
| `<family>_durable_active_ms_per_hour` | `≥ 90 000 ms/h` | absolute floor, strain axis (90 s active/hour) |

| Outcome | Meaning |
|---|---|
| all satisfied by one family | that lane is the first **shadow** candidate |
| axes rank different families | `inconclusive` |
| eligible share < 0.30 of all-source active ms | `inconclusive / re-scope` |
| any gate unmet | `inconclusive → W3 stays parked` |

A zero denominator is `inconclusive`, never a win — the share queries are plain
divisions with no clamp, so an empty or infinite result reads as exactly that.

## Window: Stable topology (`stable`, range `2h`)

Collection minimum: ≥ 2 h, no induced churn. Rule group `w1-stable-window` in
`w1-rules.yaml` carries these same expressions.

### Evidence gates (§7.3) — any unmet ⇒ inconclusive

**`completed_durable_operations`** — Completed durable/changelog sync operations (I4 count)

Evidence gate ≥ 200. I4's count DEFINES "completed logical sync operation" and is the denominator every share below divides by.

```promql
sum(increase({__name__=~"dkg_sync_operation_duration_ms(_milliseconds)?_count", lane=~"durable|changelog", instance=~"${node:regex}"}[2h]))
```

**`attributed_durable_payload_bytes`** — Attributed durable payload bytes (I2 + I3)

Evidence gate ≥ 50 MB. Encoded application-protocol payload at the router boundary — never called wire bandwidth.

```promql
sum(increase({__name__=~"dkg_sync_attempt_request_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", instance=~"${node:regex}"}[2h])) + sum(increase({__name__=~"dkg_sync_attempt_response_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", instance=~"${node:regex}"}[2h]))
```

**`cross_family_singleflight_joins`** — Cross-family single-flight joins (I6)

Evidence gate = 0. PromQL cannot compare two labels, so the predicate is enumerated per family: owner in F and joiner not in F. Each sample's owner is in exactly one family, so the terms partition and cannot double-count. Each term is zero-filled so an absent family cannot blank out a real join in another.

```promql
(sum(increase(dkg_sync_singleflight_joins_total{owner_source=~"catchup-foreground", joiner_source!~"catchup-foreground", instance=~"${node:regex}"}[2h])) or vector(0)) + (sum(increase(dkg_sync_singleflight_joins_total{owner_source=~"on-connect|reconcile", joiner_source!~"on-connect|reconcile", instance=~"${node:regex}"}[2h])) or vector(0)) + (sum(increase(dkg_sync_singleflight_joins_total{owner_source=~"catchup-background|vm-recovery|swm-recovery|control-plane", joiner_source!~"catchup-background|vm-recovery|swm-recovery|control-plane", instance=~"${node:regex}"}[2h])) or vector(0)) + (sum(increase(dkg_sync_singleflight_joins_total{owner_source!~"catchup-foreground|on-connect|reconcile|catchup-background|vm-recovery|swm-recovery|control-plane", joiner_source=~"catchup-foreground|on-connect|reconcile|catchup-background|vm-recovery|swm-recovery|control-plane", instance=~"${node:regex}"}[2h])) or vector(0))
```

**`invalidating_source_samples`** — Samples carrying an unclassified source

Evidence gate = 0. Negation of the seven classified sources, so `unspecified` and any future unlisted member both surface here instead of vanishing. Terms are zero-filled: a healthy node has no series on any of the three, and an unfilled sum would go blank and hide a sample on one of them.

```promql
(sum(increase(dkg_sync_attempt_total{plane="durable", phase=~"data|meta|delta", source!~"catchup-foreground|on-connect|reconcile|catchup-background|vm-recovery|swm-recovery|control-plane", instance=~"${node:regex}"}[2h])) or vector(0)) + (sum(increase({__name__=~"dkg_sync_operation_duration_ms(_milliseconds)?_count", lane=~"durable|changelog", source!~"catchup-foreground|on-connect|reconcile|catchup-background|vm-recovery|swm-recovery|control-plane", instance=~"${node:regex}"}[2h])) or vector(0)) + (sum(increase(dkg_sync_operation_rejected_total{lane=~"durable|changelog", source!~"catchup-foreground|on-connect|reconcile|catchup-background|vm-recovery|swm-recovery|control-plane", instance=~"${node:regex}"}[2h])) or vector(0))
```

**`counter_resets`** — Counter resets inside the window

Evidence gate = 0. A process restart resets every counter this window reads; `increase()` would paper over it.

```promql
max(resets(dkg_sync_attempt_total{plane="durable", phase=~"data|meta|delta", instance=~"${node:regex}"}[2h]))
```

**`export_coverage_min_samples`** — Export coverage — fewest samples on any read series

Evidence gate: compare against window ÷ scrape interval. A materially smaller value is an export gap and invalidates the window.

```promql
min(count_over_time(dkg_sync_attempt_total{plane="durable", phase=~"data|meta|delta", instance=~"${node:regex}"}[2h]))
```

### Denominators and the strain floor (§7.3)

**`all_source_durable_active_ms_per_hour`** — ALL-SOURCE durable active ms/hour (I4 sum, no family filter)

Strain denominator. Source-attributed active wall-clock occupancy — occupancy, not CPU.

```promql
3600 * sum(rate({__name__=~"dkg_sync_operation_duration_ms(_milliseconds)?_sum", lane=~"durable|changelog", instance=~"${node:regex}"}[2h]))
```

**`all_source_durable_bytes_per_hour`** — ALL-SOURCE durable bytes/hour (I2 + I3, no family filter)

Volume denominator.

```promql
3600 * (sum(rate({__name__=~"dkg_sync_attempt_request_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", instance=~"${node:regex}"}[2h])) + sum(rate({__name__=~"dkg_sync_attempt_response_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", instance=~"${node:regex}"}[2h])))
```

**`all_source_durable_attempts_per_hour`** — ALL-SOURCE durable attempts/hour (I1, no family filter)

Send-attempt denominator.

```promql
3600 * sum(rate(dkg_sync_attempt_total{plane="durable", phase=~"data|meta|delta", instance=~"${node:regex}"}[2h]))
```

**`eligible_durable_active_ms_per_hour`** — Eligible (foreground + recurring) durable active ms/hour

Strain numerator for the 30 % floor.

```promql
3600 * sum(rate({__name__=~"dkg_sync_operation_duration_ms(_milliseconds)?_sum", lane=~"durable|changelog", source=~"catchup-foreground|on-connect|reconcile", instance=~"${node:regex}"}[2h]))
```

**`eligible_durable_bytes_per_hour`** — Eligible (foreground + recurring) durable bytes/hour

Volume numerator for the per-family shares.

```promql
3600 * (sum(rate({__name__=~"dkg_sync_attempt_request_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", source=~"catchup-foreground|on-connect|reconcile", instance=~"${node:regex}"}[2h])) + sum(rate({__name__=~"dkg_sync_attempt_response_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", source=~"catchup-foreground|on-connect|reconcile", instance=~"${node:regex}"}[2h])))
```

**`eligible_durable_operations`** — Eligible completed durable operations (I4 count)

Eligible share of the operation denominator.

```promql
sum(increase({__name__=~"dkg_sync_operation_duration_ms(_milliseconds)?_count", lane=~"durable|changelog", source=~"catchup-foreground|on-connect|reconcile", instance=~"${node:regex}"}[2h]))
```

**`eligible_active_share_of_all_source`** — Strain floor — eligible active ms ÷ ALL-SOURCE active ms

Materiality gate ≥ 0.30. An empty result means a zero denominator, which is `inconclusive`, never a win — so this is a plain division with no clamp.

```promql
sum(rate({__name__=~"dkg_sync_operation_duration_ms(_milliseconds)?_sum", lane=~"durable|changelog", source=~"catchup-foreground|on-connect|reconcile", instance=~"${node:regex}"}[2h])) / sum(rate({__name__=~"dkg_sync_operation_duration_ms(_milliseconds)?_sum", lane=~"durable|changelog", instance=~"${node:regex}"}[2h]))
```

### Per-family cost (§7.2)

**`foreground_durable_bytes_per_hour`** — user-triggered catch-up — durable bytes/hour (I2 + I3)

Sources: catchup-foreground. Absolute floor for a winning family is ≥ 25 MB/h.

```promql
3600 * (sum(rate({__name__=~"dkg_sync_attempt_request_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", source=~"catchup-foreground", instance=~"${node:regex}"}[2h])) + sum(rate({__name__=~"dkg_sync_attempt_response_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", source=~"catchup-foreground", instance=~"${node:regex}"}[2h])))
```

**`foreground_durable_attempts_per_hour`** — user-triggered catch-up — durable attempts/hour (I1)

Sources: catchup-foreground.

```promql
3600 * sum(rate(dkg_sync_attempt_total{plane="durable", phase=~"data|meta|delta", source=~"catchup-foreground", instance=~"${node:regex}"}[2h]))
```

**`foreground_durable_active_ms_per_hour`** — user-triggered catch-up — durable active ms/hour (I4 sum)

Sources: catchup-foreground. Absolute floor for a winning family is ≥ 90 000 ms/h.

```promql
3600 * sum(rate({__name__=~"dkg_sync_operation_duration_ms(_milliseconds)?_sum", lane=~"durable|changelog", source=~"catchup-foreground", instance=~"${node:regex}"}[2h]))
```

**`foreground_share_of_eligible_durable_bytes`** — user-triggered catch-up — share of eligible durable bytes

Materiality gate ≥ 0.60 (volume axis).

```promql
(sum(rate({__name__=~"dkg_sync_attempt_request_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", source=~"catchup-foreground", instance=~"${node:regex}"}[2h])) + sum(rate({__name__=~"dkg_sync_attempt_response_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", source=~"catchup-foreground", instance=~"${node:regex}"}[2h]))) / (sum(rate({__name__=~"dkg_sync_attempt_request_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", source=~"catchup-foreground|on-connect|reconcile", instance=~"${node:regex}"}[2h])) + sum(rate({__name__=~"dkg_sync_attempt_response_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", source=~"catchup-foreground|on-connect|reconcile", instance=~"${node:regex}"}[2h])))
```

**`foreground_share_of_eligible_durable_active_ms`** — user-triggered catch-up — share of eligible durable active ms

Materiality gate ≥ 0.60 (strain axis). If the two axes rank different families the window is `inconclusive`.

```promql
sum(rate({__name__=~"dkg_sync_operation_duration_ms(_milliseconds)?_sum", lane=~"durable|changelog", source=~"catchup-foreground", instance=~"${node:regex}"}[2h])) / sum(rate({__name__=~"dkg_sync_operation_duration_ms(_milliseconds)?_sum", lane=~"durable|changelog", source=~"catchup-foreground|on-connect|reconcile", instance=~"${node:regex}"}[2h]))
```

**`recurring_durable_bytes_per_hour`** — recurring peer contact — durable bytes/hour (I2 + I3)

Sources: on-connect, reconcile. Absolute floor for a winning family is ≥ 25 MB/h.

```promql
3600 * (sum(rate({__name__=~"dkg_sync_attempt_request_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", source=~"on-connect|reconcile", instance=~"${node:regex}"}[2h])) + sum(rate({__name__=~"dkg_sync_attempt_response_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", source=~"on-connect|reconcile", instance=~"${node:regex}"}[2h])))
```

**`recurring_durable_attempts_per_hour`** — recurring peer contact — durable attempts/hour (I1)

Sources: on-connect, reconcile.

```promql
3600 * sum(rate(dkg_sync_attempt_total{plane="durable", phase=~"data|meta|delta", source=~"on-connect|reconcile", instance=~"${node:regex}"}[2h]))
```

**`recurring_durable_active_ms_per_hour`** — recurring peer contact — durable active ms/hour (I4 sum)

Sources: on-connect, reconcile. Absolute floor for a winning family is ≥ 90 000 ms/h.

```promql
3600 * sum(rate({__name__=~"dkg_sync_operation_duration_ms(_milliseconds)?_sum", lane=~"durable|changelog", source=~"on-connect|reconcile", instance=~"${node:regex}"}[2h]))
```

**`recurring_share_of_eligible_durable_bytes`** — recurring peer contact — share of eligible durable bytes

Materiality gate ≥ 0.60 (volume axis).

```promql
(sum(rate({__name__=~"dkg_sync_attempt_request_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", source=~"on-connect|reconcile", instance=~"${node:regex}"}[2h])) + sum(rate({__name__=~"dkg_sync_attempt_response_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", source=~"on-connect|reconcile", instance=~"${node:regex}"}[2h]))) / (sum(rate({__name__=~"dkg_sync_attempt_request_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", source=~"catchup-foreground|on-connect|reconcile", instance=~"${node:regex}"}[2h])) + sum(rate({__name__=~"dkg_sync_attempt_response_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", source=~"catchup-foreground|on-connect|reconcile", instance=~"${node:regex}"}[2h])))
```

**`recurring_share_of_eligible_durable_active_ms`** — recurring peer contact — share of eligible durable active ms

Materiality gate ≥ 0.60 (strain axis). If the two axes rank different families the window is `inconclusive`.

```promql
sum(rate({__name__=~"dkg_sync_operation_duration_ms(_milliseconds)?_sum", lane=~"durable|changelog", source=~"on-connect|reconcile", instance=~"${node:regex}"}[2h])) / sum(rate({__name__=~"dkg_sync_operation_duration_ms(_milliseconds)?_sum", lane=~"durable|changelog", source=~"catchup-foreground|on-connect|reconcile", instance=~"${node:regex}"}[2h]))
```

**`excluded_durable_bytes_per_hour`** — excluded / reported separately — durable bytes/hour (I2 + I3)

Sources: catchup-background, vm-recovery, swm-recovery, control-plane. Absolute floor for a winning family is ≥ 25 MB/h.

```promql
3600 * (sum(rate({__name__=~"dkg_sync_attempt_request_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", source=~"catchup-background|vm-recovery|swm-recovery|control-plane", instance=~"${node:regex}"}[2h])) + sum(rate({__name__=~"dkg_sync_attempt_response_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", source=~"catchup-background|vm-recovery|swm-recovery|control-plane", instance=~"${node:regex}"}[2h])))
```

**`excluded_durable_attempts_per_hour`** — excluded / reported separately — durable attempts/hour (I1)

Sources: catchup-background, vm-recovery, swm-recovery, control-plane.

```promql
3600 * sum(rate(dkg_sync_attempt_total{plane="durable", phase=~"data|meta|delta", source=~"catchup-background|vm-recovery|swm-recovery|control-plane", instance=~"${node:regex}"}[2h]))
```

**`excluded_durable_active_ms_per_hour`** — excluded / reported separately — durable active ms/hour (I4 sum)

Sources: catchup-background, vm-recovery, swm-recovery, control-plane. Absolute floor for a winning family is ≥ 90 000 ms/h.

```promql
3600 * sum(rate({__name__=~"dkg_sync_operation_duration_ms(_milliseconds)?_sum", lane=~"durable|changelog", source=~"catchup-background|vm-recovery|swm-recovery|control-plane", instance=~"${node:regex}"}[2h]))
```

### Corroborating pressure (§7.2)

**`rejected_operations_by_reason`** — Operations rejected before starting (I5)

Never-started work is never a 0 ms I4 sample — it lands here, by bounded reason.

```promql
sum by (reason) (increase(dkg_sync_operation_rejected_total{lane=~"durable|changelog", instance=~"${node:regex}"}[2h]))
```

**`singleflight_joins_by_scope`** — Single-flight joins by scope (I6)

Context for the cross-family gate: within-family joins are recorded and tolerated.

```promql
sum by (scope) (increase(dkg_sync_singleflight_joins_total{instance=~"${node:regex}"}[2h]))
```

**`sync_scheduler_queue_wait_p95_ms`** — Corroborating pressure — sync scheduler queue wait p95

Grouped by lane rather than filtered: the scheduler lane union is wider than the I4/I5 requester lanes, and a filter here could silently drop a lane.

```promql
histogram_quantile(0.95, sum by (le, lane) (rate({__name__=~"dkg_sync_scheduler_queue_wait_ms(_milliseconds)?_bucket", scheduler="sync-global", instance=~"${node:regex}"}[2h])))
```

**`sync_scheduler_oldest_queued_age_ms`** — Corroborating pressure — oldest queued item age

Instantaneous snapshot gauge; corroborates the window, it does not gate it.

```promql
max by (lane) ({__name__=~"dkg_backpressure_oldest_queued_age_ms(_milliseconds)?", scheduler="sync-global", instance=~"${node:regex}"})
```

### Catch-up request/job accounting (I7–I9)

**`catchup_requests_by_result`** — Catch-up subscribe requests by route result (I7)

Requests are N:1 with jobs — dedupe and replay return without minting a job.

```promql
sum by (result) (increase(dkg_context_graph_catchup_requests_total{instance=~"${node:regex}"}[2h]))
```

**`catchup_jobs_by_status_and_admission`** — Catch-up jobs by terminal status and admission path (I8)

Exactly one point per unique jobId; `admission` separates walk from synthetic.

```promql
sum by (status, admission) (increase(dkg_context_graph_catchup_jobs_total{instance=~"${node:regex}"}[2h]))
```

**`catchup_walk_job_duration_p95_ms`** — Walk catch-up job duration p95 (I9)

Walk jobs only. The bucket set reaches ~30 min because measured jobs ran 305 s and 382 s.

```promql
histogram_quantile(0.95, sum by (le, admission) (rate({__name__=~"dkg_context_graph_catchup_job_duration_ms(_milliseconds)?_bucket", instance=~"${node:regex}"}[2h])))
```

## Window: Reconnect-heavy (`reconnect`, range `1h`)

Collection minimum: ≥ 1 h, induced peer churn. Rule group `w1-reconnect-window` in
`w1-rules.yaml` carries these same expressions.

### Evidence gates (§7.3) — any unmet ⇒ inconclusive

**`completed_durable_operations`** — Completed durable/changelog sync operations (I4 count)

Evidence gate ≥ 200. I4's count DEFINES "completed logical sync operation" and is the denominator every share below divides by.

```promql
sum(increase({__name__=~"dkg_sync_operation_duration_ms(_milliseconds)?_count", lane=~"durable|changelog", instance=~"${node:regex}"}[1h]))
```

**`attributed_durable_payload_bytes`** — Attributed durable payload bytes (I2 + I3)

Evidence gate ≥ 50 MB. Encoded application-protocol payload at the router boundary — never called wire bandwidth.

```promql
sum(increase({__name__=~"dkg_sync_attempt_request_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", instance=~"${node:regex}"}[1h])) + sum(increase({__name__=~"dkg_sync_attempt_response_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", instance=~"${node:regex}"}[1h]))
```

**`cross_family_singleflight_joins`** — Cross-family single-flight joins (I6)

Evidence gate = 0. PromQL cannot compare two labels, so the predicate is enumerated per family: owner in F and joiner not in F. Each sample's owner is in exactly one family, so the terms partition and cannot double-count. Each term is zero-filled so an absent family cannot blank out a real join in another.

```promql
(sum(increase(dkg_sync_singleflight_joins_total{owner_source=~"catchup-foreground", joiner_source!~"catchup-foreground", instance=~"${node:regex}"}[1h])) or vector(0)) + (sum(increase(dkg_sync_singleflight_joins_total{owner_source=~"on-connect|reconcile", joiner_source!~"on-connect|reconcile", instance=~"${node:regex}"}[1h])) or vector(0)) + (sum(increase(dkg_sync_singleflight_joins_total{owner_source=~"catchup-background|vm-recovery|swm-recovery|control-plane", joiner_source!~"catchup-background|vm-recovery|swm-recovery|control-plane", instance=~"${node:regex}"}[1h])) or vector(0)) + (sum(increase(dkg_sync_singleflight_joins_total{owner_source!~"catchup-foreground|on-connect|reconcile|catchup-background|vm-recovery|swm-recovery|control-plane", joiner_source=~"catchup-foreground|on-connect|reconcile|catchup-background|vm-recovery|swm-recovery|control-plane", instance=~"${node:regex}"}[1h])) or vector(0))
```

**`invalidating_source_samples`** — Samples carrying an unclassified source

Evidence gate = 0. Negation of the seven classified sources, so `unspecified` and any future unlisted member both surface here instead of vanishing. Terms are zero-filled: a healthy node has no series on any of the three, and an unfilled sum would go blank and hide a sample on one of them.

```promql
(sum(increase(dkg_sync_attempt_total{plane="durable", phase=~"data|meta|delta", source!~"catchup-foreground|on-connect|reconcile|catchup-background|vm-recovery|swm-recovery|control-plane", instance=~"${node:regex}"}[1h])) or vector(0)) + (sum(increase({__name__=~"dkg_sync_operation_duration_ms(_milliseconds)?_count", lane=~"durable|changelog", source!~"catchup-foreground|on-connect|reconcile|catchup-background|vm-recovery|swm-recovery|control-plane", instance=~"${node:regex}"}[1h])) or vector(0)) + (sum(increase(dkg_sync_operation_rejected_total{lane=~"durable|changelog", source!~"catchup-foreground|on-connect|reconcile|catchup-background|vm-recovery|swm-recovery|control-plane", instance=~"${node:regex}"}[1h])) or vector(0))
```

**`counter_resets`** — Counter resets inside the window

Evidence gate = 0. A process restart resets every counter this window reads; `increase()` would paper over it.

```promql
max(resets(dkg_sync_attempt_total{plane="durable", phase=~"data|meta|delta", instance=~"${node:regex}"}[1h]))
```

**`export_coverage_min_samples`** — Export coverage — fewest samples on any read series

Evidence gate: compare against window ÷ scrape interval. A materially smaller value is an export gap and invalidates the window.

```promql
min(count_over_time(dkg_sync_attempt_total{plane="durable", phase=~"data|meta|delta", instance=~"${node:regex}"}[1h]))
```

### Denominators and the strain floor (§7.3)

**`all_source_durable_active_ms_per_hour`** — ALL-SOURCE durable active ms/hour (I4 sum, no family filter)

Strain denominator. Source-attributed active wall-clock occupancy — occupancy, not CPU.

```promql
3600 * sum(rate({__name__=~"dkg_sync_operation_duration_ms(_milliseconds)?_sum", lane=~"durable|changelog", instance=~"${node:regex}"}[1h]))
```

**`all_source_durable_bytes_per_hour`** — ALL-SOURCE durable bytes/hour (I2 + I3, no family filter)

Volume denominator.

```promql
3600 * (sum(rate({__name__=~"dkg_sync_attempt_request_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", instance=~"${node:regex}"}[1h])) + sum(rate({__name__=~"dkg_sync_attempt_response_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", instance=~"${node:regex}"}[1h])))
```

**`all_source_durable_attempts_per_hour`** — ALL-SOURCE durable attempts/hour (I1, no family filter)

Send-attempt denominator.

```promql
3600 * sum(rate(dkg_sync_attempt_total{plane="durable", phase=~"data|meta|delta", instance=~"${node:regex}"}[1h]))
```

**`eligible_durable_active_ms_per_hour`** — Eligible (foreground + recurring) durable active ms/hour

Strain numerator for the 30 % floor.

```promql
3600 * sum(rate({__name__=~"dkg_sync_operation_duration_ms(_milliseconds)?_sum", lane=~"durable|changelog", source=~"catchup-foreground|on-connect|reconcile", instance=~"${node:regex}"}[1h]))
```

**`eligible_durable_bytes_per_hour`** — Eligible (foreground + recurring) durable bytes/hour

Volume numerator for the per-family shares.

```promql
3600 * (sum(rate({__name__=~"dkg_sync_attempt_request_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", source=~"catchup-foreground|on-connect|reconcile", instance=~"${node:regex}"}[1h])) + sum(rate({__name__=~"dkg_sync_attempt_response_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", source=~"catchup-foreground|on-connect|reconcile", instance=~"${node:regex}"}[1h])))
```

**`eligible_durable_operations`** — Eligible completed durable operations (I4 count)

Eligible share of the operation denominator.

```promql
sum(increase({__name__=~"dkg_sync_operation_duration_ms(_milliseconds)?_count", lane=~"durable|changelog", source=~"catchup-foreground|on-connect|reconcile", instance=~"${node:regex}"}[1h]))
```

**`eligible_active_share_of_all_source`** — Strain floor — eligible active ms ÷ ALL-SOURCE active ms

Materiality gate ≥ 0.30. An empty result means a zero denominator, which is `inconclusive`, never a win — so this is a plain division with no clamp.

```promql
sum(rate({__name__=~"dkg_sync_operation_duration_ms(_milliseconds)?_sum", lane=~"durable|changelog", source=~"catchup-foreground|on-connect|reconcile", instance=~"${node:regex}"}[1h])) / sum(rate({__name__=~"dkg_sync_operation_duration_ms(_milliseconds)?_sum", lane=~"durable|changelog", instance=~"${node:regex}"}[1h]))
```

### Per-family cost (§7.2)

**`foreground_durable_bytes_per_hour`** — user-triggered catch-up — durable bytes/hour (I2 + I3)

Sources: catchup-foreground. Absolute floor for a winning family is ≥ 25 MB/h.

```promql
3600 * (sum(rate({__name__=~"dkg_sync_attempt_request_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", source=~"catchup-foreground", instance=~"${node:regex}"}[1h])) + sum(rate({__name__=~"dkg_sync_attempt_response_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", source=~"catchup-foreground", instance=~"${node:regex}"}[1h])))
```

**`foreground_durable_attempts_per_hour`** — user-triggered catch-up — durable attempts/hour (I1)

Sources: catchup-foreground.

```promql
3600 * sum(rate(dkg_sync_attempt_total{plane="durable", phase=~"data|meta|delta", source=~"catchup-foreground", instance=~"${node:regex}"}[1h]))
```

**`foreground_durable_active_ms_per_hour`** — user-triggered catch-up — durable active ms/hour (I4 sum)

Sources: catchup-foreground. Absolute floor for a winning family is ≥ 90 000 ms/h.

```promql
3600 * sum(rate({__name__=~"dkg_sync_operation_duration_ms(_milliseconds)?_sum", lane=~"durable|changelog", source=~"catchup-foreground", instance=~"${node:regex}"}[1h]))
```

**`foreground_share_of_eligible_durable_bytes`** — user-triggered catch-up — share of eligible durable bytes

Materiality gate ≥ 0.60 (volume axis).

```promql
(sum(rate({__name__=~"dkg_sync_attempt_request_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", source=~"catchup-foreground", instance=~"${node:regex}"}[1h])) + sum(rate({__name__=~"dkg_sync_attempt_response_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", source=~"catchup-foreground", instance=~"${node:regex}"}[1h]))) / (sum(rate({__name__=~"dkg_sync_attempt_request_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", source=~"catchup-foreground|on-connect|reconcile", instance=~"${node:regex}"}[1h])) + sum(rate({__name__=~"dkg_sync_attempt_response_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", source=~"catchup-foreground|on-connect|reconcile", instance=~"${node:regex}"}[1h])))
```

**`foreground_share_of_eligible_durable_active_ms`** — user-triggered catch-up — share of eligible durable active ms

Materiality gate ≥ 0.60 (strain axis). If the two axes rank different families the window is `inconclusive`.

```promql
sum(rate({__name__=~"dkg_sync_operation_duration_ms(_milliseconds)?_sum", lane=~"durable|changelog", source=~"catchup-foreground", instance=~"${node:regex}"}[1h])) / sum(rate({__name__=~"dkg_sync_operation_duration_ms(_milliseconds)?_sum", lane=~"durable|changelog", source=~"catchup-foreground|on-connect|reconcile", instance=~"${node:regex}"}[1h]))
```

**`recurring_durable_bytes_per_hour`** — recurring peer contact — durable bytes/hour (I2 + I3)

Sources: on-connect, reconcile. Absolute floor for a winning family is ≥ 25 MB/h.

```promql
3600 * (sum(rate({__name__=~"dkg_sync_attempt_request_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", source=~"on-connect|reconcile", instance=~"${node:regex}"}[1h])) + sum(rate({__name__=~"dkg_sync_attempt_response_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", source=~"on-connect|reconcile", instance=~"${node:regex}"}[1h])))
```

**`recurring_durable_attempts_per_hour`** — recurring peer contact — durable attempts/hour (I1)

Sources: on-connect, reconcile.

```promql
3600 * sum(rate(dkg_sync_attempt_total{plane="durable", phase=~"data|meta|delta", source=~"on-connect|reconcile", instance=~"${node:regex}"}[1h]))
```

**`recurring_durable_active_ms_per_hour`** — recurring peer contact — durable active ms/hour (I4 sum)

Sources: on-connect, reconcile. Absolute floor for a winning family is ≥ 90 000 ms/h.

```promql
3600 * sum(rate({__name__=~"dkg_sync_operation_duration_ms(_milliseconds)?_sum", lane=~"durable|changelog", source=~"on-connect|reconcile", instance=~"${node:regex}"}[1h]))
```

**`recurring_share_of_eligible_durable_bytes`** — recurring peer contact — share of eligible durable bytes

Materiality gate ≥ 0.60 (volume axis).

```promql
(sum(rate({__name__=~"dkg_sync_attempt_request_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", source=~"on-connect|reconcile", instance=~"${node:regex}"}[1h])) + sum(rate({__name__=~"dkg_sync_attempt_response_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", source=~"on-connect|reconcile", instance=~"${node:regex}"}[1h]))) / (sum(rate({__name__=~"dkg_sync_attempt_request_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", source=~"catchup-foreground|on-connect|reconcile", instance=~"${node:regex}"}[1h])) + sum(rate({__name__=~"dkg_sync_attempt_response_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", source=~"catchup-foreground|on-connect|reconcile", instance=~"${node:regex}"}[1h])))
```

**`recurring_share_of_eligible_durable_active_ms`** — recurring peer contact — share of eligible durable active ms

Materiality gate ≥ 0.60 (strain axis). If the two axes rank different families the window is `inconclusive`.

```promql
sum(rate({__name__=~"dkg_sync_operation_duration_ms(_milliseconds)?_sum", lane=~"durable|changelog", source=~"on-connect|reconcile", instance=~"${node:regex}"}[1h])) / sum(rate({__name__=~"dkg_sync_operation_duration_ms(_milliseconds)?_sum", lane=~"durable|changelog", source=~"catchup-foreground|on-connect|reconcile", instance=~"${node:regex}"}[1h]))
```

**`excluded_durable_bytes_per_hour`** — excluded / reported separately — durable bytes/hour (I2 + I3)

Sources: catchup-background, vm-recovery, swm-recovery, control-plane. Absolute floor for a winning family is ≥ 25 MB/h.

```promql
3600 * (sum(rate({__name__=~"dkg_sync_attempt_request_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", source=~"catchup-background|vm-recovery|swm-recovery|control-plane", instance=~"${node:regex}"}[1h])) + sum(rate({__name__=~"dkg_sync_attempt_response_bytes(_bytes_total)?", plane="durable", phase=~"data|meta|delta", source=~"catchup-background|vm-recovery|swm-recovery|control-plane", instance=~"${node:regex}"}[1h])))
```

**`excluded_durable_attempts_per_hour`** — excluded / reported separately — durable attempts/hour (I1)

Sources: catchup-background, vm-recovery, swm-recovery, control-plane.

```promql
3600 * sum(rate(dkg_sync_attempt_total{plane="durable", phase=~"data|meta|delta", source=~"catchup-background|vm-recovery|swm-recovery|control-plane", instance=~"${node:regex}"}[1h]))
```

**`excluded_durable_active_ms_per_hour`** — excluded / reported separately — durable active ms/hour (I4 sum)

Sources: catchup-background, vm-recovery, swm-recovery, control-plane. Absolute floor for a winning family is ≥ 90 000 ms/h.

```promql
3600 * sum(rate({__name__=~"dkg_sync_operation_duration_ms(_milliseconds)?_sum", lane=~"durable|changelog", source=~"catchup-background|vm-recovery|swm-recovery|control-plane", instance=~"${node:regex}"}[1h]))
```

### Corroborating pressure (§7.2)

**`rejected_operations_by_reason`** — Operations rejected before starting (I5)

Never-started work is never a 0 ms I4 sample — it lands here, by bounded reason.

```promql
sum by (reason) (increase(dkg_sync_operation_rejected_total{lane=~"durable|changelog", instance=~"${node:regex}"}[1h]))
```

**`singleflight_joins_by_scope`** — Single-flight joins by scope (I6)

Context for the cross-family gate: within-family joins are recorded and tolerated.

```promql
sum by (scope) (increase(dkg_sync_singleflight_joins_total{instance=~"${node:regex}"}[1h]))
```

**`sync_scheduler_queue_wait_p95_ms`** — Corroborating pressure — sync scheduler queue wait p95

Grouped by lane rather than filtered: the scheduler lane union is wider than the I4/I5 requester lanes, and a filter here could silently drop a lane.

```promql
histogram_quantile(0.95, sum by (le, lane) (rate({__name__=~"dkg_sync_scheduler_queue_wait_ms(_milliseconds)?_bucket", scheduler="sync-global", instance=~"${node:regex}"}[1h])))
```

**`sync_scheduler_oldest_queued_age_ms`** — Corroborating pressure — oldest queued item age

Instantaneous snapshot gauge; corroborates the window, it does not gate it.

```promql
max by (lane) ({__name__=~"dkg_backpressure_oldest_queued_age_ms(_milliseconds)?", scheduler="sync-global", instance=~"${node:regex}"})
```

### Catch-up request/job accounting (I7–I9)

**`catchup_requests_by_result`** — Catch-up subscribe requests by route result (I7)

Requests are N:1 with jobs — dedupe and replay return without minting a job.

```promql
sum by (result) (increase(dkg_context_graph_catchup_requests_total{instance=~"${node:regex}"}[1h]))
```

**`catchup_jobs_by_status_and_admission`** — Catch-up jobs by terminal status and admission path (I8)

Exactly one point per unique jobId; `admission` separates walk from synthetic.

```promql
sum by (status, admission) (increase(dkg_context_graph_catchup_jobs_total{instance=~"${node:regex}"}[1h]))
```

**`catchup_walk_job_duration_p95_ms`** — Walk catch-up job duration p95 (I9)

Walk jobs only. The bucket set reaches ~30 min because measured jobs ran 305 s and 382 s.

```promql
histogram_quantile(0.95, sum by (le, admission) (rate({__name__=~"dkg_context_graph_catchup_job_duration_ms(_milliseconds)?_bucket", instance=~"${node:regex}"}[1h])))
```
