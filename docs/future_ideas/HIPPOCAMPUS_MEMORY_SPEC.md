# Hippocampus-Style Memory for DKG-V9

**Status**: Future idea / exploration  
**Source**: [Hippocampus: An Efficient and Scalable Memory Module for Agentic AI](https://arxiv.org/abs/2602.13594) (arXiv:2602.13594)  
**Scope**: Optional agent memory layer for fast semantic recall and long-horizon context; complements the existing RDF triple store rather than replacing it.

---

## 1. Summary of Hippocampus (Paper)

### 1.1 Problem it addresses

- **Agentic AI** needs persistent memory beyond the LLM context window (user history, dialogue, tool outputs).
- **Existing approaches** (dense vector DBs, knowledge-graph traversal, or hybrid) incur:
  - High **retrieval latency** (vector similarity, multi-hop graph queries).
  - **Poor storage scalability** and heavy **insert cost** (embeddings, graph index maintenance).

### 1.2 Core idea

- **Dual representation** in a single, compression-native substrate:
  1. **Content**: lossless **token-ID streams** for exact reconstruction (no re-tokenization).
  2. **Signatures**: **compact binary signatures** from **Random Indexing** for semantic search (Hamming-distance–based).
- **Dynamic Wavelet Matrix (DWM)** compresses and **co-indexes** both streams:
  - Append-only, bit-level structure with fast `rank`, `select`, `access`.
  - Search = **Hamming-ball search** over signatures (bitwise ops) → then **exact content** via indices from the Content DWM.
- **No dense vectors, no graph traversal** at recall time → much lower latency and linear scaling with memory size.

### 1.3 Reported benefits

- Up to **~31×** lower end-to-end retrieval latency.
- Up to **~14×** lower per-query token footprint.
- **Linear scaling** with memory size; **zero** LLM tokens during ingestion (no embedding calls).
- Accuracy preserved on LoCoMo and LongMemEval (multi-session, knowledge-update).

### 1.4 Why it is “better than graphs” (for this use case)

- **Graph-based memory**: multi-hop traversal + schema resolution → high latency; insert = graph index maintenance.
- **Hippocampus**: single compressed index (DWM), bitwise Hamming search + direct indexed access → no graph walk, append-only writes, storage-efficient.
- Graphs remain better for **structured, relational, schema-aware** knowledge; Hippocampus targets **fast semantic recall over streams** (e.g. conversation, events).

---

## 2. Relevance to DKG-V9

### 2.1 Current DKG-V9 memory/retrieval

- **Primary store**: RDF **triple store** (Oxigraph WASM) with SPARQL; N-Quads dump for persistence.
- **Query path**: `DKGQueryEngine` wraps SPARQL with paranet graph scope → `store.query(wrappedSparql)`.
- **No semantic search**: retrieval is SPARQL-only (graph patterns, no embedding-based similarity).
- **Pluggable backends**: `TripleStore` interface + `createTripleStore(config)` allow alternative stores (e.g. SPARQL HTTP); no “semantic memory” layer today.

### 2.2 Where Hippocampus-style memory could help

1. **Agent conversation / session memory**  
   Long-horizon dialogue and tool outputs exceed context windows. A dedicated **agent memory module** (Hippocampus-style) could provide fast, low-token recall of relevant past turns before (or alongside) running SPARQL over the DKG.

2. **Semantic “find similar” over stored content**  
   Optional path: “find knowledge/assets similar to this natural language query” using binary signatures + Hamming search, then **resolve** to UALs/triples via the existing store. Complements exact SPARQL.

3. **Efficiency of local recall**  
   Reduces latency and token cost when the agent repeatedly consults its own history (observe–plan–act–learn loops), without replacing the DKG as the source of truth for **published** knowledge.

4. **Alignment with pluggable storage**  
   Fits the existing direction of pluggable backends (§8.1 in the implementation plan): one more “memory backend” that can sit beside or in front of the triple store for specific use cases.

---

## 3. Implementation Options in DKG-V9

### 3.1 Option A: Agent memory module (recommended starting point)

- **What**: New package or module, e.g. `@origintrail-official/dkg-memory` or `@origintrail-official/dkg-agent` submodule, implementing:
  - **Append-only log** of “memory entries” (e.g. dialogue turns, tool outputs, or summaries).
  - **Token-ID serialization** (using the same tokenizer as the rest of the stack where possible) + **Random Indexing** → binary signatures.
  - **DWM** (or a simplified equivalent) to co-index content and signatures; **Hamming-ball search** for retrieval.
- **Integration**:
  - **Agent**: Before answering or planning, optionally call `memory.recall(query)` to get a small set of relevant past entries; inject into context (or use to decide what to query from the DKG).
  - **Persistence**: Append-only file(s) under `dataDir` (e.g. `memory.dwm` or segment files), independent of `store.nq`.
- **APIs (sketch)**:
  - `append(entry: { content: string | tokenIds, metadata?: Record<string, unknown> })`
  - `recall(query: string, options?: { topK, hammingRadius }) => Promise<RecallResult[]>`
  - `close()`
- **Does not replace**: Triple store or SPARQL; only adds a fast, semantic “working memory” for the agent.

### 3.2 Option B: Semantic index alongside the triple store

- **What**: A **signature index** over “searchable text” derived from the graph (e.g. literals, rdfs:label, or selected predicates). Each logical “chunk” (e.g. entity + key literals) has a binary signature; Content DWM or a simpler store holds pointers into the triple store (e.g. subject URI, graph, span).
- **Query path**: Natural-language or keyword query → signatures → Hamming search → candidate (subject, graph) → **resolve** via existing `resolveKA` / SPARQL for full triples.
- **Use case**: “Find entities similar to this description” without writing SPARQL; still returns proper UALs/triples from the DKG.

### 3.3 Option C: TripleStore adapter (advanced)

- **What**: A `TripleStore` implementation that uses a DWM-backed index internally and still answers SPARQL by:
  - Parsing simple SPARQL patterns (e.g. subject/predicate/object lookups) and mapping to DWM `rank`/`select`/`access`, and/or
  - Maintaining a small “SPARQL-compatible” view (e.g. only for a dedicated graph used for agent memory) while using DWM for storage and semantic search.
- **Challenge**: Full SPARQL over arbitrary RDF is not a natural fit for DWM (designed for sequences). This option is more experimental and likely only for a constrained subset of queries (e.g. a single “agent memory” graph).

### 3.4 Recommended path

- **Phase 1**: Implement **Option A** (agent memory module) as a standalone, optional component used by `@origintrail-official/dkg-agent` for conversation/session memory. No change to `TripleStore` or `DKGQueryEngine` contract.
- **Phase 2**: If needed, add **Option B** (semantic index over graph-derived text) so that “semantic search over my knowledge” can return DKG entities/UALs; keep SPARQL as the authoritative path.
- **Phase 3**: Revisit Option C only if there is a clear need for a single store that does both SPARQL and Hippocampus-style retrieval (e.g. a dedicated “memory” graph with a custom backend).

---

## 4. Technical Notes for Implementation

### 4.1 Data structures

- **Dynamic Wavelet Matrix (DWM)**:
  - Extend the static Wavelet Matrix with **append(symbol)** in O(log σ) per symbol; maintain level-wise bit-vectors and zero-counts for `rank`/`select`.
  - See paper Section 3.2 for algorithms (rank, select, access).
- **Random Indexing**:
  - Fixed set of random hyperplanes (e.g. ±1); project token or term vector → binary signature (e.g. sign of dot product per dimension). No trainable weights; deterministic given RNG seed.
- **Token IDs**:
  - Reuse tokenizer from LLM stack if available (e.g. same as used for context); otherwise a simple subword or word-level tokenizer with a fixed vocab so that token IDs are stable.

### 4.2 Co-indexing content and signatures

- Each “memory entry” gets:
  - A **content span** in the Content DWM (token IDs).
  - A **signature span** or **entry-level signature** in the Signature DWM (e.g. one signature per entry = aggregate of token signatures).
- Metadata (e.g. timestamp, role, start/end indices) can live in a separate structure keyed by entry id; DWM returns indices into Content DWM for exact reconstruction.

### 4.3 Configuration

- **Agent config** (example): `memory: { enabled: true, backend: 'hippocampus', dataDir: string, signatureBits?: number, randomIndexingDim?: number }`.
- **Backend**: Default `'hippocampus'` for the new module; later `'none'` or `'vector'` if other backends are added.

### 4.4 Persistence

- Append-only files under `dataDir` (e.g. `memory/content.dwm`, `memory/signatures.dwm`, `memory/meta.json`).
- No need to rewrite full store on each append; DWM is append-friendly. Flush policy: same as triple store (e.g. batched flush, flush on close/SIGTERM) to avoid O(N) serialization per write.

---

## 5. Dependencies and References

- **Paper**: Hippocampus: An Efficient and Scalable Memory Module for Agentic AI (arXiv:2602.13594).
- **DKG-V9**: `@origintrail-official/dkg-storage` (TripleStore, GraphManager), `@origintrail-official/dkg-agent` (DKGAgent, config), `@origintrail-official/dkg-query` (DKGQueryEngine); implementation plan §8.1 (pluggable triple store).
- **Existing docs**: [query-flow.md](../diagrams/query-flow.md), [SPEC_CROSS_AGENT_QUERY.md](../specs/SPEC_CROSS_AGENT_QUERY.md), [00_IMPLEMENTATION_PLAN.md](../plans/00_IMPLEMENTATION_PLAN.md).

---

## 6. Open Questions

- **Tokenizer alignment**: Use the same tokenizer as the LLM for context (e.g. in adapters) to avoid double tokenization and to keep token IDs consistent?
- **Eviction / capacity**: Bounded memory size (e.g. last N entries or by time); eviction policy and how it interacts with DWM (e.g. copy-on-compact vs. true circular buffer).
- **Multi-agent**: If multiple agents share a node, separate memory namespaces (e.g. per agent id) or a single shared memory with access control?
- **Metrics**: Instrument recall latency, signature size, and token savings to compare with “no memory” and “full history” baselines.
