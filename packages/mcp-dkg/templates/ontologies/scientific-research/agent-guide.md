# Scientific-research agent guide

You are working in a DKG context graph that uses the **Scientific Research Ontology v1**. The graph tracks the full empirical research arc: Hypotheses → Experiments → Results → Reproducibility chains, all anchored in PROV-O and FaBiO so they compose with existing scholarly publishing infrastructure.

## The contract

After every substantive turn, call `dkg_annotate_turn` exactly once. Reach for the science-flavored entities when the turn discusses experimental design or empirical claims:

- `:Hypothesis` — testable claim
- `:Experiment` — defined procedure (`prov:Activity`)
- `:Method` — reusable methodology (`prov:Plan`)
- `:Result` — outcome produced by an Experiment
- `:Dataset` — input/output data (DCAT-aligned)

## Look-before-mint protocol

1. Normalise slug: lowercase → ASCII-fold → strip stopwords → hyphenate → ≤60 chars.
2. `dkg_search` first.
3. Reuse on match; mint otherwise.
4. Never fabricate URIs.

## URI patterns

```
urn:dkg:concept:<slug>     free-text concept
urn:dkg:topic:<slug>       broad topical bucket
urn:dkg:question:<slug>    open question (research question)
urn:dkg:hypothesis:<slug>  testable claim
urn:dkg:experiment:<slug>  defined procedure run to test
urn:dkg:method:<slug>      reusable methodology
urn:dkg:result:<slug>      experiment outcome
urn:dkg:dataset:<slug>     input or output dataset
urn:dkg:finding:<slug>     a Result promoted to a canonical claim
```

## Worked examples

### A — turn that designs an experiment

User: *"Design an experiment to test whether agent annotation rate scales linearly with chat session length."*

```jsonc
dkg_annotate_turn({
  topics: ["experiment design", "scaling laws", "agent behavior"],
  mentions: ["urn:dkg:concept:annotation-rate", "urn:dkg:concept:session-length"],
  proposes: [
    "urn:dkg:hypothesis:annotation-rate-scales-linearly-with-session-length",
    "urn:dkg:experiment:annotation-vs-session-length-2026-04-18"
  ]
})
```

### B — turn that reports a result

User: *"The experiment ran. Mean annotations/turn was 1.2 (SD 0.3) across 100 sessions, no length dependence detected (p=0.87)."*

```jsonc
dkg_annotate_turn({
  topics: ["experimental results"],
  examines: ["urn:dkg:experiment:annotation-vs-session-length-2026-04-18"],
  concludes: ["urn:dkg:result:annotation-rate-1-2-per-turn-no-length-dependence"]
})
```

### C — turn that questions reproducibility

User: *"Has anyone reproduced this on a different model?"*

```jsonc
dkg_annotate_turn({
  topics: ["reproducibility"],
  examines: ["urn:dkg:experiment:annotation-vs-session-length-2026-04-18"],
  asks: ["urn:dkg:question:has-annotation-rate-result-been-reproduced-on-other-models"]
})
```

## Tool reference

Same MCP toolkit. See repo `AGENTS.md`.

## Don't

- Don't promote a `:Hypothesis` to a `:Finding` without a supporting `:Result` linked via `:supportedBy`.
- Don't conflate `:Method` (reusable procedure) with `:Experiment` (one execution of a procedure).
- Don't fabricate URIs. Always `dkg_search` first.
- Don't VM-publish via MCP — use `dkg_request_vm_publish` to flag canonical Findings/Results for human ratification.
