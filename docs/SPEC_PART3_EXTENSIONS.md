# DKG V9 — Part 3: Extensions

**Status**: DRAFT v1.0  
**Date**: 2026-02-22  
**Scope**: Non-essential capabilities that enrich the core marketplace: neural queries, pipelines, visualization, V8 migration.  
**Depends on**: Part 1 (Marketplace), Part 2 (Economy)

---

## 1. Overview

These extensions are **optional packages** that agents install to gain additional capabilities. None are required for the core marketplace to function. Each extension is independently buildable and deployable.

| Package | Purpose | Depends on |
|---|---|---|
| `@origintrail-official/dkg-neural` | Hybrid symbolic+neural queries (similarity, link prediction) | core, query, storage |
| `@origintrail-official/dkg-pipeline` | Continuous knowledge graph construction from external sources | publisher, query, storage |
| `@origintrail-official/dkg-visualizer` | Interactive knowledge graph visualization | query |

---

## 2. Neural Knowledge Layer (`@origintrail-official/dkg-neural`)

### Purpose

Extend SPARQL with neural predicates: similarity search, link prediction, confidence scoring. Agents with `@origintrail-official/dkg-neural` installed gain hybrid query capabilities.

### Architecture

```
@origintrail-official/dkg-query (SPARQL engine)
  → PredicateRegistry → delegates ngdb:* calls to → @origintrail-official/dkg-neural
                                                       ├── Embedding Engine (TransE/RotatE)
                                                       ├── Vector Index (HNSW)
                                                       └── Sync Hook (listens to triple store)
```

### Neural SPARQL Predicates

| Predicate | Signature | Returns |
|---|---|---|
| `ngdb:similar` | `(referenceEntity, candidate, topK) → score` | Similarity 0.0–1.0 |
| `ngdb:predictLink` | `(subject, predicate, predicted) → confidence` | Link prediction 0.0–1.0 |
| `ngdb:confidence` | `(s, p, o) → score` | Triple plausibility 0.0–1.0 |
| `ngdb:distance` | `(entityA, entityB) → distance` | Embedding space distance |

Example:

```sparql
PREFIX ngdb: <https://dkg.origintrail.io/neural#>
SELECT ?similar ?score
WHERE {
  BIND(ngdb:similar(<http://ex.org/Alice>, ?similar, 10) AS ?score)
}
ORDER BY DESC(?score)
```

### Embedding Model as Paranet Config

The embedding model is configured **per paranet** (not per node), ensuring cross-node score comparability:

```turtle
<did:dkg:paranet:0xabc>
    dkgcap:embeddingModel [
        dkgcap:modelType dkgcap:TransE ;
        dkgcap:dimensions "200"^^xsd:integer ;
    ] .
```

All nodes in a paranet use the same model.

### Vector Index

- **HNSW** (Hierarchical Navigable Small World) for approximate nearest neighbor.
- Persistent (file-backed) for full nodes; in-memory for light nodes.
- **Sync hook**: listens for triple insert/delete events → incrementally updates embeddings.
- **Periodic full retrain**: every N triples or 24h, retrain from scratch in background.

### Pluggable Predicate Handler Interface

`@origintrail-official/dkg-query` exposes a general registration interface:

```
interface PredicateHandler {
  namespace: string                    // e.g., "https://dkg.origintrail.io/neural#"
  predicates: string[]                 // e.g., ["similar", "predictLink", ...]
  evaluate(predicate, args, context): AsyncIterable<BindingResult>
}

queryEngine.registerPredicateHandler(neuralHandler)
```

This interface is general-purpose — future packages (reasoning, temporal) can register their own predicates.

### Derivation Provenance

Neural outputs are explicitly marked as derived, not asserted:

```turtle
_:prediction1
    a ngdb:LinkPrediction ;
    ngdb:subject <http://ex.org/Alice> ;
    ngdb:predicate schema:worksFor ;
    ngdb:object <http://ex.org/Acme> ;
    ngdb:confidence "0.87"^^xsd:float ;
    ngdb:model "TransE-200d" ;
    prov:wasGeneratedBy [ a ngdb:PredictionActivity ] .
```

Agents may promote predictions to asserted triples by publishing them as new KAs.

---

## 3. Knowledge Mining Pipelines (`@origintrail-official/dkg-pipeline`)

### Purpose

Continuous knowledge graph construction from external data sources, ending with DKG publishing.

### Pipeline Stages

```
Sources → Extract → Transform → Validate → Batch → Publish
```

