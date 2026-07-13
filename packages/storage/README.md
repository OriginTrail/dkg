# @origintrail-official/dkg-storage

Triple store abstraction layer for DKG V10. Provides a unified API over multiple RDF storage backends with named graph management and private content storage.

## Features

- **Backend adapters** — pluggable triple store implementations:
  - `OxigraphStore` — embedded WASM/native store, no external dependencies
  - `OxigraphWorkerStore` — worker-thread variant; keeps the daemon event loop free, with a per-read-operation timeout (see below)
  - `BlazegraphStore` — connects to a running Blazegraph SPARQL endpoint
  - `SparqlHttpStore` — generic adapter for any SPARQL 1.1 compliant endpoint
- **Graph manager** — named graph lifecycle (create, drop, list) with contextGraph-scoped data and metadata graphs
- **Private content store** — encrypted triple storage for private KA triples, separate from the public graph
- **Custom adapters** — `registerTripleStoreAdapter()` to plug in any storage backend

## Usage

```typescript
import { createTripleStore, GraphManager } from '@origintrail-official/dkg-storage';

// In-memory store
const memStore = await createTripleStore({ backend: 'oxigraph' });

// Persistent store (requires a path)
const store = await createTripleStore({
  backend: 'oxigraph-persistent',
  options: { path: './data' },
});

const graphs = new GraphManager(store);

await store.insert(quads);
const result = await store.query('SELECT * WHERE { ?s ?p ?o } LIMIT 10');
```

## Embedded worker store (`oxigraph-worker`) tuning

The embedded worker runs **all** store operations on a single worker thread, so
a long-running or stuck op (a huge import, an expensive query) blocks every
other store-backed request behind it. Under real load this surfaces as the
daemon's `/api/status` staying green while `/api/query`,
`/api/context-graph/list`, and `/api/assertion/create` hang. A `store.options`
knob bounds that blast radius:

| Option | Default | Purpose |
|---|---|---|
| `operationTimeoutMs` | `120000` | Reject a **read-only** op (`query`, `hasGraph`, `listGraphs`, `countQuads`) that exceeds this instead of hanging forever — that's where the user-visible hang shows up. `0` disables (restores unbounded behaviour). `close` is exempt — its final flush always runs to completion so shutdown can't drop pending writes. |

Mutations (`insert`, `delete`, …) are intentionally **not** bounded by this
timeout. The bound only drops the *caller's* promise — the single worker thread
keeps running the op — so a "timed-out" write could still commit afterwards,
and the rest of the codebase treats a rejected `insert`/`delete` as a clean
failure. Bounding only reads surfaces a wedged worker on the paths that hang
without inventing an indeterminate write outcome. `insert()` therefore stays
strictly atomic (all quads commit or the call fails), which callers rely on.

```jsonc
// ~/.dkg/config.json
"store": {
  "backend": "oxigraph-worker",
  "options": { "operationTimeoutMs": 120000 }
}
```

For heavy / production workloads, prefer an out-of-process SPARQL server
(`sparql-http` or `blazegraph`), which handles reads and writes concurrently
and keeps the daemon responsive under load.

## External-store admission and deadlines

All external adapters share a process-wide priority scheduler. Waiting work is
bounded independently for `ack`, `normal`, and `background` traffic, and an
operation rejected before dispatch receives `StoreSchedulerBusyError` with
`code: STORE_SCHEDULER_BUSY`, `retryable: true`, and a reason of either
`queue_full` or `queue_wait_timeout`. Because this error is only created before
the operation closure starts, retrying it cannot duplicate a write that might
already have reached the store.

| Environment variable | Default | Purpose |
|---|---:|---|
| `DKG_STORE_MAX_CONCURRENT` | `8` | Maximum external-store operations in flight. |
| `DKG_STORE_ACK_RESERVED_SLOTS` | `1` | In-flight capacity reserved for ACK work. |
| `DKG_STORE_BACKGROUND_RESERVED_SLOTS` | `1` | Non-ACK capacity reserved for background progress. |
| `DKG_STORE_QUEUE_LIMIT` | `64` | Maximum waiting operations in each priority queue. |
| `DKG_STORE_ACK_QUEUE_LIMIT` | common limit | Optional ACK queue override. |
| `DKG_STORE_NORMAL_QUEUE_LIMIT` | common limit | Optional normal queue override. |
| `DKG_STORE_BACKGROUND_QUEUE_LIMIT` | common limit | Optional background queue override. |
| `DKG_STORE_QUEUE_WAIT_TIMEOUT_MS` | `10000` | Maximum pre-dispatch wait before a retryable busy rejection. |
| `DKG_BLAZEGRAPH_OPERATION_TIMEOUT_MS` | `30000` | Blazegraph end-to-end operation deadline, including scheduler wait, HTTP, response decoding, and mapping. |

Blazegraph's deadline can also be set per store, which takes precedence over
the environment default:

```jsonc
"store": {
  "backend": "blazegraph",
  "options": {
    "url": "http://127.0.0.1:9999/blazegraph/namespace/dkg/sparql",
    "timeout": 30000
  }
}
```

## Internal Dependencies

- `@origintrail-official/dkg-core` — configuration types, logging, constants
