# Node UI metrics collection

The daemon writes local Node UI metric snapshots to `node-ui.db`. This local
collector is separate from OpenTelemetry metric export:

- `telemetry.metrics.collectionEnabled` controls local SQLite snapshots and
  the store queries used to populate them.
- `telemetry.metrics.enabled`, `endpoint`, and `exportIntervalMs` control OTLP
  export. Disabling local collection does not disable OTLP export.

Local collection remains enabled by default for backward compatibility. To
disable it, add:

```json
{
  "telemetry": {
    "metrics": {
      "collectionEnabled": false
    }
  }
}
```

The environment override takes precedence over configuration:

```bash
export DKG_METRICS_COLLECTION_ENABLED=0
```

The environment value accepts `1`, `0`, `true`, or `false`. Invalid config or
environment values fail daemon startup instead of silently enabling the
collector. Restart the daemon after changing the setting.

Disabling the collector stops new local snapshots and store scans. Existing
history remains in SQLite. When collection is enabled, the existing metrics
presence gate and `DKG_METRICS_ALWAYS_COLLECT=1` behavior are unchanged.
