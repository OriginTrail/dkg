# Semantic entity discovery and graph queries

Entity discovery maps natural-language descriptions to candidate RDF entities.
A client can then query those entity IRIs with SPARQL. It does not merge entities,
assert `owl:sameAs`, authenticate a real-world identity, or decide whether two
records represent the same thing. Reconciliation is a subsequent application
workflow that can use these candidates plus graph facts and human review.

This opt-in capability uses a derived local SQLite vector index. The Context
Graph remains the source of truth. Search re-reads candidate documents through
the normal graph and memory-view authorization path before returning any text.

## Configure local embeddings

Add `entitySearch` to the selected DKG home's configuration and restart that
node through its normal operator workflow. Existing installations leave this
setting absent, which disables the routes. No model is downloaded automatically.

```json
{
  "entitySearch": {
    "embedding": {
      "provider": "ollama",
      "baseURL": "http://127.0.0.1:11434",
      "model": "nomic-embed-text:latest",
      "digest": "<64-character digest from your installed model inventory>",
      "dimensions": 768,
      "queryPrefix": "search_query: ",
      "documentPrefix": "search_document: "
    }
  }
}
```

The first implementation supports an explicitly configured local Ollama server
at a literal loopback address. It never falls back to a remote or billed service.
The provider checks the installed model digest before each embedding and validates
finite, nonzero vectors with the configured dimensions. A model, prefix, or
selection change produces a different index identity. A digest change is an
explicit error; update configuration and build the new index. Choose a model
whose context fits the selected entity text: inference must reject oversized
input, never silently truncate it.

## Build an entity index

Write an index specification, for example `topics.json`:

```json
{
  "contextGraphId": "research-topics",
  "view": "verifiable-memory",
  "textPredicates": ["http://schema.org/name", "http://schema.org/description"],
  "types": ["http://schema.org/DefinedTerm"]
}
```

```sh
dkg entities index topics.json
dkg entities index topics.json --restart
```

Indexing reads already available local RDF. It does not initiate synchronization,
write graph facts, or publish anything. Index administration requires the node's
operator credential (or an explicitly auth-disabled node). A scan processes up
to eight entity/source-graph pairs per request and checkpoints its keyset cursor.
Rerunning the same command resumes an interrupted scan. `--restart` starts a new
scan, reuses unchanged embeddings, updates changed documents, and removes unseen
entries only when that scan completes. Keep using the same specification to resume.

The index stores source graph, entity IRI, indexed text, its content hash, model
fingerprint, vector, and scan generation in `entity-index.db` under the selected
DKG home. It is derived state and can be rebuilt from RDF. An operator must rescan
after new content arrives; this version does not install a background scan job.

`scanComplete` describes a completed local scan, not a consistent graph snapshot
or full network coverage. Live graph edits can be missed behind the scan cursor;
rescan to discover them. Every response labels coverage `local-indexed-subset`,
`graphComplete: null` and searches `exhaustive: false`.

## Search and then use SPARQL

```sh
dkg entities search research-topics <index-id> "research about marine ecosystems" --limit 5
```

HTTP clients send `POST /api/entities/search` with:

```json
{
  "contextGraphId": "research-topics",
  "indexId": "<index-id>",
  "query": "research about marine ecosystems",
  "limit": 5,
  "timeoutMs": 2000
}
```

The result contains `entityUri`, `sourceGraph`, `text`, `contentHash`, and cosine
`score` for each candidate, plus index progress and an observation timestamp.
Search first checks current graph/view authorization, even for an empty index.
It then ranks local vectors and re-reads candidate text through `agent.query`
using the caller's identity and the index's CG/view. Deleted or changed documents
are discarded (`staleCandidates`), never returned from a stale vector record.
A permission or authority-read failure is an error, not an empty result.

Use the returned IRIs as bounded parameters in a second scoped query:

```sparql
SELECT ?entity ?name ?related WHERE {
  VALUES (?sourceGraph ?entity) {
    (<did:dkg:context-graph:research-topics/_verifiable_memory/example> <urn:topic:marine-ecology>)
  }
  GRAPH ?sourceGraph {
    ?entity <http://schema.org/name> ?name .
    OPTIONAL { ?entity <http://schema.org/isRelatedTo> ?related }
  }
}
```

Send that query with the same `contextGraphId` and `view` through the normal query
API or the bounded SELECT API. Validate/serialize RDF IRIs, not raw string
interpolation. Authorization is checked again. These two reads are not an atomic
snapshot. Rank is a discovery hint; it does not assert a relationship or truth.

`POST /api/entities/index` accepts the specification above plus `restart` and
`timeoutMs`. One successful call processes one page. Repeat until `scanComplete`
is true. Indexing requires operator permission; search follows ordinary HTTP
authentication and graph read policy.

## Bounds and failure behavior

- VM and SWM have separate index identities and authorization. WM is unsupported.
- At most 16 text predicates and 16 types; subjects must be IRIs. Empty `types`
  indexes any entity with one of the selected literal text properties.
- Maximum 32 indexes, 100,000 documents per index, 256 indexed property rows and
  16 KiB text per document. Oversized documents stop the scan without advancing
  past them; narrow the selector or split the source document.
- Query text at most 6,000 characters; `limit` 1–20. Search defaults to two seconds
  and permits up to five; index pages permit up to 30 seconds. Monotonic checks
  catch synchronous work that finishes after its deadline.
- One index page and at most two searches at a time. Excess work returns 429.
- Search uses a bounded-memory, exact cosine scan. This is not an ANN index or a
  validated 100k-entity latency claim. It revalidates at most four times the
  requested result count, capped at 80 candidates; stale candidates can reduce
  the result count. A timeout returns an error rather than partial success.
- `ENTITY_SEARCH_DISABLED`, `ENTITY_INDEX_NOT_FOUND`,
  `ENTITY_EMBEDDING_MODEL_CHANGED`, `ENTITY_DOCUMENT_TOO_LARGE`,
  `QUERY_ACCESS_DENIED`, and `QUERY_DEADLINE_EXCEEDED` are distinguishable outcomes.

Entity search is generic and does not supply an application-specific classifier.
A consumer may hydrate candidate entities, traverse relations, reconcile records,
or ask a model to reason over the returned evidence according to its own policy.

## Local validation

`test/entity-search.test.ts` exercises real Oxigraph/query-engine reads and SQLite
storage, including follow-up SPARQL, resumption, changed/deleted documents, CG/view
separation, caller propagation, denial, deadlines, embedding identity, and bounded
admission. Normal query authorization is covered by the agent's query tests.

`test/support/entity-http-fixture.mts` is an opt-in loopback integration fixture
for paired consumers: real route handlers, RDF engine, SQLite, and configured
local embeddings. It does not start a chain, peers, production authentication
middleware, or a full daemon. Supply explicit input/data/port-file paths; terminate
only the returned process when done. Production fleet/load validation remains a
separate acceptance step.
