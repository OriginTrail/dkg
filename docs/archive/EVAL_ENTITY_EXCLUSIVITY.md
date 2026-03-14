# Evaluation: Entity Exclusivity vs. Shared Subject URIs

## Context

DKG V9 enforces **Rule 4 (entity exclusivity)**: within a paranet, a `rootEntity` URI can only be "owned" by one Knowledge Collection (KC) at a time. If Agent B tries to publish a KC whose manifest contains a `rootEntity` that Agent A already published, the request is rejected.

This document evaluates this design against the alternative — allowing multiple agents to publish triples about the same subject URI — with concrete examples, real-world precedents, and analysis of how each approach interacts with the DKG's ownership, merkle, update, deletion, and economic models.

---

## 1. The Two Approaches

### Approach A: Entity Exclusivity (Current)

**Rule**: one KC owns each `rootEntity` per paranet. To describe someone else's entity, publish a *new* entity that *links to* it.

```turtle
# Agent A publishes KA with rootEntity = <did:dkg:product:ABC>
<did:dkg:product:ABC> schema:name "Widget ABC" .
<did:dkg:product:ABC> schema:price "49.99"^^xsd:decimal .

# Agent B wants to review Widget ABC.
# B cannot use <did:dkg:product:ABC> as rootEntity (rejected).
# Instead, B publishes a NEW entity that links to it:
<did:dkg:agent:Bob/review/1> a schema:Review .
<did:dkg:agent:Bob/review/1> schema:about <did:dkg:product:ABC> .
<did:dkg:agent:Bob/review/1> schema:reviewRating "4"^^xsd:integer .
<did:dkg:agent:Bob/review/1> schema:author <did:dkg:agent:Bob> .
```

**Query**: to find all knowledge about Widget ABC (including reviews):
```sparql
SELECT ?s ?p ?o WHERE {
  { <did:dkg:product:ABC> ?p ?o . BIND(<did:dkg:product:ABC> AS ?s) }
  UNION
  { ?s schema:about <did:dkg:product:ABC> . ?s ?p ?o . }
}
```

### Approach B: Shared Subject URIs (Alternative)

**Rule**: multiple agents can publish triples about the same subject URI. Each agent's triples are tracked via their own KC manifest entry, but they share the subject.

```turtle
# Agent A publishes about <did:dkg:product:ABC>
<did:dkg:product:ABC> schema:name "Widget ABC" .
<did:dkg:product:ABC> schema:price "49.99"^^xsd:decimal .

# Agent B ALSO publishes about <did:dkg:product:ABC>
<did:dkg:product:ABC> schema:review <did:dkg:agent:Bob/review/1> .
<did:dkg:product:ABC> schema:aggregateRating "4.2"^^xsd:float .
```

**Query**: simpler — all facts about the subject merge automatically:
```sparql
SELECT ?p ?o WHERE { <did:dkg:product:ABC> ?p ?o . }
```

---

## 2. Detailed Comparison

### 2.1 Ownership, Updates, and Deletion

| Concern | Approach A (Exclusivity) | Approach B (Shared Subjects) |
|---|---|---|
| **Who can update?** | Clear: only the KA owner (KC creator) can call `updateKnowledgeCollection` for that rootEntity. | Ambiguous: which publisher's triples are updated? Need per-publisher triple tracking. |
| **Deletion** | Safe: burn the KA → delete all triples where `subject == rootEntity` or starts with `{rootEntity}/.well-known/genid/`. No collateral damage. | Dangerous: deleting rootEntity removes *everyone's* triples about it, or requires per-publisher deletion (complex). |
| **Transfer** | Clean: transferring a KA transfers all triples about that rootEntity. New owner has full control. | Fractured: a "transfer" only covers one publisher's triples. The same subject has triples from multiple non-transferable sources. |
| **Conflict resolution** | None needed: one publisher per entity. | Required: Agent A says `price "49.99"`, Agent B says `price "39.99"`. Which is "correct"? Needs merge strategy, trust scoring, or "latest wins." |

#### Example: The Deletion Problem

