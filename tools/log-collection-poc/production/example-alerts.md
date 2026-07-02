# Grafana alerting — live setup on the observability server

> **Status (2026-07-02):** everything below is **provisioned and healthy** on the
> production observability Grafana (the dedicated server, Loki 3.x native-OTLP
> stack — see RUNBOOK.md). This file documents it so it can be recreated from
> scratch. Webhook URLs are **secrets** — they live only in Grafana contact
> points, never in this repo.

## Routing model — one Slack channel per signal

| Slack channel | Contact point | Route matchers |
|---|---|---|
| `#node-logs` | `DKG node logs (Slack)` | `team=dkg`, `signal=logs` |
| `#node-metrics` | `DKG node metrics (Slack)` | `team=dkg`, `signal=metrics` |
| `#node-traces` | `DKG node traces (Slack)` | `team=dkg`, `signal=traces` |

Routes are appended as children of the root notification policy
(`group_by: [alertname, service_instance_id]`, `group_wait 30s`,
`group_interval 5m`, `repeat_interval 4h`). Every rule carries labels
`team=dkg` + `signal=<x>`; add those two labels to any new rule and it routes
itself.

The webhooks belong to the Slack app **"DKG Grafana Alerts"** (workspace
OriginTrail) — manage/rotate them at *api.slack.com/apps → DKG Grafana Alerts →
Incoming Webhooks*.

## The 9 rules (folder "DKG V10 Node Observability", group `dkg-node-telemetry`)

All queries are **range queries** — on Loki 3.x an *instant* metric query over a
range ≥ a few hours is split internally and dies with `maximum of series (500)
reached`; range+reduce avoids that class of failure entirely.

### → #node-logs (live today, datasource: Loki)

1. **Node silent — was reporting in last 24h, quiet 15m**
   - A (range, last 24h, 30m steps): `count(sum by (service_instance_id) (count_over_time({service_name="dkg-node"}[1h])))` → reduce **max** = B
   - D (range, last 15m): `count(sum by (service_instance_id) (count_over_time({service_name="dkg-node"}[15m])))` → reduce **last** = E
   - C (math): `$B - $E > 0`, for `10m`, **noData = Alerting** (a total pipeline
     blackout must page too). Adapts as the fleet grows — no hardcoded node count.
2. **Error spike** — `sum by (service_instance_id) (count_over_time({service_name="dkg-node"} | severity_text=`ERROR` [10m]))` → last `> 10`, for 5m, noData OK.
3. **Warn spike** — same with `WARN`, `> 150`, for 10m, noData OK.

### → #node-metrics

4. **RPC credit burn spike** (Loki, from the `rpc_usage` log lines): `sum by (service_instance_id) (sum_over_time({service_name="dkg-node"} |= `rpc_usage` | logfmt | method != `` | unwrap count [1h]))` → last `> 6000`/h, for 5m, noData OK. *Needs nodes on a post-#1409 build.*
5. **Log pipeline export failing** (VictoriaMetrics, live): `sum(rate(otelcol_exporter_send_failed_log_records[10m])) > 0`, for 10m.
6. **Collector queue near capacity** (VictoriaMetrics, live): `max(otelcol_exporter_queue_size / otelcol_exporter_queue_capacity) > 0.8`, for 10m.
7. **Publish failures per node** *(armed — silent until nodes export OTel metrics)*: `sum by (instance, service_instance_id) (rate(dkg_publish_total{outcome=~"failed|error"}[15m])) > 0.02`, noData OK.
8. **Chain RPC failover exhausted per node** *(armed)*: `sum by (instance, service_instance_id) (rate(dkg_chain_rpc_failover_total[15m])) > 0`, noData OK.

### → #node-traces

9. **Errored spans rate** *(armed — needs traces flowing + Tempo
   metrics-generator/spanmetrics writing to VictoriaMetrics)*:
   `sum(rate(traces_spanmetrics_calls_total{status_code="STATUS_CODE_ERROR"}[15m])) > 0.05`, noData OK.

"Armed" rules evaluate healthy with **noDataState=OK** — zero noise now, they
fire automatically once the signal exists. If the eventual spanmetrics label
names differ, adjust rule 9's matchers.

## Re-provisioning from scratch (API recipe)

With an admin session, `X-Disable-Provenance: true` header keeps everything
UI-editable:

```bash
# 1. Contact points (one per channel; $HOOK_* from your password manager)
POST /api/v1/provisioning/contact-points
  { "name": "DKG node logs (Slack)", "type": "slack",
    "settings": { "url": "$HOOK_NODE_LOGS" } }          # ×3, one per signal

# 2. Notification policy — ALWAYS GET the tree first and APPEND child routes;
#    a PUT replaces the WHOLE tree and would clobber other teams' routes.
GET  /api/v1/provisioning/policies
PUT  /api/v1/provisioning/policies    # tree + appended routes (matchers above)

# 3. Rules
POST /api/v1/provisioning/alert-rules # one per rule; folderUID of the
                                      # dashboards folder, ruleGroup dkg-node-telemetry
```

Legacy note: an earlier 4-rule single-channel version of this setup exists on
polaris (Loki 2.5 query shapes — `level=` label instead of `severity_text`
metadata). The rules above are the current reference.
