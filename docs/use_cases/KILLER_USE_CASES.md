# DKG V9 Killer Use Cases

**Status**: Draft  
**Date**: 2026-02  
**Purpose**: Explain where the DKG shines (shared-by-default, multi-party knowledge), give concrete examples, and **analyse the current DKG V9 codebase** for missing features and problematic designs per use case.

---

## 1. AI Agents as the Dominant User

**Feedback**: The dominant user of the DKG will be **AI agents**, not legacy enterprise systems. Use cases should be framed accordingly.

**We agree.** The use cases below are written so that:

- **Primary actors** are agents (publishers, queriers, verifiers, skill providers). Humans and legacy systems interact via agents or APIs that agents call.
- **Value** is in shared, machine-readable knowledge that many agents read and write: discovery, provenance, cross-agent query, skills, and verified claims.
- **“Legacy” use cases** (supply chain, credentials, compliance) remain valid but are framed as **agent-mediated**: e.g. “agents publish and query supply-chain attestations” rather than “ERP exports events to the DKG.”

Sections 3–9 describe each use case with examples and **DKG V9 gap analysis**. Section 10 reframes them in an **AI-agent-first** way and calls out design risks (including **entity exclusivity** for supply chain / EPCIS).

---

## 2. How the DKG Shines (Blockchain-Style)

The DKG is most valuable when:

- **Data is shared by default** — one (or a few) graph(s) that many parties read and write.
- **Provenance and verification matter** — who said what, when; merkle/chain-backed.
- **Graph + semantics** — relationships, ontology, cross-query, not just key-value.
- **Multi-party write** — many issuers, attestors, publishers; no single gatekeeper.

So “killer” = **shared, verifiable, graph-shaped knowledge** as infrastructure. The following use cases are evaluated against the current V9 implementation for fit and gaps.

---

## 3. Supply Chain & Provenance

### 3.1 Description

One traceability graph: products, batches, events, attestations (certifications, audits, transfers). Producers, carriers, retailers, regulators, and consumers (or their agents) read and write. Value = shared view of “where did this come from, who attested what.”

### 3.2 Examples

- **Product journey**: Manufacturer publishes batch `urn:epc:batch:ABC`. Carrier publishes event “batch ABC arrived at warehouse W1 at T1.” Retailer publishes “batch ABC on shelf at store S1.” All reference the same batch; queries like “full history of batch ABC” merge events from multiple publishers.
- **Certifications**: Certifier publishes attestation “product P meets standard X.” Brand and regulators query the same graph.

### 3.3 DKG V9 Analysis

| Aspect | Current state | Gap / risk |
|--------|----------------|------------|
| **Multi-party events** | Publish is per-publisher; each KC has manifest with rootEntities. | **Entity exclusivity (Rule 4)** — see §10.1. |
| **EPCIS-style** | Events can be modelled as **one event = one rootEntity** (e.g. `did:dkg:event:carrier-123`) linking to product/batch URI. That pattern is **compatible** with Rule 4. | If the requirement is “multiple parties add **triples whose subject is the same product URI**” (e.g. `urn:epc:id:sgtin:...`), then Rule 4 **blocks** it: only the first publisher can use that URI as rootEntity. |
| **Provenance** | Meta graph has `rootEntity`, `partOf` (KC UAL), publisher. | Good for “who published this entity.” No first-class **event time** or **event type** in core validation. |
| **Discovery** | Paranets, listParanetsFromChain, sync. | Sufficient for “which paranets exist.” No standard **supply-chain ontology** or EPCIS mapping in codebase. |

**Conclusion**: For **event-centric** supply chain (each event = own rootEntity, link to object), V9 is fine. For **object-centric** (many parties adding attributes/events about the **same** object URI), Rule 4 is a **problem**. See §10.1 and [EVAL_ENTITY_EXCLUSIVITY.md](../EVAL_ENTITY_EXCLUSIVITY.md).

---

## 4. Verifiable Credentials & Attestations

### 4.1 Description

Credentials (degrees, employment, certifications) as a graph of attestations. Issuers publish; holders reference; verifiers (or agents) query. Shared credential layer, not per-app silos.

### 4.2 Examples

- **Degree**: University publishes KA with rootEntity `did:dkg:credential:degree-123`, triples “holder, degree type, date, revocation list ref.” Employer’s agent queries by UAL or entity type.
- **Employment**: Company publishes attestation “Alice worked here 2020–2024.” Multiple verifiers use the same graph.

### 4.3 DKG V9 Analysis

