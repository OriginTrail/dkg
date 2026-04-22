# Coding-project agent guide

You are working in a DKG context graph that uses the **Coding Project ontology v1**. This document is your operational reference for emitting structured triples about every chat turn via `dkg_annotate_turn`. The companion file `ontology.ttl` is the formal source of truth; this file is its instructional translation.

## The contract

After **every substantive turn** (anything that reasoned, proposed, examined, or referenced something — basically every turn that wasn't a one-line acknowledgement), call `dkg_annotate_turn` exactly once. Quality of annotation matters more than gating which turns get one — over-eagerness is not a failure mode here. The shared chat sub-graph is project memory, not a search index for "DKG-related" topics.

## The look-before-mint protocol

**This is the single most important rule.** It's how parallel agents converge on the same URIs instead of fragmenting the graph into archipelagos.

Before emitting a new URI in `dkg_annotate_turn`:

1. Compute the **normalised slug** for the label per Section 7 below.
2. Call `dkg_search` with the unnormalised label (it does its own fuzzy match).
3. If any returned entity's normalised slug matches yours → **REUSE** that URI.
4. Otherwise → mint `urn:dkg:<type>:<slug>` per the patterns in Section 5.

Never fabricate an existing URI. If unsure, prefer minting fresh and let the reconciliation flow merge duplicates via `owl:sameAs` later.

## 1. Annotation primitives — what to put on every turn

The universal predicates apply to ANY project type. Reach for these first; they're cheap and make the graph navigable:

| Predicate | When to use | Cardinality |
|---|---|---|
| `chat:topic` (literal) | Free-text topical bucket the turn lives under. Pick 1–3 short phrases ("performance tuning", "VM publish flow"). Don't be precious — emit liberally. | Many |
| `chat:mentions` (URI) | Any entity the turn referenced. The most common edge in the graph. Apply look-before-mint religiously. | Many |
| `chat:examines` (URI) | Entity the turn walked through in detail (vs just citing in passing). Implies the agent or operator is ANALYSING it, not merely linking. | 0..N |
| `chat:proposes` (URI) | An idea/decision/task put forward. Often points at a freshly-minted Decision or Task entity created in the same `dkg_annotate_turn` call. | 0..N |
| `chat:concludes` (URI) | A `:Finding` entity the turn produced — a claim worth preserving as its own node. | 0..N |
| `chat:asks` (URI) | A `:Question` entity the turn left open. Surfaces "what did we never resolve". | 0..N |

## 2. Coding-project-specific entities

When the turn discusses architecture or work, also use the project-flavoured tools (which `dkg_annotate_turn` wraps for you):

- **Decision** (`decisions:Decision`) — when the turn settled an architectural question. Required fields: `title`, `context`, `outcome`. Optional: `consequences`, `status` (default `proposed`).
- **Task** (`tasks:Task`) — when the turn identified work to do. Required: `title`. Optional: `priority` (p0..p3), `status`, `assignee`, `relatedDecision`, `touches`.
- **Comment** (`schema:Comment`) — when the turn made a remark ABOUT an existing entity. Required: `about` (URI), `body`.
- **VmPublishRequest** (`dkg:VmPublishRequest`) — when the turn surfaced something worth anchoring on-chain. Required: `entityUri`, `rationale`. The agent NEVER publishes to VM directly; this writes a marker that a human ratifies via the node-ui's VerifyOnDkgButton.

## 3. URI patterns (memorise these)

```
urn:dkg:concept:<slug>      free-text concept (skos:Concept)
urn:dkg:topic:<slug>        broad topical bucket (skos:Concept in TopicScheme)
urn:dkg:question:<slug>     open question (subClassOf schema:Question)
urn:dkg:finding:<slug>      preserved claim/observation (subClassOf prov:Entity)
urn:dkg:decision:<slug>     architectural decision (subClassOf prov:Activity)
urn:dkg:task:<slug>         work item (subClassOf schema:Action)
urn:dkg:agent:<slug>        agent identity — usually <framework>-<operator>
urn:dkg:github:repo:<owner>/<name>      GitHub repo
urn:dkg:github:pr:<owner>/<name>/<num>  pull request
urn:dkg:code:file:<pkg>/<path>          source file
urn:dkg:code:package:<name>             package
```

## 4. Slug normalisation algorithm

To produce a canonical slug from a free-text label:

1. **Lowercase.**
2. **ASCII-fold:** apply Unicode NFKD then strip combining marks.
3. **Strip stopwords:** `the / a / an / of / for / and / or / to / in / on / with`.
4. **Hyphenate:** replace any run of non-`[a-z0-9]` with a single hyphen.
5. **Trim** leading/trailing hyphens.
6. **Truncate** to 60 characters.

Examples: `"the Tree-Sitter library"`, `"Tree sitter"`, `"TREE_SITTER"` all normalise to `tree-sitter`.

## 5. Worked examples

### Example A — turn that proposes adopting a tool

User asked: *"should we use tree-sitter for Python parsing?"*
You replied with an analysis recommending it.

```jsonc
dkg_annotate_turn({
  topics: ["AST tooling", "Python parsing", "incremental reparsing"],
  mentions: [
    "urn:dkg:concept:tree-sitter",      // existed already — REUSED via dkg_search
    "urn:dkg:concept:incremental-parsing"
  ],
  examines: [
    "urn:dkg:code:package:%40origintrail-official%2Fdkg-cli"  // the package the change would affect
  ],
  proposedDecisions: [{
    title: "Adopt tree-sitter for Python AST parsing",
    context: "Operator asked whether to switch from lark to tree-sitter for Python source parsing.",
    outcome: "Adopt tree-sitter-python behind a Parser interface so we can swap implementations later.",
    consequences: "+1.5MB bundle per language; gain incremental reparse, error recovery, and a mature DSL. Behind an interface so reversible.",
    status: "proposed"
  }],
  proposedTasks: [{
    title: "Stub a Parser interface that wraps tree-sitter-python",
    priority: "p1",
    status: "todo"
  }]
})
```

The Decision and Task get fresh URIs (`urn:dkg:decision:adopt-tree-sitter-for-python-ast-parsing-...`) attributed to you via `prov:wasAttributedTo`, auto-promoted to SWM, instantly visible to teammates' agents. The `chat:proposes` edge from the turn to the Decision is created automatically.

### Example B — turn that just discusses without deciding

User asked: *"what was the gossip latency we measured between node-1 and node-2?"*
You looked it up in the chat history and replied "≤5s in both directions".

```jsonc
dkg_annotate_turn({
  topics: ["gossip protocol", "two-machines test"],
  mentions: [
    "urn:dkg:concept:gossip-protocol",
    "urn:dkg:concept:two-machines-demo"
  ],
  concludes: [
    "urn:dkg:finding:node1-node2-gossip-under-5s"   // newly minted Finding entity
  ]
})
```

No decision proposed (the question was retrospective). One Finding minted because the answer is worth preserving as a citeable node.

### Example C — turn that opens a question

User asked: *"how would we reconcile divergent URIs minted in parallel?"*
You sketched some options but didn't pick one.

```jsonc
dkg_annotate_turn({
  topics: ["URI convergence", "conflict resolution"],
  mentions: [
    "urn:dkg:concept:look-before-mint",
    "urn:dkg:concept:owl-sameas"
  ],
  asks: [
    "urn:dkg:question:how-to-reconcile-divergent-uris-minted-in-parallel"
  ]
})
```

The Question entity is now in the graph. A future turn that proposes an answer can `chat:concludes urn:dkg:finding:dkg-propose-same-as-flow` and `:answers urn:dkg:question:how-to-reconcile-...` — closing the loop.

## 6. Things to NOT do

- **Don't fabricate URIs.** If `dkg_search` returns nothing for a label, mint fresh — never guess at a URI someone else might have used.
- **Don't skip turns to "save tokens".** Annotation cost is one extra MCP call (~few hundred ms). Coverage wins.
- **Don't put project-specific predicates on the universal primitives.** `chat:mentions` is universal; if you want to express "this turn voted to accept a decision", use a Decision-specific predicate, not `chat:mentions decision:Decision`.
- **Don't publish to VM via MCP.** That's `dkg_request_vm_publish` (writes a marker the human ratifies), not actual on-chain publish. You're never the gating actor for VM.
- **Don't normalise slugs in your URI lookup BEFORE calling `dkg_search`.** Search the unnormalised label so the daemon's fuzzy match has the most signal; THEN compare normalised slugs to decide reuse-vs-mint.

## 7. Cheat sheet — minimum viable annotation

If you remember nothing else, do this on every substantive turn:

```jsonc
dkg_annotate_turn({
  topics: [<2-3 short topic strings>],
  mentions: [<URIs found via dkg_search; mint fresh ones if no match>]
})
```

Everything else (`examines`, `proposes`, `concludes`, `asks`, sugared writes) is additive and turn-dependent.
