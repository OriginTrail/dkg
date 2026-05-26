# Agent Instructions

This repository is bound to a **DKG V10 context graph** (`dkg-code-project`) used for shared project memory across every AI coding agent working in it. Cursor, Claude Code, Codex CLI, Continue, and any other MCP-aware agent must follow the same protocol so the graph converges rather than fragments.

For Cursor-specific session-start guidance the same content lives in [`.cursor/rules/dkg-annotate.mdc`](.cursor/rules/dkg-annotate.mdc) with `alwaysApply: true`. **This file is canonical for AGENTS.md-honouring tools.**

The authoritative reference for the V10 MCP tool surface is [`packages/cli/skills/dkg-node/SKILL.md`](packages/cli/skills/dkg-node/SKILL.md). Read it once per session — that's the source of truth for every `dkg_*` tool listed below.

## 1. What this graph is

- **Sub-graphs**: `chat`, `tasks`, `decisions`, `code`, `github`, `meta` — each a distinct slice of project memory.
- **Capture hook** at `packages/mcp-dkg/hooks/capture-chat.mjs` writes every chat turn into `chat` as a `chat:Turn` entity with deterministic URI `urn:dkg:chat:session:<sessionKey>#turn:<idx>`. Auto-promoted to SWM when `autoShare: true`.
- **Session-context hook** at `packages/mcp-dkg/hooks/inject-session-context.mjs` prepends a `<dkg-session-context>` block to every operator prompt. This is how you, the agent, know the URI of THIS turn so annotations can link back to it.
- **Code-graph scanner** at `.dkg/scripts/scan-code.mjs` (operator-installed) walks `git ls-files` of any target repo and writes `code:File` / `code:Package` triples into the `code` sub-graph. Idempotent (rolling per-repo assertion).
- **MCP server** at `packages/mcp-dkg` exposes the V10 tool surface — see §6. The V9 sugared annotation tools (`dkg_annotate_turn`, `dkg_propose_decision`, `dkg_add_task`, `dkg_comment`, `dkg_request_vm_publish`, `dkg_set_session_privacy`, `dkg_get_chat`, `dkg_get_ontology`) are **retired**.

## 2. Session context injection — read this first every turn

On every turn, your incoming prompt is prefixed by a structured block:

```
<dkg-session-context>
  <session-id>{sessionKey}</session-id>
  <next-turn-index>{N}</next-turn-index>
  <turn-uri>urn:dkg:chat:session:{sessionKey}#turn:{N}</turn-uri>
  <agent-uri>{your agent URI}</agent-uri>
</dkg-session-context>
```

**Parse this block once at the start of every turn and hold `<turn-uri>` + `<agent-uri>` in working memory.** They are the two identifiers you need to write graph-edged annotations.

The capture hook will write the actual `chat:Turn` entity at exactly this `<turn-uri>` after your response is captured, so any `<turn-uri> chat:proposes <X>` edge you author during the turn JOINs cleanly once the post-response write lands.

If the block is missing (degraded hook, fresh tool, etc.), fall back: annotations still stand on their own provenance via `dcterms:created` + `prov:wasAttributedTo` even without the turn-URI edge.

(V9 sourced the session id from a session-start `additionalContext` payload — "Your current session ID: `<id>`". That injection path is retired in V10; use the `<dkg-session-context>` block instead.)

## 3. The annotation protocol

**After every substantive turn** — anything that reasoned, proposed, examined, or referenced something, i.e. every turn that wasn't a one-line acknowledgement — author a per-turn annotation assertion. **Over-eagerness is not a failure mode; under-coverage is.** The shared chat sub-graph is project memory, not a "DKG-relevant search index".

The canonical V10 write flow is three explicit MCP calls. One assertion per turn holds all of that turn's structured entities; promotion happens once at the end.

### 3.1 Look-before-mint (the convergence rule)

Before minting any new `urn:dkg:<type>:<slug>` URI:

1. Compute the **normalised slug**: lowercase → ASCII-fold → strip stopwords (`the/a/an/of/for/and/or/to/in/on/with`) → hyphenate → ≤60 chars.
2. Call `dkg_memory_search` with the **unnormalised label** (the daemon does its own fuzzy match across WM/SWM/VM layers).
3. If any returned hit's normalised slug matches yours → **REUSE** that URI. Prefer hits in higher layers (VM > SWM > WM) when multiple match.
4. Otherwise mint `urn:dkg:<type>:<slug>` per the patterns in §5.

**Never fabricate URIs** for entities you didn't discover via `dkg_memory_search` or freshly mint via this protocol. If unsure, prefer minting fresh and let humans (or future `owl:sameAs` reconciliation) merge duplicates.

