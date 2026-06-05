# @origintrail-official/dkg-storage

Triple store abstraction layer for DKG V10. Provides a unified API over multiple RDF storage backends with named graph management and private content storage.

## Features

- **Backend adapters** — pluggable triple store implementations:
  - `OxigraphStore` — embedded WASM/native store, no external dependencies
  - `OxigraphWorkerStore` — worker-thread variant; keeps the daemon event loop free, with a per-operation timeout and large-insert chunking (see below)
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
`/api/context-graph/list`, and `/api/assertion/create` hang. Two `store.options`
knobs bound that blast radius:

| Option | Default | Purpose |
|---|---|---|
| `operationTimeoutMs` | `120000` | Reject any single op that exceeds this instead of hanging forever. `0` disables (restores unbounded behaviour). |
| `insertChunkSize` | `25000` | Split inserts larger than this into sequential chunks so concurrent ops are serviced between chunks. `0` disables chunking. |

```jsonc
// ~/.dkg/config.json
"store": {
  "backend": "oxigraph-worker",
  "options": { "operationTimeoutMs": 120000, "insertChunkSize": 25000 }
}
```

For heavy / production workloads, prefer an out-of-process SPARQL server
(`sparql-http` or `blazegraph`), which handles reads and writes concurrently
and keeps the daemon responsive under load.

## Internal Dependencies

- `@origintrail-official/dkg-core` — configuration types, logging, constants
