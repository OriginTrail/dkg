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

## Shared-memory attribution across subgraphs

For a CG-wide attribution query, omit `view` and send
`{ contextGraphId, includeContextGraphPartitions: true, includeSharedMemoryMeta: true }`.
The opt-in extends `GRAPH ?g` to the root and registered subgraphs' exact
`/_shared_memory_meta` partitions. Known child Context Graphs, unregistered
subgraphs, private graphs, and staging partitions remain excluded. It does not
widen explicit `GRAPH <iri>` targets or an SWM-only `graphSuffix` route.
The default partition policy is unchanged, including existing root metadata
access. Agent/API callers still need CG and SWM read admission.

The same options are accepted by `/api/query`, the CLI API client, and MCP's
`dkg_query` tool. The attribution legend and VM anchor hooks use this server
scope instead of scanning URI prefixes in the browser.

To check the real workflow on an existing local devnet, run from the repository root:

```sh
DKG_DEVNET_API_URL=http://127.0.0.1:9201 \
DKG_DEVNET_AUTH_FILE=.devnet/node1/auth.token \
node scripts/devnet-test-shared-memory-metadata.mjs
```

This creates five agents, a unique public CG with four registered subgraphs,
and a child CG on the local chain. It shares actual KAs, verifies five distinct
contributors while excluding the child, and checks that ordinary query results
remain unchanged. The native CLI integration test runs the same HTTP scenario
against an isolated daemon, Hardhat chain, and Oxigraph worker.

## Internal Dependencies

- `@origintrail-official/dkg-core` — configuration, logging, protocol streams
- `@origintrail-official/dkg-storage` — triple store access for query execution