### 3.2 Per-turn assertion shape

Build one assertion named `turn-anno-<sessionKey>-<N>` (matches `/^[a-z0-9-]+$/` once sanitised). Put every entity the turn produced into it. Promote once at the end.

```js
// Step 1 — stage the assertion (WM)
dkg_assertion_create({
  contextGraphId,                          // omit to default to .dkg/config.yaml
  name: `turn-anno-${sessionKey}-${N}`,
  subGraphName: "decisions",               // see §4 for routing
});

// Step 2 — write quads. Each entity gets:
//   - rdf:type + rdfs:label
//   - dcterms:created + prov:wasAttributedTo (provenance)
//   - chat:proposes / chat:examines / chat:mentions edge from <turn-uri>
dkg_assertion_write({
  contextGraphId,
  name: `turn-anno-${sessionKey}-${N}`,
  subGraphName: "decisions",
  quads: [
    // a Finding
    { subject: "urn:dkg:finding:swm-sync-acks-needed",
      predicate: "rdf:type",
      object: "http://dkg.io/ontology/findings/Finding" },
    { subject: "urn:dkg:finding:swm-sync-acks-needed",
      predicate: "rdfs:label",
      object: `"SWM sync needs explicit acks under burst load"` },
    { subject: "urn:dkg:finding:swm-sync-acks-needed",
      predicate: "http://purl.org/dc/terms/created",
      object: `"${new Date().toISOString()}"^^<http://www.w3.org/2001/XMLSchema#dateTime>` },
    { subject: "urn:dkg:finding:swm-sync-acks-needed",
      predicate: "http://www.w3.org/ns/prov#wasAttributedTo",
      object: agentUri },
    // the linking edge — restores V9 forSession behaviour
    { subject: turnUri,
      predicate: "http://dkg.io/ontology/chat/proposes",
      object: "urn:dkg:finding:swm-sync-acks-needed" },
  ],
});

