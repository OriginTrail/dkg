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
  { contextGraphId: 'example', view: 'verifiable-memory' },
);

// Inspect allowed named graphs without expanding the selected scope.
const graphResults = await engine.query(
  'SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } } LIMIT 10',
  { contextGraphId: 'example', view: 'shared-working-memory' },
);
```

contextGraphId and view are authoritative for local queries. A local
`GRAPH ?g` pattern is constrained locally to the graph set resolved from those
fields; it cannot range over another context graph or memory view. Local scoped
queries reject explicit out-of-scope `GRAPH <iri>` targets and `FROM` /
`FROM NAMED` clauses because those would let caller SPARQL redefine the dataset.

Remote raw SPARQL handled by `QueryHandler` remains stricter: `GRAPH`, `FROM`,
and `FROM NAMED` clauses are rejected before execution. Structured remote
lookups such as `ENTITIES_BY_TYPE` and `ENTITY_TRIPLES` continue to build their
own internal graph patterns.

## Internal Dependencies

- `@origintrail-official/dkg-core` — configuration, logging, protocol streams
- `@origintrail-official/dkg-storage` — triple store access for query execution
