# `dkg_propose_same_as` reconciliation flow — design

**Investigation date:** 2026-04-18
**Status:** specification only — not implemented in Phase 7. Targeted for Phase 8.

## The problem

The look-before-mint protocol (`packages/mcp-dkg/templates/ontologies/coding-project/agent-guide.md` § "Look-before-mint") has agents call `dkg_search` before minting any new `urn:dkg:<type>:<slug>` URI. That works perfectly when the search is "before" — i.e. the candidate URI already exists in the graph and `dkg_search` returns it.

Two failure modes remain:

1. **Concurrent mint race.** Agent A on machine 1 and Agent B on machine 2 both decide to discuss a brand-new concept at the same moment. Both `dkg_search` queries fire before either's mint has propagated via gossip. Both mint independently. Now the graph has two URIs for the same concept (slug variations like `tree-sitter` vs `treesitter` arise because slug normalisation is deterministic but the underlying *labels* the agents chose may differ slightly — `Tree-sitter` and `Tree sitter` both normalise to `tree-sitter`, but `tree-sitter parser` normalises to `tree-sitter-parser`).

2. **Synonyms an agent doesn't recognise.** Agent A mints `urn:dkg:concept:incremental-parsing`. Agent B refers to the same idea as `urn:dkg:concept:reactive-reparsing`. Slug normalisation doesn't catch this — the labels are different even though the concepts are equivalent.

Both failure modes leave the graph technically correct (two distinct URIs for two distinct labels) but practically fragmented (queries that should aggregate across the concept now miss half the data).

## The Linked Data answer

`owl:sameAs`. RDF semantics: `<a> owl:sameAs <b>` means the two URIs denote the same entity, and reasoners + SPARQL endpoints with `owl:sameAs` inference enabled treat them as one. This is the canonical mechanism; we don't need to invent anything.

But: `owl:sameAs` is a strong claim. Asserting it incorrectly is hard to undo (every triple about A bleeds onto B). So we want a **propose → human-review → ratify** flow, not unilateral agent merging.

## Proposed mechanism

A new MCP tool **`dkg_propose_same_as`** that any agent can call when it suspects two URIs refer to the same entity. It writes a marker entity (`dkg:SameAsProposal`), NOT an `owl:sameAs` triple. The human reviews via the node-ui and ratifies — at which point a real `owl:sameAs` triple gets written to SWM (and optionally promoted to VM for permanence).

### Tool signature

```typescript
dkg_propose_same_as({
  uriA: string,                  // first URI (the one the agent considers "canonical")
  uriB: string,                  // second URI (the duplicate)
  rationale: string,             // why the agent thinks they're the same entity
  evidence?: {                   // optional supporting context
    overlappingProperties?: string[];   // predicates A and B both have with matching values
    sharedNeighbours?: string[];        // entities both A and B link to
    detectedBy?: 'slug-similarity' | 'shared-neighbour-overlap' | 'agent-judgement';
  },
  projectId?: string,
})
```

### Triples written

Marker only — never `owl:sameAs` itself:

```
<urn:dkg:same-as-proposal:<rand>>  rdf:type           dkg:SameAsProposal
<urn:dkg:same-as-proposal:<rand>>  dkg:proposesSameAs (<uriA>, <uriB>)
<urn:dkg:same-as-proposal:<rand>>  dkg:rationale      "<rationale>"
<urn:dkg:same-as-proposal:<rand>>  prov:wasAttributedTo <agent>
<urn:dkg:same-as-proposal:<rand>>  dcterms:created    <now>
<urn:dkg:same-as-proposal:<rand>>  dkg:status         "pending"
```

Auto-promoted to SWM so curators on every node see it. Curator UI surfaces these in a "Pending reconciliations" panel.

### Curator ratification

In the node-ui:

1. Pending reconciliations show as a list with:
   - The two URIs side-by-side
   - Their property tables diffed (overlap highlighted)
   - The rationale + agent attribution
   - The marker's URI
2. Three actions per row:
   - **Confirm** → daemon writes `<uriA> owl:sameAs <uriB>` to a new `same-as` assertion in `meta`, auto-promotes to SWM, marks the proposal `status = "confirmed"`.
   - **Reject** → marks `status = "rejected"` with optional `dkg:rejectionReason` literal.
   - **Defer** → leaves `status = "pending"` and marks `dkg:deferredUntil <iso-date>` for a later look.

3. Optional: bulk-confirm for high-confidence groups (e.g. all proposals where slug normalisation detects a likely typo variant).

### Querying with reconciliation

Once `<a> owl:sameAs <b>` exists, any client query that wants to aggregate across reconciled URIs uses one of:

- **SPARQL with property paths**: `?subj (owl:sameAs|^owl:sameAs)* ?canonicalSubj` to walk equivalence sets.
- **Daemon-side reasoner pass**: extend `/api/query` to optionally apply `owl:sameAs` inference before returning results. Cheaper for the client; defaultable per-query.

### Detection helpers

`dkg_propose_same_as` is the human-facing tool, but agents need a way to *find* duplication candidates. Two helpers worth shipping alongside:

- **`dkg_find_duplicate_candidates({ projectId? })`** — runs a periodic batch SPARQL that flags entity pairs with high property/neighbour overlap. Returns a ranked list. Agents can call this opportunistically, then `dkg_propose_same_as` for the highest-confidence pairs.
- **Slug-collision detection in capture-chat hook** — when the regex backstop sees a URI in turn text that doesn't exist in the graph but whose normalised slug matches an existing entity, log a candidate proposal. Operator can review the log.

## Phase 8 implementation order

1. **Daemon:** add `dkg:SameAsProposal` to the `meta/project-ontology` ontologies (one-line ttl addition each), define the marker URI pattern.
2. **MCP:** implement `dkg_propose_same_as` and `dkg_find_duplicate_candidates` as new tools in `packages/mcp-dkg/src/tools/annotations.ts`. Reuse existing `writeAssertion` + `promoteAssertion` patterns.
3. **node-ui:** add a "Reconciliation" panel under the project view that lists pending proposals + provides Confirm/Reject/Defer actions. The Confirm action calls a new daemon helper that writes `owl:sameAs` to a `meta/same-as` assertion.
4. **Daemon:** optionally extend `/api/query` with an `applySameAs: boolean` parameter that pre-rewrites the query to walk `owl:sameAs` equivalence classes.
5. **AGENTS.md update:** add a section explaining when an agent should call `dkg_propose_same_as` vs `dkg_find_duplicate_candidates`.

Estimated effort: ~1 day for v0 (steps 1-3 + a minimal AGENTS.md note); steps 4-5 polish over an additional day.

## Why we didn't ship it in Phase 7

Phase 7's scope is the **annotation pathway**: agents emit triples per turn, the graph grows, look-before-mint keeps URIs converged at write time. Reconciliation is the **repair pathway** — the cleanup for the rare cases where look-before-mint loses a race. Implementing the repair pathway before the write pathway has any real production data to repair would be premature optimisation; we'd be designing for a problem we haven't yet observed in practice.

The cleaner sequencing is: ship Phase 7, run real multi-agent sessions for a week, see what fragmentation patterns actually emerge, then design `dkg_propose_same_as` against the empirical evidence. The spec above is a starting point; the data will sharpen it.
