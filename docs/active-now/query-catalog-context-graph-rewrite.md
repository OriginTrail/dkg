# Query Catalog Context Graph Rewrite

## Goal

Make a query catalog ordinary Context Graph data. Catalog definitions live in
the registered `meta` subgraph as Knowledge Asset assertions, and each saved
query points to the Context Graph or subgraph it is allowed to query.

The catalog endpoint is a semantic API. It must not expose generic RDF storage
operations or require triple-store-specific subject replacement.

## Invariants

1. New catalog writes target `<context-graph>/meta/assertion/...`; the old
   `<context-graph>/meta/query-catalog` graph is never a write target.
2. `prof:scopeGraph` is the canonical execution scope and contains a Context
   Graph or registered subgraph IRI. `prof:forSubGraph` is transitional only.
3. A write contains one or more read-only `prof:SavedQuery` subjects and at
   most one `prof:QueryCatalog` subject, all owned by the target Context Graph.
4. Writes use the normal assertion lifecycle. No store `insert`, SPARQL update,
   subject replacement, or graph replacement is part of catalog persistence.
5. The normalized payload is content-addressed. An exact retry is a no-op or
   repairs missing triples; conflicting content for an existing logical query
   fails with HTTP 409 before a new assertion is created.
6. Reads apply the Context Graph authorization boundary and merge the `meta`
   subgraph across WM, SWM, and VM.

## Data shape

```turtle
@prefix prof: <http://dkg.io/ontology/profile/> .

<urn:dkg:profile:CG:catalog:operations>
  a prof:QueryCatalog ;
  prof:scopeGraph <did:dkg:context-graph:CG/orders> ;
  prof:forSubGraph "orders" .

<urn:dkg:profile:CG:query:configuration-trace>
  a prof:SavedQuery ;
  prof:scopeGraph <did:dkg:context-graph:CG/orders> ;
  prof:forSubGraph "orders" ;
  prof:inCatalog <urn:dkg:profile:CG:catalog:operations> ;
  prof:sparqlQuery "SELECT ..." .
```

The `meta` subgraph is where the catalog definition is stored. `scopeGraph`
identifies the data graph used when the saved query runs; these are separate
concepts and must not be inferred from the assertion graph name.

## Delivery phases

### Phase 1: safe persistence boundary

- Route new writes through `assertion.create`, `assertion.write`, and
  `subGraphName: "meta"`.
- Accept a complete multi-query catalog batch for integrations such as
  Kamstrup.
- Add canonical `scopeGraph` triples when a transitional client sends only
  `forSubGraph`.
- Read normal Context Graph layers and temporarily merge the exact legacy
  direct graph.
- Return a versioned schema with canonical items and validated graph scopes.
- Reject mutation modes and logical-query collisions.

### Phase 2: client and data migration

- Update external catalog producers to write `scopeGraph` directly.
- Change the Kamstrup harness from stale-value/upsert testing to immutable
  current-catalog write plus exact-retry/idempotency testing.
- Provide an explicit migration command that reads the legacy direct graph,
  validates it, writes one normal `meta` assertion, verifies parity, and emits
  a receipt. The migration must not silently delete the legacy source.

### Phase 3: revisions and sharing

- Design revisions at the catalog assertion level before enabling edits. The
  design must define ordering, concurrent writers, rollback, and which revision
  is active without reintroducing subject replacement.
- Expose explicit assertion lifecycle actions for sharing a catalog to SWM or
  publishing it to VM. Saving a local catalog remains WM by default.
- Replace raw quad input with a typed catalog request after downstream clients
  have migrated.

### Phase 4: remove compatibility paths

- Remove `prof:forSubGraph` write-back after all supported clients understand
  `scopeGraph`.
- Remove legacy direct-graph reads only after migrated nodes report parity and
  the agreed compatibility window closes.

## Acceptance gates

- Unit: scope IRI validation, read-only SPARQL, managed subjects/predicates,
  multi-query batches, retry repair, conflicts, and concurrent writers.
- Route: authorization before reads, WM/SWM/VM merge, response row/byte limits,
  disconnect cancellation, and no direct store mutation.
- Client: CLI, node UI, and OpenClaw decode schema v2 and execute the saved view
  and scope exactly.
- Integration: Kamstrup writes its complete seven-query catalog into `meta`,
  repeats the same request idempotently, reads seven canonical entries, and
  executes all parameterized queries against the intended Context Graph.
