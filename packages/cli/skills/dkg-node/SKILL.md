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

**Step 1 — Create a Context Graph (project):**

```bash
curl -X POST $BASE_URL/api/context-graph/create \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id": "my-project", "name": "My Project"}'
```

**Step 2 — Create a Working Memory assertion:**

```bash
curl -X POST $BASE_URL/api/assertion/create \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"contextGraphId": "my-project", "name": "notes"}'
```

**Step 3 — Write triples to Working Memory:**

```bash
curl -X POST $BASE_URL/api/assertion/notes/write \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "contextGraphId": "my-project",
    "quads": [
      {"subject": "https://example.org/alice", "predicate": "http://www.w3.org/1999/02/22-rdf-syntax-ns#type", "object": "https://schema.org/Person", "graph": ""},
      {"subject": "https://example.org/alice", "predicate": "https://schema.org/name", "object": "\"Alice\"", "graph": ""}
    ]
  }'
```

**Step 4 — Promote to Shared Working Memory (when ready to share):**

```bash
curl -X POST $BASE_URL/api/assertion/notes/promote \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"contextGraphId": "my-project", "entities": "all"}'
```

**Step 5 — Publish to Verified Memory (from SWM):**

> Data must be in Shared Working Memory before publishing. The on-chain
> transaction is a finality signal — peers already have the data via gossip.

```bash
curl -X POST $BASE_URL/api/shared-memory/publish \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"contextGraphId": "my-project"}'
```

**Step 6 — Query across any layer:**

