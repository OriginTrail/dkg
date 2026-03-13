# @origintrail-official/dkg-query

SPARQL query engine for DKG V9. Provides paranet-scoped querying, Knowledge Asset resolution by UAL, and read-only query validation.

## Features

- **DKGQueryEngine** — execute SPARQL SELECT, CONSTRUCT, ASK, and DESCRIBE queries against local triple stores
- **Paranet scoping** — queries are automatically scoped to the correct named graphs for a given paranet
- **KA resolution** — resolve a UAL to its constituent triples, metadata, and provenance
- **QueryHandler** — P2P protocol handler for serving remote SPARQL queries from other nodes
- **SPARQL guard** — `validateReadOnlySparql()` ensures incoming queries are read-only (no INSERT, DELETE, LOAD, etc.)

## Usage

```typescript
import { DKGQueryEngine } from '@origintrail-official/dkg-query';

const engine = new DKGQueryEngine(store);

const results = await engine.query({
  sparql: 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 10',
  paranetId: 'urn:paranet:example',
});
```

## Internal Dependencies

- `@origintrail-official/dkg-core` — configuration, logging, protocol streams
- `@origintrail-official/dkg-storage` — triple store access for query execution
