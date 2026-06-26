# Verifiable Answers (dRAG)

dRAG (OT-RFC-55) answers a natural-language question over a context graph and
returns **grounded, individually verifiable citations** — every fact comes with
a proof that it is really published on the DKG (V10 Merkle inclusion + the
on-chain root + the author's EIP-712 seal). No LLM is required to produce the
answer; an LLM is an optional synthesis layer on top of facts that are already
proven.

The hard part dRAG solves is the **natural-language → knowledge-asset** path:
finding the right facts when you don't know the URI to ask for.

## The endpoint

```
POST /api/answer
{
  "question": "which suppliers were flagged in the audit?",
  "contextGraphId": "my-cg",
  "scope": "local",            // "local" (this node) | "network" (fan out)
  "retrieval": "semantic",     // "default" | "keyword" | "semantic"
  "maxCitations": 12,
  "synthesize": false          // optional: compose grounded prose (needs an LLM)
}
```

Response:

```jsonc
{
  "answer": "…a short grounded digest…",
  "facts":   [{ "subject": "...", "predicate": "...", "object": "..." }],
  "citations": [{ "triple": {...}, "kaId": "...", "proof": {...}, "checks": { "verified": true } }],
  "stats": { "retrieval": "vector:Xenova/all-MiniLM-L6-v2", "factsCited": 7, "citationsVerified": 7 },
  "perNode": [ /* present for scope:network */ ]
}
```

Each citation is **independently auditable** — `verifyCitationProof(citation)`
(exported from `@origintrail-official/dkg-core`) recomputes the Merkle root from
the triple and checks it against the chain. In `scope:network`, the asking node
re-verifies every remote citation against its **own** view of the chain before
returning it, so you never trust the serving node.

Agents reach the same capability through the **`dkg_answer`** MCP tool (same
`scope` / `retrieval` parameters).

## Retrieval modes

| `retrieval` | What it does | When to use |
|-------------|--------------|-------------|
| `keyword` | Substring match over literals. Predictable, zero-dependency, but misses paraphrases. | Exact terms, codes, IDs. |
| `semantic` | Embeds the question and ANN-searches the CG's entities by **meaning**, then graph-expands one hop. Finds facts that never use the question's words. | Discovery, fuzzy questions, real prose. |
| `default` | The node's configured embedder (`config.drag.embedder`); keyword if none. | Let the operator decide. |

`semantic` resolves a model **hard**: it uses the configured embedder if it is
semantic, otherwise an OpenAI-compatible provider if credentials exist,
otherwise the offline local model. If no model is reachable it degrades to an
empty result rather than failing the request.

## Configuring the embedder

dRAG ships with **keyword as the default** (semantic is opt-in, because a model
is not always present and lexical fallbacks can rank wrong). Turn on semantic
retrieval node-wide with `config.drag`:

**Local Ollama (recommended — no heavy dependency, fully offline):**

```yaml
drag:
  embedder: openai            # OpenAI-compatible wire format
  embedderBaseURL: http://localhost:11434/v1
  embedderModel: nomic-embed-text
```

**Hosted OpenAI:**

```yaml
drag:
  embedder: openai
  embedderModel: text-embedding-3-small
  embedderApiKey: sk-...      # or inherit from llm.apiKey
```

**Offline MiniLM (in-process, no API):** install the optional dependency and set

```yaml
drag:
  embedder: local             # Xenova/all-MiniLM-L6-v2 via @huggingface/transformers
```

```bash
npm i @huggingface/transformers   # ~200 MB ONNX runtime; opt-in, not bundled
```

The `DKG_DRAG_EMBEDDER` environment variable overrides `config.drag.embedder`
for quick experiments. `hashing` is a zero-dependency lexical baseline kept as a
contrast control for testing — not for production.

## Payments (off by default)

Answers are **free** unless you enable `config.drag.payments.enabled`. The x402
wire format (`402 → X-PAYMENT → 200 + receipt`) and a pluggable
`PaymentVerifier` are wired so monetization is one swap away; real per-CG pricing
and the live facilitator are deferred. The `simulatePrice` request knob is a
dev/test affordance honoured only under `config.drag.experimentalOverrides`.

## Grounded synthesis (optional)

By default the answer is a **structured digest** of the cited facts — the ideal
machine-readable shape for a consuming agent. Set `"synthesize": true` (and
configure `config.llm`) to additionally compose a short **prose** answer. The
model is instructed to use *only* the supplied verified facts and add nothing,
and synthesis **never mutates `facts`/`citations`** — those remain the
authoritative, chain-verified result. If the LLM is unreachable, the request
falls back to the structured digest. Default off.

## Observability

- `GET /api/answer/metrics` — in-process counters: `answersServed`, `byMode`
  (keyword/semantic/network), `citationsVerified`, `retrievalDegraded`,
  `synthesized`.
- Each answer carries `stats.latencyMs`.
- `stats.retrievalDegraded: true` means semantic retrieval was requested but **no
  embedding model was reachable** — an actionable signal that is distinct from a
  genuine "no matches" empty result. Configure `config.drag.embedder` to fix it.

## How it works under the hood

1. **Index** (semantic only): each entity in the CG's verifiable memory is
   rendered to a short text signature (label + its facts) and embedded into a
   per-node SQLite vector store. Indexing is incremental — only new entities are
   embedded — and warmed right after a publish.
2. **Retrieve**: the question is embedded and ANN-searched (brute-force cosine;
   fine to ~100k vectors/node — upgrade to `sqlite-vec`/`pgvector` for scale),
   yielding ranked anchor entities, then expanded one hop along the graph.
3. **Cite**: for each retrieved entity, the matching triples are turned into
   verifiable citations against the chain.

The vector index is an **untrusted hint** — it only proposes which entities are
relevant. The facts returned are always grounded and cryptographically verified,
so the index can be approximate, offline, or even stale without weakening
correctness.

## Scaling notes

- Search is brute-force cosine over the CG's vectors. Sub-millisecond to tens of
  thousands of entities per node; the embedding step (not the search) dominates.
  For larger graphs, swap the `VectorStore` search for `sqlite-vec` (ANN) behind
  the same interface.
- Cross-node `semantic` requires each serving node to have a model configured;
  decentralized semantic routing over the public catalog is a later phase.
- **Retrieval precision is a known limitation.** Retrieval returns a ranked
  top-K (with only a conservative absolute floor, not a tuned similarity cutoff),
  so on small or ambiguous graphs a weakly-related entity can appear among the
  results. This is by design — the index is an untrusted hint and every returned
  fact is verifiable, so the consuming agent (or the optional synthesis step)
  reasons over proven facts rather than trusting the ranker. Tuned re-ranking is
  a later refinement.