```bash
curl -X POST $BASE_URL/api/query \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sparql": "SELECT * WHERE { ?s ?p ?o } LIMIT 10", "contextGraphId": "my-project", "view": "working-memory", "agentAddress": "YOUR_PEER_ID"}'
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

- `POST /api/shared-memory/write` — write triples directly to SWM (gossip-replicated). Body: `{ contextGraphId, quads, subGraphName? }`. Use the WM → promote path for most workflows; direct SWM writes are for bulk team data that skips the private draft stage.
- `POST /api/shared-memory/conditional-write` — compare-and-swap write. Body: `{ contextGraphId, quads, conditions: [...], subGraphName? }`. Checks each condition atomically before writing; throws `StaleWriteError` on mismatch and leaves SWM unchanged. Use for concurrent multi-agent writes to the same root entity.
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

### Operational constraints

Respect these when producing writes — they're enforced at the node and produce errors rather than silent truncation.

- **Reorganizing assertions.** There is no rename-assertion or move-between-sub-graphs endpoint. To reorganize, create a new assertion (with `subGraphName?` for a different partition), copy the triples over via `/write`, then `/discard` the original. A new assertion starts a fresh lifecycle record in `_meta`.
- **Reserved subject IRIs.** Subjects matching `urn:dkg:file:*` or `urn:dkg:extraction:*` are reserved for internal file/extraction metadata and are rejected at write time. Use a different subject IRI.
- **SWM gossip size cap (512 KB).** A single promote or SWM write must fit in one 512 KB gossip message. Split large assertions by root entity before promoting — use the `entities` parameter on `/promote` to promote subsets.
- **SWM entity ownership (first-writer-wins).** The first peer to write a root entity in SWM becomes its owner; other peers' promotes or writes against that same root entity are rejected with an ownership error. Partition work by agent-owned root entities to avoid conflicts.
- **Blank nodes are auto-skolemized.** Any `_:b0`-style blank nodes you submit are deterministically rewritten to UUID-backed URIs before storage, so IDs stay stable across sync and on-chain anchoring. Prefer explicit IRIs in production data.

### Automatic recall

**Making memories recallable.** Any literal content of 20+ characters written under a project or `agent-context` context graph is automatically searchable by slot-backed recall on future turns — no specific assertion name or predicate is required. Write RDF shapes that fit your domain (use `schema:description`, `rdfs:comment`, a custom ontology predicate, anything semantically appropriate). Slot-backed recall performs a permissive keyword-substring match across all literals in the working-memory, shared-working-memory, and verified-memory views of both the `agent-context` graph and the user's selected project context graph on every turn.

## 6. Context Graphs

Context Graphs are scoped knowledge domains with configurable access and governance. In the node UI, context graphs are called **projects** — when a user says "my project" or selects a project in the right-panel dropdown, they mean a context graph.

### Routing: Turn Context Override

When the chat turn includes injected context with `target_context_graph`, treat that value as BOTH:

1. **The authoritative target context graph for tool routing on this turn** — default all DKG reads, writes, imports, promotions, publishes, and queries in that turn to this value unless the user explicitly overrides it in the same message.
2. **The user's currently-selected project in the UI** — when the user asks introspective questions like "which project am I on?", "what is currently selected?", "do you see that I have X selected?", answer directly from this field. Do not claim you cannot see the UI state. The field IS the UI state: the right-side panel project dropdown stamps it onto every turn envelope before the turn reaches you, so its presence means the user has that project selected and its absence means they have nothing selected.

Implications:

- If `target_context_graph` is present, the user is on that project. State this explicitly when asked.
- If it is absent, the user has no project selected. Try to deduce the target project from the conversation context (e.g., "add this to my research project" → look up "research" via `GET /api/context-graph/list`). If the project is ambiguous or you are not confident, ask the user which project to use. Only suggest the right-side panel project dropdown if the user is chatting through the DKG UI — users on other channels (Telegram, API, etc.) do not have a panel to select from. When no project can be determined, route reads and writes to `agent-context` only.
- Default all DKG reads, writes, imports, promotions, publishes, and queries in that turn to the injected target context graph.
- Do not keep using an older conversational context graph when a newer injected `target_context_graph` is present.
- If the injected value includes both display name and ID, prefer the ID when calling tools or APIs, and reference the display name when answering the user.
- If the user explicitly says to use a different context graph in the same turn, follow the user's explicit instruction instead.

### Core CG routes

- `POST /api/context-graph/create` — create a context graph.
  Body: `{ id, name, description?, accessPolicy? (0=open, 1=private), allowedAgents?: [...], allowedPeers?: [...], private?, register?, participantIdentityIds?, requiredSignatures? }`.
  By default the CG stays local-only. Pass `register: true` to also register on-chain in the same call; if that fails, the CG is still created locally and the response carries a `registerError` + retry hint. For private CGs (`private: true`), `requiredSignatures` is optional.
- `POST /api/context-graph/register` — register a previously-created local CG on-chain (two-phase creation). Body: `{ id, revealOnChain?, accessPolicy? }`. Use this to promote a free CG to an on-chain identity before publishing to Verified Memory.
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

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/context-graph/invite` | Invite a peer. Body: `{ contextGraphId, peerId }`. CG creator only. |
| `POST` | `/api/context-graph/{id}/add-participant` | Directly add a participant (creator only). |
| `POST` | `/api/context-graph/{id}/remove-participant` | Remove a participant. |
| `GET`  | `/api/context-graph/{id}/participants` | List current participants. |
| `POST` | `/api/context-graph/{id}/request-join` | Signed request from an invitee to join. |
| `GET`  | `/api/context-graph/{id}/join-requests` | List pending join requests (curator view). |
| `POST` | `/api/context-graph/{id}/approve-join` | Approve a pending request. |
| `POST` | `/api/context-graph/{id}/reject-join` | Reject a pending request. |
| `POST` | `/api/context-graph/{id}/sign-join` | Sign a join request and forward to the curator via P2P (multi-sig CGs). |

## 7. File Ingestion

Upload a document (PDF, DOCX, HTML, CSV, Markdown, etc.) and let the node
extract RDF triples into a WM assertion. The node runs a deterministic
two-phase pipeline:

1. **Phase 1 (optional converter):** non-Markdown formats go through a
   registered converter (e.g. MarkItDown for PDF/DOCX/HTML) which produces
   a Markdown intermediate. `text/markdown` uploads skip Phase 1 — the raw
   file IS the intermediate.
