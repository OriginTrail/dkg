# Project adoption telemetry

DKG nodes can optionally report two project-adoption signals to an operator-
controlled HTTPS endpoint:

- `install_completed` after a project manifest has been written successfully;
- `context_graph_synced` after a clean Context Graph catch-up emits
  `PROJECT_SYNCED`.

The feature is disabled unless the daemon-wide telemetry switch, the adoption
switch, and an endpoint are all configured explicitly:

```json
{
  "telemetry": {
    "enabled": true,
    "adoption": {
      "enabled": true,
      "endpoint": "https://telemetry.example/v1/adoption",
      "token": "optional-bearer-token",
      "timeoutMs": 3000,
      "maxAttempts": 3
    }
  }
}
```

Environment variables override the adoption block:

```text
DKG_ADOPTION_TELEMETRY_ENABLED=1
DKG_ADOPTION_TELEMETRY_ENDPOINT=https://telemetry.example/v1/adoption
DKG_ADOPTION_TELEMETRY_TOKEN=optional-bearer-token
DKG_ADOPTION_TELEMETRY_TIMEOUT_MS=3000
DKG_ADOPTION_TELEMETRY_MAX_ATTEMPTS=3
```

## Receipt contract

The daemon sends JSON with this shape:

```json
{
  "schemaVersion": 1,
  "receiptId": "sha256:...",
  "adoptionKey": "sha256:...",
  "event": "context_graph_synced",
  "contextGraphId": "example-project",
  "nodeIdHash": "sha256:...",
  "nodeVersion": "10.0.7",
  "network": "mainnet",
  "occurredAt": "2026-07-22T12:00:00.000Z",
  "dataSynced": 1200,
  "sharedMemorySynced": 40
}
```

`adoptionKey` is stable for `(event, contextGraphId, nodeIdHash)`. `receiptId`
identifies one install/sync occurrence and is also sent as the
`Idempotency-Key` header; retries of that occurrence reuse the same receipt.
A receiver should deduplicate `receiptId`, then upsert by `adoptionKey`, retaining
the first timestamp as `firstSeen` and updating `lastSeen` for each new
occurrence. Therefore recurring sync does not increase the unique installation
or node count; it refreshes activity without confusing an HTTP retry for a new
sync.

For example, the receiver's logical record is:

```text
IF receiptId has not been processed:
  INSERT receiptId
  UPSERT adoptionKey
    firstSeen = existing firstSeen or occurredAt
    lastSeen = occurredAt
    syncCount = existing syncCount + 1
```

Count distinct `nodeIdHash` values for total participating nodes. Filter by
`lastSeen` for active nodes over a chosen time window. Keep `install_completed`
and `context_graph_synced` separate: one proves that supported installer code
wrote the manifest files, while the other proves that the DKG node completed a
clean catch-up.

## Privacy and delivery

The raw Peer ID, wallet address, workspace path, and daemon authentication token
are not included. `nodeIdHash` is deterministically derived from the stable Peer
ID so a receiver can deduplicate a node without receiving the raw identifier.
Deleting the node's persistent DKG home generates a new Peer ID and therefore a
new pseudonym.

Delivery is best-effort and fail-open: an unavailable telemetry endpoint never
turns a successful install or sync into a failure. The daemon retries transient
HTTP and transport failures within configured bounds and drains outstanding
deliveries during graceful shutdown. Nodes that do not opt in are not visible,
so aggregated counts are a lower bound rather than a protocol-wide registry.
Remote endpoints must use HTTPS; plain HTTP is accepted only for a collector on
`localhost`, `127.0.0.1`, or `::1`.