```
Scenario: Agent A publishes <did:dkg:product:ABC> with name, price, description.
          Agent B adds triples: <did:dkg:product:ABC> schema:review ... .
          Agent A burns their KA (removes their product from the graph).

Approach A: Only A's triples are deleted. B's review (a separate entity
            <did:dkg:agent:Bob/review/1>) survives because it has its own rootEntity.
            The review's schema:about link now points to a deleted entity — a
            dangling reference, but B's data is intact.

Approach B: If we delete all triples with subject <did:dkg:product:ABC>,
            B's triples are destroyed too. If we only delete A's triples,
            we need a per-publisher ownership index for every triple.
```

### 2.2 Merkle Tree Integrity

| Concern | Approach A (Exclusivity) | Approach B (Shared Subjects) |
|---|---|---|
| **KA root computation** | Well-defined: all triples with `subject == rootEntity` or skolemized children → one publisher's set. Deterministic root. | Multiple publishers contribute triples to the same subject. The KA root must either (a) cover ALL publishers' triples (but then any new publisher invalidates the root), or (b) be computed per-publisher (then "the KA" has multiple roots). |
| **On-chain verification** | One KC root covers all the entity's triples. Nodes can verify. | If Agent C adds triples to `<product:ABC>`, the on-chain root from Agent A's KC no longer covers the full triple set. Verification becomes partial. |
| **Tamper detection** | Complete: any modification to any triple under this rootEntity is detectable against the on-chain root. | Incomplete: only the *original publisher's* triples are covered by their merkle root. Additions by other publishers are covered by *their* separate roots. No single root covers "everything about this subject." |

#### Example: The Merkle Problem

```
Agent A publishes <did:dkg:product:ABC> → KC root = 0xAAA (covers A's 5 triples)
Agent B adds 3 triples about <did:dkg:product:ABC> → KC root = 0xBBB (covers B's 3 triples)

A querying agent asks: "give me all 8 triples about product:ABC."
  - Verifying 0xAAA proves A's 5 triples are authentic.
  - Verifying 0xBBB proves B's 3 triples are authentic.
  - But there is no single root for "the entity." The concept of one
    KA root per entity breaks down — or each publisher-contribution
    becomes its own KA, and "the entity" is a virtual aggregate.
```

### 2.3 Query Ergonomics

| Concern | Approach A (Exclusivity) | Approach B (Shared Subjects) |
|---|---|---|
| **Discovering all knowledge about X** | Requires UNION: direct triples about X + triples from entities that link to X via `schema:about` or similar predicates. | Natural: `?s ?p ?o WHERE { <X> ?p ?o }` returns everything. Standard RDF merge. |
| **Provenance** | Clear by construction: every triple belongs to one KC (via rootEntity → meta graph). | Needs explicit provenance: which publisher asserted which triple? Requires quad-level attribution or named-graph-per-publisher-per-subject. |
| **Aggregation** | Aggregation (e.g., "average rating of product ABC") requires querying *across* entities that link to it. Standard SPARQL, slightly more verbose. | Direct: `SELECT AVG(?rating) WHERE { <product:ABC> schema:rating ?rating }` — but results mix multiple publishers' assertions without attribution. |

#### Example: Agent Discovery

```sparql
# Approach A: "Find all agents that offer ImageAnalysis"
SELECT ?agent ?name WHERE {
  ?agent dkgskill:offersSkill ?offering .
  ?offering dkgskill:skill dkgskill:ImageAnalysis .
  ?agent schema:name ?name .
}
# Works perfectly — each agent is its own rootEntity.
# No exclusivity conflict because each agent publishes under its own URI.

# Approach A: "Find all reviews of product ABC"
SELECT ?review ?rating ?author WHERE {
  ?review schema:about <did:dkg:product:ABC> .
  ?review schema:reviewRating ?rating .
  ?review schema:author ?author .
}
# Slightly more complex than B, but standard SPARQL pattern.
```

```sparql
# Approach B: "Find all reviews of product ABC"
SELECT ?rating ?author WHERE {
  <did:dkg:product:ABC> schema:rating ?rating .
  <did:dkg:product:ABC> schema:ratedBy ?author .
}
# Simpler query, but: which publisher asserted which rating?
# No way to distinguish without extra provenance triples.
```

### 2.4 Economic Model and Incentives