// Step 3 — promote WM → SWM so teammates see it.
// IMPORTANT: the MCP wrapper rejects entities:"all" (Zod expects array)
// and the daemon REST also rejects empty arrays. Pass the explicit list
// of root subject URIs you minted (turn URI + every Decision/Finding/Task
// URI). Forgetting an entity here means it stays in WM, invisible to peers.
dkg_assertion_promote({
  projectId,                              // MCP uses projectId, not contextGraphId
  name: `turn-anno-${sessionKey}-${N}`,
  subGraphName: "decisions",
  entities: [
    turnUri,
    "urn:dkg:finding:swm-sync-acks-needed",
    // ...every other root URI
  ],
});
```

**Object encoding rule** (the #1 mistake): in `dkg_assertion_write`, the `object` field is EITHER a bare URI OR a literal wrapped in double quotes. A literal without surrounding quotes gets parsed as a URI and fails on embedded spaces. Typed literals use the `"<value>"^^<datatype>` form.

### 3.3 What goes in each per-turn assertion (the over-eagerness sweet spot)

For every substantive turn, the per-turn assertion should typically contain at least:

- `<turn-uri> chat:topic "<short label>"` — 2-3 topic literals for what the turn was about.
- `<turn-uri> chat:mentions <X>` — edges to every entity URI the turn referenced (via `dkg_memory_search` reuse or fresh mint).
- For any **durable artifact** produced — `Finding`, `Decision`, `Task`, `Question` — full triples per §3.2 plus the linking `chat:proposes` edge.
- For any **file touched** — see §7 "Code-graph annotations".

Skip the assertion entirely for one-line acknowledgements ("ok", "thanks", "done") — that's the only failure mode of over-eagerness.

## 4. Sub-graph routing

Pick `subGraphName` based on the entity type. The scanner and capture hook auto-create `code` and `chat`; the others must be registered once via `dkg_sub_graph_create` (a one-time bootstrap — see [`docs`](docs) or the workspace setup history).

| Entity type | Sub-graph |
|---|---|
| `chat:Turn` (hook-owned, do NOT write) | `chat` |
| Topic / mentions annotations on a turn | `chat` |
| `Finding`, `Decision`, `Question` | `decisions` |
| `Task` | `tasks` |
| `urn:dkg:code:file:*` / `urn:dkg:code:package:*` / `urn:dkg:code:repo:*` | `code` |
| `urn:dkg:github:repo|pr|issue:*` | `github` |
| `Concept`, agent profile, ontology refs | `meta` |

Multiple sub-graphs per turn are fine — create one assertion per sub-graph. The `turn-anno-<sessionKey>-<N>` name can be suffixed (`-decisions`, `-code`) to avoid collisions.

## 5. URI patterns

```
urn:dkg:concept:<slug>                       free-text concept (skos:Concept)
urn:dkg:topic:<slug>                         broad topical bucket
urn:dkg:question:<slug>                      open question
urn:dkg:finding:<slug>                       preserved claim/observation
urn:dkg:decision:<slug>                      architectural decision
urn:dkg:task:<slug>                          work item
urn:dkg:agent:<slug>                         agent identity (e.g. cursor-aleatoric)
urn:dkg:github:repo:<owner>/<name>           GitHub repository
urn:dkg:github:pr:<owner>/<name>/<num>       GitHub PR
urn:dkg:github:issue:<owner>/<name>/<num>    GitHub issue
urn:dkg:code:repo:<owner>/<name>             scanner-owned repo node
urn:dkg:code:file:<owner>/<name>/<relpath>   scanner-owned file node
urn:dkg:code:package:<owner>/<name>/<pkg>    scanner-owned package node
urn:dkg:chat:session:<key>                   capture-hook-owned session
urn:dkg:chat:session:<key>#turn:<idx>        capture-hook-owned turn (== <turn-uri>)
```

## 6. Tool reference (V10)

The full schema lives in each tool's MCP descriptor; this is the working map.

**Read tools (no side effects):**

- `dkg_memory_search` — keyword search across WM/SWM/VM with trust-weighted ranking. **Use this in look-before-mint.** (V9: `dkg_search`.)
- `dkg_query` — arbitrary SPARQL SELECT/ASK/CONSTRUCT. Pass `view` to pick the memory tier; pair with `contextGraphId` and `subGraphName` to narrow. **`view` and `subGraphName` are mutually exclusive in V10** — see §7b for the workaround. **Always wrap patterns in `GRAPH ?g { ... }`** or you'll get zero rows from sub-graph-routed data. (V9: `dkg_sparql`.)
- `dkg_get_entity` — describe one URI + its 1-hop inbound neighbourhood.
- `dkg_list_context_graphs` — every CG this node knows about. (V9: `dkg_list_projects`.)
- `dkg_sub_graph_list` — sub-graphs in a CG. (V9: `dkg_list_subgraphs`.)
- `dkg_list_activity` — recent activity feed across sub-graphs; filter by `agentUri`, `sinceIso`, `view`.
- `dkg_get_agent` — agent profile + authored counts.
- `dkg_assertion_query` — dump every quad in a single assertion (not SPARQL).
- `dkg_assertion_history` — read an assertion's lifecycle descriptor.
- `dkg_status`, `dkg_peer_info`, `dkg_wallet_balances` — node ops.

**Write tools (auto-promoted to SWM when `autoShare: true`):**

- `dkg_assertion_create` — stage a new WM assertion.
- `dkg_assertion_write` — append RDF quads to it.
- `dkg_assertion_promote` — WM → SWM. See §7b(3) for the explicit-array requirement.
- `dkg_assertion_discard` — drop a WM assertion.
- `dkg_share` — direct SWM write (skips WM staging). Prefer the assertion flow for durable work; use `dkg_share` for quick team-visible notes.
- `dkg_sub_graph_create` — register a new sub-graph in a CG.

**Inter-agent (best-effort P2P) — see §8:**

- `dkg_send_message`, `dkg_check_inbox` / `dkg_read_messages`, `dkg_subscribe`.

**HUMAN-GATED — do not call without explicit operator instruction:**

- `dkg_shared_memory_publish` — SWM → VM (on-chain, costs TRAC). The V9 marker tool `dkg_request_vm_publish` is gone; there is no agent-side "request review" shortcut.

**Retired (do not call — they no longer exist):**

- `dkg_annotate_turn`, `dkg_propose_decision`, `dkg_add_task`, `dkg_comment`, `dkg_request_vm_publish`, `dkg_set_session_privacy`, `dkg_get_chat`, `dkg_get_ontology`, `dkg_search`, `dkg_sparql`, `dkg_list_projects`, `dkg_list_subgraphs`.

## 7. Code-graph annotations

The `code` sub-graph has two layers:

**Layer 1 — Structural skeleton (scanner-owned, do not author yourself):** `.dkg/scripts/scan-code.mjs` walks `git ls-files` and writes `code:File`, `code:Package`, `code:Repository` triples. Run it whenever the operator asks for a fresh scan, or rely on the launchd template at `.dkg/scripts/com.dkg.scan-code.plist` if it's been installed. Run scan invocations: `node .dkg/scripts/scan-code.mjs <repo>` or `--all`.

**Layer 2 — Runtime context (yours to author):** when a turn touches a file (Read/Edit/Write or substantive reference), include in your per-turn assertion:

- `<turn-uri> chat:mentions <file-uri>` — every file touched.
- `<file-uri> code:touchedInTurnBy <agent-uri>` — for non-trivial touches (skip incidental Reads).
- `<file-uri> dcterms:modified "<iso-ts>"^^xsd:dateTime` — for Edit/Write only.
- `<file-uri> schema:description "<one line on why>"` — optional, but useful.

**The file URI MUST match the scanner's shape**: `urn:dkg:code:file:<owner>/<name>/<relpath>`. Run `dkg_memory_search` for the path before minting — if the scanner has indexed the repo, the URI exists; reuse it.

**Self-healing**: if `dkg_memory_search` for a file URI returns nothing, the containing repo hasn't been scanned. Either run `node .dkg/scripts/scan-code.mjs <repo-path>` once (if the daemon is up and you have shell access), or just mint the URI directly using the scanner's pattern — the next scan will reconcile.

## 7b. Query gotchas (learned the hard way)

Things that consistently bite agents writing SPARQL via `dkg_query` against this CG:

**(1) Sub-graph data lives in named graphs, not the default graph.** A query like `SELECT ?s WHERE { ?s a code:File }` returns ZERO rows even though there are thousands of `code:File` entities. Wrap every triple pattern in `GRAPH ?g { ... }`:

```sparql
SELECT ?s WHERE { GRAPH ?g { ?s a <http://dkg.io/ontology/code/File> } }
```

This applies to every sub-graph other than the bare CG default — `chat`, `code`, `decisions`, `tasks`, `github`, `meta` all live in named graphs (e.g. `did:dkg:context-graph:<cg>/code/_shared_memory`).

**(2) `subGraphName` is incompatible with `view: "shared-working-memory"` in V10.** The daemon returns HTTP 400 `"subGraphName cannot be combined with view-based routing. Sub-graph scoping within views is deferred to V10.x."` Two workarounds:

- For scoped queries: **omit `view`** entirely and pass `subGraphName: "<name>"` — that's the legacy data-path query and it routes correctly.
- For cross-subgraph views: pass `view: "shared-working-memory"` without `subGraphName`, then filter by named graph in your SPARQL: `GRAPH <did:dkg:context-graph:<cg>/code/_shared_memory> { ?s ?p ?o }`.

**(3) `dkg_assertion_promote` requires an explicit array of root URIs via MCP.** The MCP wrapper rejects `entities: "all"` (Zod expects array) and the daemon REST rejects empty arrays with `"entities" must be "all" or a non-empty array of non-empty strings`. Pass the explicit list of every root subject URI you minted (turn URI + every `Decision`/`Finding`/`Task`/`Question`/file URI). Anything not listed stays in WM, invisible to peers. (The shell scanner can hit the daemon REST directly with `entities: "all"`; only the MCP-side has the array constraint.)

**(4) Path segments in `code:` URIs are percent-encoded.** Files with spaces, parens, `+`, `@`, etc. would otherwise produce IRIs that Oxigraph rejects with `Invalid IRI code point`. The scanner encodes each path segment with `encodeURIComponent` and joins with `/`. So `@origintrail-official/dkg-core` becomes `%40origintrail-official/dkg-core` inside the URI. When minting a file URI by hand, apply the same encoding.

## 8. Agent-to-agent debug chat

This repository's DKG nodes can be paired with each other. When they are, agents working on the same problem from different nodes can exchange encrypted libp2p messages — invaluable for debugging network features where neither agent has the whole picture on their own. The MCP ships two tools for this:

- **`dkg_check_inbox`** — read unread peer messages from this node's local SQLite history.
- **`dkg_send_message`** — send an encrypted chat to another agent on the network.

### When to call which

**Call `dkg_check_inbox` at the start of every session.** If the digest is non-empty, surface the messages to the operator BEFORE doing anything else — those peers are waiting for a reply. A typical opener after operator types anything:

> "Before I get to that — `bob-node` sent 2 messages while you were away: …"

**Call `dkg_check_inbox` again whenever** the operator's prompt references another node, the current task is part of a known cross-node debugging effort, or you see an injected `<dkg-inbox-notice>` block in the session context (the prompt-hook may have already fetched fresh messages — re-check to be sure nothing was missed).

**Call `dkg_send_message`** whenever the operator says "ask <name>", "tell <name>", "let <name> know", "ping <name>", or otherwise indicates cross-node communication. Use the operator's word for the recipient as `to` — the daemon resolves it to a peerId. Don't ask the operator to clarify if they used a recognisable name like "alice's agent" → `to: "alice-node"`.

### ACL-aware error handling

If `dkg_send_message` returns `delivered: false` with `error: "unauthorized: ..."`, the receiver's chat ACL rejected the message. Don't retry — the situation is human-fixable. Tell the operator something like:

> "Receiver rejected my message via their chat ACL: `<reason>`. Ask the operator on the other node to either add this node to their `chat.acl.peerAllowlist`, or add us as a member of the CG they have scoped to."

For any other error (peer not found, timeout, network), retry once before bothering the operator.

### Don't

- **Don't send messages without operator approval** when you're about to expose anything beyond standard debugging context (file contents, sensitive code paths). When in doubt, draft the message and let the operator confirm.
- **Don't loop** — if you send a message and the response comes back asking another question, surface it to the operator before auto-replying. Phase 1 is operator-in-the-loop by design; Phase 3 (autonomous bridge) is a future RFC.
- **Don't conflate chat with the `chat` sub-graph.** The `chat` sub-graph (captured by `capture-chat.mjs`) is the operator's conversation with you; `dkg_send_message` is *your* conversation with another agent. They're separate channels for now.

## 9. Universal Messenger (v10.0.0-rc.9)

DKG's short peer-to-peer protocols (chat, skill request, query-remote, swm-sender-key, private-access, join-request, storage-ack, verify-proposal) all route through a single reliability substrate called the **Universal Messenger**. Architecture: [`docs/architecture/universal-messenger.md`](./docs/architecture/universal-messenger.md). Operator-facing surfaces: [`docs/operate/messenger.md`](./docs/operate/messenger.md). Migration recipe for a hypothetical 9th protocol: [`.ai/specs/messenger-add-protocol.md`](./.ai/specs/messenger-add-protocol.md).

**Convergence rule for agents working on this codebase**: route any new short-message protocol through `Messenger.sendReliable` and register handlers via `Messenger.register` — never `ProtocolRouter.send` / `ProtocolRouter.register` directly. The substrate gives you sender-side durable retry (SQLite outbox surviving daemon restart), receiver-side dedup keyed by `messageId`, sender-side response cache, stale-snapshot-safe retries, opportunistic flush on `connection:open`, DHT-walk-on-stall, and observability via `/api/slo`. Bypassing it loses every one of those properties. The migration recipe lives at `.ai/specs/messenger-add-protocol.md` and includes the worked example from PR-3 (chat).

## 10. Things to NOT do

- **Don't fabricate URIs.** Every URI in `chat:mentions` (or any other edge) must come from `dkg_memory_search` or be freshly minted via look-before-mint.
- **Don't skip turns to "save tokens".** A three-step annotation per turn is ~few hundred ms. Coverage wins.
- **Don't publish to VM via MCP.** `dkg_shared_memory_publish` mints on-chain and costs TRAC. Operator-gated only.
- **Don't normalise slugs in your `dkg_memory_search` query.** Pass the unnormalised label; the daemon's fuzzy match wants the most signal. Normalise only when comparing for reuse-vs-mint.
- **Don't try to compute the turn URI yourself.** The `<dkg-session-context>` block already gives it to you. Computing it from session state files is brittle and the rule is "use what the hook injected".
- **Don't write the `chat:Turn` entity yourself.** The capture hook owns it. Your job is to write annotations that LINK to it, not duplicate it.
- **Don't call `ProtocolRouter.send` directly for new short-message protocols.** Use `Messenger.sendReliable` (see §9 Universal Messenger).
- **Don't call any V9-retired tool** listed in §6 — they no longer exist on the MCP surface; calling them will error.

## 11. Cheat sheet (per substantive turn)

```
1. Read <dkg-session-context> from the incoming prompt → grab <turn-uri>, <agent-uri>.
2. dkg_memory_search "<unnormalised label from the turn>" → reuse-or-mint URIs.
3. dkg_assertion_create({ name: `turn-anno-${sessionKey}-${N}`, subGraphName: <route per §4> }).
4. dkg_assertion_write({ name, quads: [
     // topic + mentions on <turn-uri>
     // every Decision/Finding/Task/Question with provenance triples
     // <turn-uri> chat:proposes <each durable artifact>
     // every file touched: <turn-uri> chat:mentions <file-uri>, code:touchedInTurnBy, dcterms:modified
   ]}).
5. dkg_assertion_promote({ name, entities: [<turn-uri>, ...every-minted-root-uri] }).
```

That's it. The graph grows; teammates' agents see your work in seconds via auto-recall; humans ratify on-chain via `dkg_shared_memory_publish` when worthwhile.
