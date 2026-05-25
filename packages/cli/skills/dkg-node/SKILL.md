---
name: dkg-node
description: The DKG V10 Node is your primary memory system. This skill teaches you to operate your node's three-layer verifiable memory — write and retrieve private drafts in Working Memory, share with peers in Shared Working Memory, and publish permanently to Verified Memory on-chain.
---

# DKG V10 Node Skill

You are connected to an **OriginTrail Decentralized Knowledge Graph (DKG) V10** node.
This skill teaches you the full node API surface so you can operate autonomously.

## 1. Node Info

> This section is dynamically generated from node state at serve-time.

- **Node version:** (dynamic)
- **Base URL:** (dynamic)
- **Peer ID:** (dynamic)
- **Node role:** (dynamic — `core` or `edge`)
- **Available extraction pipelines:** (dynamic)

To see which context graphs (projects) are currently subscribed, call `GET /api/context-graph/list` — this returns a live list that stays current as projects are created or subscribed during the session.

## 2. Capabilities Overview

> **Note:** This skill describes the full DKG V10 API surface. Some endpoints
> may not yet be available on your node depending on its version. Call
> `GET /api/status` to check the node version, and rely on error responses
> (404) to detect unimplemented routes. The node is under active development
> toward V10.0 — endpoints are being shipped incrementally.

This node provides a three-layer **verifiable memory system** for AI agents:

| Layer | Scope | Cost | Trust Level | Persistence |
|-------|-------|------|-------------|-------------|
| **Working Memory (WM)** | Private to you | Free | Self-attested | Local, survives restarts |
| **Shared Working Memory (SWM)** | Visible to team | Free | Self-attested (gossip replicated) | TTL-bounded |
| **Verified Memory (VM)** | Permanent, on-chain | TRAC tokens | Self-attested → endorsed → consensus-verified | Permanent |

**What you can do:** create knowledge assertions, import files (PDF, DOCX, Markdown),
share knowledge with peers, publish to the blockchain, endorse others' knowledge,
propose M-of-N consensus verification, query across all memory layers, and
discover other agents on the network.

## 3. Quick Start

> Before writing in production, read §6 "Routing: Turn Context Override" — it governs which context graph each turn's operations target.

**Canonical flow:** create a context graph, create an assertion, write triples to
WM, promote to SWM, then publish SWM to VM. Data must be in SWM before VM
publishing; the on-chain transaction is a finality signal for data peers already
received via gossip.

```bash
curl -X POST $BASE_URL/api/context-graph/create -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"id":"my-project","name":"My Project"}'
curl -X POST $BASE_URL/api/assertion/create -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"contextGraphId":"my-project","name":"notes"}'
curl -X POST $BASE_URL/api/assertion/notes/write -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"contextGraphId":"my-project","quads":[{"subject":"https://example.org/alice","predicate":"https://schema.org/name","object":"\"Alice\"","graph":""}]}'
curl -X POST $BASE_URL/api/assertion/notes/promote -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"contextGraphId":"my-project","entities":"all"}'
curl -X POST $BASE_URL/api/shared-memory/publish -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"contextGraphId":"my-project"}'
curl -X POST $BASE_URL/api/query -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"sparql":"SELECT * WHERE { ?s ?p ?o } LIMIT 10","contextGraphId":"my-project","view":"working-memory","agentAddress":"YOUR_PEER_ID"}'
```

## 4. Authentication

**Token usage:** Include `Authorization: Bearer $TOKEN` on all requests.
Every request's Bearer token is resolved to a `callerAgentAddress` the
daemon uses for access-control decisions. Single-token nodes still work —
requests without an explicit caller fall back to the node's default agent.

**Public endpoints (no auth):** `GET /api/status`, `GET /api/chain/rpc-health`,
`GET /.well-known/skill.md`.

### Token discovery

