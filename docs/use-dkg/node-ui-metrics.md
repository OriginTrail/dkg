# Node UI metrics collection

The daemon writes local Node UI metric snapshots to `node-ui.db`. This local
collector is separate from OpenTelemetry metric export:

- `telemetry.metrics.collectionEnabled` and the two `*CollectionIntervalMs`
  settings control local SQLite snapshots and store scans.
- `telemetry.metrics.enabled`, `endpoint`, and `exportIntervalMs` control OTLP
  export. Changing `exportIntervalMs` does not change local collection.

## Recommended configuration for large stores

Cheap CPU, memory, disk, peer, RPC, and relay snapshots remain useful at
30-second resolution. Full-store SPARQL cardinality queries are much more
expensive and default to a separate 12-hour cadence:

```json
{
  "telemetry": {
    "metrics": {
      "collectionEnabled": true,
      "collectionIntervalMs": 30000,
      "storeCollectionIntervalMs": 43200000
    }
  }
}
```

The collector attempts both lanes immediately at startup. The expensive
startup attempt only runs when the metrics-presence gate is open. After a
successful attempt, the next full-store scan is scheduled 12 hours after the
previous scan finishes, so a slow scan cannot overlap another store scan.
Cheap snapshots use their own completion-relative scheduler and continue while
a store scan is active.

To restore the legacy shared 30-second cadence, explicitly set
`storeCollectionIntervalMs` to `30000`.

## Environment overrides

Environment values take precedence over `config.json` or `config.yaml`:

```bash
export DKG_METRICS_COLLECTION_ENABLED=1
export DKG_METRICS_COLLECTION_INTERVAL_MS=30000
export DKG_STORE_METRICS_COLLECTION_INTERVAL_MS=43200000
```

`DKG_METRICS_COLLECTION_ENABLED` accepts `1`, `0`, `true`, or `false`.
Intervals must be finite integers from `1000` through `2147483647`
milliseconds. The 1-second minimum prevents accidental busy loops; the maximum
is Node's safe timer limit. Invalid config or environment values fail daemon
startup instead of silently falling back. Restart the daemon after changing
these settings.

Set `collectionEnabled` to `false` (or the environment toggle to `0`) to stop
all new local metric snapshots and store scans. Existing history remains in
SQLite. This toggle is independent of the telemetry master/export toggles.

## Metrics-presence gate

The expensive store getters include total triples, KCs, KAs, confirmed and
tentative KCs, and context-graph count. They run only when the Node UI has an
open SSE consumer or `/api/metrics` or `/api/metrics/history` was read
recently. When the gate is closed, cheap snapshots continue and the expensive
columns are null; the gate is checked again without querying the store.

`DKG_METRICS_ALWAYS_COLLECT=1` preserves the operator override that keeps the
presence gate open. It does not bypass `storeCollectionIntervalMs`: with
`DKG_STORE_METRICS_COLLECTION_INTERVAL_MS=43200000`, the override still permits
at most one scheduled set of expensive scans per 12 hours, apart from the
documented immediate startup attempt.
