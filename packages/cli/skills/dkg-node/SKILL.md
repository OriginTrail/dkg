---
name: dkg-node
description: The DKG V10 Node is your primary memory system. This skill teaches you to operate your node's three-layer verifiable memory — write and retrieve private drafts in Working Memory, share with peers in Shared Working Memory, and publish permanently to Verifiable Memory on-chain.
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

If the Node UI injects a target context graph for the turn, use that target directly. If no target is injected or configured, call `dkg_list_context_graphs` / `GET /api/context-graph/list`; agent tool surfaces default that list to the caller's created/joined context graphs, with `scope: "all"` for every graph the node knows about.

### Context Graph IDs

For write or mutation routes, always pass the injected target context graph id,
an exact existing context graph id from `dkg_list_context_graphs` /
`GET /api/context-graph/list`, or the full `did:dkg:context-graph:<id>` URI.

- A context graph created locally can have a bare canonical id, for example
  `local-notes`, with full URI `did:dkg:context-graph:local-notes`.
- A joined or curated context graph can have a curator-scoped canonical id, for
  example `0x1234567890abcdef1234567890abcdef12345678/team-notes`, with full
  URI `did:dkg:context-graph:0x1234567890abcdef1234567890abcdef12345678/team-notes`.

Do not guess from the display name, shorten a curator-scoped id, or pass only a
suffix slug such as `team-notes` when the listed id is
`0x.../team-notes`. Write routes reject unknown, ambiguous, or non-canonical
targets before writing so they cannot accidentally create shadow context graphs.

## 1a. Operating the node (install, update, troubleshoot)

> **Before reasoning about install state, run `dkg doctor`.** Detects orphan repository clones, version skew between the daemon and the global `dkg` CLI, served-UI / source mismatch, broken plugin install roots, and other install-layout anomalies. Use `dkg doctor --json` for a machine-parsable report; the `state` field always carries the full diagnostic snapshot (daemon entry point, install mode, node role, dkg-home, current version + commit, auto-update settings) independent of any anomaly findings.

**Updating DKG:**

- The canonical update verb is `dkg update`. It resolves the next release from the npm registry and applies it.
- **Do not `git pull`.** Do not clone the repository. Do not edit files under `~/.dkg/releases/` (on Core nodes — Edge nodes have no `~/.dkg/releases/` at all under RFC-41).
- If `dkg doctor` reports orphan clones at `~/dkg/`, `~/Projects/dkg/`, or similar, ask the operator before touching them — they are not the running daemon.
- `dkg update --check` previews the available version without applying.
- `dkg update --allow-prerelease` follows the `next` dist-tag for pre-release builds.
- `dkg rollback` reverts to the previous version (Edge: re-installs the prior npm version recorded in `~/.dkg/previous-version`; Core: flips the blue-green slot symlink).

**Detecting current install state:**

- `dkg --version` — the global CLI's version.
- `curl http://127.0.0.1:9200/api/status | jq '{version, commit, commitShort, buildTime, distTag, installMode, nodeRole}'` — the running daemon's version, commit, and install mode. Mismatch between `dkg --version` and the daemon's version is the §1a version-skew condition; `dkg doctor` reports it explicitly.
- `cat ~/.dkg/config.json | jq .nodeRole` — `edge` (default; daemon runs from npm-global install, no release slots) or `core` (operator opted into blue-green slots via `dkg init --role core`).

**Troubleshooting common confusion:**

- "There seem to be multiple DKG installations on this machine" → run `dkg doctor`; the `state.cli.globalPath`, `state.daemon.entryPoint`, and orphan-repos check together identify the canonical install and any stray clones.
- "The UI shows an old version even after I updated" → run `dkg doctor`; the served-UI / source-mismatch check flags stale browser / PWA / service-worker caches.
- "I ran `npm install -g @origintrail-official/dkg@latest` but the daemon still reports the old version" → on Edge nodes the daemon needs a restart to pick up the new install (`dkg restart`). On Core nodes, the slot mechanism gates the visible version on `dkg update`'s atomic swap, not on `npm install -g` directly — use `dkg update` for Core nodes.

