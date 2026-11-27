# RPC usage snapshot v1

`GET /api/diagnostics/rpc-usage` returns a Bearer-authenticated, loopback-only,
non-draining snapshot. The response uses `Cache-Control: no-store`. Capturing a
snapshot reads in-memory counters only: it performs no chain request,
reconciliation, provider selection, or counter drain.

```json
{
  "schemaVersion": 1,
  "consumerVocabularyVersion": 1,
  "processEpoch": "opaque-process-uuid",
  "capturedAtUtc": "2026-09-20T12:00:00.000Z",
  "capturedAtMonotonicMs": 123.5,
  "completeness": {
    "complete": true,
    "reasons": [],
    "populationEpoch": 3,
    "sources": {
      "mainAgent": {
        "status": "included",
        "totalRegisteredTrackers": 1,
        "totalsRetained": true
      },
      "publisherWallets": {
        "status": "included",
        "totalRegisteredTrackers": 1,
        "totalsRetained": true
      },
      "routeRuntimes": {
        "status": "included",
        "totalRegisteredTrackers": 1,
        "totalsRetained": true
      },
      "other": {
        "status": "included",
        "totalRegisteredTrackers": 0,
        "totalsRetained": true
      }
    }
  },
  "cumulative": {
    "methods": { "eth_getBlockByNumber": 8 },
    "consumers": {
      "eth_getBlockByNumber": {
        "chainIndex.head": 5,
        "unattributed": 3
      }
    },
    "adapterRoles": {
      "eth_getBlockByNumber": {
        "main_agent": 8
      }
    }
  }
}
```

## Accounting semantics

- `cumulative.methods` is authoritative. Counts are physical transport attempts,
  including failed attempts and retries, rather than logical operations or
  successful calls.
- `consumers` and `adapterRoles` are overlapping dimensions. Never add them to
  each other or to `methods`. For every method, each detail dimension sums
  independently to the authoritative method total. Missing attribution is
  explicit as `unattributed`; bounded vocabulary overflow is `other`.
- Zero-count methods are omitted. Method, consumer, and adapter-role storage is
  bounded and code-owned. RPC URLs, addresses, graph identifiers, query text,
  request identifiers, tickets, and credentials are never stored.
- Consumer labels cross a second fail-closed privacy boundary before cumulative
  storage. Only the frozen, code-owned
  `RPC_USAGE_SNAPSHOT_CONSUMERS` vocabulary (version 1) can be retained; every
  unknown value collapses to `other`. Adding a legitimate label therefore
  requires an explicit code and contract-test change. Raw unknown values are
  never retained.
- `consumerVocabularyVersion` identifies that exact closed vocabulary. A
  collector must reject unsupported values rather than interpreting labels
  against a different census.
- `processEpoch` changes on process restart and invalidates a start/end interval.
  `populationEpoch` starts at zero and increases once per tracker construction;
  it equals the sum of `totalRegisteredTrackers` across the four source entries.
  Population changes are reportable but do not invalidate an interval because
  each attempt is copied into retained process totals at record time. Retiring or
  replacing a tracker never subtracts its earlier attempts.
- Repeated snapshots do not affect later drains. Existing minute-window drains
  do not affect cumulative snapshots or their process epoch.

## Header consumer vocabulary

The snapshot uses fixed labels for the measured header paths:

- `chainIndex.head`
- `chainIndex.lineage`
- `chainIndex.authorityLineage`
- `authorityIndex.head`
- `authorityIndex.anchor`
- `authorityIndex.lineage`
- `authorityIndex.stabilize`
- `authorityProjection.validateAnchor`
- `receiptFinality.head`
- `receiptFinality.header`
- `unattributed` for all remaining header attempts

The inventory covers `eth_blockNumber`, `eth_getBlockByNumber`, and
`eth_getBlockByHash`. It is attribution only and does not change provider
selection, retries, timing, returned values, or any authority decision.
