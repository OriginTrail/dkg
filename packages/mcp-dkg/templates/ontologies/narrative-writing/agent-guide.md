# Narrative-writing agent guide

You are working in a DKG context graph that uses the **Narrative Writing Ontology v1**. The graph tracks the structural elements of long-form narrative — Characters, Scenes, PlotPoints, Themes, Settings — and the relationships between them.

## The contract

After every substantive turn, call `dkg_annotate_turn` exactly once. Reach for the narrative-flavored entities when the turn discusses story craft:

- `:Character` (subclass of `foaf:Person`)
- `:Scene` (subclass of `schema:Event`)
- `:PlotPoint` (structural moment in the arc)
- `:Theme` (subclass of `skos:Concept`)
- `:Setting` (place + time context)

## Look-before-mint protocol

1. Normalise slug: lowercase → ASCII-fold → strip stopwords → hyphenate → ≤60 chars.
2. `dkg_search` first.
3. Reuse on match; mint otherwise.
4. Never fabricate URIs.

## URI patterns

```
urn:dkg:concept:<slug>     free-text concept
urn:dkg:topic:<slug>       broad topical bucket
urn:dkg:question:<slug>    open question (craft, plot)
urn:dkg:character:<slug>   a character in the story
urn:dkg:scene:<slug>       a scene
urn:dkg:plotpoint:<slug>   a structural moment (inciting incident, climax, etc.)
urn:dkg:theme:<slug>       a unifying idea explored across the work
urn:dkg:setting:<slug>     a place/time context for Scenes
```

## Worked examples

### A — turn that introduces a new character

User: *"Sketch a character: an aging cartographer haunted by an early professional failure."*

```jsonc
dkg_annotate_turn({
  topics: ["character design", "backstory"],
  proposes: ["urn:dkg:character:aging-cartographer-haunted-by-early-failure"],
  mentions: ["urn:dkg:theme:professional-redemption"]   // existed already — REUSED via dkg_search
})
```

### B — turn that drafts a scene linking characters and themes

User: *"Write a scene where the cartographer sees their failed map in a museum."*

```jsonc
dkg_annotate_turn({
  topics: ["scene drafting", "museum"],
  proposes: ["urn:dkg:scene:cartographer-sees-failed-map-in-museum"],
  examines: [
    "urn:dkg:character:aging-cartographer-haunted-by-early-failure",
    "urn:dkg:theme:professional-redemption",
    "urn:dkg:setting:metropolitan-museum-late-afternoon"
  ]
})
```

### C — turn that asks a craft question

User: *"Should this scene come before or after the daughter is introduced?"*

```jsonc
dkg_annotate_turn({
  topics: ["plot ordering"],
  examines: ["urn:dkg:scene:cartographer-sees-failed-map-in-museum"],
  asks: ["urn:dkg:question:should-museum-scene-precede-or-follow-daughter-intro"]
})
```

## Tool reference

Same MCP toolkit. See repo `AGENTS.md`.

## Don't

- Don't conflate `:Character` (the narrative entity) with `agent:Agent` (a writer/agent in the meta sub-graph).
- Don't fabricate URIs. Always `dkg_search` first.
- Don't VM-publish via MCP — use `dkg_request_vm_publish` to flag canon-worthy scenes for human ratification.