**Co-located agents (running on the same machine as the daemon).** The daemon writes its admin token to `~/.dkg/auth.token` on first start. If your adapter provides a DKG client (e.g. the OpenClaw adapter's `DkgDaemonClient`), **prefer the adapter's high-level tools** (`createContextGraph`, `createAssertion`, `promoteAssertion`, etc.) — they load this file automatically and you never need to handle `$TOKEN` yourself. Only fall back to raw HTTP if no adapter tool covers what you need, in which case:

```bash
TOKEN=$(cat ~/.dkg/auth.token)
```

**Remote agents (not on the daemon host).** Register your own agent via `POST /api/agent/register` and use the returned `authToken` — see "Agent identity" below. Do not ask the user to paste `~/.dkg/auth.token` from another machine; that's the node's admin credential and should stay on the host that owns the daemon.

**If you get 401 or 403 on a protected route, diagnose in this order:**

1. **Is there a token on the request?** A missing `Authorization` header → 401. If you tried to build a `curl` command without discovering the token first, the adapter's built-in tools should have been your first choice.
2. **Does the token correspond to an agent the node knows?** Call `GET /api/agent/identity` — the response tells you who the server sees as the caller. If it doesn't match who you think you are, you're holding the wrong token.
3. **Do you have CG-level access?** A valid token + recognized agent can still get 403 on context-graph operations if the agent isn't a participant / creator of that CG. Check the CG's participant list or use an invite / join flow (§6).

Never guess — `GET /api/agent/identity` is free and definitive. Call it first.

**Agent identity:**

- `POST /api/agent/register` — register a new agent on this node.
  Body: `{ "name": "...", "framework"?: "...", "publicKey"?: "..." }`.
  Returns `{ agentAddress, authToken, mode }` where `mode` is
  `"custodial"` (node holds the key; response also carries `publicKey` +
  `privateKey` once — store them) or `"self-sovereign"` (you supplied
  the key; no private key returned).
- `GET /api/agent/identity` — resolve the calling token to an agent.
  Returns `{ agentAddress, agentDid, name, framework, peerId, nodeIdentityId }`.
  Use this to confirm which identity the node is treating you as before
  performing access-controlled operations.

## 4a. Tool vs. HTTP — when to use each

On an **OpenClaw runtime** or **Hermes provider runtime**, prefer the `dkg_*` tools below over raw HTTP — the adapter handles token discovery, parameter aliasing, and error shaping. Other runtimes may expose different tool surfaces — Cursor / Claude Code / MCP clients should install [`@origintrail-official/dkg-mcp`](../../../mcp-dkg/README.md) for its own (different) tool set. When no tool layer applies (raw CLI, custom HTTP client, or an operation not covered by the tools below), use the HTTP API — the rest of this doc is the reference.

Drop to HTTP when the operation isn't in the table — participant self-service join/sign routes (§6), conditional writes (§5), publisher jobs (§8), file retrieval (§7), endorse / verify / update (§5), SSE events (§8). Each tool's full schema lives in `DkgNodePlugin.ts`; this table exists to help you find the right name, not re-document it.

| Tool | Wraps | Short description |
|---|---|---|
| `dkg_status` | `GET /api/status` | Node health and subscribed CGs |
| `dkg_wallet_balances` | `GET /api/wallets/balances` | TRAC / ETH balances |
| `dkg_list_context_graphs` | `GET /api/context-graph/list` | List all context graphs the node knows about — each entry carries `subscribed` and `synced` flags (discovered-but-not-subscribed entries are present too) |
| `dkg_context_graph_create` | `POST /api/context-graph/create` | Create a simple context graph (tool schema accepts only `name` / `description` / `id` — no multi-sig inputs). On chain-enabled nodes the daemon may auto-register on-chain as a best-effort side-effect — see §6 for the register semantics. Multi-sig CGs are HTTP-only |
| `dkg_subscribe` | `POST /api/context-graph/subscribe` | Subscribe + catch up an existing CG |
| `dkg_context_graph_invite` | `POST /api/context-graph/invite` | Create a ready-to-share invite for another peer to join a context graph |
| `dkg_participant_add` | `POST /api/context-graph/{id}/add-participant` | Add an agent address to a curated/private context graph allowlist |
| `dkg_participant_remove` | `POST /api/context-graph/{id}/remove-participant` | Remove an agent address from a curated/private context graph allowlist |
| `dkg_participant_list` | `GET /api/context-graph/{id}/participants` | List current context graph participants / allowed agents |
| `dkg_join_request_list` | `GET /api/context-graph/{id}/join-requests` | List pending join requests for a context graph |
| `dkg_join_request_approve` | `POST /api/context-graph/{id}/approve-join` | Approve a pending join request by agent address |
| `dkg_join_request_reject` | `POST /api/context-graph/{id}/reject-join` | Reject a pending join request by agent address |
| `dkg_assertion_create` | `POST /api/assertion/create` | Start a WM assertion |
| `dkg_assertion_write` | `POST /api/assertion/{name}/write` | Append triples to a WM assertion |
| `dkg_assertion_promote` | `POST /api/assertion/{name}/promote` | Move a WM assertion's triples to SWM |
| `dkg_assertion_discard` | `POST /api/assertion/{name}/discard` | Drop a WM assertion |
| `dkg_assertion_import_file` | `POST /api/assertion/{name}/import-file` | Multipart upload a document + extract triples |
| `dkg_assertion_query` | `POST /api/assertion/{name}/query` | Dump every quad in a single assertion (not SPARQL) |
| `dkg_assertion_history` | `GET /api/assertion/{name}/history` | Read an assertion's lifecycle descriptor |
| `dkg_import_artifact_read_markdown` | `POST /api/assertion/import-artifact/read-markdown` | Safely read Markdown for a completed imported attachment by content-addressed hash |
| `dkg_import_artifact_resolve` | `POST /api/assertion/import-artifact/resolve` | Optional metadata re-check for completed imported attachments |
| `dkg_semantic_enrichment_write` | `POST /api/assertion/semantic-enrichment/write` | Append model-derived semantic triples and provenance to the imported assertion |
| `dkg_publish` | `POST /api/shared-memory/write` + `POST /api/shared-memory/publish` | **Two-call helper**: first writes supplied quads to SWM via `/write`, then publishes all SWM → VM (TRAC). Calling only the `/publish` route skips the write — if dropping to raw HTTP, use both calls in order |
| `dkg_shared_memory_publish` | `POST /api/shared-memory/publish` | **Canonical finalizer** after `dkg_assertion_promote`: publish SWM → VM, no fresh quads |
| `dkg_share` | `POST /api/shared-memory/write` | Directly write concise team-visible knowledge to SWM without staging a WM assertion. Prefer the WM assertion → promote flow for durable/canonical work. Both Hermes and OpenClaw expose the same tool schema (required `content` and `context_graph_id`, optional `sub_graph_name`), so MCP-discovered call signatures are portable. The OpenClaw implementation additionally validates content as non-whitespace, mints a unique subject per share (returned in the response), and N-Triples-quotes content; Hermes is currently looser on those points — the parallel hardening is tracked in OriginTrail/dkg#414. |
| `dkg_sub_graph_create` | `POST /api/sub-graph/create` | Register a sub-graph inside a CG |
| `dkg_sub_graph_list` | `GET /api/sub-graph/list` | List sub-graphs in a CG |
| `dkg_query` | `POST /api/query` | Read-only SPARQL across assertions in a CG. Pass `view` (`working-memory` / `shared-working-memory` / `verified-memory`) to pick the layer — when `view` is set, `context_graph_id` is required; for WM reads, optional `agent_address` targets another agent's WM (defaults to this node). Omit `view` for a legacy cross-graph data-path query. |
| `dkg_query_catalog_list` | `POST /api/profile/query-catalog/read` | List saved SPARQL queries declared in the project profile query catalog |
| `dkg_query_catalog_run` | `POST /api/profile/query-catalog/read` + `POST /api/query` | Run a saved catalog query by slug or exact display name |
| `dkg_query_catalog_save` | `POST /api/profile/query-catalog/write` | Save a read-only SPARQL query into the project profile query catalog |
| `dkg_find_agents` | `GET /api/agents` | Discover other agents (best-effort P2P) |
| `dkg_send_message` | `POST /api/chat` | Send a direct message (best-effort P2P) |
| `dkg_read_messages` | `GET /api/messages` | Read inbound messages |
| `dkg_invoke_skill` | `POST /api/invoke-skill` | Call another agent's skill (best-effort P2P) |

P2P tools fail gracefully when the peer is offline. `dkg_publish` (fresh quads + write + publish, two HTTP calls) and `dkg_shared_memory_publish` (publish existing SWM, one HTTP call) differ in intent: use the two-call helper for "I have quads, publish now"; use the canonical finalizer as step 4 of the stepwise write → promote → publish flow. `dkg_share` is a direct SWM convenience helper for quick team-visible notes, not a replacement for assertion lifecycle tracking.

**Bulk imports (>5,000 quads in one logical operation):** the per-call `dkg_assertion_*` loop IS the chunked-write API; there is no `/api/import/bulk`. If you're pushing a code graph, a corpus, or any multi-thousand-quad import, read [`dkg-importer/SKILL.md`](../dkg-importer/SKILL.md) first — it codifies the chunking budgets, HTTP 413 recovery, resumability manifest, and canonical-URI rules so your importer converges with the rest of the workspace.

### HTTP-only operations (no tool wrapper)

- **Participant self-service join/sign flow** — see §6.
- **Conditional writes** (`POST /api/shared-memory/conditional-write`) — see §5 SWM.
- **Async publisher job queue** (`/api/publisher/*`) — see §8.
- **Raw query catalog writes** (`POST /api/profile/query-catalog/write`) when not using `dkg_query_catalog_save` — see §5 "Saved Query Catalog".
- **Raw file retrieval** (`GET /api/file/{fileHash}`) — see §7.
- **Endorse / verify / update** (`POST /api/endorse`, `/verify`, `/update`) — see §5 VM.
- **SSE event stream** (`GET /api/events`) — see §8.

## 5. Memory Model

Knowledge flows through three layers: **WM → SWM → VM**. Always start in Working Memory, then promote outward as the knowledge matures.

### Working Memory (WM) — Private assertions

WM assertions are your agent-local drafts — private to you, readable and
writable only by your peer ID, never gossiped. Use them to stage knowledge
before promoting it to SWM (team) or through to VM (chain-anchored).
**This is where you write first.**

- `POST /api/assertion/create` — create a named private assertion
  Body: `{ "contextGraphId": "...", "name": "...", "subGraphName"?: "..." }`
- `POST /api/assertion/{name}/write` — write triples to an assertion
  Body: `{ "contextGraphId": "...", "quads": [...], "subGraphName"?: "..." }`
- `POST /api/assertion/{name}/query` — read assertion contents as quads
  Body: `{ "contextGraphId": "...", "subGraphName"?: "..." }`
- `POST /api/assertion/{name}/promote` — promote assertion triples to SWM
  Body: `{ "contextGraphId": "...", "entities"?: [...] | "all", "subGraphName"?: "..." }`
- `POST /api/assertion/{name}/discard` — drop the assertion graph
  Body: `{ "contextGraphId": "...", "subGraphName"?: "..." }`
- `POST /api/assertion/{name}/import-file` — import a document (multipart/form-data) — see §7
- `GET /api/assertion/{name}/extraction-status?contextGraphId=...` — poll the status of an import-file extraction job
- `GET /api/assertion/{name}/history?contextGraphId=...&agentAddress=...&subGraphName=...` — read the assertion's lifecycle descriptor (created → promoted → published → finalized | discarded) from the CG's `_meta` graph. Returns `{ state, timestamps, operationIds, rootEntities, kcUalRefs }` or 404 if no lifecycle record exists.

> **Lifecycle provenance.** Every assertion carries a durable `dkg:Assertion` lifecycle record in the CG's `_meta` graph, updated as a side effect of `/create`, `/write`, `/promote`, `/discard`, and publish. The assertion data moves WM→SWM→VM on promotion — the lifecycle record is an independent audit trail you can read without touching the data itself.

> If `subGraphName` is provided but the sub-graph is not registered in the CG's
> `_meta` graph, all assertion operations throw
> `Sub-graph "{name}" has not been registered in context graph "{id}". Call createSubGraph() first.`
> Create the sub-graph before targeting it.

### Shared Working Memory (SWM) — Team-visible

SWM is for knowledge you've promoted from WM and want peers to see. Data arrives here via `POST /api/assertion/{name}/promote` (from WM) or via direct SWM writes (escape hatch for team-visible data that doesn't need a WM staging step).

