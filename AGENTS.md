# Agent Instructions

This repository is bound to a **DKG context graph** (`dkg-code-project`) used for shared project memory across all AI coding agents working on it. Cursor, Claude Code, and any other MCP-aware agent should follow the same protocol so the graph converges rather than fragments.

For Cursor-specific session-start guidance the same content lives in [`.cursor/rules/dkg-annotate.mdc`](.cursor/rules/dkg-annotate.mdc) with `alwaysApply: true`. This file is the canonical instructions and is read by Claude Code, Continue, OpenAI Codex CLI, and any other tool that honours `AGENTS.md`.

## What this graph is

- **Subgraphs**: `chat`, `tasks`, `decisions`, `code`, `github`, `meta` — each a distinct slice of project memory.
- **Capture hook** at `packages/mcp-dkg/hooks/capture-chat.mjs` writes every chat turn into `chat` and gossips it to all subscribed nodes within ~5s. Wired via `.cursor/hooks.json` and `~/.claude/settings.json`.
- **MCP server** at `packages/mcp-dkg` exposes ~14 read+write+annotation tools to any MCP-aware agent.
- **Project ontology** lives at `meta/project-ontology` — fetch via `dkg_get_ontology`. The formal Turtle/OWL artifact + a markdown agent guide.

## The annotation protocol

After **every substantive turn** (anything that reasoned, proposed, examined, or referenced something — basically every turn that wasn't a one-line acknowledgement), call **`dkg_annotate_turn`** exactly once. The shared chat sub-graph is project memory, not a "DKG-relevant search index" — over-eagerness is not a failure mode; under-coverage is.

Minimum viable annotation:

```jsonc
dkg_annotate_turn({
  topics:   [<2-3 short topic strings>],   // chat:topic literals
  mentions: [<URIs found via dkg_search>], // chat:mentions edges
})
```

Add when the turn warrants:

- `examines` — entities the turn analysed in detail (vs just citing in passing)
- `concludes` — `:Finding` entities the turn produced (claims worth preserving)
- `asks` — `:Question` entities left open
- `proposedDecisions` — sugar over `dkg_propose_decision`; freshly mints a Decision and links via `chat:proposes`
- `proposedTasks` — sugar over `dkg_add_task`
- `comments` — sugar over `dkg_comment` (against any existing entity)
- `vmPublishRequests` — sugar over `dkg_request_vm_publish` (writes a marker; **never** publishes on-chain)

## Look-before-mint protocol (the convergence rule)

This is the single most important rule. It's how parallel agents converge on the same URIs instead of fragmenting the graph.

Before minting any new `urn:dkg:<type>:<slug>` URI:

1. Compute the **normalised slug**: lowercase → ASCII-fold → strip stopwords (`the/a/an/of/for/and/or/to/in/on/with`) → hyphenate → ≤60 chars.
2. Call `dkg_search` with the **unnormalised label** (the daemon does its own fuzzy match).
3. If any returned entity's normalised slug matches yours → **REUSE** that URI.
4. Otherwise mint `urn:dkg:<type>:<slug>` per the patterns below.

**Never fabricate URIs** for entities you didn't discover via `dkg_search`. If unsure, prefer minting fresh and let humans (or the future `dkg_propose_same_as` reconciliation flow) merge duplicates via `owl:sameAs`.

## URI patterns

```
urn:dkg:concept:<slug>              free-text concept (skos:Concept)
urn:dkg:topic:<slug>                broad topical bucket
urn:dkg:question:<slug>             open question
urn:dkg:finding:<slug>              preserved claim/observation
urn:dkg:decision:<slug>             architectural decision (coding-project)
urn:dkg:task:<slug>                 work item (coding-project)
urn:dkg:agent:<slug>                agent identity (usually <framework>-<operator>)
urn:dkg:github:repo:<owner>/<name>  GitHub repository
urn:dkg:github:pr:<owner>/<name>/<num>
urn:dkg:code:file:<pkg>/<path>
urn:dkg:code:package:<name>
```

## Tool reference

Read tools (read-only, no side effects):

- `dkg_list_projects` — list every CG this node knows about
- `dkg_list_subgraphs` — show counts per sub-graph in a project
- `dkg_sparql` — arbitrary SELECT/CONSTRUCT/ASK; layer ∈ {wm, swm, union, vm}
- `dkg_get_entity` — describe one entity + 1-hop neighbourhood
- `dkg_search` — keyword search across labels + body text (use this in look-before-mint)
- `dkg_list_activity` — recent activity feed (decisions, tasks, turns) with attribution
- `dkg_get_agent` — agent profile + authored counts
- `dkg_get_chat` — captured turns filterable by session/agent/keyword/time
- `dkg_get_ontology` — the project's ontology + agent guide (call once per session)

Write tools (auto-promoted to SWM; humans gate VM):

- `dkg_annotate_turn` — **the main per-turn surface**; batches everything below
- `dkg_propose_decision`, `dkg_add_task`, `dkg_comment`, `dkg_request_vm_publish`, `dkg_set_session_privacy` — the underlying primitives, available standalone for explicit "file a decision" / "open a task" requests

## Things to NOT do

- **Don't fabricate URIs.** Every URI in `mentions` must come from `dkg_search` or be freshly minted via the look-before-mint protocol.
- **Don't skip turns to "save tokens".** One annotation call per turn is cheap (~few hundred ms). Coverage wins.
- **Don't publish to VM via MCP.** That's `dkg_request_vm_publish` (marker for human review), not `/api/shared-memory/publish`. The agent is never the gating actor for on-chain commitment.
- **Don't normalise slugs in your `dkg_search` query.** Pass the unnormalised label so the daemon's fuzzy match has the most signal; only normalise when comparing for reuse-vs-mint.

## Cheat sheet

```
After every substantive turn:
1. dkg_search "<some label from the turn>" → reuse-or-mint URIs
2. dkg_annotate_turn({
     topics: [...], mentions: [...],
     examines?, concludes?, asks?,
     proposedDecisions?, proposedTasks?, comments?
   })
```

That's it. The graph grows; teammates' agents see your work in seconds; humans ratify on-chain when worthwhile.
