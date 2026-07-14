# Verifiable Answers (dRAG)

dRAG (OT-RFC-55) answers a natural-language question over a context graph and
returns **grounded, individually verifiable citations** — every fact comes with
a proof that it is really published on the DKG (V10 Merkle inclusion + the
live on-chain root/author, plus an EIP-712 seal when available). No LLM is required to produce the
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
  "stats": { "retrieval": "vector:Xenova/all-MiniLM-L6-v2", "factsCited": 7, "verified": 7 },
  "perNode": [ /* present for scope:network */ ]
}
```

Each citation is **independently auditable**. `verifyCitationProof(citation)`
(exported from `@origintrail-official/dkg-core`) recomputes the carried Merkle
root from the triple and proof; a complete verifier must also read the KA's
current root, leaf count, and author from the chain. The agent does all of those
live reads before setting `checks.verified`. In `scope:network`, the asking node
also proves the graph is currently public, checks each KA belongs to the exact
requested graph, and re-verifies the citation against its **own** chain view.

Agents reach the same capability through the **`dkg_answer`** MCP tool (same
`scope` / `retrieval` parameters).

## Retrieval modes

| `retrieval` | What it does | When to use |
|-------------|--------------|-------------|
| `keyword` | Uses literal substring matches to select entities, then returns a bounded set of those entities' attribute and relationship facts. Predictable and zero-dependency, but misses paraphrases. | Exact terms, codes, IDs. |
| `semantic` | Embeds the question and vector-searches the CG's entities by **meaning**, then graph-expands one hop. Finds facts that never use the question's words. | Discovery, fuzzy questions, real prose. |
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

Private context graphs use keyword retrieval and reject synthesis/semantic
requests by default, so graph text cannot silently leave the node through a
configured model endpoint. An operator who has reviewed that endpoint (for
example a loopback Ollama instance) can opt in with
`drag.allowPrivateModelCalls: true`. Background publish-time index warming uses
the same fail-closed policy: private, unknown, and policy-lookup failures do not
reach the embedder without that explicit opt-in.

## Payments (off by default)

Answers are **free** unless you enable `config.drag.payments.enabled`. V1 has a
replay-safe, request-bound `402 → X-PAYMENT → 200` development seam with a
bounded single-use challenge store. Its bundled verifier produces a synthetic
receipt; it does **not** settle funds. Production monetization still requires a
real facilitator/verifier and pricing policy. The `simulatePrice` request knob
is a dev/test affordance honoured only under `config.drag.experimentalOverrides`.

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
  `synthesized`, `reasoned`.
- Each answer carries `stats.latencyMs`.
- Network answers also carry `scopeVerified`, `rejected`, `notEvaluated`, and
  `peersSkipped`, so consumers can distinguish verified facts from complete
  network coverage.
- `stats.retrievalDegraded: true` means semantic retrieval was requested but **no
  embedding model was reachable** — an actionable signal that is distinct from a
  genuine "no matches" empty result. Configure `config.drag.embedder` to fix it.

## Reasoning — derive conclusions with verified evidence (EYE)

`retrieve → verify → **reason** → derive`. With `"reason": true`, dRAG runs the
**EYE** N3 reasoner (`eyereasoner`, in-process WebAssembly — an optional
dependency) over the context graph's **verified** facts, applying N3 rules to
**derive new conclusions** — the things vectors and SPARQL can't do: **negation**
(`log:notIncludes` / `collectAllIn`), **transitive inference**, and conditional /
policy logic — with auditable, verified supporting facts.

```jsonc
"reasoning": {
  "engine": "eye-js",
  "rules": [{ "kaId": "...", "checks": { "verified": true } }],   // rules are themselves verifiable KAs
  "derived": [
    { "conclusion": { "subject": "...D1", "predicate": "...violatesReviewPolicy", "object": "\"true\"" },
      "rule": "{ … } => { … } .",
      "support": [ /* verified, rule-scoped supporting evidence */ ] }
  ]
}
```

Two invariants make this trustworthy:

1. **EYE only sees VERIFIED facts.** The reasoner's inputs are filtered to facts
   whose merkle/chain/seal citation verified — the trust gate. A bad rule can
   mis-derive, but it can never reason from an unproven fact.
2. **Derived ≠ published.** Conclusions are returned in `reasoning.derived`,
   never mixed into `facts`/`citations`. `support` is a bounded, rule-scoped set
   of chain-verified evidence. It is not claimed to be an exact or minimal EYE
   derivation proof; re-run the rule when that stronger property is required.

**Rules are verifiable too — and managed.** A rule is N3; publish it as a KA whose
object is the rule body under predicate `…/drag/reasoning#ruleN3` (to the CG **root**
— fact/rule discovery is root-scoped in V1; a dedicated `rules` sub-graph awaits
sub-graph-aware proof extraction), and dRAG auto-discovers it. Now **verified facts +
verified rules → conclusions with verified supporting evidence**. Rules are managed
objects: a rule whose `…/drag/reasoning#ruleStatus` is `"disabled"` never fires, and
`config.drag.reasoningRuleAuthors` (an allowlist of `0x` author addresses) restricts
auto-discovery to rules whose chain-verified author you trust — governance for public
CGs where any publisher could plant a rule. The response identifies the rule and a
bounded, rule-scoped evidence set; it does not claim that set is the exact or minimal
derivation. Rules may also be passed per-request (`"rules": "<n3>"`).