> **Visibility.** SWM gossips to peers in the context graph's allowlist.
> For a **curated** CG (the default — see §6), only listed agents/peers
> receive the gossip. For an **explicitly public** CG (`public: true` at
> creation), every peer subscribed to the CG receives the gossip.
> Working Memory is per-agent regardless of CG visibility.

- `POST /api/shared-memory/write` — write triples directly to SWM (gossip-replicated). Body: `{ contextGraphId, quads, subGraphName? }`. Use the WM → promote path for most workflows; direct SWM writes are for bulk team data that skips the private draft stage.
- `POST /api/shared-memory/conditional-write` — compare-and-swap write. Body: `{ contextGraphId, quads, conditions: [...], subGraphName? }`. Each condition is `{ subject: IRI, predicate: IRI, expectedValue: string | null }`; `null` means "must not exist", a string must match the current object after N-Triples serialization. Any mismatch throws `StaleWriteError` and leaves SWM unchanged. `conditions` must be non-empty — use `/api/shared-memory/write` for unconditional writes.
- `POST /api/shared-memory/publish` — promote SWM triples to Verified Memory (costs TRAC)

### Verified Memory (VM) — Permanent, on-chain

> **All VM publishing goes through SWM.** The HTTP API exposes no direct
> WM → VM route — always promote to SWM first, then publish from there.
> The on-chain transaction is a finality signal that seals data peers already hold.

- `POST /api/shared-memory/publish` — promote SWM data to Verified Memory (costs TRAC)
- `POST /api/update` — update an existing Knowledge Asset (reads new data from SWM)
- `POST /api/endorse` — endorse a Knowledge Asset ("I vouch for this")
- `POST /api/verify` — propose or approve M-of-N consensus verification

### Querying

**Agent-initiated free-text recall: `memory_search` tool.**

The `memory_search` tool is the recommended entry point for free-text memory recall. It fans out across all trust tiers (WM drafts, SWM consolidated, VM on-chain) in both the `agent-context` graph AND the currently-selected project context graph, then returns trust-weighted ranked snippets.