| Concern | Approach A (Exclusivity) | Approach B (Shared Subjects) |
|---|---|---|
| **Token economics** | One KA token per rootEntity. Owner pays for storage, earns from private access sales. Clean 1:1 mapping. | Multiple publishers pay for triples about the same subject. Who "owns" the entity for token purposes? Do all get separate tokens? How are access fees split? |
| **Storage pricing** | Publisher pays for their entity's byte size. Predictable. | Each publisher pays for their triples. Total cost of "the entity" is the sum of all contributions. But who pays for query overhead of the merged set? |
| **Spam / griefing** | To publish about a subject, you must create a new rootEntity (your own URI). On-chain cost deters spam. | Anyone can add triples to any subject. Low cost to pollute a popular subject with noise. Needs spam prevention (allow-lists, staking, reputation). |

#### Example: The Spam Problem

```
Approach B, no safeguards:
  Agent Spammer publishes 10,000 triples about <did:dkg:product:ABC>:
    <did:dkg:product:ABC> schema:review "BUY NOW CHEAP PILLS" .
    <did:dkg:product:ABC> schema:review "CLICK HERE FOR FREE" .
    ...

  Every query for product:ABC now returns Agent A's real data
  mixed with 10,000 spam triples. No way to filter without
  per-publisher provenance and trust scoring.

Approach A:
  Spammer must create their own rootEntity for each spam review.
  The original <did:dkg:product:ABC> is untouched.
  Queries directly about <product:ABC> return only A's data.
  Spam lives in separate entities and can be filtered by
  meta graph provenance (who published it, when, reputation score).
```

### 2.5 Real-World Precedents

| System | Model | Notes |
|---|---|---|
| **Wikidata** | Shared subjects | Anyone edits any entity. Works via human curation, edit wars, vandalism detection, admin locks. Massive curation cost. |
| **DBpedia** | Shared subjects | Auto-extracted from Wikipedia. Single authoritative source (Wikipedia) means no real multi-publisher conflicts. |
| **Schema.org** | Shared vocabulary, exclusive instances | The *vocabulary* (schema:name, schema:price) is shared. Each website publishes its *own* instances with its own URIs. Google doesn't merge two websites' price claims for "the same product" — they show multiple results. |
| **Solid (Tim Berners-Lee)** | Pod-scoped exclusivity | Each user's data lives in their pod. Shared subjects exist across pods but each pod controls its own triples. Cross-pod queries aggregate but each pod is authoritative for its own claims. |
| **IPFS / Ceramic** | Content-addressed, append-only | Documents have owners. Others can create documents that reference them, but can't modify the original. Similar to Approach A. |
| **OriginTrail DKG V8** | Publisher-owned KAs | V8 already uses publisher-owned assets. V9 continues this model. |
| **DNS / ENS** | Exclusive ownership | One owner per domain name. Others can link to it but can't modify it. Universal adoption. |

**Pattern**: systems that operate in adversarial or economically-incentivized environments overwhelmingly use exclusive ownership. Systems that allow open editing (Wikidata, Wikipedia) require massive curation infrastructure to function.

---

## 3. Hybrid Approaches

If Approach A feels too restrictive but Approach B is too dangerous, there are middle grounds:

### 3.1 Endorsed Annotations (Approach A + explicit annotation protocol)

Keep entity exclusivity. Add a first-class "annotation" mechanism:

```turtle
# Agent B publishes an Annotation KA (its own rootEntity)
<did:dkg:agent:Bob/annotation/1>
    a dkg:Annotation ;
    dkg:annotates <did:dkg:product:ABC> ;
    schema:reviewRating "4"^^xsd:integer ;
    schema:reviewBody "Great product, fast shipping" ;
    prov:wasAttributedTo <did:dkg:agent:Bob> .
```

Queries can opt-in to annotations:
```sparql
SELECT ?entity ?p ?o WHERE {
  { <did:dkg:product:ABC> ?p ?o . BIND(<did:dkg:product:ABC> AS ?entity) }
  UNION
  { ?ann dkg:annotates <did:dkg:product:ABC> . ?ann ?p ?o . BIND(?ann AS ?entity) }
}
```

**Pro**: clean ownership, opt-in merge, built-in provenance.
**Con**: slightly more verbose queries (but could be abstracted by the SDK).

### 3.2 Paranet-Level Policy (Approach A default, Approach B opt-in)

Each paranet declares its subject policy:

```json
{
  "paranetId": "product-reviews",
  "subjectPolicy": "shared",
  "requiredStake": "100 TRAC"
}
```

