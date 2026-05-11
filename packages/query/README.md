# @origintrail-official/dkg-query

SPARQL query engine for DKG V10. Provides contextGraph-scoped querying, Knowledge Asset resolution by UAL, and read-only query validation.

## Features

- **DKGQueryEngine** — execute SPARQL SELECT, CONSTRUCT, ASK, and DESCRIBE queries against local triple stores
- **ContextGraph scoping** — queries are automatically scoped to the correct named graphs for a given contextGraph
- **KA resolution** — resolve a UAL to its constituent triples, metadata, and provenance
- **QueryHandler** — P2P protocol handler for serving remote SPARQL queries from other nodes
- **SPARQL guard** — `validateReadOnlySparql()` ensures incoming queries are read-only (no INSERT, DELETE, LOAD, etc.)

## Usage

```typescript
import { DKGQueryEngine } from '@origintrail-official/dkg-query';

const engine = new DKGQueryEngine(store);

const results = await engine.query(
  'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 10',
  { contextGraphId: 'urn:contextGraph:example' },
);

// Query with workspace data included
const wsResults = await engine.query(
  'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 10',
  { contextGraphId: 'urn:contextGraph:example', includeWorkspace: true },
);
```

## Internal Dependencies

- `@origintrail-official/dkg-core` — configuration, logging, protocol streams
- `@origintrail-official/dkg-storage` — triple store access for query execution