**Closed-world caveat.** Negation-as-failure means "no senior review *in the
facts EYE saw*." The route refuses to run EYE if its KA/fact bounds were hit or
any graph could not be verified. That prevents silently reasoning over a known
partial set, but it does not turn one CG into a statement about the whole world.

Reasoning is single-node (`scope:local`) and requires both request
`"reason": true` and explicit operator opt-in `config.drag.reasoning: true`.
See `scripts/drag-reason-demo.mjs` for a
multi-agent code-graph example (a change that violates the review policy, derived
with negation + transitivity and accompanied by verified evidence).

**Known limitations (V1).**
- **Untrusted rules + compute.** Auto-discovered rule-KAs are author-untrusted by
  default (any publisher to a public CG can plant one), and EYE runs **in-process** —
  an in-process timeout cannot interrupt the blocking WASM. The fact/rule/derived sets
  are hard-capped and `config.drag.reasoningRuleAuthors` confines auto-discovery to
  allow-listed chain-verified authors, but an adversarial rule's *runtime* is not
  bounded. **Until EYE runs in a worker-thread with a hard timeout, set
  `config.drag.reasoning: false` on nodes that expose the API beyond loopback, and set
  `reasoningRuleAuthors` wherever reasoning runs over a public CG.**
- **Evidence attribution is best-effort.** `support` is a set of verified facts in the
  conclusion's rule-scoped neighbourhood — every leaf is a real chain-verified
  citation (never fabricated), but the *set* may include a sibling-branch fact or
  omit a body fact anchored on a shared object. The exact rule-instance proof
  (EYE's justification output) is a planned enhancement.

## How it works under the hood

1. **Index** (semantic only): each entity in the CG's verifiable memory is
   rendered to a short text signature (label + its facts) and embedded into a
   per-node SQLite vector store. Indexing is incremental for newly observed
   graph/entity pairs and warmed right after a publish.
2. **Retrieve**: the question is embedded and vector-searched (brute-force cosine;
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
- Cross-node serving is explicit operator opt-in (`drag.networkServing: true`),
  and only opted-in nodes advertise the capability-specific
  `skill:dragContextGraphsServed` phonebook entries. Merely hosting a public CG
  does not make a node an answer responder. The handler is public-only,
  rate/concurrency bounded, and forces keyword retrieval so an
  unauthenticated peer cannot trigger model calls or whole-index construction.
  During a rolling upgrade, responders become discoverable after republishing
  their profile; explicit `peers` remain the deterministic compatibility path.
  The asker queries at most 12 serving peers and allocates its verification budget
  round-robin; `peersSkipped`/`notEvaluated` expose partial coverage. Decentralized
  semantic routing over the public catalog is a later phase.
- **Index freshness is entity-count based in V1.** Publishing new facts for an
  already-indexed graph/entity pair does not yet invalidate its stored embedding.
  This can reduce recall until the index is rebuilt, but cannot make an unverified
  fact authoritative because citation verification remains the trust gate.
- **Retrieval precision is a known limitation.** Retrieval returns a ranked
  top-K (with only a conservative absolute floor, not a tuned similarity cutoff),
  so on small or ambiguous graphs a weakly-related entity can appear among the
  results. This is by design — the index is an untrusted hint and every returned
  fact is verifiable, so the consuming agent (or the optional synthesis step)
  reasons over proven facts rather than trusting the ranker. Tuned re-ranking is
  a later refinement.