2. **Phase 2 (structural extractor):** the Markdown intermediate is parsed
   for YAML frontmatter, wikilinks (`[[Target]]`), hashtags (`#keyword`),
   Dataview inline fields (`key:: value`), and heading structure. No LLM —
   deterministic, node-side, no external calls.

The extracted triples are written to the target assertion graph via the
same path as `POST /api/assertion/{name}/write`. Agents can then query,
promote, or publish them like any other assertion content.

**Supported formats:** see Node Info §1 for the list of registered
extraction pipelines on your specific node. `text/markdown` is always
supported (no converter needed).

### Request

`POST /api/assertion/{name}/import-file` with `Content-Type: multipart/form-data`:

| Field           | Required | Description                                                                 |
|-----------------|----------|-----------------------------------------------------------------------------|
| `file`          | yes      | The document bytes                                                          |
| `contextGraphId`| yes      | Target context graph                                                        |
| `contentType`   | no       | Override the file part's Content-Type header                                |
| `ontologyRef`   | no       | CG `_ontology` URI for guided Phase 2 extraction                            |
| `subGraphName`  | no       | Target sub-graph inside the CG (must be registered via `createSubGraph`)    |

### Example

```bash
curl -X POST $BASE_URL/api/assertion/climate-report/import-file \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@climate-2026.md;type=text/markdown" \
  -F "contextGraphId=research"
```

### Response

```json
{
  "assertionUri": "did:dkg:context-graph:research/assertion/0xAgentAddr/climate-report",
  "fileHash": "keccak256:a1b2c3...",
  "detectedContentType": "application/pdf",
  "extraction": {
    "status": "completed",
    "tripleCount": 14,
    "pipelineUsed": "application/pdf",
    "mdIntermediateHash": "keccak256:d4e5f6..."
  }
}
```

Both `fileHash` and `mdIntermediateHash` are `keccak256:<hex>`. `mdIntermediateHash` is only present when Phase 1 actually ran (converter-backed imports like PDF/DOCX); pure-markdown imports leave it undefined.

### Extraction statuses

- `completed` — Phase 1 (if needed) and Phase 2 both ran; triples were written to the assertion graph
- `skipped` — no converter is registered for the file's content type; the file is stored in the file store but no triples were written. Agents can still reference the file via its `fileHash`
- `failed` — one of the phases threw an error; check the `error` field in the response. The file is still stored; no triples written.

For synchronous extractions (the V10.0 default) the response carries the
final status immediately. To re-query later without holding the original
response, use:

```bash
curl $BASE_URL/api/assertion/climate-report/extraction-status?contextGraphId=research \
  -H "Authorization: Bearer $TOKEN"
```

Returns the same `{ status, fileHash, pipelineUsed, tripleCount, ... }` shape from the in-memory extraction status tracker, or 404 if no import-file has been run for that assertion.

### Retrieving stored files

- `GET /api/file/{fileHash}` — fetch a previously-imported file by its content hash. The hash in the URL is just the hex portion (the `keccak256:` prefix returned by the import response is for ontology use). Returns the original bytes with the stored `Content-Type`. Use this when you need to re-reference or re-process the source document after import.

## 8. Node Administration

- `GET /api/status` (PUBLIC) — node status, peer ID, version, connections
- `GET /api/info` — lightweight health check
- `GET /api/agents` — list known agents
- `GET /api/connections` — transport details
- `GET /api/wallets/balances` — TRAC and ETH balances
- `GET /api/chain/rpc-health` (PUBLIC) — RPC health
- `GET /api/identity` — node identity (DID, identity ID)
- `GET /api/events` — SSE stream for real-time notifications (`text/event-stream`). Emits `join_request`, `join_approved`, `project_synced` events with a `: heartbeat` comment every 30 s. Use it to watch for inbound invitations and project sync completions without polling.
- 🚧 `GET /api/agent/profile` — your agent profile *(planned)*

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