- Input: `{ query: string, limit?: number }` — a natural-language query; limit is a hint (default 20, capped at 100). The default is intentionally larger than the per-turn auto-recall (which caps at 5) so the agent gets a richer snapshot when it explicitly invokes recall. Shares the same fan-out and ranking as auto-recall.
- Output: `{ query, count, scope, hits: [{ snippet, layer, source, score, path }] }`. `layer` is one of `agent-context-wm | agent-context-swm | agent-context-vm | project-wm | project-swm | project-vm`. Higher-trust layers outrank lower-trust ones on the same content (VM ×1.3, SWM ×1.15, WM ×1.0).

**When to prefer `memory_search` vs `dkg_query`:**

- **`memory_search`** — free-text recall across all memory layers. Use when you want "what does my memory have on topic X". No SPARQL required.
- **`dkg_query`** — precise SPARQL control over a known graph pattern, specific predicates, or named graphs. Use when `memory_search` gives you too much or you want to ask a structured question (e.g. "give me every `schema:name` under this project's WM").

**Raw HTTP surface:**

- `POST /api/query` — SPARQL query. Body parameters:
  - `sparql` (required) — the query string
  - `contextGraphId` — scope query to one CG (recommended)
  - `view` — `working-memory` | `shared-working-memory` | `verified-memory`
  - `agentAddress` — required when `view: "working-memory"` (WM is per-agent)
  - `assertionName` — scope to a specific WM assertion graph
  - `subGraphName` — scope to a specific sub-graph
  - `graphSuffix` — advanced: target a specific internal graph (e.g. `_shared_memory`, `_meta`)
  - `includeSharedMemory` / `includeWorkspace` — merge SWM into the result set
  - `verifiedGraph` — target a specific VM (on-chain) named graph
- `POST /api/query-remote` — query a remote peer via P2P. Body: `{ peerId, lookupType, contextGraphId, ual?, entityUri?, rdfType?, sparql?, limit?, timeout? }`. `lookupType` picks the strategy (e.g. `sparql`, `entity`, `rdf-type`). Remote peer ACL is enforced.

### Saved Query Catalog

The query catalog is project profile metadata: saved SPARQL queries attached to
a context graph and grouped by sub-graph/catalog. In the Node UI it appears in
the Project view as **Query catalog** above the context-graph query surface and
inside sub-graph detail views; it is not the Graph Overview.

Use this decision order:

1. When a turn has a clear selected project/context graph
   (`target_context_graph` or an explicit user-provided context graph) and the
   user asks a substantive question about that project's data, call
   `dkg_query_catalog_list` before inventing ad-hoc SPARQL or using broad
   free-text recall. Skip this first-check only for operational/admin requests
   such as daemon status, publishing, setup, connectivity, permissions, or
   explicit writes.
2. Inspect the returned saved-query candidates (`slug`, `name`, `description`,
   `catalogName`, and `subGraph`) and choose the query that best matches the
   user's wording. If exactly one candidate clearly matches, run it with
   `dkg_query_catalog_run` and answer from the result. Mention the saved query
   used in one short phrase when useful.
3. If several candidates plausibly match and the answer depends on which one
   is used, list the candidate names/slugs and ask the user to choose. If one
   is clearly the best default, run it and note that other catalog options
   exist only if the result is incomplete.
4. If the catalog is empty or no saved query matches the request, continue with
   the normal lookup path (`memory_search` for broad recall or `dkg_query` for
   precise SPARQL). Do not pretend a catalog query was used.
5. If the user asks which saved queries exist, call `dkg_query_catalog_list`
   with the selected `context_graph_id` and present the useful candidates.
6. If the user explicitly asks to run a saved query, call
   `dkg_query_catalog_run` with the selected `context_graph_id` and the saved
   query slug or exact display name. If the name is ambiguous, list first and
   ask/choose by slug.
7. If the user asks to save the current/query/SPARQL, call
   `dkg_query_catalog_save` with the selected `context_graph_id`, a concise
   `name`, optional `description`, and the exact read-only SPARQL text. If the
   SPARQL text is not present in the user message or turn context, ask for it;
   do not invent a query and save it as if it came from the user.
8. If no query catalog tool is available, use `dkg_query` against the profile
   graph (`did:dkg:context-graph:<id>/meta/query-catalog`) to read saved
   queries, then run the selected `prof:sparqlQuery` with `dkg_query`.
9. Only write or change query catalog entries when the user explicitly asks to
   save/update catalog queries.

OpenClaw tool path:

- `dkg_query_catalog_list` input: `{ "context_graph_id": "<contextGraphId>" }`
- `dkg_query_catalog_run` input:
  `{ "context_graph_id": "<contextGraphId>", "query": "<slug-or-exact-name>" }`
- `dkg_query_catalog_save` input:
  `{ "context_graph_id": "<contextGraphId>", "name": "<display-name>", "sparql": "<read-only-sparql>", "description"?: "...", "result_column"?: "uri" }`
  Optional advanced fields: `sub_graph` (defaults to `__context_graph`),
  `catalog_slug`, `catalog_name`, and `catalog_description`.

CLI fallback:

```bash
dkg query-catalog list <context-graph>
dkg query-catalog run <context-graph> <query-slug-or-exact-name>
```

HTTP fallback:

- `POST /api/profile/query-catalog/read`
  Body: `{ "contextGraphId": "<contextGraphId>" }`
  Returns bindings with `q`, `subGraph`, `catalog`, `name`, `description`,
  `sparql`, `rank`, `catalogName`, `catalogDescription`, and `catalogRank`.
- `POST /api/profile/query-catalog/write`
  Body: `{ "contextGraphId": "<contextGraphId>", "quads": [...] }`
  The daemon stores these triples in
  `did:dkg:context-graph:<contextGraphId>/meta/query-catalog` regardless of
  the incoming quad `graph` field. Prefer `dkg_query_catalog_save` for normal
  user-requested saves. Raw writes append profile triples; prefer a new
  saved-query URI for new saved queries and avoid overwriting unrelated
  catalog/profile metadata.

Profile RDF shape for writes:

