# @origintrail-official/dkg-storage

Triple store abstraction layer for DKG V9. Provides a unified API over multiple RDF storage backends with named graph management and private content storage.

## Features

- **Backend adapters** — pluggable triple store implementations:
  - `OxigraphStore` — embedded WASM/native store, no external dependencies
  - `OxigraphWorkerStore` — worker-thread variant for non-blocking operations
  - `BlazegraphStore` — connects to a running Blazegraph SPARQL endpoint
  - `SparqlHttpStore` — generic adapter for any SPARQL 1.1 compliant endpoint
- **Graph manager** — named graph lifecycle (create, drop, list) with paranet-scoped data and metadata graphs
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

## Internal Dependencies

- `@origintrail-official/dkg-core` — configuration types, logging, constants