| Aspect | Current state | Gap / risk |
|--------|----------------|------------|
| **One credential = one entity** | One rootEntity per credential fits exclusivity. Issuer “owns” that credential entity. | No conflict with Rule 4. |
| **Revocation** | Update flow exists (publisher can update their KA). | No standard **revocation** ontology or “status list” pattern in core. |
| **Discovery** | ENTITIES_BY_TYPE, SPARQL_QUERY (opt-in). Cross-agent query supports “find credentials of type X.” | Sufficient. No built-in **credential schema** (e.g. W3C VC) in codebase. |
| **Privacy** | Private triples supported; access protocol for requesting private portion. | Good for “sensitive claims in private store.” No selective disclosure / ZK in core. |

**Conclusion**: V9 supports credential-as-KA and cross-agent query. Missing: standard credential/revocation ontology, optional ZK/selective disclosure.

---

## 5. AI Training Data & Attribution

### 5.1 Description

Graph of datasets, licenses, model lineages: “this model was trained on these sources; these providers attested this license.” Regulators, rights holders, and model providers query the same attribution graph.

### 5.2 Examples

- **Model card**: Publisher publishes KA “model M, training datasets D1–D3, license L.” Each dataset can be UAL or external ref.
- **Lineage**: Agent A publishes “run R used dataset D”; Agent B publishes “model M produced by run R.” Queries: “what datasets fed model M?”

### 5.3 DKG V9 Analysis

| Aspect | Current state | Gap / risk |
|--------|----------------|------------|
| **Attribution links** | Entities can reference other entities (by URI). No exclusivity on **object** of a triple. | Fine: “model M” has rootEntity; “dataset D” has another; “M schema:trainingData D” is just a triple. |
| **Provenance** | Merkle roots, UAL, publisher in meta. | Good for integrity. **Verified KAs** (SPEC_VERIFIED_KAS) would add claim verification — not yet implemented. |
| **Query** | SPARQL, ENTITY_BY_UAL, ENTITIES_BY_TYPE. | Sufficient for lineage and attribution queries. |
| **Scale** | Large manifests (many KAs per KC). | Batch mint supports multiple rootEntities per publish. No specific “dataset registry” in codebase. |

**Conclusion**: V9 fits attribution and lineage. Verified KAs would strengthen “attested claim” use case; currently only drafted.

---

## 6. Scientific & Research Knowledge

### 6.1 Description

Papers, datasets, replications, citations as a shared graph. Institutions, tools, and agents read and write. Value = discovery, replication, meta-science.

### 6.2 Examples

- **Citation**: Paper entity links to dataset entity and other papers. “Find all papers that cite dataset D.”
- **Replication**: Lab B publishes “replication of experiment E with outcome O.” Same E (or new entity linking to E) as subject of discussion.

### 6.3 DKG V9 Analysis

| Aspect | Current state | Gap / risk |
|--------|----------------|------------|
| **Citations** | Model as triples: paper P `schema:citation` dataset D. Each P and D can be own rootEntity. | No Rule 4 issue. |
| **Multiple assertions about same paper** | If “paper” is one canonical URI and many parties add metadata (citations, reviews, replication status), that would be shared-subject. | **Entity exclusivity** would force “each assertion is its own entity linking to paper” — same pattern as reviews in EVAL_ENTITY_EXCLUSIVITY. |
| **Ontology** | Ontology paranet exists; no research-specific ontology in core. | Community can define; no gap in engine. |
| **Query** | SPARQL, cross-agent query. | Adequate. |

**Conclusion**: Citation and replication work with “entity-per-assertion + link to canonical ref.” Full shared-subject “everyone edits same paper entity” would need a different policy (see EVAL doc).

---

## 7. DePIN / IoT & Sensor Data

### 7.1 Description

Device identity and data: calibration, ownership, readings. Fleet operators, insurers, regulators, and apps consume. One shared view of “what this device is and what it reported.”

### 7.2 Examples

- **Device registration**: Manufacturer publishes “device D, type T, calibration C.” Operator publishes “D assigned to fleet F.”
- **Readings**: Each reading can be an entity (e.g. `did:dkg:sensor:D/reading/ts-123`) or a time-series structure under one rootEntity.

### 7.3 DKG V9 Analysis

| Aspect | Current state | Gap / risk |
|--------|----------------|------------|
| **One device, many publishers** | If “device D” is one rootEntity, only first publisher can own it. | **Exclusivity**: others must use separate entities (e.g. “assignment,” “reading batch”) that **link to** D. Same as supply chain: event-centric = OK; object-centric = blocked. |
| **Time-series** | No native time-series or aggregation in core. | Store as triples (e.g. observation entities); query via SPARQL. No optimized path. |
| **Identity** | Agent identity, profile, paranet. | No **device identity** spec in codebase; could be modelled as agent or custom ontology. |