```turtle
@prefix prof: <http://dkg.io/ontology/profile/> .
@prefix schema: <http://schema.org/> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<urn:dkg:profile:PROJECT:catalog:CATALOG> rdf:type prof:QueryCatalog ;
  prof:forSubGraph "SUBGRAPH" ;
  prof:displayName "Catalog name" ;
  schema:description "Catalog description" ;
  prof:rank "50"^^xsd:integer .

<urn:dkg:profile:PROJECT:query:QUERY> rdf:type prof:SavedQuery ;
  prof:forSubGraph "SUBGRAPH" ;
  prof:inCatalog <urn:dkg:profile:PROJECT:catalog:CATALOG> ;
  prof:displayName "Saved query name" ;
  schema:description "What this query returns" ;
  prof:sparqlQuery "SELECT ?uri WHERE { ?uri ?p ?o } LIMIT 50" ;
  prof:resultColumn "uri" ;
  prof:rank "100"^^xsd:integer .
```

When composing saved SPARQL, keep it read-only (`SELECT`, `ASK`, `CONSTRUCT`,
or `DESCRIBE`). Prefer returning a stable `?uri` column when the result should
feed entity-list UI surfaces.

### Operational constraints

Respect these when producing writes — they're enforced at the node and produce errors rather than silent truncation.

- **Reorganizing assertions.** There is no rename-assertion or move-between-sub-graphs endpoint. To reorganize, create a new assertion (with `subGraphName?` for a different partition), copy the triples over via `/write`, then `/discard` the original. A new assertion starts a fresh lifecycle record in `_meta`.
- **Reserved subject IRIs.** Subjects matching `urn:dkg:file:*` or `urn:dkg:extraction:*` are reserved for internal file/extraction metadata and are rejected at write time. Use a different subject IRI.
- **SWM gossip size cap (10 MB).** A single promote or SWM write must fit in one 10 MB gossip message. Split larger assertions by root entity before promoting — use the `entities` parameter on `/promote` to promote subsets.
- **SWM entity ownership (first-writer-wins).** The first peer to write a root entity in SWM becomes its owner; other peers' promotes or writes against that same root entity are rejected with an ownership error. Partition work by agent-owned root entities to avoid conflicts.
- **Blank nodes are auto-skolemized.** Any `_:b0`-style blank nodes you submit are deterministically rewritten to UUID-backed URIs before storage, so IDs stay stable across sync and on-chain anchoring. Prefer explicit IRIs in production data.

### Automatic recall

**Making memories recallable.** Any literal content of 20+ characters written under a project or `agent-context` context graph is automatically searchable by slot-backed recall on future turns — no specific assertion name or predicate is required. Write RDF shapes that fit your domain (use `schema:description`, `rdfs:comment`, a custom ontology predicate, anything semantically appropriate). Slot-backed recall performs a permissive keyword-substring match against all 6 memory layers (WM/SWM/VM × `agent-context` + active project context graph) on every turn.

**Per-turn `<recalled-memory>` block.** On every turn, the adapter's `before_prompt_build` hook runs a narrow recall across all 6 memory layers using your latest user message as the query, caps the result at top 5 trust-weighted hits, and injects them as a `<recalled-memory>` block into the system context. You do NOT need to call `memory_search` to see these — they're already in the prompt before you start reasoning.

Call `memory_search` (default 20 hits, capped at 100) when:

1. You need a broader recall than the 5-hit auto-snapshot, OR
2. You want to search for something unrelated to the user's current message.

The `<recalled-memory>` block is stripped from outgoing assistant text before turns are persisted, so recalled context does not boomerang into future-turn queries.

## 6. Context Graphs

Context Graphs are scoped knowledge domains with configurable access and governance. In the node UI, context graphs are called **projects** — when a user says "my project" or selects a project in the right-panel dropdown, they mean a context graph.

> **Default privacy model.** Context graphs created via the
> `dkg_context_graph_create` tool are **curated/private by default** —
> only agents in the allowlist can read SWM gossip or subscribe to
> the CG. The creator is auto-included in the allowlist on creation,
> so they can immediately read and write without an explicit
> self-invite. Pass `public: true` to create an open/discoverable
> context graph instead. Pass `allowed_agents: ["0x..."]` to invite
> collaborators atomically with creation, or use
> `dkg_participant_add` to invite them later. Working Memory is
> per-agent regardless of CG visibility. Verified Memory anchors
> are public on-chain — but the underlying private quads stay local
> on the publishing node and are gated to allowed peers.

### Routing: Turn Context Override

When the chat turn includes injected context with `target_context_graph`, treat that value as BOTH:

1. **The authoritative target context graph for tool routing on this turn** — default all DKG reads, writes, imports, promotions, publishes, and queries in that turn to this value unless the user explicitly overrides it in the same message.
2. **The user's currently-selected project in the UI** — when the user asks introspective questions like "which project am I on?", "what is currently selected?", "do you see that I have X selected?", answer directly from this field. Do not claim you cannot see the UI state. The field IS the UI state: the right-side panel project dropdown stamps it onto every turn envelope before the turn reaches you, so its presence means the user has that project selected and its absence means they have nothing selected.

### Context-First Lookup

For any substantive user request related to the current project, consult the selected project context graph before substantive project work. Use it as the default first source of project context so the agent reuses prior findings, tasks, decisions, and stored facts instead of re-deriving them from scratch.

Exceptions:

- Skip the lookup for trivial acknowledgements, greetings, or simple confirmations.
- Skip the lookup for purely local or operational requests that do not depend on project memory.
- Skip or narrow the lookup when the user explicitly tells you to ignore project memory or use another source first.

Fallback behavior:

- If no `target_context_graph` is present and the user does not name a project, first try to infer the intended project from the recent conversation.
- If the target project is still ambiguous, ask a short clarification question before doing project-scoped work.

Lookup scope:

- Start with the cheapest useful lookup.
- Prefer narrow graph queries, entity lookups, or recent-memory checks over broad scans when they are sufficient.
- Avoid repeated or heavy graph queries unless the task actually needs them.

Conflict handling:

- If project memory conflicts with the user's current instruction, the repository, or fresh runtime evidence, do not blindly trust memory.
- Call out the conflict briefly, prefer fresh evidence for execution, and write corrected context back to memory when appropriate.

Minimum behavior:

1. Identify the selected project context graph from `target_context_graph` or from explicit user instruction.
2. Query the project context graph for relevant context before substantive work.
3. Use what you find to shape the response, tool choice, and next actions.
4. When the turn produces durable new information, write it back to the appropriate memory layer.

Implications:

- If `target_context_graph` is present, the user is on that project. State this explicitly when asked.
- If it is absent, the user has no project selected. Try to deduce the target project from the conversation context (e.g., "add this to my research project" → look up "research" via `GET /api/context-graph/list`). If the project is ambiguous or you are not confident, ask the user which project to use. Only suggest the right-side panel project dropdown if the user is chatting through the DKG UI — users on other channels (Telegram, API, etc.) do not have a panel to select from. When no project can be determined, route reads and writes to `agent-context` only.
- Default all DKG reads, writes, imports, promotions, publishes, and queries in that turn to the injected target context graph.
- Do not keep using an older conversational context graph when a newer injected `target_context_graph` is present.
- If the injected value includes both display name and ID, prefer the ID when calling tools or APIs, and reference the display name when answering the user.
- If the user explicitly says to use a different context graph in the same turn, follow the user's explicit instruction instead.

### Core CG routes

- `POST /api/context-graph/create` — create a context graph.
  Body: `{ id, name, description?, accessPolicy? (0=open, 1=private), allowedAgents?: [...], allowedPeers?: [...], participantAgents?: [...], private?, register?, publishPolicy?, pcaAccountId? }`.

  Whether the CG stays local depends on the node's chain adapter configuration — there are four distinct regimes:

  - **No chain adapter** (`chainId: 'none'`): CG is local-only permanently. Both `register: true` and a follow-up `/api/context-graph/register` call throw `On-chain registration requires a configured chain adapter`. This is a terminal state — the node operator must configure a chain adapter before on-chain promotion is possible.
  - **Mock chain adapter** (`chainId` starts with `mock`): the create-time auto-register path is deliberately skipped to avoid polluting test runs. The CG stays local on create; explicit `register: true` or `/api/context-graph/register` may succeed depending on what the mock implements.
  - **Real chain adapter WITH on-chain identity**: `createContextGraph()` auto-registers on-chain as a best-effort side-effect. Failures are logged as warnings (not surfaced on the create response) and the CG remains local. Passing `register: true` in this regime usually duplicates the auto-register work and returns `200` with `registered: false` + `registerError` + `hint` because the CG is already registered — looks like a failure but isn't one. Use `register: true` here only as an explicit retry hook when the auto-register path failed.
  - **Real chain adapter WITHOUT on-chain identity**: no auto-register on create; CG stays local until `/api/context-graph/register` or `register: true` promotes it.
  - **Curated CG** (default for the `dkg_context_graph_create` tool): the tool sends `accessPolicy: 1` automatically. The creator is auto-included in `DKG_ALLOWED_AGENT` so they can immediately read/write. Add collaborators with `dkg_participant_add` (or pass `allowed_agents: ["0x..."]` at creation to do it atomically).
  - **Public CG**: pass `public: true` on the tool (or `accessPolicy: 0` / omit on the raw HTTP route). Anyone can subscribe and read SWM gossip.

  > **No more multi-sig hosting committees.** Per `SPEC_CG_MEMORY_MODEL`,
  > on-chain CGs are edge-owned by default: hosts are picked from the
  > network sharding table at publish time and the ACK quorum is the
  > system parameter `parametersStorage.minimumRequiredSignatures()`. The
  > legacy `participantIdentityIds` / `requiredSignatures` body fields
  > are accepted for backwards compatibility but silently dropped with a
  > deprecation warning.

  > **Direct HTTP vs tool.** When you call the `dkg_context_graph_create`
  > tool, it defaults to curated/private (sends `accessPolicy: 1`). When
  > you call `POST /api/context-graph/create` directly without
  > `accessPolicy`, the daemon resolves to public/discoverable. The tool
  > is the recommended surface for agent workflows; raw HTTP is for
  > programmatic clients that want explicit control.
- `POST /api/context-graph/register` — register a previously-created local CG on-chain (two-phase creation). Body: `{ id, accessPolicy?, publishPolicy? }`, where `accessPolicy` controls public/private discovery and `publishPolicy` controls open/curated publishing. Use this to promote a free CG to an on-chain identity before publishing to Verified Memory. `revealOnChain` is deprecated and ignored on the V10 ContextGraphs path.
- `POST /api/context-graph/rename` — rename a CG (human-readable name only; the ID is immutable). Body: `{ contextGraphId, name }`.
- `POST /api/context-graph/subscribe` — subscribe to a context graph
- `GET /api/context-graph/list` — list subscribed context graphs
- `GET /api/context-graph/exists` — check if a context graph exists
- `GET /api/sync/catchup-status?contextGraphId=...` — poll CG sync progress after subscribing
- 🚧 `GET /api/context-graph/{id}` — CG details *(planned)*
- 🚧 `POST /api/context-graph/{id}/ontology` — add ontology *(planned)*
- 🚧 `GET /api/context-graph/{id}/ontology` — list ontologies *(planned)*

### Sub-Graphs — partitions within a CG

A **sub-graph** is a named partition inside a context graph. Use them to organize assertions by topic, source, or any other axis. Sub-graphs are optional — by default assertions live at the CG root. A sub-graph must be registered before any assertion op passes `subGraphName`; otherwise those ops fail with `Sub-graph "{name}" has not been registered in context graph "{id}". Call createSubGraph() first.`

- `POST /api/sub-graph/create` — register a new sub-graph. Body: `{ contextGraphId, subGraphName }`.
- `GET /api/sub-graph/list?contextGraphId=...` — list all sub-graphs registered in a CG.

To put an assertion in a sub-graph, pass `subGraphName` on `/api/assertion/create`, `/write`, `/query`, `/promote`, `/discard`, `/import-file`, `/history`, and on `/api/query` when scoping queries.

### Participants and join flow

| Method | Route | Body | Purpose |
|---|---|---|---|
| `POST` | `/api/context-graph/invite` | `{ contextGraphId, peerId }` | Invite a peer by peer ID. CG creator only. |
| `POST` | `/api/context-graph/{id}/add-participant` | `{ agentAddress }` | Directly add a participant by agent address (creator only). |
| `POST` | `/api/context-graph/{id}/remove-participant` | `{ agentAddress }` | Remove a participant (creator only). |
| `GET`  | `/api/context-graph/{id}/participants` | — | List current participants. Returns `{ contextGraphId, allowedAgents: [...] }`. |
| `POST` | `/api/context-graph/{id}/request-join` | `{ agentAddress, signature, timestamp, agentName? }` | Signed request from an invitee to join. If local node is the curator, stored locally; otherwise P2P-forwarded to the curator. |
| `GET`  | `/api/context-graph/{id}/join-requests` | — | List pending join requests (curator view). |
| `POST` | `/api/context-graph/{id}/approve-join` | `{ agentAddress }` | Approve a pending request. |
| `POST` | `/api/context-graph/{id}/reject-join` | `{ agentAddress }` | Reject a pending request. |
| `POST` | `/api/context-graph/{id}/sign-join` | — | Sign a join request as the caller and forward to the curator via P2P (multi-sig CGs). Signs `(contextGraphId, agentAddress, timestamp)` with the caller's private key; the bearer token only resolves which local agent is signing — external agents without a locally-stored private key cannot use this route. No body required. |

