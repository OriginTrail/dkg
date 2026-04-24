# PKM agent guide

You are working in a DKG context graph that uses the **PKM (Personal Knowledge Management) Ontology v1**. Your job is to keep the knowledge garden growing organically — every chat turn that surfaces a Note, Highlight, or Insight should be annotated.

## The contract

After every substantive turn, call `dkg_annotate_turn` exactly once. PKM-flavored entities to reach for:

- `:Note` — atomic, self-contained thought worth capturing
- `:Highlight` — significant passage extracted from a source (article, book, transcript)
- `:Insight` — synthesis across multiple Notes or Highlights (promote via `chat:concludes`)
- `:Question` — open question worth tracking (`chat:asks`)
- `:Topic` — broad bucket (`chat:topic`)

## Look-before-mint protocol

Standard rule across all DKG starters:

1. Normalise slug: lowercase → ASCII-fold → strip stopwords → hyphenate → ≤60 chars.
2. `dkg_search` the unnormalised label.
3. Reuse on slug match; mint fresh otherwise.
4. Never fabricate URIs.

## URI patterns

```
urn:dkg:concept:<slug>      free-text concept
urn:dkg:topic:<slug>        broad topical bucket
urn:dkg:question:<slug>     open question
urn:dkg:finding:<slug>      preserved claim
urn:dkg:note:<slug>         atomic note (the daily driver)
urn:dkg:highlight:<slug>    extracted passage from a source
urn:dkg:insight:<slug>      synthesis across multiple notes
```

## Worked examples

### A — capturing a highlight from an article

User: *"Capture this from the Nielsen article: 'The 1% Rule says only 1% of users on a community website actively create new content...'"*

```jsonc
dkg_annotate_turn({
  topics: ["online communities", "user behaviour"],
  mentions: ["urn:dkg:concept:1-percent-rule"],
  proposes: ["urn:dkg:highlight:nielsen-1-percent-rule-90-9-1"]   // freshly minted Highlight entity
})
```

### B — synthesizing an insight across multiple notes

User: *"What's the through-line between the Nielsen highlight, the lurker study from 2006, and our own engagement metrics?"*

```jsonc
dkg_annotate_turn({
  topics: ["community engagement", "lurkers"],
  examines: [
    "urn:dkg:highlight:nielsen-1-percent-rule-90-9-1",
    "urn:dkg:note:lurker-study-2006",
    "urn:dkg:note:our-engagement-metrics-q4"
  ],
  concludes: ["urn:dkg:insight:lurker-ratio-stable-across-decades-and-platforms"]
})
```

### C — surfacing an open question

User: *"What would falsify the 1% rule?"*

```jsonc
dkg_annotate_turn({
  topics: ["1% rule", "falsifiability"],
  mentions: ["urn:dkg:concept:1-percent-rule"],
  asks: ["urn:dkg:question:what-would-falsify-the-1-percent-rule"]
})
```

## Tool reference

Same MCP toolkit as every project. See repo `AGENTS.md` for the full list. Key calls: `dkg_get_ontology`, `dkg_annotate_turn`, `dkg_search`, `dkg_get_entity`.

## Don't

- Don't conflate Notes (atomic captures) with Insights (synthesis). One Note per atomic thought; promote to Insight only when synthesising.
- Don't fabricate URIs. Always look first.
- Don't VM-publish via MCP. Insights worth canonising route through `dkg_request_vm_publish` for human review.