**Conclusion**: Event/assertion-per-entity pattern works. Single shared “device” entity updated by many parties would require relaxing or scoping Rule 4 (e.g. paranet-level policy per EVAL).

---

## 8. Cross-Platform Identity & Reputation

### 8.1 Description

Identity and reputation graph: “this entity, these attributes, these attestations.” Many apps and agents read and write. Portable identity/reputation.

### 8.2 Examples

- **Agent profile**: Agent publishes profile (skills, paranetsServed, name). Other agents discover via agents paranet and findSkills.
- **Reputation**: Different parties publish attestations (“A completed task T,” “A has rating R”). All reference the same identity URI or a canonical agent entity.

### 8.3 DKG V9 Analysis

| Aspect | Current state | Gap / risk |
|--------|----------------|------------|
| **Agent profile** | Profile is one rootEntity per agent (`did:dkg:agent:{peerId}`). One publisher (the agent). | Fits exclusivity. |
| **Skills** | Skills in profile; findSkills, invokeSkill. Cross-agent query for skills. | Good for agent-first use. |
| **Reputation from others** | If “Alice” is rootEntity and only Alice can publish it, then “Bob attests Alice is reliable” must be Bob’s entity (e.g. `did:dkg:attestation:Bob-alice-1`) linking to Alice. | Same “describe by linking” pattern. Queries need UNION/link traversal. |
| **Discovery** | Agents paranet, listParanets, sync. | Sufficient. |

**Conclusion**: V9 supports agent-centric identity and attestations-by-linking. No built-in “reputation score” or “consensus” layer — can be built on top.

---

## 9. Regulatory & Compliance Audit Trail

### 9.1 Description

What’s regulated, what’s been attested, what’s the status. Regulators, firms, and auditors read (and sometimes write) the same graph. Shared compliance ledger.

### 9.2 Examples

- **Attestation**: Firm publishes “we attest compliance with rule R for period P.” Regulator’s agent queries all such attestations.
- **Status**: Multiple parties update “status of entity E” — e.g. approved / under review. If E is one rootEntity, only one publisher can own it.

### 9.3 DKG V9 Analysis

| Aspect | Current state | Gap / risk |
|--------|----------------|------------|
| **Attestation per publisher** | Each attestation = own rootEntity. Links to regulation, entity, period. | Fits Rule 4. |
| **Shared “status” on same entity** | If the same entity (e.g. “license L”) must get status updates from regulator, auditor, and firm, that’s multi-publisher on one subject. | **Exclusivity** would require “status event” entities (each with own rootEntity) linking to L, not triples with subject L. |
| **Immutability** | Merkle, chain. Append/update by owner. | Good. No “append-only log” primitive; can model as event entities. |

**Conclusion**: Event/attestation-per-entity works. Shared “living document” per entity would need design (event log vs. paranet-level shared policy).

---

## 10. Design Analysis: Entity Exclusivity and EPCIS

### 10.1 What is Entity Exclusivity?

**Rule 4** in `packages/publisher/src/validation.ts`: within a paranet, no manifest `rootEntity` may already exist as a live KA. So **one publisher “owns” each rootEntity** in that paranet; others cannot publish a new KC that uses the same rootEntity.

- **Code**: `existingEntities.has(m.rootEntity)` → reject with “Rule 4: rootEntity … already exists in paranet …”.
- **Ownership**: `ownedEntities` in publisher and publish-handler tracks which rootEntities are already taken per paranet.

Full evaluation: [EVAL_ENTITY_EXCLUSIVITY.md](../EVAL_ENTITY_EXCLUSIVITY.md).

### 10.2 Is Exclusivity a Problem for Supply Chain / EPCIS?

**EPCIS** (GS1): multiple parties create **events** about the same physical/digital object (What, When, Where, Why, How). The same EPC/serial number appears in many events from different organizations.

- **Event-centric model** (fits V9): Each **event** is its own rootEntity (e.g. `did:dkg:event:carrier-456` or `urn:epc:event:...`). Event triples **link to** the object (e.g. `epcis:object urn:epc:id:sgtin:...`). No one “owns” the object URI as rootEntity; everyone publishes **events** that reference it. **Rule 4 is not a problem** — object is not the rootEntity.
- **Object-centric model** (clashes with V9): The **product/batch URI** is the subject of triples, and multiple parties add triples about it (e.g. “batch ABC received at W1,” “batch ABC shipped from W2”). Then the **first** publisher to use `urn:epc:id:...` as rootEntity “owns” it; others are **rejected** by Rule 4.

So:

- **If** the use case is “each party publishes its own **events** (own rootEntity) that reference the same object → aggregate events by object in query,” **V9 is fine**.
- **If** the use case is “multiple parties add **triples with the same object as subject**” (true shared subject), **V9’s Rule 4 is a problem**.

**Recommendation**: Document the **event-centric** pattern as the supported supply-chain/EPCIS pattern; clarify that “one object, many triples from many parties” would require a paranet-level shared-subject policy (see EVAL §3.2) or first-class “annotation”/“event” entities (EVAL §3.1). Consider SDK helpers for “publish event about object X” so event-centric is ergonomic.

---

## 11. AI-Agents-First Reframe

### 11.1 Why Agents First?

- **Scale**: More automated publishers and queriers than human-operated UIs.
- **Interop**: Agents need shared knowledge to coordinate (skills, capabilities, attestations).
- **Trust**: Verified KAs and provenance matter most when decisions are automated.
- **Discovery**: findSkills, cross-agent query, ENTITIES_BY_TYPE are agent-oriented primitives.

### 11.2 Use Cases Reframed for Agents

| Use case | Legacy framing | Agent-first framing |
|----------|----------------|----------------------|
| Supply chain | “ERP exports EPCIS to DKG” | Agents publish and query traceability events; other agents aggregate and reason over provenance. |
| Credentials | “Issuer issues VC to holder” | Issuer agent publishes credential KA; verifier agents query by type/UAL; holder agent references. |
| AI attribution | “Model card with dataset refs” | Agents publish lineage and licenses; regulator/rights-holder agents query and verify. |
| Research | “Institutions share papers” | Agents publish citations and replications; discovery and meta-analysis agents query. |
| DePIN | “Devices report to platform” | Device/operator agents publish identity and readings; fleet/insurer agents query. |
| Identity/reputation | “User profile and reviews” | Agent profiles and skill discovery; attestation agents publish; query agents aggregate. |
| Compliance | “Firm submits attestation” | Firm/regulator agents publish and query attestations; audit agents traverse the graph. |

### 11.3 Gaps for Agent-First

| Need | Current state | Gap |
|------|----------------|-----|
| **Structured agent discovery** | findSkills, profile in agents paranet. | Good. No standard “capability” or “task” ontology; skills are free-form. |
| **Cross-agent query** | Protocol and lookup types (ENTITY_BY_UAL, ENTITIES_BY_TYPE, SPARQL_QUERY). | Implemented. Rate limits and payment hooks exist; payment not enforced. |
| **Invoke skill** | invokeSkill(offering, input). | Present. No standard skill I/O schema. |
| **Verified claims** | SPEC_VERIFIED_KAS. | Draft only; not in codebase. |
| **Natural language → query** | Node UI chatbot, LLM. | Optional; not core. Agents may need NL→SPARQL or structured templates. |
| **Entity exclusivity** | Rule 4 enforced. | Event-centric patterns work; object-centric multi-publisher needs doc or policy option. |

---

## 12. Summary Table: Use Case vs. V9 Fit

| Use case | Examples | Rule 4 / exclusivity | Other gaps |
|----------|----------|------------------------|------------|
| Supply chain | Batch/event traceability, certifications | **OK** if event-per-rootEntity; **blocker** if same object URI as rootEntity by many. | EPCIS/ontology not in core. |
| Credentials | Degrees, employment, attestations | OK (one credential = one entity). | Revocation ontology, ZK optional. |
| AI attribution | Model cards, lineage, licenses | OK (link entities). | Verified KAs not implemented. |
| Research | Citations, replications | OK (entity-per-assertion + link). | Research ontology community. |
| DePIN / IoT | Device id, readings, assignments | OK if event/reading = own entity. | No device identity or time-series primitive. |
| Identity/reputation | Agent profile, skills, attestations | OK (describe by linking). | No reputation consensus layer. |
| Compliance | Attestations, status | OK (attestation = entity). | Shared “status” on one entity needs event log or policy. |

---

## 13. References

- [EVAL_ENTITY_EXCLUSIVITY.md](../EVAL_ENTITY_EXCLUSIVITY.md) — Rule 4, shared-subject alternatives, hybrid options.
- [SPEC_CROSS_AGENT_QUERY.md](../specs/SPEC_CROSS_AGENT_QUERY.md) — Remote query protocol.
- [SPEC_VERIFIED_KAS.md](../SPEC_VERIFIED_KAS.md) — Verified claims (draft).
- [SPEC_PARANET_LIFECYCLE.md](../specs/SPEC_PARANET_LIFECYCLE.md) — Paranet creation and discovery.
- `packages/publisher/src/validation.ts` — Rule 4 implementation.