The full design rationale lives in [OT-RFC-41](https://github.com/OriginTrail/dkgv10-spec/blob/main/rfcs/OT-RFC-41-edge-node-npm-only-install-and-update.md).

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
| **Verifiable Memory (VM)** | Permanent, on-chain | TRAC tokens | Self-attested → endorsed → consensus-verified | Permanent |

**What you can do:** create knowledge assertions, import files (PDF, DOCX, Markdown),
share knowledge with peers, publish to the blockchain, endorse others' knowledge,
propose M-of-N consensus verification, query across all memory layers, and
discover other agents on the network.

## 3. Quick Start

> Before writing in production, read §6 "Routing: Turn Context Override" — it governs which context graph each turn's operations target.

**Canonical flow (the 5-stage Knowledge-Asset lifecycle):** create a context graph,
**create** an assertion, **write** triples to WM, **finalize** (seal) the draft,
**share** to SWM, then **publish** the sealed assertion to VM — which mints it on
chain and returns its **UAL** (see §5 VM for the response body). Data must be in SWM
before VM publishing; the on-chain transaction is a finality signal for data peers
already received via gossip.

A full `swm/share` (`entities: "all"`) auto-seals best-effort, so you can also share
without an explicit finalize — but the explicit `wm/finalize` step below is the
canonical, predictable path (see §5 "Verifiable Memory" for the auto-seal caveats).

> **VM publishing needs an on-chain CG.** A project created with
> `/api/context-graph/create` is local-only — `vm/publish` fails until the CG is
> registered on-chain. The quick start registers it explicitly below; alternatively pass
> `"register_if_needed": true` on the `vm/publish` body to register-then-publish in one
> call (see §5 "Registering the CG for VM").

```bash
curl -X POST $BASE_URL/api/context-graph/create -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"id":"my-project","name":"My Project"}'
curl -X POST $BASE_URL/api/context-graph/register -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"id":"my-project"}'   # register on-chain so VM publishing works (costs gas/TRAC)
curl -X POST $BASE_URL/api/knowledge-assets -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"contextGraphId":"my-project","name":"notes"}'
curl -X POST $BASE_URL/api/knowledge-assets/notes/wm/write -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"contextGraphId":"my-project","quads":[{"subject":"https://example.org/alice","predicate":"https://schema.org/name","object":"\"Alice\""}]}'
curl -X POST $BASE_URL/api/knowledge-assets/notes/wm/finalize -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"contextGraphId":"my-project"}'
curl -X POST $BASE_URL/api/knowledge-assets/notes/swm/share -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"contextGraphId":"my-project","entities":"all"}'
curl -X POST $BASE_URL/api/knowledge-assets/notes/vm/publish -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"contextGraphId":"my-project"}'   # → { "kaId": "...", "ual": "did:dkg:<chainId>/<kasAddress>/<number>", "txHash": "0x...", ... }
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
| `dkg_list_context_graphs` | `GET /api/context-graph/list` | List context graphs. Tool surfaces default to caller-created/joined graphs; pass `scope: "all"` for every known graph. Entries carry `subscribed`, `synced`, and caller involvement when available |
| `dkg_context_graph_create` | `POST /api/context-graph/create` | Create a simple context graph (tool schema accepts only `name` / `description` / `id` — no multi-sig inputs). On chain-enabled nodes the daemon may auto-register on-chain as a best-effort side-effect — see §6 for the register semantics. Multi-sig CGs are HTTP-only |
| `dkg_subscribe` | `POST /api/context-graph/subscribe` | Subscribe + catch up an existing CG |
| `dkg_context_graph_invite` | `POST /api/context-graph/invite` | Create a ready-to-share invite for another peer to join a context graph |
| `dkg_participant_add` | `POST /api/context-graph/{id}/add-participant` | Add an agent address to a curated/private context graph allowlist |
| `dkg_participant_remove` | `POST /api/context-graph/{id}/remove-participant` | Remove an agent address from a curated/private context graph allowlist |
| `dkg_participant_list` | `GET /api/context-graph/{id}/participants` | List current context graph participants / allowed agents |
| `dkg_join_request_list` | `GET /api/context-graph/{id}/join-requests` | List pending join requests for a context graph |
| `dkg_join_request_approve` | `POST /api/context-graph/{id}/approve-join` | Approve a pending join request by agent address |
| `dkg_join_request_reject` | `POST /api/context-graph/{id}/reject-join` | Reject a pending join request by agent address |
| `dkg_knowledge_asset_create` | `POST /api/knowledge-assets` | Start a WM assertion (knowledge asset). Non-empty `quads` here auto-seals (write+finalize in one call); `promote: true` also shares to SWM |
| `dkg_knowledge_asset_write` | `POST /api/knowledge-assets/{name}/wm/write` | Append triples (`{subject,predicate,object}` — no per-quad `graph`) to a WM assertion |
| `dkg_knowledge_asset_finalize` | `POST /api/knowledge-assets/{name}/wm/finalize` | **Seal** the WM draft (the "git commit" — EIP-712 AuthorAttestation over the whole assertion). Returns `merkleRoot`, `authorAddress`, `schemeVersion`, `chainId`, `kav10Address`, `eip712Digest` |
| `dkg_knowledge_asset_share` | `POST /api/knowledge-assets/{name}/swm/share` | Share a WM assertion's triples to SWM (formerly "promote"). A full share (`entities: "all"` / omitted) auto-seals best-effort; a subset share is SWM-only — see §5 |
| `dkg_knowledge_asset_publish` | `POST /api/knowledge-assets/{name}/vm/publish` | **Mint / update on chain** (the sealed assertion → VM). Returns the **UAL** + `kaId` + `txHash` — see §5 VM for the full response body |
| `dkg_knowledge_asset_pull_from` | `POST /api/knowledge-assets/{name}/wm/pull-from` | Seed a fresh WM draft from the current SWM or VM state (the "git checkout" — edit loop). Body `{ contextGraphId, layer: "swm"\|"vm", onConflict?: "reject"\|"replace" }` |
| `dkg_knowledge_asset_discard` | `POST /api/knowledge-assets/{name}/wm/discard` | Drop a WM assertion |
| `dkg_knowledge_asset_import_file` | `POST /api/knowledge-assets/{name}/wm/import-file` | Multipart upload a document + extract triples |
| `dkg_knowledge_asset_query` | `GET /api/knowledge-assets/{name}/wm/quads` | Dump every quad in a single assertion (not SPARQL) |
| `dkg_knowledge_asset_history` | `GET /api/knowledge-assets/{name}` | Read an assertion's lifecycle descriptor |
| `dkg_knowledge_asset_import_artifact_read_markdown` | `POST /api/knowledge-assets/import-artifact/read-markdown` | Safely read Markdown for a completed imported attachment by content-addressed hash |
| `dkg_knowledge_asset_import_artifact_resolve` | `POST /api/knowledge-assets/import-artifact/resolve` | Optional metadata re-check for completed imported attachments |
| `dkg_knowledge_asset_semantic_enrichment_write` | `POST /api/knowledge-assets/semantic-enrichment/write` | Append model-derived semantic triples and provenance to the imported assertion |
| `dkg_publish` | `POST /api/knowledge-assets/publish` | **Direct explicit-quads one-shot publish**: sends the supplied quads inline to the publish route, so core ACK collection receives the payload directly and does **not** depend on SWM pre-positioning. Multi-root-safe in one mint. Does **not** auto-register the CG → accepts `register_if_needed` + `access_policy` to register a fresh CG on-chain first (§6). For a staged/named lifecycle publish use `dkg_knowledge_asset_publish`; for pre-existing SWM data use `dkg_shared_memory_publish` |
| `dkg_shared_memory_publish` | `POST /api/shared-memory/publish` (`{selection}`) | **SWM-bridge / CG-wide publish (legacy, retained)**: publish existing SWM → VM, no fresh quads. Uses the **`selection` fork** — **single-root-per-call** (loop one root per call with `clearAfter:false` on all but the last, else `409 MULTI_ROOT_PUBLISH_NOT_ATOMIC`). Auto-registers the CG on first publish (OT-RFC-38 LU-6). For the per-KA sealed path use `dkg_knowledge_asset_publish` |
| `dkg_share` | `POST /api/shared-memory/write` | Directly write concise team-visible knowledge to SWM without staging a WM assertion. Prefer the WM assertion → promote flow for durable/canonical work. Both Hermes and OpenClaw expose the same tool schema (required `content` and `context_graph_id`, optional `sub_graph_name`), so MCP-discovered call signatures are portable. The OpenClaw implementation additionally validates content as non-whitespace, mints a unique subject per share (returned in the response), and N-Triples-quotes content; Hermes is currently looser on those points — the parallel hardening is tracked in OriginTrail/dkg#414. |
| `dkg_sub_graph_create` | `POST /api/sub-graph/create` | Register a sub-graph inside a CG |
| `dkg_sub_graph_list` | `GET /api/sub-graph/list` | List sub-graphs in a CG |
| `dkg_query` | `POST /api/query` | Read-only SPARQL across assertions in a CG. Pass `view` (`working-memory` / `shared-working-memory` / `verifiable-memory`) to pick the layer — when `view` is set, `context_graph_id` is required; for WM reads, optional `agent_address` targets another agent's WM (when omitted it defaults to this node's primary agent wallet, falling back to the peer ID on nodes without a configured default agent). Omit `view` for a legacy cross-graph data-path query. |
| `dkg_query_catalog_list` | `POST /api/profile/query-catalog/read` | List saved SPARQL queries declared in the project profile query catalog |
| `dkg_query_catalog_run` | `POST /api/profile/query-catalog/read` + `POST /api/query` | Run a saved catalog query by slug or exact display name |
| `dkg_query_catalog_save` | `POST /api/profile/query-catalog/write` | Save a read-only SPARQL query into the project profile query catalog |
| `dkg_find_agents` | `GET /api/agents` | Discover other agents (best-effort P2P) |
| `dkg_send_message` | `POST /api/chat` | Send a direct message (best-effort P2P). Body: `{ to: "<peerId>", text: "...", contextGraphId? }` (`peerId`/`message` are accepted as aliases for `to`/`text`) |
| `dkg_read_messages` | `GET /api/messages` | Read inbound messages |
| `dkg_invoke_skill` | `POST /api/invoke-skill` | Call another agent's skill (best-effort P2P) |

P2P tools fail gracefully when the peer is offline. There are **three publish tools**, but only **two underlying forks** of `/api/shared-memory/publish` — the difference is *atomic per-assertion* vs *CG-wide selection*:

- **Per-KA sealed publish** — `dkg_knowledge_asset_publish` (`/vm/publish`). Publishes one sealed assertion by name; takes **no selector** (the seal commits the whole assertion) and is multi-root-safe. This is the canonical step 5 of the `create → write → finalize → share → publish` lifecycle and the one that returns the **UAL**.
- **One-shot atomic publish** — `dkg_publish` ("I have loose quads, publish now"). Two HTTP calls: `POST /api/knowledge-assets` (creates a fresh auto-named assertion with the quads) then `POST /api/shared-memory/publish` with `{assertionName}` — the **atomic finalized-assertion fork**, scoped to that one assertion's seal. **Multi-root-safe**: no single-root loop, no `409 MULTI_ROOT`. It does **not** auto-register the CG, so on a fresh never-registered CG pass `register_if_needed: true`.
- **CG-wide SWM-bridge publish (legacy, retained)** — `dkg_shared_memory_publish` (publish existing SWM, no fresh quads). Uses the **`selection` fork** of `/api/shared-memory/publish` and is **single-root-per-call**: for multiple root entities, loop one root per call with `clearAfter: false` on all but the last (else the daemon returns `409 MULTI_ROOT_PUBLISH_NOT_ATOMIC`). Auto-registers the CG on first publish (OT-RFC-38 LU-6). Use it to flush existing SWM.

`dkg_share` is a direct SWM convenience helper for quick team-visible notes, not a replacement for the knowledge-asset lifecycle.

**Bulk imports (>5,000 quads in one logical operation):** the per-call `dkg_knowledge_asset_*` loop IS the chunked-write API; there is no `/api/import/bulk`. Keep `/api/knowledge-assets/<name>/wm/write` payloads under the 10 MB body cap, keep `/api/knowledge-assets/<name>/swm/share` payloads under the 256 KB body cap, and remember that promotion can still fail at the 10 MB gossip-message cap even when the HTTP body is small. For multi-part imports, write a resumable manifest in the `meta` sub-graph (`scripts/lib/manifest.mjs` is the canonical helper), promote import roots in size-aware batches, and halve/retry on 413 rather than restarting the whole import. The expanded contract — chunking budgets, manifest pattern, HTTP 413 recipes, async-promote queue (`/api/knowledge-assets/<name>/swm/share-async`) — is served at `GET /.well-known/skill-importer.md` (the daemon's second canonical skill endpoint, same auth-public + ETag-cacheable shape as `/.well-known/skill.md`). Source checkouts also have the same file at `packages/cli/skills/dkg-importer/SKILL.md`.

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

- `POST /api/knowledge-assets` — create a named private assertion
  Body: `{ "contextGraphId": "...", "name": "...", "subGraphName"?: "..." }`
- `POST /api/knowledge-assets/{name}/wm/write` — write triples to an assertion
  Body: `{ "contextGraphId": "...", "quads": [{ "subject": "...", "predicate": "...", "object": "..." }], "subGraphName"?: "..." }`. Do **not** send a per-quad `graph` field — the daemon pins the data to the per-KA WM graph itself.
- `POST /api/knowledge-assets/{name}/wm/finalize` — **seal** the WM draft (the "git commit"). Computes the canonical `merkleRoot` over the whole assertion, builds + signs an EIP-712 AuthorAttestation, and stamps the seal into `_meta`. After finalize, the content is committed: a later `vm/publish` consumes the seal verbatim (it never re-hashes or re-signs).
  Body: `{ "contextGraphId": "...", "subGraphName"?: "...", "authorAgentAddress"?: "0x...", "preSignedAuthorAttestation"?: {...}, "schemeVersion"?: 1 }` (`authorAgentAddress` and `preSignedAuthorAttestation` are mutually exclusive). Returns `{ assertionUri, merkleRoot, authorAddress, schemeVersion, chainId, kav10Address, eip712Digest }`. **Finalize always seals the entire draft — there is no subset/`entities` parameter.**
- `GET /api/knowledge-assets/{name}/wm/quads?contextGraphId=...&subGraphName=...` — read assertion contents as quads
- `POST /api/knowledge-assets/{name}/wm/pull-from` — seed a fresh WM draft from the current SWM or VM state (the "git checkout" — start an edit loop on already-shared/published content).
  Body: `{ "contextGraphId": "...", "layer": "swm" | "vm", "onConflict"?: "reject" | "replace", "subGraphName"?: "..." }`. Returns `{ wmDraft: "open", seededFrom: { layer }, ... }`; an existing dirty draft → `409 WM_DRAFT_CONFLICT` unless `onConflict: "replace"`.
- `POST /api/knowledge-assets/{name}/swm/share` — share assertion triples to SWM (synchronous; returns once SWM insert + gossip complete). Formerly "promote". A **full** share (`entities` omitted or `"all"`) auto-seals best-effort first (see §5 "Verifiable Memory"); a **subset** share (`entities` = a proper subset) is SWM-only and is **not** publishable to VM as a subset.
  Body: `{ "contextGraphId": "...", "entities"?: [...] | "all", "subGraphName"?: "..." }`
- `POST /api/knowledge-assets/{name}/swm/share-async` — enqueue the same promote for an in-daemon worker to handle in the background. Returns `202 { jobId, state: "queued" }` immediately. Use this for bulk importers where waiting for the synchronous round-trip is the bottleneck (the Graphify import RFC `docs/specs/SPEC_ASYNC_PROMOTE_QUEUE.md` explains the motivation). See §8 "Async promote queue" for the inspection routes.
- `POST /api/knowledge-assets/{name}/wm/discard` — drop the assertion graph
  Body: `{ "contextGraphId": "...", "subGraphName"?: "..." }`
- `POST /api/knowledge-assets/{name}/wm/import-file` — import a document (multipart/form-data) — see §7
- `GET /api/knowledge-assets/{name}/wm/extraction-status?contextGraphId=...` — poll the status of an import-file extraction job
- `GET /api/knowledge-assets/{name}?contextGraphId=...&agentAddress=...&subGraphName=...` — read the assertion's lifecycle descriptor (created → promoted → published → finalized | discarded) from the CG's `_meta` graph. Returns `{ state, timestamps, operationIds, rootEntities, kcUalRefs }` or 404 if no lifecycle record exists.

> **Lifecycle provenance.** Every assertion carries a durable `dkg:Assertion` lifecycle record in the CG's `_meta` graph, updated as a side effect of create, `/wm/write`, `/wm/finalize`, `/swm/share`, `/wm/discard`, and `/vm/publish`. The assertion data moves WM→SWM→VM as it is shared and published — the lifecycle record is an independent audit trail you can read without touching the data itself. (The internal `dkg:state` values are `created` / `promoted` / `published` / `finalized` / `discarded`; these are data-model literals, distinct from the tool/verb names.)

> If `subGraphName` is provided but the sub-graph is not registered in the CG's
> `_meta` graph, all assertion operations throw
> `Sub-graph "{name}" has not been registered in context graph "{id}". Call createSubGraph() first.`
> Create the sub-graph before targeting it.

### Shared Working Memory (SWM) — Team-visible

SWM is for knowledge you've promoted from WM and want peers to see. Data arrives here via `POST /api/knowledge-assets/{name}/swm/share` (from WM) or via direct SWM writes (escape hatch for team-visible data that doesn't need a WM staging step).

> **Visibility.** SWM gossips to peers in the context graph's allowlist.
> For a **curated** CG (the default — see §6), only listed agents/peers
> receive the gossip. For an **explicitly public** CG (`public: true` at
> creation), every peer subscribed to the CG receives the gossip.
> Working Memory is per-agent regardless of CG visibility.

- `POST /api/shared-memory/write` — write triples directly to SWM (gossip-replicated). Body: `{ contextGraphId, quads, subGraphName? }`. Use the WM → promote path for most workflows; direct SWM writes are for bulk team data that skips the private draft stage.
- `POST /api/shared-memory/conditional-write` — compare-and-swap write. Body: `{ contextGraphId, quads, conditions: [...], subGraphName? }`. Each condition is `{ subject: IRI, predicate: IRI, expectedValue: string | null }`; `null` means "must not exist", a string must match the current object after N-Triples serialization. Any mismatch throws `StaleWriteError` and leaves SWM unchanged. `conditions` must be non-empty — use `/api/shared-memory/write` for unconditional writes.
- `POST /api/knowledge-assets/publish` — direct explicit-quads one-shot publish. Body: `{ contextGraphId, quads, privateQuads?, accessPolicy?, allowedPeers?, subGraphName? }`. Use this when the request already contains the exact quads to publish; the ACK path carries the inline payload and does not rely on SWM.
- `POST /api/shared-memory/publish` — publish SWM triples → Verifiable Memory (costs TRAC). This is the explicit SWM-bridge / CG-wide path used by `dkg_shared_memory_publish`; it publishes data that must already be available in SWM on the target cores. Explicit root selections are single-root-per-call (resolving >1 root returns `409 MULTI_ROOT_PUBLISH_NOT_ATOMIC` — loop one root per call with `clearAfter: false` on all but the last). For the per-KA sealed lifecycle path that takes no selector and returns a UAL, use `/api/knowledge-assets/{name}/vm/publish` (see VM below).

### Verifiable Memory (VM) — Permanent, on-chain

> **Lifecycle VM publishing goes through SWM.** Named WM assertions are finalized,
> shared to SWM, then published from there. One-shot requests that already carry
> explicit quads use `POST /api/knowledge-assets/publish` so the publish ACK path
> carries the payload directly.

**Two publish surfaces.** rc.17 has two ways to publish SWM → VM:

- **Per-KA sealed publish (canonical)** — `POST /api/knowledge-assets/{name}/vm/publish`.
  Mints (or updates) the **sealed** assertion on chain. The URL `:name` + the seal
  select the assertion and encode the author, so this endpoint takes **no selector** —
  `assertionName`, author overrides, and any `selection` other than `"all"` are
  rejected `400`. It is multi-root-safe (the seal commits the whole assertion).
  Body: `{ "contextGraphId": "...", "subGraphName"?: "...", "options"?: { "publishEpochs"?: N, "publisherNodeIdentityIdOverride"?: "N" } }`.
  **Preconditions:** the assertion must be finalized **and** present in SWM (else
  `409 VM_PUBLISH_PRECONDITION`), **and the context graph must be registered on-chain**
  (else the daemon throws *"Context graph … is not registered on-chain. Run 'dkg
  context-graph register …' first"*). A fresh project created via
  `dkg_context_graph_create` is **local-only** (no chain) until its first registration —
  see "Registering the CG for VM" below. Returns the **publish response body** below.
- **One-shot atomic publish** — `dkg_publish`. Creates a fresh auto-named assertion from
  loose quads (`POST /api/knowledge-assets`) then publishes it via the **atomic
  finalized-assertion fork** of `/api/shared-memory/publish` (`{assertionName}`) — scoped
  to that one assertion's seal, **multi-root-safe** (no `selection`, no single-root loop,
  no `409 MULTI_ROOT`). Like `vm/publish` it does **not** auto-register the CG → pass
  `register_if_needed: true` on a fresh CG. Use it for "I have loose quads, publish now".
- **CG-wide SWM-bridge publish (legacy, retained)** — `dkg_shared_memory_publish` →
  `POST /api/shared-memory/publish` with a **`selection`** selector. **Single-root-per-call**
  (§5 SWM): loop one root per call (else `409 MULTI_ROOT_PUBLISH_NOT_ATOMIC`); auto-registers
  the CG on first publish (LU-6). Use it to flush existing SWM that isn't a named lifecycle
  assertion.

**Publish response body (`vm/publish`).** A successful publish returns:

```jsonc
{
  "kaId":   "...",                                  // packed on-chain KA id (response-only)
  "status": "confirmed",
  "ual":    "did:dkg:<chainId>/<kasAddress>/<number>",    // the UAL — see below
  "txHash": "0x...",
  "merkleRoot": "...",
  "authorAddress": "0x...",                          // the SEAL author
  "kas": [ { "tokenId": "...", "rootEntity": "..." } ],
  "blockNumber": 123
}
```

A **UAL** (Universal Asset Locator) is the on-chain identifier for the published knowledge
asset: `did:dkg:<chainId>/<kasAddress>/<number>` — the middle segment is the KnowledgeAssets
(KAV10) **contract** address (`kav10Address`), **NOT** the author (the separate `authorAddress`
field above is the different seal author; don't conflate). It materializes **only at VM
publish** — not at create / write / finalize / share. Store the returned `ual` (and/or `kaId` /
`kas[].tokenId`) to reference the asset later (e.g. for `/api/update`, `/api/endorse`). **There
is no `kaNumber` field** at the v10.0 floor — the identifiers you get back are `kaId`, `ual`,
and `kas[].tokenId`.

**Status codes:** `200` confirmed · `207` minted but the CG-binding step failed
(`contextGraphError` present; the UAL is still valid) · `502` did not confirm ·
`409 VM_PUBLISH_PRECONDITION` (not finalized / empty SWM).

**Registering the CG for VM.** Verifiable-Memory publishing requires the context graph to
be **registered on-chain** (the first registration is when you accept the chain cost). A
project created with `dkg_context_graph_create` is local-only until then. Three ways to
register:
- **`register_if_needed` on the publish tools (simplest):** all three publish tools —
  `dkg_publish`, `dkg_knowledge_asset_publish`, and `dkg_shared_memory_publish` — accept
  `register_if_needed: true` (`registerIfNeeded` on the MCP runtime) plus an optional
  `access_policy` (`0` open / `1` private, used only when registering). It registers the CG
  on-chain (idempotent; a no-op if already registered, may spend gas/TRAC) and then
  publishes, in one call. Use this to complete `create → write → finalize → share →
  publish` on a brand-new CG, or to one-shot `dkg_publish` fresh quads to an unregistered
  CG. Default is `false` (publish a never-registered CG and you'll get the daemon's
  not-registered error).
- **Explicit register:** `POST /api/context-graph/register` `{ id, accessPolicy?, publishPolicy? }` (CLI: `dkg context-graph register <id>`), then publish.
- **Implicit on the CG-wide path:** the legacy `POST /api/shared-memory/publish` /
  `dkg_shared_memory_publish` auto-registers on first publish (transparent
  register-then-publish), so publishing a fresh CG's SWM there also registers it.

**Auto-seal on full share (best-effort).** A full `swm/share` (`entities: "all"` /
omitted) tries to seal the draft for you before promoting, with three outcomes:
1. **sealed** — it finalizes then shares (the common case);
2. **capability gap** — the node can't sign for this author (no local key / non-V10
   adapter / unregistered CG): it logs a warning and shares **UNSEALED**; a later
   `vm/publish` then returns `409 VM_PUBLISH_PRECONDITION` ("requires an explicit
   finalize first") — call `wm/finalize` explicitly and re-share;
3. **stale / corrupt seal** — the assertion was edited after a prior finalize: the share
   **throws**; re-finalize (or discard) before sharing.

For predictable publishing, call `wm/finalize` explicitly before `swm/share`.

- `POST /api/knowledge-assets/{name}/vm/publish` — per-KA sealed publish → VM (costs TRAC; returns the UAL). Canonical.
- `POST /api/shared-memory/publish` — SWM-bridge / CG-wide publish → VM (costs TRAC; legacy, retained).
- `POST /api/update` — update an existing Knowledge Asset on-chain. Body: `{ kaId, contextGraphId, quads, privateQuads?, precomputedUpdateAttestation? }` — the new data is passed **inline as `quads`** (it is NOT read from SWM). For the name-based edit loop, prefer `wm/pull-from` → edit → `wm/finalize` → `swm/share` → `vm/publish` instead.
- `POST /api/endorse` — endorse a Knowledge Asset ("I vouch for this")
- `POST /api/verify` — propose or approve M-of-N consensus verification

### Querying

**Agent-initiated free-text recall: `memory_search` tool.**

> **Tool name by runtime.** On the OpenClaw and Hermes runtimes this tool is
> registered as **`memory_search`**; on the MCP runtime the same capability is
> exposed as **`dkg_memory_search`**. They are the same fan-out + ranking — use
> whichever your runtime registers.

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
  - `view` — `working-memory` | `shared-working-memory` | `verifiable-memory`
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

- **Reorganizing assertions.** There is no rename-assertion or move-between-sub-graphs endpoint. To reorganize, create a new assertion (with `subGraphName?` for a different partition), copy the triples over via `/wm/write`, then `/wm/discard` the original. A new assertion starts a fresh lifecycle record in `_meta`.
- **Reserved subject IRIs.** Subjects matching `urn:dkg:file:*` or `urn:dkg:extraction:*` are reserved for internal file/extraction metadata and are rejected at write time. Use a different subject IRI.
- **SWM gossip size cap (10 MB).** A single promote or SWM write must fit in one 10 MB gossip message. Split larger assertions by root entity before promoting — use the `entities` parameter on `/swm/share` to promote subsets.
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
> per-agent regardless of CG visibility. Verifiable Memory anchors
> are public on-chain — but the underlying private quads stay local
> on the publishing node and are gated to allowed peers.

### Routing: Turn Context Override

When the chat turn includes injected context with `target_context_graph`, treat that value as the canonical context graph id. If present, `target_context_graph_uri` is the same target as a full DID URI, and `target_context_graph_name` is display-only. Treat the target id as BOTH:

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

- If `target_context_graph` is present, its value is the canonical context graph id for the turn. `target_context_graph_uri` is the same target in full DID form; `target_context_graph_name` is display-only. State the selected project explicitly when asked.
- If it is absent, the user has no project selected. Try to deduce the target project from the conversation context (e.g., "add this to my research project" -> look up "research" via `dkg_list_context_graphs` / `GET /api/context-graph/list`, whose tool surfaces default to created/joined graphs). If the project is ambiguous or you are not confident, ask the user which project to use. Only suggest the right-side panel project dropdown if the user is chatting through the DKG UI — users on other channels (Telegram, API, etc.) do not have a panel to select from. When no project can be determined, route reads and writes to `agent-context` only.
- Default all DKG reads, writes, imports, promotions, publishes, and queries in that turn to the injected target context graph.
- Do not keep using an older conversational context graph when a newer injected `target_context_graph` is present.
- Older UI versions may inject one value containing both display name and ID. If so, prefer the ID inside parentheses when calling tools or APIs, and reference the display name when answering the user.
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
- `POST /api/context-graph/register` — register a previously-created local CG on-chain (two-phase creation). Body: `{ id, accessPolicy?, publishPolicy? }`, where `accessPolicy` controls public/private discovery and `publishPolicy` controls open/curated publishing. Use this to promote a free CG to an on-chain identity before publishing to Verifiable Memory. `revealOnChain` is deprecated and ignored on the V10 ContextGraphs path.
- `POST /api/context-graph/rename` — rename a CG (human-readable name only; the ID is immutable). Body: `{ contextGraphId, name }` (`id` is accepted as an alias for `contextGraphId`; all `/api/context-graph/*` routes accept either).
- `POST /api/context-graph/subscribe` — subscribe to a context graph. Body: `{ contextGraphId }` (or `{ id }`).
- `GET /api/context-graph/list` — list known context graphs; tool wrappers default to the caller's created/joined graphs and can expose all known graphs with `scope: "all"`
- `GET /api/context-graph/exists` — check if a context graph exists
- `GET /api/sync/catchup-status?contextGraphId=...` — poll CG sync progress after subscribing
- 🚧 `GET /api/context-graph/{id}` — CG details *(planned)*
- 🚧 `POST /api/context-graph/{id}/ontology` — add ontology *(planned)*
- 🚧 `GET /api/context-graph/{id}/ontology` — list ontologies *(planned)*

### Sub-Graphs — partitions within a CG

A **sub-graph** is a named partition inside a context graph. Use them to organize assertions by topic, source, or any other axis. Sub-graphs are optional — by default assertions live at the CG root. A sub-graph must be registered before any assertion op passes `subGraphName`; otherwise those ops fail with `Sub-graph "{name}" has not been registered in context graph "{id}". Call createSubGraph() first.`

- `POST /api/sub-graph/create` — register a new sub-graph. Body: `{ contextGraphId, subGraphName }`. Sub-graph names **cannot contain `/`** (it is the graph-URI path separator) — use `-` or `.` for hierarchy-flavored names (e.g. `research-alpha`, not `research/alpha`).
- `GET /api/sub-graph/list?contextGraphId=...` — list all sub-graphs registered in a CG.

To put an assertion in a sub-graph, pass `subGraphName` on `/api/knowledge-assets` (create), `/wm/write`, `/wm/quads`, `/swm/share`, `/wm/discard`, `/wm/import-file`, the `GET /api/knowledge-assets/{name}` descriptor, and on `/api/query` when scoping queries.

### Participants and join flow

| Method | Route | Body | Purpose |
|---|---|---|---|
| `POST` | `/api/context-graph/invite` | `{ contextGraphId, peerId }` | Invite a peer by peer ID. CG creator only. |
| `POST` | `/api/context-graph/{id}/add-participant` | `{ agentAddress }` | Directly add a participant by agent address (creator only). |
| `POST` | `/api/context-graph/{id}/remove-participant` | `{ agentAddress }` | Remove a participant (creator only). |
| `GET`  | `/api/context-graph/{id}/participants` | — | List current participants. Returns `{ contextGraphId, allowedAgents: [...] }`. |
| `POST` | `/api/context-graph/{id}/request-join` | `{ delegation, curatorPeerId, agentName? }` | Deliver a signed join request. `delegation` is the full object returned by `sign-join`; `curatorPeerId` is the curator's libp2p peer id (V10 invite codes embed it as `"<cgId>\n<peerId>"`) and is required unless the local node IS the curator. If local node is the curator, stored locally; otherwise P2P-forwarded to the curator. |
| `GET`  | `/api/context-graph/{id}/join-requests` | — | List pending join requests (curator view). |
| `POST` | `/api/context-graph/{id}/approve-join` | `{ agentAddress }` | Approve a pending request. |
| `POST` | `/api/context-graph/{id}/reject-join` | `{ agentAddress }` | Reject a pending request. |
| `POST` | `/api/context-graph/{id}/sign-join` | — | **Sign-only**: sign a join-request delegation as the caller and return it — this route does **NOT** forward anything to the curator (the response carries `forwarded: false`). To deliver, POST the returned `delegation` to `/request-join` with the curator's `curatorPeerId`. The bearer token only resolves which local agent is signing — external agents without a locally-stored private key cannot use this route. No body required. |

## 7. File Ingestion

Upload a document (PDF, DOCX, HTML, CSV, Markdown, etc.) and let the node
extract RDF triples into a WM assertion. Non-Markdown formats may pass through a
registered converter first; Markdown is parsed directly for frontmatter,
wikilinks, hashtags, Dataview inline fields, and headings. Extracted triples land
through the same path as `POST /api/knowledge-assets/{name}/wm/write`.

`POST /api/knowledge-assets/{name}/wm/import-file` uses multipart form data:

| Field | Required | Description |
|---|---|---|
| `file` | yes | Document bytes |
| `contextGraphId` | yes | Exact existing target context graph id, or full `did:dkg:context-graph:<id>` URI. Must be a **multipart form field** (`-F "contextGraphId=..."`) — passing it as a URL query parameter returns `400 Missing "contextGraphId"` |
| `contentType` | no | Override the file part's Content-Type |
| `ontologyRef` | no | CG `_ontology` URI for guided extraction |
| `subGraphName` | no | Target sub-graph, already registered |

```bash
curl -X POST $BASE_URL/api/knowledge-assets/climate-report/wm/import-file -H "Authorization: Bearer $TOKEN" -F "file=@climate-2026.md;type=text/markdown" -F "contextGraphId=research"
curl $BASE_URL/api/knowledge-assets/climate-report/wm/extraction-status?contextGraphId=research -H "Authorization: Bearer $TOKEN"
```

Import responses include `assertionUri`, `fileHash`, `detectedContentType`, and
an `extraction` object with `status` (`in_progress`, `completed`, `skipped`, or
`failed`), `tripleCount`, `pipelineUsed`, optional `rootEntity`,
`mdIntermediateHash`, `error`, `startedAt`, and `completedAt`. A failed write is
atomic; do not treat a non-zero `tripleCount` on `failed` as partial-write
evidence. `skipped` usually means no converter was available, so the file was
stored but no triples were written. `GET /api/knowledge-assets/{name}/wm/extraction-status?contextGraphId=...`
returns `404` if no import-file record exists or the tracker was TTL-pruned.

### Imported attachment semantic enrichment

When Node UI chat provides a completed imported attachment ref, treat its
`contextGraphId`, `assertionUri`, `fileHash`, status, counts, and Markdown
hash/form as the starting point. Do not read local filesystem paths.

Canonical flow:

1. Call `dkg_knowledge_asset_import_artifact_read_markdown` when you need the Markdown text. The
   daemon validates the import and reads only the content-addressed Markdown blob.
2. Optionally call `dkg_knowledge_asset_query` to inspect existing triples, or
   `dkg_knowledge_asset_import_artifact_resolve` when you need to re-check artifact metadata.
3. Call `dkg_knowledge_asset_semantic_enrichment_write` with `contextGraphId`, `assertionUri`,
   `semanticQuads`, and optional generation metadata.

`dkg_knowledge_asset_semantic_enrichment_write` appends model-derived semantic triples and
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

### Async promote queue (WM → SWM)

Sibling to the publisher queue, but for the WM→SWM transition that a synchronous `POST /api/knowledge-assets/{name}/swm/share` would otherwise perform inline. Use it when the importer is producing assertions faster than the daemon can promote them (bulk Graphify imports, EPCIS batch loads, etc.); the synchronous route stays available for small interactive cases.

The worker runs in-daemon and is **on by default**. Disable per node with `config.promoteQueue.enabled: false`; tune throughput with `workerConcurrency` (default 4), `pollIntervalMs` (default 100), `heartbeatIntervalMs` (default 60_000), `shutdownTimeoutMs` (default 30_000).

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/knowledge-assets/{name}/swm/share-async` | Enqueue a promote. Body: `{ contextGraphId, entities?: [...] \| "all", subGraphName? }`. Returns `202 { jobId, state: "queued", enqueuedAt }`. Returns `409 { existingJobId }` if there is already an active job for the same `(contextGraphId, subGraphName, name)`. |
| `GET`  | `/api/knowledge-assets/swm/share-jobs` | List jobs. Query: `state=queued,running,failed_retrying,succeeded,failed` (comma-separated), `contextGraphId=...`, `limit=N`. Returns `{ jobs: [...] }`. |
| `GET`  | `/api/knowledge-assets/swm/share-jobs/{jobId}` | Read one job (`state`, `attempt.count`, `commitMarker`, `result`, `attempt.lastError` with `classification: transient\|cap_exceeded\|fatal`). |
| `DELETE` | `/api/knowledge-assets/swm/share-jobs/{jobId}` | Cancel a `queued` / `failed_retrying` job. `409` if the job is `running` (let the lease expire). |
| `POST` | `/api/knowledge-assets/swm/share-jobs/{jobId}/recover` | Re-queue a `failed` job after the operator has fixed whatever was wrong (subdivided an over-large entity set, restarted an upstream, etc.). |

Failure classifications you'll see in `attempt.lastError.classification`:

| Classification | Retry? | Typical cause | Operator action |
|---|---|---|---|
| `transient` | yes (until `maxRetries=5` reached) | `fetch failed` / `ECONNRESET` / `timeout` | Wait — the worker will pick it up after backoff. |
| `cap_exceeded` | no | `Promoted assertion too large for gossip` (10 MB) or `Request body too large` (256 KB) | Re-enqueue with a smaller `entities` slice — the queue can't subdivide on its own. |
| `fatal` | no | Bad request, missing assertion, etc. | Inspect the error message, fix the cause, then `POST /api/knowledge-assets/swm/share-jobs/{jobId}/recover`. |

### TRAC auto-approve policy (V10 publish + update)

Every V10 publish or update pulls TRAC from the operational signer via `token.transferFrom(msg.sender, CSS, fullCost)`. Before that call, the EVM adapter checks the signer's allowance for the V10 KA contract and approves more if it's short. `config.chain.approvalPolicy` controls how much it approves at each top-up — a per-publish gas trade-off that's neutral on testnet (zero-cost publishes) but matters at mainnet scale.

| Mode | Per-publish gas | Blast radius (compromised KA) | When to use |
|---|---|---|---|
| `per-publish` (default) | One `approve` tx whenever `tokenAmount` exceeds prior allowance | One publish's cost ceiling | Conservative default. Low publish volume, or operators who trust nothing. |
| `replenishing` | One `approve` per ~`targetAllowance / avgPublishCost` publishes | Capped at `targetAllowance` (1000 TRAC default) | **Recommended for mainnet at any volume.** Predictable gas profile + bounded exposure. |
| `unlimited` | One `approve` ever per wallet | Operational wallet's full TRAC balance | High-volume operators on a contract they trust absolutely. Matches V9 behaviour. |

Configuration (defaults shown):

```yaml
chain:
  type: evm
  rpcUrl: https://base.llamarpc.com
  hubAddress: '0x...'
  approvalPolicy:
    mode: per-publish                # 'per-publish' | 'replenishing' | 'unlimited'
    # `replenishing` mode only:
    targetAllowance: '1000000000000000000000'   # decimal wei-TRAC string (1000 TRAC = 10^21)
    refillBelowFraction: 0.1                     # refill when current < target × this (default 10%)
```

`targetAllowance` is a string because YAML/JSON can't carry bigints natively — the daemon parses it into a bigint at startup, fails fast on garbage input. `refillBelowFraction` clamps to `[0, 1]`; a value of `1` means "refill on every publish" (defeats the policy) and `0` means "never refill until the publish floor (1 wei-TRAC) is breached" (which on a zero-cost CG would mean approve once then never again).

Mode-only shorthand is accepted for compatibility (`approvalPolicy: unlimited` is normalized to `approvalPolicy: { mode: unlimited }`). Use the object form when setting `targetAllowance` or `refillBelowFraction`.

The policy never approves *less* than the immediate publish needs — a too-low `targetAllowance` gets quietly raised to the publish's on-chain floor so misconfiguration can't brick a publish.

This entire surface was empirically driven by [PR #720](https://github.com/OriginTrail/dkg/pull/720)'s `TooLowAllowance(token, 0, 1)` finding on the May 2026 Base Sepolia publish-stress run; see also `packages/chain/test/evm-adapter.unit.test.ts` for the policy's invariants and edge cases.

## 9. Error Reference

| Status | Meaning | Recovery |
|--------|---------|----------|
| 400 | Bad request — missing fields, invalid SPARQL, or an illegal field (e.g. `selection`/`assertionName`/author overrides on `vm/publish`) | Fix the request body |
| 401 | Unauthorized — invalid or missing token | Re-authenticate or refresh token |
| 402 | Insufficient TRAC for publication | Check balances, notify node operator |
| 403 | Forbidden — publishPolicy or allowList violation | Verify CG membership and publish authority |
| 404 | Resource not found | Verify resource identifiers (assertion name, CG ID, **UAL** = the on-chain Universal Asset Locator `did:dkg:<chainId>/<kasAddress>/<number>` returned by `vm/publish`) |
| 409 `VM_PUBLISH_PRECONDITION` | `vm/publish` called on an assertion that is not finalized, or has no quads in SWM | Call `wm/finalize` then `swm/share` before publishing |
| 409 `WM_DRAFT_CONFLICT` | `wm/pull-from` onto an existing dirty WM draft | Pass `onConflict: "replace"`, or `wm/discard` the draft first |
| 409 `MULTI_ROOT_PUBLISH_NOT_ATOMIC` | `/api/shared-memory/publish` resolved >1 root entity | Loop one root per call (`clearAfter: false` on all but the last); or use per-KA `vm/publish` |
| 409 | Conflict — name collision or concurrent modification | Retry with a different name |
| 429 | Rate limited | Wait and retry with backoff |
| 502 | Chain/upstream error — incl. `vm/publish` "did not confirm" | Retry — transient blockchain issue (do not blind-retry a confirmed mint) |
| 503 | Service unavailable | Node is starting up or shutting down |

## 10. Common Workflows

**Create → Write → Finalize → Share → Publish (the canonical 5-stage flow):**

1. Create a context graph / project (`POST /api/context-graph/create`)
2. **Create** a WM assertion (`POST /api/knowledge-assets`)
3. **Write** triples to Working Memory (`POST /api/knowledge-assets/{name}/wm/write`)
4. **Finalize** (seal) the draft (`POST /api/knowledge-assets/{name}/wm/finalize`) — the EIP-712 "git commit" over the whole assertion
5. **Share** to SWM when ready for peers (`POST /api/knowledge-assets/{name}/swm/share`, `entities: "all"`)
6. **Publish** the sealed assertion to VM (`POST /api/knowledge-assets/{name}/vm/publish`) — mints on chain and returns the **UAL** in the response body (`{ kaId, ual, txHash, ... }`); store the UAL to reference the asset later. **On a brand-new project**, the CG isn't registered on-chain yet — pass `register_if_needed: true` on `dkg_knowledge_asset_publish` so it registers then publishes in one call (or register first; see §5 "Registering the CG for VM").

> Shortcut: a full `swm/share` auto-seals best-effort, so steps 4–5 can collapse into a
> single `swm/share` for the common case (see §5 VM for the auto-seal caveats). The
> explicit finalize in step 4 is the predictable path. You can also pass `quads` directly
> to `POST /api/knowledge-assets` (step 2) to auto write+seal in one call, then add
> `alsoShareSwm`/`alsoPublishVm` to run the whole lifecycle atomically — but `alsoPublishVm`
> still needs the CG registered on-chain first (register it, or use the explicit
> `vm/publish` + `register_if_needed` path), since the create route has no register flag.

**Private project for me alone (the default):**

1. `dkg_context_graph_create({ name: "My Notes" })` — curated by default; creator is the only allowed agent.
2. Write WM, then finalize + share to SWM — gossip is gated to the creator's allowlist (just yourself).

**Shared project with a teammate:**

1. `dkg_context_graph_create({ name: "Team X", allowed_agents: ["0xAlice"] })` — curated CG with Alice (and the creator) on the allowlist atomically with creation.
2. Or, if Alice's address comes later: `dkg_context_graph_create({ name: "Team X" })` followed by `dkg_participant_add({ context_graph_id: "team-x", agent_address: "0xAlice" })`.
3. Write, finalize, and share — SWM gossip is delivered only to the listed peers.

**Open/discoverable project:**

1. `dkg_context_graph_create({ name: "Public Research", public: true })` — explicitly opts out of curation; anyone subscribed receives SWM gossip.

**Import a file into a project:**

1. `POST /api/knowledge-assets/{name}/wm/import-file` with the document + `contextGraphId`
2. Poll `GET /api/knowledge-assets/{name}/wm/extraction-status?contextGraphId=...` if needed
3. Finalize + share the assertion to SWM when extraction is complete (and `vm/publish` to anchor it on chain — pass `register_if_needed: true` if the project isn't registered on-chain yet; see §5 "Registering the CG for VM")

**Query across layers:**

- Working memory: `{"sparql": "...", "view": "working-memory", "agentAddress": "...", "contextGraphId": "..."}`
- Shared memory: `{"sparql": "...", "contextGraphId": "...", "view": "shared-working-memory"}`
- Verifiable memory: `{"sparql": "...", "contextGraphId": "...", "view": "verifiable-memory"}`

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

Then call `GET /api/knowledge-assets/{name}?contextGraphId=...&agentAddress=...` for the full event history of a single assertion.