## 7. File Ingestion

Upload a document (PDF, DOCX, HTML, CSV, Markdown, etc.) and let the node
extract RDF triples into a WM assertion. Non-Markdown formats may pass through a
registered converter first; Markdown is parsed directly for frontmatter,
wikilinks, hashtags, Dataview inline fields, and headings. Extracted triples land
through the same path as `POST /api/assertion/{name}/write`.

`POST /api/assertion/{name}/import-file` uses multipart form data:

| Field | Required | Description |
|---|---|---|
| `file` | yes | Document bytes |
| `contextGraphId` | yes | Target context graph |
| `contentType` | no | Override the file part's Content-Type |
| `ontologyRef` | no | CG `_ontology` URI for guided extraction |
| `subGraphName` | no | Target sub-graph, already registered |

```bash
curl -X POST $BASE_URL/api/assertion/climate-report/import-file -H "Authorization: Bearer $TOKEN" -F "file=@climate-2026.md;type=text/markdown" -F "contextGraphId=research"
curl $BASE_URL/api/assertion/climate-report/extraction-status?contextGraphId=research -H "Authorization: Bearer $TOKEN"
```

Import responses include `assertionUri`, `fileHash`, `detectedContentType`, and
an `extraction` object with `status` (`in_progress`, `completed`, `skipped`, or
`failed`), `tripleCount`, `pipelineUsed`, optional `rootEntity`,
`mdIntermediateHash`, `error`, `startedAt`, and `completedAt`. A failed write is
atomic; do not treat a non-zero `tripleCount` on `failed` as partial-write
evidence. `skipped` usually means no converter was available, so the file was
stored but no triples were written. `GET /api/assertion/{name}/extraction-status?contextGraphId=...`
returns `404` if no import-file record exists or the tracker was TTL-pruned.

### Imported attachment semantic enrichment

When Node UI chat provides a completed imported attachment ref, treat its
`contextGraphId`, `assertionUri`, `fileHash`, status, counts, and Markdown
hash/form as the starting point. Do not read local filesystem paths.

Canonical flow:

1. Call `dkg_import_artifact_read_markdown` when you need the Markdown text. The
   daemon validates the import and reads only the content-addressed Markdown blob.
2. Optionally call `dkg_assertion_query` to inspect existing triples, or
   `dkg_import_artifact_resolve` when you need to re-check artifact metadata.
3. Call `dkg_semantic_enrichment_write` with `contextGraphId`, `assertionUri`,
   `semanticQuads`, and optional generation metadata.

`dkg_semantic_enrichment_write` appends model-derived semantic triples and
daemon-stamped provenance to the same imported assertion graph. It rejects skipped
or incomplete imports, rejects per-quad `graph`, rejects target assertion names,
and does not promote, finalize, or publish.

- `GET /api/file/{fileHash}` — fetch a stored file. Accepts `sha256:<hex>`,
  `keccak256:<hex>`, or bare `<hex>` (treated as sha256). The daemon does not
  persist the original content type; pass `?contentType=...` when inline preview
  matters.

## 8. Node Administration

- `GET /api/status` (PUBLIC) — node status, peer ID, version, connections
- `GET /api/info` — lightweight health check
- `GET /api/agents` — list known agents
- `GET /api/connections` — transport details
- `GET /api/wallets/balances` — TRAC and ETH balances
- `GET /api/chain/rpc-health` (PUBLIC) — RPC health
- `GET /api/identity` — node identity (DID, identity ID)
- `GET /api/host/info` — OS-level host details for UI flows that need real absolute paths (no `~`). Returns `{ homedir, hostname, username, platform, defaultWorkspaceParent }`. `defaultWorkspaceParent` probes `~/code`, `~/dev`, `~/projects` in order and falls back to `homedir`. Auth-required because `hostname` and `username` can be identifying; does not expose anything sensitive beyond that.
- `GET /api/events` — SSE stream for real-time notifications (`text/event-stream`). Emits `join_request`, `join_approved`, `project_synced` events with a `: heartbeat` comment every 30 s. Use it to watch for inbound invitations and project sync completions without polling.
- 🚧 `GET /api/agent/profile` — your agent profile *(planned)*

### Agent encryption-key management

Each DKG agent is associated with one or more X25519 **workspace encryption keys**. SWM gossip is encrypted to every active key registered for an allowed agent, so any node holding the private half of at least one of them can decrypt. Use rotation when:

