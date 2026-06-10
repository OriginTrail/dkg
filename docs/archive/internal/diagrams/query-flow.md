# Query Flow

Sequence diagrams for the three query paths in DKG V9: contextGraph-scoped queries,
cross-contextGraph queries, and entity resolution (resolveKA).

Every query generates an `operationId` (UUID) at the agent entry point. Log
format: `YYYY-MM-DD HH:MM:SS query <operationId> "message"`. This enables
cross-module tracing even though queries are local-only in Part 1.

## 1. ContextGraph-Scoped Query

The primary query path. All queries run against the local store — there is no
remote/federated querying in Part 1.

```mermaid
sequenceDiagram
    actor User
    participant Agent as @origintrail-official/dkg-agent<br/>DKGAgent
    participant QueryEngine as @origintrail-official/dkg-query<br/>DKGQueryEngine
    participant Store as @origintrail-official/dkg-storage<br/>TripleStore
    participant GraphMgr as @origintrail-official/dkg-storage<br/>GraphManager

    User ->> Agent: query(sparql, contextGraphId)
    Agent ->> Agent: Generate operationId (UUID)
    Agent ->> QueryEngine: query(sparql, contextGraphId, operationId)

    QueryEngine ->> GraphMgr: contextGraphDataGraphUri(contextGraphId)
    GraphMgr -->> QueryEngine: did:dkg:context-graph:contextGraphId

    QueryEngine ->> QueryEngine: wrapWithGraph(sparql, graphUri)
    Note right of QueryEngine: Wraps the WHERE clause in<br/>a GRAPH block scoped to<br/>the contextGraph data graph.<br/>Skipped if query already<br/>contains GRAPH patterns.

    QueryEngine ->> Store: store.query(wrappedSparql)
    Store ->> Store: SPARQL execution
    Store -->> QueryEngine: raw result

    alt SELECT query
        QueryEngine ->> QueryEngine: Convert Maps to bindings
        QueryEngine -->> Agent: bindings result
    else CONSTRUCT query
        QueryEngine ->> QueryEngine: Convert to triple array
        QueryEngine -->> Agent: triples result
    else ASK query
        QueryEngine -->> Agent: boolean result
    end

    Agent -->> User: QueryResult
```

## 2. Cross-ContextGraph Query (queryAllContextGraphs)

Runs the same SPARQL against every known contextGraph and unions the results.

```mermaid
sequenceDiagram
    actor User
    participant Agent as @origintrail-official/dkg-agent<br/>DKGAgent
    participant QueryEngine as @origintrail-official/dkg-query<br/>DKGQueryEngine
    participant GraphMgr as @origintrail-official/dkg-storage<br/>GraphManager
    participant Store as @origintrail-official/dkg-storage<br/>TripleStore

    User ->> Agent: queryAllContextGraphs(sparql)
    Agent ->> Agent: Generate operationId (UUID)
    Agent ->> QueryEngine: queryAllContextGraphs(sparql, operationId)

    QueryEngine ->> GraphMgr: listContextGraphs()
    GraphMgr ->> Store: listGraphs()
    Store -->> GraphMgr: all graph URIs
    GraphMgr ->> GraphMgr: Filter did:dkg:context-graph:* URIs
    Note right of GraphMgr: Deduplicates by stripping<br/>/_meta suffix
    GraphMgr -->> QueryEngine: contextGraphIds array

    loop For each contextGraphId
        QueryEngine ->> QueryEngine: query(sparql, contextGraphId)
        Note right of QueryEngine: Same path as<br/>ContextGraph-Scoped Query above
        QueryEngine ->> Store: store.query(wrappedSparql)
        Store -->> QueryEngine: bindings for this contextGraph
        QueryEngine ->> QueryEngine: Accumulate into allBindings
    end

    QueryEngine -->> Agent: combined bindings
    Agent -->> User: Combined QueryResult
```

## 3. Entity Resolution (resolveKA)

Two-step lookup: find the KA's metadata in the meta graph, then fetch the
entity's data triples from the data graph.

```mermaid
sequenceDiagram
    actor User
    participant Agent as @origintrail-official/dkg-agent<br/>DKGAgent
    participant QueryEngine as @origintrail-official/dkg-query<br/>DKGQueryEngine
    participant Store as @origintrail-official/dkg-storage<br/>TripleStore

    User ->> Agent: resolveKA(ual)
    Agent ->> Agent: Generate operationId (UUID)
    Agent ->> QueryEngine: resolveKA(ual, operationId)

    Note over QueryEngine,Store: Step 1 — Metadata Lookup

    QueryEngine ->> Store: store.query(metadataSparql)
    Note right of QueryEngine: Queries all meta graphs for<br/>?ka dkg:rootEntity ?rootEntity<br/>?ka dkg:partOf ual<br/>ual dkg:contextGraph ?contextGraph
    Store -->> QueryEngine: rootEntity + contextGraphUri

    alt No results found
        QueryEngine -->> User: Error: KA not found for UAL
    end

    QueryEngine ->> QueryEngine: Extract contextGraphId from URI
    QueryEngine ->> QueryEngine: Compute dataGraph URI

    Note over QueryEngine,Store: Step 2 — Entity Data Fetch

    QueryEngine ->> Store: store.query(entitySparql)
    Note right of QueryEngine: Fetches all triples where<br/>subject = rootEntity OR<br/>subject starts with<br/>rootEntity/.well-known/genid/<br/>(skolemized blank nodes)

    Store -->> QueryEngine: entity triples

    QueryEngine ->> QueryEngine: Convert bindings to triples
    QueryEngine -->> Agent: rootEntity + contextGraphId + triples
    Agent -->> User: Resolved KA data
```

## Data Flow Summary

```mermaid
flowchart LR
    subgraph User_API[User API]
        Q[query]
        QA[queryAllContextGraphs]
        R[resolveKA]
    end

    subgraph DKG_Query[@origintrail-official/dkg-query]
        QE[DKGQueryEngine]
    end

    subgraph DKG_Storage[@origintrail-official/dkg-storage]
        GM[GraphManager]
        TS[TripleStore]
    end

    Q --> QE
    QA --> QE
    R --> QE

    QE -->|graph scoping| GM
    QE -->|SPARQL| TS
    GM -->|listGraphs| TS
```
