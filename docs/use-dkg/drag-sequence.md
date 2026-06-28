# dRAG — request → answer sequence

How a natural-language question becomes a grounded, verifiable answer (OT-RFC-55).
Two flows: a single node (`scope:local`, the semantic-retrieval demo) and the
cross-node fan-out (`scope:network`).

> **Preview in VS Code:** open the Markdown preview (`⇧⌘V`). If the diagrams show as
> code, install the **“Markdown Preview Mermaid Support”** extension (bierner.markdown-mermaid).

---

## 1. Single node — `scope:local`, `retrieval:semantic`

This is the exact path a UI question takes on `drag-sem-demo`.

```mermaid
sequenceDiagram
    autonumber
    actor U as You (DragAskView)
    participant API as node-ui api.ts
    participant R as Route /api/answer
    participant A as Agent dragAnswerLocal
    participant Ret as Retriever + MiniLM
    participant VS as VectorStore (SQLite)
    participant TS as Triple store (oxigraph/SPARQL)
    participant CH as Chain (EVM reads)

    Note over U,R: 1 — Request
    U->>API: answerQuestion(q, cg="drag-sem-demo", scope=local, retrieval=semantic)
    API->>R: POST /api/answer (Bearer token)
    Note over R: payments off, price gate skipped
    R->>R: resolveSemanticEmbedder(config) to MiniLM, cache retriever
    R->>A: dragAnswerLocal(q, cg, retriever)

    Note over A,CH: 2 — Bind to chain (+ injection guard)
    A->>A: validateContextGraphId(cg) ok
    A->>CH: getContextGraphOnChainId(cg)
    CH-->>A: cgId = 8

    Note over A,VS: 3 — Semantic retrieval (neurosymbolic)
    A->>Ret: retrieve(q, cg, maxKas)
    Ret->>TS: count distinct VM (graph,subject) pairs
    TS-->>Ret: N
    Ret->>VS: count(cg, model, layer=vm)
    VS-->>Ret: M
    alt first call, M < N — build the index
        Ret->>TS: enumerate VM triples (SPARQL)
        TS-->>Ret: graph/subject/predicate/object rows
        Ret->>Ret: renderEntityText per entity, MiniLM.embed (~10s)
        Ret->>VS: insert entity vectors
    end
    Ret->>Ret: MiniLM.embed(question) to 384-d vector
    Ret->>VS: search(vec, layer=vm, model, limit)
    VS-->>Ret: top-K anchors (cosine)
    Ret-->>A: anchors [initech, hooli, ...]

    Note over A,CH: 4 — Graph expand + verify each citation
    A->>TS: dragExpandNeighbours, 1-hop (coversVendor)
    TS-->>A: neighbour entities (review to initech)
    loop per selected entity
        A->>TS: extractV10KCFromStore(kaId), canonical triples
        TS-->>A: triples
        A->>A: buildV10ProofMaterial (keccak merkle)
        A->>CH: getLatestMerkleRoot(kaId)
        CH-->>A: on-chain root
        A->>A: re-anchor root + recover EIP-712 seal to VerifiableCitation (merkle/onchain/authSig ok)
    end
    A->>A: dedup, compose answer + facts + citations + stats

    Note over R,U: 5 — Respond
    A-->>R: result
    R->>R: stats.latencyMs, dragMetrics++
    R-->>API: 200 {answer, facts, citations, stats}
    API-->>U: render answer + cited triples + semantic chip
```

**Reading it:**
- The `alt` block (first-call index build) is the ~10 s you see once per CG. Later
  questions skip straight to *embed-question → ANN search*.
- The `loop` block is where trust comes from: every candidate fact is re-proven
  against the **live on-chain root**, so the vector index above it can be an
  approximate, offline, even stale *hint* without weakening the answer.

---

## 2. Cross-node — `scope:network`

The asking node holds none of the CG; it fans out to serving peers and
**re-verifies every returned citation against its own chain** before trusting it.

```mermaid
sequenceDiagram
    autonumber
    actor U as You (UI)
    participant R as Route /api/answer
    participant A as Asker dragAnswerNetwork
    participant CH as Asker's own Chain
    participant P as Serving peer(s)

    U->>R: POST /api/answer (scope=network, peers?)
    R->>A: dragAnswerNetwork(q, cg, peers)
    A->>A: validateContextGraphId(cg) ok
    A->>CH: getContextGraphOnChainId(cg)
    CH-->>A: askedCgId
    A->>A: discovery.findNodesServingCG(cg) + explicit peers

    par fan-out to each serving peer
        A->>P: PROTOCOL_DRAG_ANSWER {q, cg} (libp2p)
        Note over P: wire handler validateContextGraphId + public-only gate
        P->>P: dragAnswerLocal(q, cg)
        P-->>A: DragAnswerResult { citations }
    end

    loop per remote citation — TRUST NO PEER
        A->>CH: getKAContextGraphId(kaId) — belongs to this CG?
        A->>CH: getLatestMerkleRoot(kaId)
        A->>A: verifyVerifiableCitation vs OWN chain (full-proof verdict key)
        A->>A: byFact dedup, keep the verified one
    end
    A->>A: verified-first, then cap to maxCitations
    A-->>R: result + perNode (offered vs verified)
    R-->>U: 200 {answer, citations, perNode}
```

**Reading it:**
- A serving peer’s self-reported verdict is **never trusted** — the asker re-stamps
  every citation with its *own* `verifyVerifiableCitation` result.
- The CG-scope check (`getKAContextGraphId`) drops a genuinely-verifiable fact that
  belongs to a *different* CG (the scope-swap defense).
- The verdict cache is keyed on the **full proof**, and the citation cap is filled
  **verified-first**, so one malicious/early peer can neither poison an honest
  verdict nor starve honest verified facts out of the answer.

---

## The one idea

The **vector index is an untrusted hint**; the **citation is the truth**. Retrieval
(neural + 1-hop graph) only *proposes* which facts are relevant — fast, approximate,
decentralizable. Every fact returned is independently auditable against the chain,
which is why a normal RAG’s “the retrieved chunk *is* the answer” failure mode does
not apply here.

---

## 3. Reasoning — `reason:true` (retrieve · verify · **reason** · prove)

The EYE reasoner derives *new* conclusions over the verified facts, each carrying a
proof = {the chain-verified support facts} + {the rule}.

```mermaid
sequenceDiagram
    autonumber
    actor U as You (UI / agent)
    participant R as Route /api/answer
    participant A as Agent
    participant TS as Triple store
    participant CH as Chain
    participant E as EYE (eye-js / WASM)

    U->>R: POST /api/answer (reason=true)
    R->>A: gatherVerifiedFacts(cg)
    A->>TS: enumerate the CG's verifiable-memory KAs
    TS-->>A: all canonical triples (relationship + attribute)
    loop verify each
        A->>CH: getLatestMerkleRoot(kaId)
        A->>A: merkle + on-chain + seal → keep only checks.verified
    end
    A-->>R: verified facts (+ rule-KAs auto-discovered, verifiable)
    R->>E: n3reasoner(verified facts + rules)
    E-->>R: derived facts (negation / transitivity / policy)
    loop per derived conclusion
        R->>R: reconstruct proof — match rule-body facts back to their citations
    end
    R-->>U: { facts, citations, reasoning: { derived: [{conclusion, proof: {rule, support}}] } }
```

Note the trust gates: only `checks.verified` facts ever reach EYE (step 9), and a
derived conclusion is returned in `reasoning.derived` — never mixed into the
published `facts`/`citations`. A reasoner can mis-derive; it can never forge a fact.