| Stage | Interface | Responsibility |
|---|---|---|
| **Source** | `stream(): AsyncIterable<RawItem>` | Connect to APIs, RSS, webhooks, files |
| **Extractor** | `extract(item): ExtractedData` | Entities + relations + claims from raw data |
| **Transformer** | `transform(data, ontology): Quad[]` | Map to RDF, entity resolution, URI minting |
| **Validator** | `validate(quads, shapes): Report` | SHACL shape validation |
| **Batcher** | `add(quads), flush(): KC[]` | Group into KCs (by entity/source/time) |
| **Publisher** | Uses `@origintrail-official/dkg-publisher` | Reserve UALs, publish, retry |

### Extractors

- **LLM-based**: GPT-4, Claude for unstructured text → entities + relations.
- **Rule-based**: Regex, NER for structured patterns.
- **Structured**: JSON-LD, microdata parsers for web pages.

### Configuration (YAML)

```yaml
name: climate-monitor
paranet: "did:dkg:paranet:0xclimate"
source:
  type: rss
  config: { urls: ["https://climate-news.org/feed"] }
extractor:
  type: llm
  config: { model: gpt-4o, schema: ./schemas/climate.json }
transformer:
  type: rdf-mapper
  config: { ontology: ./ontologies/climate.ttl }
validator:
  type: shacl
  config: { shapes: ./shapes/climate.ttl, onViolation: dead-letter }
batcher:
  maxTriplesPerKA: 500
  flushIntervalMs: 30000
  groupBy: entity
```

### Observability

Pipelines emit metrics: `items.received`, `triples.generated`, `validation.passed`, `validation.failed`, `kcs.published`, `publish.latency`, `errors`.

---

## 4. Visualizer (`@origintrail-official/dkg-visualizer`)

### Purpose

Interactive knowledge graph visualization for debugging, exploration, and marketplace browsing.

### Capabilities

- **Force-directed graph**: 2D/3D rendering of RDF graphs (based on existing `rdf-force-graph`).
- **Paranet browser**: Navigate paranets, explore KAs, view provenance chains.
- **Skill marketplace UI**: Browse agents, skill offerings, pricing, success rates.
- **Agent profile pages**: View an agent's skills, hosting capabilities, reputation.
- **Filtering**: By paranet, entity type, predicate, publisher, time range.
- **Export**: SVG, PNG, interactive HTML.

---

## 5. V8 Migration

### Strategy: Gradual, Non-Breaking

| Phase | Timeline | Description |
|---|---|---|
| **Coexistence** | Months 1-3 | V9 nodes join same P2P network. Same blockchain contracts (+ additions). V8 engine continues. |
| **Feature parity** | Months 3-6 | V9 reaches parity for publish/query/update. New features (marketplace, skills) V9-only. |
| **Deprecation** | Months 6-12 | V8 enters maintenance. Migration tooling ships. V9 handles V8 protocol messages. |

### Data Migration

- **On-chain**: No migration needed. KCs/KAs/paranets remain valid.
- **Off-chain**: V9 connects to same triple store (GraphDB/Blazegraph). Or: export N-Quads → import into new backend.
- **UAL format**: Unchanged. V8 UALs work in V9.

### SDK Migration

| V8 Call | V9 Equivalent |
|---|---|
| `DkgClient.asset.create(content)` | `publisher.publish(triples, { paranetId })` |
| `DkgClient.asset.get(ual)` | `query.resolveKA(ual)` |
| `DkgClient.graph.query(sparql)` | `query.sparql(sparql, { paranetId })` |
| `DkgClient.node.info()` | `node.status()` |

---

## 6. Security Notes

### Threat Model (brief)

| Threat | Mitigation |
|---|---|
| **Sybil** | Staking requirement, on-chain identity, minimum signature threshold |
| **Eclipse** | Diverse bootstrap nodes, minimum peer diversity, DHT verification |
| **Macaroon theft** | Short TTL, identity binding, rate limiting, revocation list |
| **Merkle manipulation** | Independent computation per node, multi-sig consensus, on-chain root |
| **Data poisoning** | SHACL validation, paranet curation (STAGING policy), provenance tracing |
| **Privacy leakage** | Encryption at rest, key delegates, ECDH key exchange, right-to-be-forgotten |
| **UAL squatting** | Deposit + expiry + slashing |

Full threat model should be developed as a separate document during implementation.

---

## 7. Future Work