- `"exclusive"` (default): current Rule 4 — one owner per rootEntity.
- `"shared"`: multiple publishers can add triples about the same subject, with per-publisher tracking and required stake.

This pushes the decision to paranet operators who understand their domain.

### 3.3 Layered: Exclusive Core + Open Metadata

```
Layer 1 (exclusive):  <did:dkg:product:ABC> schema:name "Widget" .
                      Only the owner can set core properties.

Layer 2 (open):       Anyone can add triples in a separate "community" graph
                      <did:dkg:paranet:products/_community>
                      with per-publisher provenance.
```

Queries against Layer 1 return authoritative data. Queries against Layer 1 + Layer 2 return the enriched, multi-source view. Users/agents choose their trust level.

---

## 4. Impact Analysis on Current Architecture

### What changes if we moved to Approach B?

| Component | Change Required | Complexity |
|---|---|---|
| **validation.ts** | Remove Rule 4 or make it conditional | Trivial |
| **Merkle tree** | Per-publisher KA roots (no single "entity root") | Medium — need composite verification |
| **Meta graph** | Multiple KA entries per rootEntity, each from different KC | Medium — schema changes |
| **Deletion** | Per-publisher deletion (only remove that publisher's triples for the subject) | High — need triple-level publisher attribution |
| **Update flow** | Each publisher updates only their triples for a subject | High — current flow assumes one publisher per rootEntity |
| **Storage model** | Need per-publisher triple tracking (quad + publisher = quint?) or per-publisher named subgraphs | High — fundamental storage model change |
| **On-chain contracts** | Multiple KA tokens for the same rootEntity from different publishers | High — KnowledgeAssets contract assumes rootEntity uniqueness per paranet |
| **Access control** | Private triples: each publisher controls access to only their private triples for a shared subject | Medium |
| **Query layer** | Need provenance-aware queries ("who said this?") | Medium |
| **Spam prevention** | New mechanism needed (staking per subject, reputation, allow-lists) | High |

**Estimated effort**: moving to full Approach B would touch every layer of the stack. It's a fundamental architectural change, not a config toggle.

---

## 5. Recommendation Matrix

| Priority | Recommendation |
|---|---|
| **Ship V9 with confidence** | Keep Approach A. It's sound, consistent with real-world systems, and avoids a class of hard problems (conflict resolution, per-triple provenance, spam). |
| **Better UX now** | Improve error messages when Rule 4 fires. Add SDK helpers for the "describe by linking" pattern (e.g., `publisher.annotate(targetEntity, triples)`). Document it prominently. |
| **Future flexibility** | Consider Approach 3.1 (endorsed annotations) as a first-class feature — it gives 80% of the UX benefit of shared subjects with none of the ownership/merkle complexity. |
| **Long-term exploration** | Approach 3.2 (paranet-level policy) is the most powerful option but should be deferred to a future version after V9 has production data on how paranets are actually used. |

---

## 6. Summary

| Dimension | Approach A (Exclusivity) | Approach B (Shared Subjects) |
|---|---|---|
| Ownership clarity | **Strong** | Weak — needs per-triple attribution |
| Update/delete safety | **Safe** — one owner, no collateral damage | Risky — cascading deletes or complex per-publisher tracking |
| Merkle integrity | **Complete** — one root per entity | Partial — multiple roots, no single verification path |
| Query simplicity | Moderate (UNION needed for cross-entity) | **Simple** for basic lookups, complex for provenance |
| Spam resistance | **Strong** — each entity costs on-chain fees | Weak — anyone can add triples to any subject |
| Economic model fit | **Clean** — 1 KA token = 1 entity = 1 owner | Messy — multiple tokens per subject, fee splitting unclear |
| RDF standards alignment | Partial (restricts open-world assumption) | **Full** (anyone can say anything about anything) |
| Real-world precedent | DNS, ENS, IPFS, Solid pods, V8 DKG | Wikidata, DBpedia (with heavy curation) |
| Implementation cost | **Already done** | High — touches every layer |

**Bottom line**: entity exclusivity is the right default for an adversarial, economically-incentivized decentralized network. The "describe by linking" pattern provides the open-world flexibility of RDF without the ownership, integrity, and spam problems of shared subjects. The main improvement is making this pattern more ergonomic (better error messages, SDK helpers, documentation).