- Re-bootstrapping an agent on a new node (the new node mints its own key; the previous node's key keeps working until you revoke it).
- A node's keystore disk leaks or is suspected compromised.
- Routine hygiene rotation.

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/agent/:address/rotate-encryption-key` | Mint a fresh workspace encryption key for a custodial agent, persist it, and re-publish the profile. Body: `{ "retireOld": true }` (default `false`) to also wallet-sign + publish a revocation for the previous default key in the same operation. Authorization: agent-scoped tokens may only manage their own agent; node-admin tokens may manage any local agent. |
| `POST` | `/api/agent/:address/revoke-encryption-key` | Wallet-sign and publish a revocation for one specific key. Body: `{ "keyId": "did:dkg:agent:0x...#x25519-..." }`. Refuses to revoke the agent's last active key (would brick SWM); rotate first in that case. Same authorization gating as rotate. |
| `POST` | `/api/agent/publish-profile` | Re-broadcast the default agent's profile. The rotate/revoke routes call this implicitly on success; this endpoint is the retry path for the partial-failure case where local persistence succeeded but the implicit republish errored (the response includes `profilePublished: false` + `profilePublishError`). Node-admin token required. |

CLI equivalents (run on the node operator's machine):

```bash
dkg agent rotate-encryption-key 0xCdba429ca35B458E83420B8FD101172fd8B7CFA5
dkg agent rotate-encryption-key 0xCdba... --retire-old
dkg agent revoke-encryption-key 0xCdba... did:dkg:agent:0xcdba...#x25519-<hash>
dkg agent publish-profile   # retry after a partial-success rotate/revoke
```

**Recommended rotation playbook:**

1. **Safe rotate** — `dkg agent rotate-encryption-key <agent>` (no flags). Both old and new keys remain active. Peers gradually pick up the new key as they resolve the updated profile; existing SWM ciphertext keyed to the old key remains decryptable.
2. **Wait for propagation** — give peers' resolvers time to observe the new profile (a few SWM rounds). You can monitor with `dkg query` against the `did:dkg:system/agents` graph.
3. **Retire the old key** — `dkg agent revoke-encryption-key <agent> <oldKeyId>`. The resolver now skips it; new ciphertext is encrypted only to the survivors.

**Urgent compromise:** `dkg agent rotate-encryption-key <agent> --retire-old` in one shot — peers that haven't seen the new profile yet may fail to encrypt to you for one round (they'll retry after their next resolver query), but the blast radius of the compromised key is minimised. Self-sovereign agents must sign rotations off-node and submit the resulting key + proof via `POST /api/agent/register` (re-register with new encryption material), then revoke the old key with `attachRevocationToWorkspaceEncryptionKey` from a script.

### Async publishing (job queue)

Use the job queue for bulk or long-running publishes, publishes that must survive the client session, or when the daemon should hold its own signing wallet. For small interactive publishes, use synchronous `/api/shared-memory/publish` instead.

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/publisher/enqueue` | Enqueue a publish job. Body: `{ contextGraphId, selection?, ... }` (same shape as `/shared-memory/publish`). Returns `{ jobId }`. |
| `GET`  | `/api/publisher/jobs?status=...` | List jobs, optionally filtered by status. |
| `GET`  | `/api/publisher/job?id=...` | Fetch one job's status. |
| `GET`  | `/api/publisher/job-payload?id=...` | Fetch a job's payload. |
| `GET`  | `/api/publisher/stats` | Queue statistics (running / pending / completed / failed). |
| `POST` | `/api/publisher/cancel` | Cancel a job. Body: `{ jobId }`. |
| `POST` | `/api/publisher/retry` | Retry a failed job. Body: `{ jobId }`. |
| `POST` | `/api/publisher/clear` | Clear completed/failed jobs. |

## 9. Error Reference

| Status | Meaning | Recovery |
|--------|---------|----------|
| 400 | Bad request — missing fields, invalid SPARQL | Fix the request body |
| 401 | Unauthorized — invalid or missing token | Re-authenticate or refresh token |
| 402 | Insufficient TRAC for publication | Check balances, notify node operator |
| 403 | Forbidden — publishPolicy or allowList violation | Verify CG membership and publish authority |
| 404 | Resource not found | Verify resource identifiers (assertion name, CG ID, UAL) |
| 409 | Conflict — name collision or concurrent modification | Retry with a different name |
| 429 | Rate limited | Wait and retry with backoff |
| 502 | Chain/upstream error | Retry — transient blockchain issue |
| 503 | Service unavailable | Node is starting up or shutting down |

## 10. Common Workflows

**Write → Promote → Publish (the canonical flow):**

1. Create a context graph / project (`POST /api/context-graph/create`)
2. Create a WM assertion (`POST /api/assertion/create`)
3. Write triples to Working Memory (`POST /api/assertion/{name}/write`)
4. When ready to share with peers: promote to SWM (`POST /api/assertion/{name}/promote`)
5. When ready to publish permanently: publish to VM (`POST /api/shared-memory/publish`)

**Private project for me alone (the default):**

1. `dkg_context_graph_create({ name: "My Notes" })` — curated by default; creator is the only allowed agent.
2. Write WM and promote to SWM — gossip is gated to the creator's allowlist (just yourself).

**Shared project with a teammate:**

1. `dkg_context_graph_create({ name: "Team X", allowed_agents: ["0xAlice"] })` — curated CG with Alice (and the creator) on the allowlist atomically with creation.
2. Or, if Alice's address comes later: `dkg_context_graph_create({ name: "Team X" })` followed by `dkg_participant_add({ context_graph_id: "team-x", agent_address: "0xAlice" })`.
3. Write and promote — SWM gossip is delivered only to the listed peers.

**Open/discoverable project:**

1. `dkg_context_graph_create({ name: "Public Research", public: true })` — explicitly opts out of curation; anyone subscribed receives SWM gossip.

**Import a file into a project:**

1. `POST /api/assertion/{name}/import-file` with the document + `contextGraphId`
2. Poll `GET /api/assertion/{name}/extraction-status?contextGraphId=...` if needed
3. Promote the assertion to SWM when extraction is complete

**Query across layers:**

- Working memory: `{"sparql": "...", "view": "working-memory", "agentAddress": "...", "contextGraphId": "..."}`
- Shared memory: `{"sparql": "...", "contextGraphId": "...", "view": "shared-working-memory"}`
- Verified memory: `{"sparql": "...", "contextGraphId": "...", "view": "verified-memory"}`

**List and inspect your assertions:**

There is no dedicated list endpoint. Assertion lifecycle records live in the CG's `_meta` graph as `dkg:Assertion` entities (namespace `http://dkg.io/ontology/`), with `dkg:state` (`created` | `promoted` | `published` | `finalized` | `discarded`) and `dkg:memoryLayer` (`WM` | `SWM` | `VM`). Query them via `/api/query` with `graphSuffix: "_meta"`:

```bash
curl -X POST $BASE_URL/api/query \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sparql": "PREFIX dkg: <http://dkg.io/ontology/> SELECT ?assertion ?name ?state ?layer WHERE { ?assertion a dkg:Assertion ; dkg:assertionName ?name ; dkg:state ?state ; dkg:memoryLayer ?layer }",
    "contextGraphId": "my-project",
    "graphSuffix": "_meta"
  }'
```

Then call `GET /api/assertion/{name}/history?contextGraphId=...&agentAddress=...` for the full event history of a single assertion.
