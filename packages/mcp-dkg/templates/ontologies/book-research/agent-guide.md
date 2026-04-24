# Book-research agent guide

You are working in a DKG context graph that uses the **Book Research Ontology v1** (`packages/mcp-dkg/templates/ontologies/book-research/ontology.ttl`). This document is the operational translation: how to annotate every chat turn into the project's `chat` sub-graph via `dkg_annotate_turn`.

## The contract

After every substantive turn, call `dkg_annotate_turn` exactly once. Universal primitives apply (`topics`, `mentions`, `examines`, `concludes`, `asks`); add book-specific entities (`Hypothesis`, `Argument`, `Counterexample`, `Quote`, `Citation`) when the turn warrants.

## Look-before-mint protocol

1. Compute normalised slug: lowercase → ASCII-fold → strip stopwords (`the/a/an/of/for/and/or/to/in/on/with`) → hyphenate → ≤60 chars.
2. `dkg_search` the unnormalised label.
3. Reuse on slug match; mint fresh otherwise.
4. Never fabricate URIs.

## URI patterns

```
urn:dkg:concept:<slug>      free-text concept (skos:Concept)
urn:dkg:topic:<slug>        broad topical bucket
urn:dkg:question:<slug>     open question
urn:dkg:finding:<slug>      preserved claim/observation
urn:dkg:hypothesis:<slug>   claim under investigation
urn:dkg:argument:<slug>     reasoned position
urn:dkg:quote:<slug>        verbatim passage from a source
urn:dkg:citation:<slug>     bibliographic reference (subclass of bibo:Document)
```

## Worked examples

### A — turn that examines a source and extracts a quote

User asked: *"what does Berners-Lee say about HTTP URIs in the Semantic Web roadmap?"*
You quoted a passage and analysed it.

```jsonc
dkg_annotate_turn({
  topics: ["URI design", "Semantic Web", "Berners-Lee 2001"],
  mentions: ["urn:dkg:citation:berners-lee-2001-semantic-web-roadmap"],
  examines: ["urn:dkg:quote:tbl-2001-use-http-uris-so-people-can-look-up"],
  concludes: ["urn:dkg:finding:tbl-anchored-look-before-mint-in-2001"]
})
```

### B — turn that puts forward a hypothesis

User: *"argue that knowledge graphs require deterministic naming to converge."*
You laid out a hypothesis and supporting Arguments.

```jsonc
dkg_annotate_turn({
  topics: ["graph convergence", "naming"],
  mentions: ["urn:dkg:concept:knowledge-graph"],
  proposes: [],  // not minting a Decision; this is a knowledge claim
  concludes: [],
  // Use the dedicated tools for Hypotheses/Arguments — coming in a future
  // release of dkg_annotate_turn. For v1, mint via mentions:
  mentions: ["urn:dkg:hypothesis:graphs-need-deterministic-naming-to-converge"],
  examines: ["urn:dkg:argument:slug-normalisation-makes-naming-deterministic"]
})
```

### C — turn that opens a research question

User: *"how do we measure cross-agent URI convergence empirically?"*

```jsonc
dkg_annotate_turn({
  topics: ["measurement", "URI convergence"],
  asks: ["urn:dkg:question:how-to-measure-cross-agent-uri-convergence"]
})
```

## Tool reference

Same MCP tools as every project: `dkg_get_ontology`, `dkg_annotate_turn`, `dkg_search`, `dkg_get_entity`, `dkg_sparql`, `dkg_propose_decision`, `dkg_add_task`, `dkg_comment`, `dkg_request_vm_publish`. See repo-level `AGENTS.md` for the full list.

## What to NOT do

- Don't fabricate URIs for sources you haven't verified exist (use `dkg_search` first).
- Don't conflate `:Hypothesis` (under investigation) with `:Finding` (preserved as established claim). Promote one to the other only when evidence warrants.
- Don't publish to VM via MCP. Use `dkg_request_vm_publish` to flag canon-worthy passages for human ratification.
