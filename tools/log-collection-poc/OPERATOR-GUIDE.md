# Forwarding your DKG node logs (opt-in)

Every DKG node keeps full local logs by default (SQLite + `~/.dkg/daemon.log`).
If you *also* want to forward them to your own log backend (or an
OriginTrail-provided collector), enable the OTLP exporter. **Forwarding is off
until you turn it on**, and secrets (wallet keys, mnemonics, tokens) are
redacted on the node before anything is sent.

## Enable it
Add to your `config.json`:

```json
"name": "my-node-01",
"telemetry": {
  "enabled": true,
  "logs": {
    "exporter": "otlp",
    "endpoint": "https://<your-collector>/v1/logs",
    "token": "<optional-bearer-token>",
    "level": "info"
  }
}
```

| Field | Meaning |
|---|---|
| `name` | Your node's name — becomes the `service_instance_id` label, i.e. how you pick this node in Grafana. Use a unique value. |
| `telemetry.enabled` | Master switch. `false` (default) = nothing leaves the node. |
| `logs.exporter` | `otlp` (recommended), `syslog` (legacy Graylog), or `none` (local only). **If omitted it defaults to `syslog`** — set `otlp` explicitly to forward via OTLP. |
| `logs.endpoint` | Your OTLP/HTTP logs URL (an OpenTelemetry Collector, Grafana Alloy, or Loki ≥3.0 `/otlp/v1/logs`). |
| `logs.token` | Optional bearer token sent as `Authorization: Bearer …`. |
| `logs.level` | Minimum level forwarded (`debug`/`info`/`warn`/`error`). Default `info` — `debug` stays local. |
| `logs.redact` | Extra sensitive key names to scrub from messages, on top of the built-in set. |

Restart the node. It now pushes redacted, structured logs to your collector;
local logging is unchanged. The exporter is non-blocking and buffered — if your
collector is down, the node keeps running and logs are dropped-oldest, never
queued unboundedly.

## What gets sent
- **Resource labels:** `service.name=dkg-node`, `service.instance.id=<name>`, `deployment.environment=<network>`, `dkg.node.role`, `dkg.chain` (matches the traces/metrics resource). Loki sanitizes dots to underscores, so these appear as `service_name`, `service_instance_id`, `deployment_environment`, `dkg_node_role`, `dkg_chain`.
- **Per-record attributes:** `dkg.operation_id`, `dkg.operation_name`, `dkg.source_operation_id`, `dkg.module`, severity, plus `trace_id`/`span_id` when emitted inside a span.
- **Body:** the log message, with secrets already redacted.

## Traces & metrics (optional)
Logs go through a hand-rolled OTLP/HTTP exporter; **traces and metrics use the
stable OpenTelemetry SDK** exporters and are configured the same way under
`telemetry`:

```json
"telemetry": {
  "enabled": true,
  "logs":    { "exporter": "otlp", "endpoint": "https://<collector>/v1/logs", "level": "info" },
  "traces":  { "endpoint": "https://<collector>/v1/traces", "sampleRatio": 1 },
  "metrics": { "endpoint": "https://<collector>/v1/metrics", "exportIntervalMs": 30000 }
}
```

Each signal is independent and stays off until it has an endpoint (or set
`"enabled": false` to disable one explicitly). Point traces at Tempo/any OTLP
traces backend and metrics at a Prometheus/Mimir-backed collector.

## Viewing
Point Grafana at your log store and import `tools/observability/grafana-dashboard-dkg-node-logs.json`
(per-node) and/or `tools/observability/grafana-dashboard-dkg-fleet-logs.json` (fleet),
then pick your node and a time range. If your store is Loki < 3.0, front it with
Grafana Alloy (see `tools/observability/RUNBOOK.md`).