| Item | Description |
|---|---|
| **GNN embeddings** | Graph Neural Networks (R-GCN, CompGCN) for richer embeddings |
| **Multimodal embeddings** | Graph + text + image for multimedia entities |
| **Federated embedding training** | Privacy-preserving cross-node model training |
| **Reasoning DSL** | User-defined SPARQL-based rules for alerting/response |
| **Cross-chain bridge** | Dedicated bridge nodes for UAL resolution across chains |
| **ZK-SPARQL** | Zero-knowledge proofs for query results over private data |
| **CRDTs for RDF** | Conflict-free collaborative knowledge editing |
| **Embedding marketplace** | Sell access to high-quality vector indices via x402 |

---

## 8. Work Packages

### WP-3A: Neural Layer (Developer A)

**Scope**: `@origintrail-official/dkg-neural`

| Phase | Deliverable | Weeks |
|---|---|---|
| 1 | HNSW vector index (hnswlib-node): insert, query, persist, delete | 2 |
| 2 | TransE embedding engine: training, inference, entity embedding | 2 |
| 3 | Sync hook: listen for triple insert/delete, update embeddings | 1 |
| 4 | Neural SPARQL predicates: similar, predictLink, confidence, distance. Register with PredicateHandler interface. | 2 |
| 5 | Federated neural queries: route ngdb:* to peers, merge scores | 1 |

**Total: ~8 weeks**

### WP-3B: Pipelines & Visualization (Developer B)

**Scope**: `@origintrail-official/dkg-pipeline`, `@origintrail-official/dkg-visualizer`

| Phase | Deliverable | Weeks |
|---|---|---|
| 1 | Pipeline framework: stage interfaces, configuration loader, job queue, DLQ | 2 |
| 2 | Source connectors: REST API, RSS, file watcher | 1 |
| 3 | Extractors: LLM-based (OpenAI/Anthropic), regex-based | 2 |
| 4 | Transformers + validators: RDF mapping, SHACL validation | 1 |
| 5 | Batcher + publisher integration: auto-partition, batch publish | 1 |
| 6 | `@origintrail-official/dkg-visualizer`: force-directed graph, paranet browser, agent profiles, marketplace UI | 3 |

**Total: ~10 weeks**

### Integration Milestone

**After both WPs**: End-to-end scenario:
- Pipeline agent monitors RSS feed → extracts entities → publishes KAs to climate paranet
- Another agent queries the paranet with neural predicates (ngdb:similar)
- Visualizer displays the paranet graph, agent profiles, and marketplace
- Neural embeddings are consistent across two nodes in the same paranet

---

## Appendix: Full Package Map

| Package | Part | Owner (suggested) |
|---|---|---|
| `@origintrail-official/dkg-core` | 1 | Dev A |
| `@origintrail-official/dkg-storage` | 1 | Dev A |
| `@origintrail-official/dkg-chain` (EVM) | 1 | Dev A |
| `@origintrail-official/dkg-publisher` | 1 | Dev A |
| `@origintrail-official/dkg-query` | 1 | Dev A |
| `@origintrail-official/dkg-agent` | 1 | Dev B |
| `@origintrail-official/dkg-access` | 2 | Dev B |
| `@origintrail-official/dkg-chain` (Solana) | 2 | Dev A |
| EVM contracts (delegation, channels) | 2 | Dev A |
| Solana programs | 2 | Dev A |
| Marketplace flows | 2 | Dev B |
| Self-governance | 2 | Dev B |
| `@origintrail-official/dkg-neural` | 3 | Dev A |
| `@origintrail-official/dkg-pipeline` | 3 | Dev B |
| `@origintrail-official/dkg-visualizer` | 3 | Dev B |

### Timeline Summary

| Phase | Dev A | Dev B | Weeks |
|---|---|---|---|
| **Week 0** | Joint: monorepo, types, interfaces, CI | | 1 |
| **Part 1** | core, storage, chain(EVM), publisher, query | agent, skills, messaging, framework adapters | 9 |
| **Part 2** | EVM+Solana contracts, chain(Solana) | access, payments, marketplace, governance | 13 |
| **Part 3** | neural | pipeline, visualizer | 10 |
| **Integration** | Joint: testnet deploy, security review, launch prep | | 3 |
| **Total** | | | **~36 weeks** |

Parts 2 and 3 can overlap: Dev A starts Solana programs while Dev B works on access control. Part 3 work begins as Part 2 stabilizes. Realistic timeline with overlap: **~26 weeks**.
