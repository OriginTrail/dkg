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
- `dkg update --allow-prerelease` allows published prerelease channels when the network policy permits.
- `dkg rollback` reverts to the previous version (Edge: re-installs the prior npm version recorded in `~/.dkg/previous-version`; Core: flips the blue-green slot symlink).

**Detecting current install state:**

- `dkg --version` — the global CLI's version.
- `curl http://127.0.0.1:9200/api/status | jq '{version, commit, commitShort, buildTime, distTag, installMode, nodeRole}'` — the running daemon's version, commit, and install mode. Mismatch between `dkg --version` and the daemon's version is the §1a version-skew condition; `dkg doctor` reports it explicitly.
- `cat ~/.dkg/config.json | jq .nodeRole` — `edge` (default; daemon runs from npm-global install, no release slots) or `core` (operator opted into blue-green slots via `dkg init --role core`).

**Troubleshooting common confusion:**

- "There seem to be multiple DKG installations on this machine" → run `dkg doctor`; the `state.cli.globalPath`, `state.daemon.entryPoint`, and orphan-repos check together identify the canonical install and any stray clones.
- "The UI shows an old version even after I updated" → run `dkg doctor`; the served-UI / source-mismatch check flags stale browser / PWA / service-worker caches.
- "I ran `npm install -g @origintrail-official/dkg@latest` but the daemon still reports the old version" → on Edge nodes, run `dkg stop` and then `dkg start` so the daemon picks up the new install. On Core nodes, the slot mechanism gates the visible version on `dkg update`'s atomic swap, not on `npm install -g` directly — use `dkg update` for Core nodes.
- "Publishing or context-graph registration intermittently fails with an RPC/503 error" → the node uses **multiple chain RPC endpoints with automatic failover**. Each supported network ships a curated set of public RPCs: `chain.rpcUrl` is the primary and `chain.rpcUrls` is an ordered list of backups. A transient failure (rate-limit/timeout/network) on one endpoint silently fails over to the next; on-chain reverts and other application errors do **not** trigger failover. A `503`/`504` from a publish/register/identity/PCA route means **every** configured endpoint was exhausted — retry, or add a faster/private endpoint. Configure backups via `chain.rpcUrls` in `~/.dkg/config.json` or the **"Backup RPC URLs"** prompt in `dkg init`. Precedence: an operator-set `chain.rpcUrls` **replaces** the network defaults; setting only a private `chain.rpcUrl` keeps the public defaults as failover (set `"rpcUrls": []` to opt out). A wrong-chain backup fails the node loudly at startup (provider network-mismatch), never silently. Inspect failover activity at `GET /api/status` → `chain.rpcFailovers` / `chain.rpcExhaustions` / `chain.rpcFailoversByClass`, and per-endpoint reachability at `GET /api/chain/rpc-health`.

The current operator guidance lives in [Updates & Rollback](https://github.com/OriginTrail/dkg/blob/main/docs/use-dkg/updates-and-rollback.md).

## 2. Capabilities Overview

> **Note:** This skill describes the current DKG V10 API surface. Availability
> can vary with the installed node version. Call `GET /api/status` to check the
> version, use `dkg <command> --help` for its CLI surface, and rely on explicit
> error responses when a route is unavailable.

This node provides a three-layer **verifiable memory system** for AI agents:

| Layer | Scope | Cost | Trust Level | Persistence |
|-------|-------|------|-------------|-------------|
| **Working Memory (WM)** | Private to you | Free | Self-attested | Local, survives restarts |
| **Shared Working Memory (SWM)** | Visible to team | Free | Self-attested (gossip replicated) | TTL-bounded |
| **Verifiable Memory (VM)** | Network-queryable, chain-anchored | Gas + TRAC | Self-attested → endorsed → consensus-verified | Durable |

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

A full `swm/share` (`entities: "all"`) **seals by default** and is then publish-ready, so
the explicit `wm/finalize` step is optional on the happy path. Pass `"skipSeal": true` to
share WITHOUT sealing (an unsealed SWM share for local-only collaboration). **Sealing no
longer needs the CG registered on-chain** — `finalize`/`share` are entirely off-chain (see
§5 "Verifiable Memory").

> **Registration happens at publish, automatically.** A project created with
> `/api/context-graph/create` is local-only; you can create → write → seal → share it
> entirely off-chain. The FIRST `vm/publish` **transparently registers** the CG on-chain
> (costs gas/TRAC) and then mints — no separate `register` step is required. (You may still
> register explicitly via `/api/context-graph/register` if you prefer.)

```bash
curl -X POST $BASE_URL/api/context-graph/create -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"id":"my-project","name":"My Project"}'
curl -X POST $BASE_URL/api/context-graph/register -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"id":"my-project"}'   # OPTIONAL — vm/publish auto-registers on first publish (costs gas/TRAC). finalize/share work without it.
curl -X POST $BASE_URL/api/knowledge-assets -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"contextGraphId":"my-project","name":"notes"}'
curl -X POST $BASE_URL/api/knowledge-assets/notes/wm/write -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"contextGraphId":"my-project","quads":[{"subject":"https://example.org/alice","predicate":"https://schema.org/name","object":"\"Alice\""}]}'
curl -X POST $BASE_URL/api/knowledge-assets/notes/wm/finalize -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"contextGraphId":"my-project"}'
curl -X POST $BASE_URL/api/knowledge-assets/notes/swm/share -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"contextGraphId":"my-project","entities":"all"}'
curl -X POST $BASE_URL/api/knowledge-assets/notes/vm/publish -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"contextGraphId":"my-project"}'   # → { "kaId": "...", "ual": "did:dkg:<chainId>/<kasAddress>/<number>", "txHash": "0x...", ... }
curl -X POST $BASE_URL/api/query -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"sparql":"SELECT * WHERE { ?s ?p ?o } LIMIT 10","contextGraphId":"my-project","view":"working-memory","agentAddress":"YOUR_PEER_ID"}'
```

**CLI equivalents for shell-driving agents:**

```bash
dkg context-graph create my-project

# RDF payload source: <name> is the Knowledge Asset name; --input-file is the local source.
dkg ka create notes -c my-project --input-file ./notes.ttl --share

# Document extraction source: import into WM, then finalize/share explicitly.
dkg ka import-file notes-doc -c my-project --input-file ./notes.md
dkg ka finalize notes-doc -c my-project
dkg ka share notes-doc -c my-project

# VM publish is always explicit and operates on a named KA already shared to SWM.
dkg ka publish notes-doc -c my-project
dkg ka publish-async notes-doc -c my-project

# Recovery/edit loop.
dkg ka pull-from notes-doc -c my-project --layer swm --on-conflict replace
dkg ka query notes-doc -c my-project
dkg ka history notes-doc -c my-project
```

`dkg ka create ... --share` is the one-shot create/write/finalize/share convenience and never VM-publishes. `-f` is a short alias for `--input-file`; prefer the long flag in docs and scripts so the local payload source is not confused with the positional KA `<name>`.

## 4. Authentication

**Token usage:** Include `Authorization: Bearer $TOKEN` on all requests.
Every request's Bearer token is resolved to a `callerAgentAddress` the
daemon uses for access-control decisions. Single-token nodes still work —
requests without an explicit caller fall back to the node's default agent.

**Public endpoints (no auth):** `GET /api/status`, `GET /api/chain/rpc-health`,
`GET /.well-known/skill.md`.

### Token discovery

**Co-located agents (running on the same machine as the daemon).** The daemon writes its admin token to `~/.dkg/auth.token` on first start. If your adapter provides a DKG client (for example MCP, Hermes, or OpenClaw), **prefer the adapter's high-level lifecycle tools** (`dkg_context_graph_create`, `dkg_knowledge_asset_create`, `dkg_knowledge_asset_share`, `dkg_knowledge_asset_publish`, etc.) — they load this file automatically and you never need to handle `$TOKEN` yourself. Only fall back to raw HTTP if no adapter tool covers what you need, in which case:

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

> **Parameter spelling differs by runtime.** The `dkg_*` examples in this doc use the MCP/HTTP **camelCase** spelling (`alsoShareSwm`, `subGraphName`, `contextGraphId`). The **OpenClaw** and **Hermes** tools expose the *same fields* in **snake_case** (`also_share_swm`, `sub_graph_name`, `context_graph_id`). Match the spelling to your runtime's own tool schema — e.g. on OpenClaw/Hermes the one-shot is `dkg_knowledge_asset_create({ quads, also_share_swm: true })`. A wrong-case key is silently ignored (the asset would seal but not share).

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
| `dkg_knowledge_asset_create` | `POST /api/knowledge-assets` | Start a WM assertion (knowledge asset). **One-shot:** pass non-empty `quads` to write+seal in one call (**stops at a sealed WM draft**); add **`alsoShareSwm:true`** to also share to SWM in the same call — `dkg_knowledge_asset_create({ quads, alsoShareSwm:true })` is the recommended create→write→seal→share shortcut that lands a publish-ready KA in SWM (then `dkg_knowledge_asset_publish` to mint). `alsoShareSwm` defaults **false** (sharing — private→networked — is an explicit step); it never mints to VM. Sealing needs no on-chain registration |
| `dkg_knowledge_asset_write` | `POST /api/knowledge-assets/{name}/wm/write` | Append triples (`{subject,predicate,object}` — no per-quad `graph`) to a WM assertion |
| `dkg_knowledge_asset_finalize` | `POST /api/knowledge-assets/{name}/wm/finalize` | **Seal** the WM draft (the "git commit" — EIP-712 AuthorAttestation over the whole assertion). Returns `merkleRoot`, `authorAddress`, `schemeVersion`, `chainId`, `kav10Address`, `eip712Digest` |
| `dkg_knowledge_asset_share` | `POST /api/knowledge-assets/{name}/swm/share` | Share a WM assertion's triples to SWM (formerly "promote"). A full share (`entities: "all"` / omitted) **seals by default** (publish-ready); `skipSeal:true` opts out; a subset share is SWM-only — see §5 |
| `dkg_knowledge_asset_publish` | `POST /api/knowledge-assets/{name}/vm/publish` | **Mint / update on chain** (the sealed assertion → VM). Returns the **UAL** + `kaId` + `txHash` — see §5 VM for the full response body |
| `dkg_knowledge_asset_pull_from` | `POST /api/knowledge-assets/{name}/wm/pull-from` | Seed a fresh WM draft from the current SWM or VM state (the "git checkout" — edit loop). Body `{ contextGraphId, layer: "swm"\|"vm", onConflict?: "reject"\|"replace" }` |
| `dkg_knowledge_asset_discard` | `POST /api/knowledge-assets/{name}/wm/discard` | Drop a WM assertion |
| `dkg_knowledge_asset_import_file` | `POST /api/knowledge-assets/{name}/wm/import-file` | Multipart upload a document + extract triples |
| `dkg_knowledge_asset_query` | `GET /api/knowledge-assets/{name}/wm/quads` | Dump every quad in a single assertion (not SPARQL) |
| `dkg_knowledge_asset_history` | `GET /api/knowledge-assets/{name}` | Read an assertion's lifecycle descriptor |
| `dkg_knowledge_asset_import_artifact_read_markdown` | `POST /api/knowledge-assets/import-artifact/read-markdown` | Safely read Markdown for a completed imported attachment by content-addressed hash |
| `dkg_knowledge_asset_import_artifact_resolve` | `POST /api/knowledge-assets/import-artifact/resolve` | Optional metadata re-check for completed imported attachments |
| `dkg_knowledge_asset_semantic_enrichment_write` | `POST /api/knowledge-assets/semantic-enrichment/write` | Append model-derived semantic triples and provenance to the imported assertion |
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

P2P tools fail gracefully when the peer is offline. **Publishing to Verifiable Memory has exactly one
agent tool:** `dkg_knowledge_asset_publish` (`/vm/publish`) — it publishes one sealed assertion by name, takes
**no selector** (the seal commits the whole assertion), is multi-root-safe, auto-registers the CG on first
publish, and returns the **UAL**. It is step 5 of the canonical `create → write → finalize → share → publish`
lifecycle (`finalize` = seal; a full `share` seals by default, so the explicit finalize is optional). To put
knowledge into Shared Working Memory, author it as a **named knowledge asset** (`dkg_knowledge_asset_create`
→ `dkg_knowledge_asset_share`); there is no separate loose-write or direct-bridge publish tool.

**Bulk imports (>5,000 quads in one logical operation):** the per-call `dkg_knowledge_asset_*` loop IS the chunked-write API; there is no `/api/import/bulk`. Keep `/api/knowledge-assets/<name>/wm/write` payloads under the 10 MB body cap, keep `/api/knowledge-assets/<name>/swm/share` payloads under the 256 KB body cap, and remember that promotion can still fail at the 4 MiB gossip-message cap even when the HTTP body is small. For multi-part imports, write a resumable manifest in the `meta` sub-graph (`scripts/lib/manifest.mjs` is the canonical helper), promote import roots in size-aware batches, and halve/retry on 413 rather than restarting the whole import. The expanded contract — chunking budgets, manifest pattern, HTTP 413 recipes, async-promote queue (`/api/knowledge-assets/<name>/swm/share-async`) — is served at `GET /.well-known/skill-importer.md` (the daemon's second canonical skill endpoint, same auth-public + ETag-cacheable shape as `/.well-known/skill.md`). Source checkouts also have the same file at `packages/cli/skills/dkg-importer/SKILL.md`.

### HTTP-only operations (no tool wrapper)

- **Participant self-service join/sign flow** — see §6.
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
- `POST /api/knowledge-assets/{name}/wm/finalize` — **seal** the WM draft (the "git commit"). Computes the canonical `merkleRoot` over the whole assertion, builds + signs an EIP-712 AuthorAttestation, and stamps the seal into `_meta`. The seal is **context-graph-independent**: finalize does **not** require the CG to be registered on-chain — it is an off-chain operation (registration happens at publish). After finalize, the content is committed: a later `vm/publish` consumes the seal verbatim (it never re-hashes or re-signs).
  Body: `{ "contextGraphId": "...", "layer"?: "wm" | "swm", "subGraphName"?: "...", "authorAgentAddress"?: "0x...", "preSignedAuthorAttestation"?: {...}, "schemeVersion"?: 1 }` (`authorAgentAddress` and `preSignedAuthorAttestation` are mutually exclusive). `layer` (default `"wm"`) selects WHERE the content to seal lives: `"swm"` seals an asset whose content is already in Shared Working Memory (e.g. after a `skipSeal` share, or an asset stuck unsealed) — it reconstructs a transient WM draft from SWM and seals it, so the asset becomes publishable **without recreating it**. Returns `{ assertionUri, merkleRoot, authorAddress, schemeVersion, chainId, kav10Address, eip712Digest }`. **Finalize always seals the entire draft — there is no subset/`entities` parameter.**
- `GET /api/knowledge-assets/{name}/wm/quads?contextGraphId=...&subGraphName=...` — read assertion contents as quads
- `POST /api/knowledge-assets/{name}/wm/pull-from` — seed a fresh WM draft from the current SWM or VM state (the "git checkout" — start an edit loop on already-shared/published content).
  Body: `{ "contextGraphId": "...", "layer": "swm" | "vm", "onConflict"?: "reject" | "replace", "subGraphName"?: "..." }`. Returns `{ wmDraft: "open", seededFrom: { layer }, ... }`; an existing dirty draft → `409 WM_DRAFT_CONFLICT` unless `onConflict: "replace"`.
- `POST /api/knowledge-assets/{name}/swm/share` — share assertion triples to SWM (synchronous; returns once SWM insert + gossip complete). Formerly "promote". A **full** share (`entities` omitted or `"all"`) **seals by default** and is then publish-ready; pass `"skipSeal": true` to share WITHOUT sealing (an unsealed SWM share — you can seal it later in place with `wm/finalize` `layer:"swm"`). A **subset** share (`entities` = a proper subset) is SWM-only, never sealed, and **not** publishable to VM as a subset. If a default (sealing) full share cannot seal — a rare residual capability gap (no local key / non-V10 adapter; an unregistered CG is no longer a gap) — it **fails closed**: `409 { code: "UNSEALED_SHARE_BLOCKED", error, recovery }` with **Working Memory preserved** (no silent unsealed share); resolve the gap or pass `skipSeal:true`.
  Body: `{ "contextGraphId": "...", "entities"?: [...] | "all", "skipSeal"?: boolean, "subGraphName"?: "..." }`. Returns `{ swmShared: true, promotedCount, sealed, publishReady }` — `sealed`/`publishReady` describe THIS share (a subset or `skipSeal` share is `sealed:false` **by design**, not a failure).
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

SWM is for knowledge you've shared from WM and want peers to see. Agents put data here by authoring a **named knowledge asset** and sharing it: `POST /api/knowledge-assets/{name}/swm/share` (after `create` → `write`). There is no agent loose-write path — everything in SWM is a named, sealed, publishable knowledge asset.

> **Visibility.** SWM gossips to peers in the context graph's allowlist.
> For a **curated** CG (the default — see §6), only listed agents/peers
> receive the gossip. For an **explicitly public** CG (`public: true` at
> creation), every peer subscribed to the CG receives the gossip.
> Working Memory is per-agent regardless of CG visibility.

- `POST /api/knowledge-assets/{name}/swm/share` — the canonical way an agent puts a named assertion into SWM (after `create` → `write`); a full share seals by default and is publish-ready. **This is the agent path** — see §5 WM and the lifecycle in §3.
- `POST /api/knowledge-assets/{name}/swm/share-async` — enqueue the same WM→SWM share for the in-daemon worker. Use this for bulk importers that should not block on the synchronous share round.

> **No loose SWM writes.** Agent-facing producers must author a named knowledge
> asset and move it through WM→SWM→VM. The legacy loose-write SWM routes were
> retired so shared/published data always has a lifecycle name, seal, and audit
> record.

### Verifiable Memory (VM) — Durable, chain-anchored

> **Lifecycle VM publishing goes through SWM.** Named WM assertions are finalized,
> shared to SWM, then published from there. The public daemon API no longer has
> an unnamed direct explicit-quads publish route.

**Canonical publish (the agent path):** `POST /api/knowledge-assets/{name}/vm/publish`.
Mints (or updates) the **sealed** assertion on chain. The URL `:name` + the seal
select the assertion and encode the author, so authorship cannot be **overridden** here:
`assertionName`, `authorAgentAddress`, `preSignedAuthorAttestation`, and any `selection`
other than `"all"` are rejected `400`. It is multi-root-safe (the seal commits the whole
assertion).
Body: `{ "contextGraphId": "...", "subGraphName"?: "...", "selectedAuthorAgentAddress"?: "0x...", "options"?: { "publishEpochs"?: N, "publisherNodeIdentityIdOverride"?: "N" } }`.

**Choosing among several authors (GH#1786).** When two or more OTHER members have a
finalized assertion with this name, publish returns
`409 { code: "AMBIGUOUS_ASSERTION_AUTHOR", candidates: [...] }`. Retry with
`selectedAuthorAgentAddress` set to one of those `candidates` to publish that member's KA;
the authenticated caller remains the identity used for context-graph registration and
curator stamping. The field **selects among authors that already have a finalized
assertion** — it never confers authorship. It must be **top level** (inside `options` it is
rejected `400`), and an address that is not a resident candidate is rejected
`409 { code: "ASSERTION_AUTHOR_NOT_RESIDENT", candidates: [...] }` rather than publishing
anything. Publishing another author's KA works for the initial **mint** (their sealed
attestation is replayed), but an **update** of a foreign author's KA needs that author's key
to be custodial on this node — otherwise use `/api/update` with a pre-signed
`UpdateAuthorAttestation`.

How that surfaces differs by lane, deliberately. On the **synchronous** `vm/publish` the node
knows the signer, so it answers `409 PUBLISH_AUTHOR_NOT_CUSTODIAL` immediately. On
**`vm/publish-async`** the publisher wallet is chosen later by whichever worker claims the
job, so at accept time the node cannot know which signer will run it; rather than refuse a
publish a different wallet could have made, it accepts (`202`) and the condition surfaces
when the worker runs — as a **terminal** job failure with
`code: "authority_forbidden"` (`retryable: false`, `resolution: "fail_job"`), carrying the
signer's message. It is deliberately *not* retried: no amount of retrying makes the node able
to sign for that author. Poll `/api/publisher/job` for that failure, or read the
`agentAddress` echoed in the 202 body to confirm which author was selected before the job
runs.
**Preconditions:** the assertion must be finalized **and** present in SWM (else
`409 VM_PUBLISH_PRECONDITION`), and the context graph must be registered on-chain — which
`vm/publish` does **automatically on first publish** (no flag needed; costs gas/TRAC). Returns the
**publish response body** below.

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
project created with `dkg_context_graph_create` is local-only until then — but you do **not**
need to register it yourself first. Three things to know:
- **Automatic at publish (default — #1116):** the per-KA `POST /api/knowledge-assets/{name}/vm/publish`
  **auto-registers** an unregistered CG on first publish (register-then-publish), so the whole
  create → write → seal → share → publish flow works on a never-registered CG with **no
  explicit register step and no flag** (the registration spends gas/TRAC; it is **not**
  gas-free).
- **Explicit register (optional):** `POST /api/context-graph/register` `{ id, accessPolicy?, publishPolicy? }` (CLI: `dkg context-graph register <id>`) — only needed to **pre-set** a custom `accessPolicy`/`publishPolicy` before publishing.

**Seal on share (default — #1116).** A full `swm/share` (`entities: "all"` / omitted)
**seals the draft by default** before promoting — the asset is then publish-ready. Outcomes:
1. **sealed** (the default / common case) — it finalizes then shares; the 200 response
   carries `sealed: true, publishReady: true`.
2. **`skipSeal: true`** — you opt out of sealing: it shares **UNSEALED** (`sealed: false,
   publishReady: false`). Seal it later in place with `wm/finalize` `layer:"swm"`, then
   publish — no need to recreate it.
3. **capability gap** (rare: no local key / non-V10 adapter — an unregistered CG is **no
   longer** a gap, since sealing is context-graph-independent) — the share **fails closed**:
   `409 { code: "UNSEALED_SHARE_BLOCKED", error, recovery }`, **Working Memory preserved**
   (never a silent unsealed share). Resolve the gap or pass `skipSeal:true`.
4. **stale / corrupt seal** — the assertion was edited after a prior finalize: the share
   **throws**; re-finalize (or discard) before sharing.

Subset shares are SWM-only and never sealed (`publishReady: false` by design). To recover an
asset that is unsealed-in-SWM, `wm/finalize` `layer:"swm"` seals it in place — then publish.

- `POST /api/knowledge-assets/{name}/vm/publish` — per-KA sealed publish → VM (costs TRAC; returns the UAL). Canonical.
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
- **SWM gossip size cap (4 MiB).** A single share (`/swm/share`) must fit in one 4 MiB gossip message. Split larger assertions by root entity before sharing — use the `entities` parameter on `/swm/share` to share subsets.
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
- `POST /api/context-graph/reconcile` — node-admin maintenance endpoint that reconciles one subscribed/hosted context graph against its on-chain KC watermark. Body: `{ contextGraphId }` (or `{ id }`). A current watermark returns without VM-slice or peer catch-up work. Requires the node-level admin token when daemon auth is enabled; agent-scoped tokens are rejected.
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

Use the job queue for bulk or long-running publishes, publishes that must survive the client session, or when the daemon should hold its own signing wallet. For small interactive publishes, use the synchronous per-KA `POST /api/knowledge-assets/{name}/vm/publish` instead.

CLI equivalents:

```bash
dkg ka publish-async <name> -c <context-graph-id>
dkg publisher publish-async <context-graph-id> <name>   # operational alias
dkg publisher publish-async <context-graph-id> <name> --publisher-node-identity-id 0
dkg publisher jobs
dkg publisher job <job-id>
dkg publisher stats
dkg publisher retry     # prints all three counts of the pass (see the retry table below)
```

Async publisher wallets need native gas plus PCA agent registration or TRAC for direct spend. They do not need on-chain identities/profiles to claim VM publish jobs. Identity `0` is valid no-attribution mode; a non-zero identity is optional publisher-node attribution only. Separate publisher wallets are not automatically attached to the node's Core identity; use `POST /api/operational-wallets` only when attribution to that node identity is desired. See `docs/use-dkg/async-publisher-wallets.md`.

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/knowledge-assets/{name}/vm/publish-async` | Enqueue VM publish for a named KA already shared to SWM. Body: `{ contextGraphId, options? }`; `options.publisherNodeIdentityIdOverride: "0"` forces no-attribution. Returns `202 { jobId, status: "accepted" }`. Re-submitting the same request resumes the EXISTING job for that KA; `503 { code: "LIFT_JOB_PENDING_CHAIN_PROOF", retryable, existingJobId }` means that job failed after it may have submitted a transaction and is held. `retryable` is **per-job** now: **true** means an automatic lane exists that can move THIS job — chain recovery re-checks it every recovery tick, and either canonical recognition (the transaction actually landed; applies to creates AND updates) or the create-only proven-absence release (create with a recorded nonce and pinned KA id) will settle it, so re-submitting converges without an operator. For an UPDATE, true is conditional: recognition converges only if its transaction actually mined — an update whose transaction is gone has no absence release (re-applying a stale root over a later third-party update is the hazard) and keeps 503ing until you act. **false** means the record has no automatic exit at all (a legacy job with no recorded nonce, or one whose recognition question cannot be formed): retrying will 503 forever. Either way it is not a deadline — the hold never expires — and the exit you control is the same: check that transaction yourself and clear that job with `POST /api/publisher/clear-job`. Do **not** re-share or publish under a new name to work around it (that is how you double-publish). |
| `GET`  | `/api/publisher/jobs?status=...` | List jobs, optionally filtered by status. |
| `GET`  | `/api/publisher/job?id=...` | Fetch one job's status: `{ job, retryState }` (see `retryState` below). |
| `GET`  | `/api/publisher/job-payload?id=...` | Fetch the prepared payload for internal raw LIFT jobs, as `{ job, payload, retryState }`. Named lifecycle publish jobs return no raw payload. |
| `GET`  | `/api/publisher/stats` | Queue statistics (running / pending / completed / failed). |
| `POST` | `/api/publisher/cancel` | Cancel a job. Body: `{ jobId }`. |
| `POST` | `/api/publisher/retry` | Reaccept every failed job that is safe to re-run. Body: `{ status: "failed" }`. Returns `200 { retried, blockedPendingRecovery, skipped }` — three counts that partition the failed jobs: reaccepted, left failed because a transaction may exist (awaiting chain proof or owned by recovery), and left failed with nothing to retry (terminal failure or spent retry budget). |
| `POST` | `/api/publisher/clear` | Clear completed/failed jobs in BULK (`dkg publisher clear <status>`). Safe by default: it skips a failed job that is still held for chain proof and still owns its KA's lifecycle — deleting that record is what would let the next re-submit publish the same KA a second time. |
| `POST` | `/api/publisher/clear-job` | Clear ONE terminal job by id: `{ jobId }` → `{ outcome: "cleared" \| "already_absent" }`. The deliberate override for a job bulk clear skips — you name the job and take the decision. |

#### Retry behaviour and its knobs (`config.publisher`)

A failed job is retried by the publisher itself only when the failure is one the publisher classifies as safe to re-run — today `quorum_unmet` (the ACK quorum was not reached) and `workspace_unavailable` (the shared-memory head the job reads was missing or corrupt when the job was claimed). Both are established **before** any transaction is signed, so a re-run cannot double-publish. Failures that may have sent a transaction (`rpc_unavailable`, `nonce_conflict`, the timeout codes) are never retried automatically, and whether an operator can re-run one by hand depends on the evidence the job persisted — see the evidence rule below.

An eligible job gets a `nextRetryAt` and is re-accepted with the **same `jobId`** when it comes due — the queue never mints a replacement job for a retry.

No path — automatic, `POST /api/publisher/retry`, or re-submit — re-runs a job that persisted a transaction hash or failed from `included`: whatever its failure code says, that job may have a transaction on chain, so it stays `failed` and is counted as `blockedPendingRecovery` (a re-submit gets the `503 LIFT_JOB_PENDING_CHAIN_PROOF` above). This holds even when the failure is TERMINAL (`confirmation_mismatch`, an unreconcilable recovery), and it holds no matter what happened to that KA afterwards: a later job for the same KA — even one that finalized — is not evidence about the held job's transaction, so the held job keeps its KA's lifecycle and every re-submit keeps getting the 503 until you resolve it. The exits are chain recovery establishing the transaction's fate, or `POST /api/publisher/clear-job` on that exact jobId once you have checked it yourself. Chain recovery now does this for named-KA (`vm/publish-async`) jobs too, not only raw lift ones: every recovery tick asks the chain about each held job and releases it with no operator action — finalizing it if the publish landed, or putting it back on the queue under the same jobId if the transaction is proven to have never landed. "Proven" is strict, and deliberately so: a node simply not finding the transaction is **not** enough, because a broadcast whose response timed out can still be sitting in a mempool that endpoint cannot see and be mined a minute later. The release needs the transaction to be missing, its nonce — recorded on the job when it was signed — to be spent at a **finalized** block by something else (so it can never mine), **and** the knowledge-asset id the job would mint to be provably absent on chain — because a replacement transaction on that same nonce slot could have performed the very same publish, and the nonce alone cannot tell. A job whose record predates that nonce, one that would allocate a fresh id on re-run (an unsealed raw-lift job — there is nothing to check, so a duplicate could not be detected), or one that runs against a deployment with no finalized-block reads, therefore stays held until you clear it by id. There is also deliberately **no** timeout on the wait: a hold that expired on its own would mean resending with no proof, which is the double publish this rule exists to prevent. The exception is a failure that PROVES the transaction had no effect — `tx_reverted` (it reverted on chain) and `insufficient_funds` (refused before entering the mempool) — which supersedes normally, so topping the wallet up and re-submitting works. Read `retryState` on `GET /api/publisher/job` for the per-job answer: `autoRetryEligible` tells you whether this node will retry the job by itself — it requires a retry to be actually SCHEDULED, so a job that failed while `autoRetryEnabled` was off reads `false` even after you switch the lane back on (re-enabling does not schedule past failures; `POST /api/publisher/retry` or a re-submit re-arms them), and `waitingReason` — `backoff` (scheduled), `pending_chain_proof` (a transaction may exist), `recovery` (owned by the chain-recovery loop), `operator` (nothing automatic will move it), `exhausted` (budget spent) — tells you what it is waiting for. `waitingReason` is ABSENT when the job is not waiting on a retry at all: it is still running, finalized, or failed terminally with nothing left to re-arm it. Both fields are derived on read, never stored. A job in `pending_chain_proof` is also skipped by bulk clear, so cleaning up failed jobs cannot silently free its KA for a fresh publish; clear it by id only once you know its transaction's fate. On a node upgraded from a version before this rule, a KA that already has a newer job can still be held by such a predecessor — the same by-id clear releases it.

| Key | Default | Meaning |
|---|---|---|
| `autoRetryEnabled` | `true` | Kill-switch for the publisher's own retry lane. `false` collapses it to manual-only: nothing new is scheduled and nothing already scheduled is re-accepted. |
| `retryBackoffBaseMs` | `5000` | Delay before the first retry; doubles per attempt. |
| `retryBackoffMaxMs` | `60000` | Hard ceiling on the delay, jitter included. |
| `retryJitterRatio` | `0.2` | Fraction of the delay the jitter may add or subtract (`0` disables jitter, must stay below `1`). Spreads retries so a fleet doesn't stampede a recovering peer. |
| `maxRetries` | `10` | Retry **budget** per job — see below. |

`maxRetries` is one counter shared by the automatic retries and by every manual `POST /api/publisher/retry` / re-submit reaccept, snapshot when the job is admitted (changing the config does not re-arm jobs already in the queue). With the defaults, a job's automatic recovery window is 10 attempts over roughly 7 minutes; after that it stays `failed` (`waitingReason: "exhausted"`) until an operator intervenes — except that re-submitting the identical `vm/publish-async` request is a FRESH MANDATE: if the job carries no transaction evidence it is reaccepted on the same `jobId` with the budget re-armed to one full window, which is why an exhausted job never becomes a second job for the same KA.

Two operational notes: turning `autoRetryEnabled` off **strands** jobs that were already scheduled (their `nextRetryAt` passes without firing) — they stay retryable by hand, and turning it back on releases them, at most five per claim; and `retryBackoffBaseMs`/`retryBackoffMaxMs` may be set independently — the daemon validates the **effective** pair (your value combined with the built-in default for the unset one) at startup, so a lone `retryBackoffBaseMs` above the default 60s ceiling is rejected with a message naming both sides. The four retry knobs survive `dkg publisher enable`, which rewrites only the keys it owns (`enabled`, `pollIntervalMs`, `errorBackoffMs`, `maxRetries`).

### Async promote queue (WM → SWM)

Sibling to the publisher queue, but for the WM→SWM transition that a synchronous `POST /api/knowledge-assets/{name}/swm/share` would otherwise perform inline. Use it when the importer is producing assertions faster than the daemon can promote them (bulk Graphify imports, EPCIS batch loads, etc.); the synchronous route stays available for small interactive cases.

The worker runs in-daemon and is **on by default**. Disable per node with `config.promoteQueue.enabled: false`; tune throughput with `workerConcurrency` (default 4), `pollIntervalMs` (default 100), `heartbeatIntervalMs` (default 60_000), `shutdownTimeoutMs` (default 30_000).

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/knowledge-assets/{name}/swm/share-async` | Enqueue a promote. Body: `{ contextGraphId, entities?: [...] \| "all", subGraphName? }`. Returns `200 { jobId, state: "queued" }`. Returns `409 { existingJobId }` if there is already an active job for the same `(contextGraphId, subGraphName, name)`. |
| `GET`  | `/api/knowledge-assets/swm/share-jobs` | List jobs. Query: `state=queued,running,failed_retrying,succeeded,failed` (comma-separated), `contextGraphId=...`, `limit=N`. Returns `{ jobs: [...] }`. |
| `GET`  | `/api/knowledge-assets/swm/share-jobs/{jobId}` | Read one job (`state`, `attempt.count`, `commitMarker`, `result`, `attempt.lastError` with `classification: transient\|cap_exceeded\|fatal`). |
| `DELETE` | `/api/knowledge-assets/swm/share-jobs/{jobId}` | Cancel a `queued` / `failed_retrying` job. `409` if the job is `running` (let the lease expire). |
| `POST` | `/api/knowledge-assets/swm/share-jobs/{jobId}/recover` | Re-queue a `failed` job after the operator has fixed whatever was wrong (subdivided an over-large entity set, restarted an upstream, etc.). |

CLI equivalents:

```bash
dkg ka share-async <name> -c <context-graph-id>
dkg ka share-jobs --context-graph-id <context-graph-id> --state queued,failed_retrying --limit 20
dkg ka share-job <job-id>
dkg ka cancel-share-job <job-id>
dkg ka recover-share-job <job-id>
```

Failure classifications you'll see in `attempt.lastError.classification`:

| Classification | Retry? | Typical cause | Operator action |
|---|---|---|---|
| `transient` | yes (until `maxRetries=5` reached) | `fetch failed` / `ECONNRESET` / `timeout` | Wait — the worker will pick it up after backoff. |
| `cap_exceeded` | no | `Promoted assertion too large for gossip` (4 MiB) or `Request body too large` (256 KB) | Re-enqueue with a smaller `entities` slice — the queue can't subdivide on its own. |
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
  finalityConfirmations: 1          # operator-selected; 1 has no successor-block reorg buffer
  approvalPolicy:
    mode: per-publish                # 'per-publish' | 'replenishing' | 'unlimited'
    # `replenishing` mode only:
    targetAllowance: '1000000000000000000000'   # decimal wei-TRAC string (1000 TRAC = 10^21)
    refillBelowFraction: 0.1                     # refill when current < target × this (default 10%)
```

`finalityConfirmations` is an operator-selected positive integer. It controls when a mined publish receipt becomes terminal and when its publisher wallet may take another queued job. Standard EVM confirmation counting applies: `1` accepts the receipt's own block after verifying that its hash is canonical; `2` waits for one successor, and so on. The default is `1`.
Lower values reduce publish latency, but they increase reorganization risk. A value of `1` gives no successor-block buffer: a chain reorganization can reverse a receipt after the node has accepted it and released the wallet. Choose a larger value when the network can have reorganizations or when reversal risk is more important than publish speed. The node uses the configured value for receipt finality and recovery proof snapshots; it does not replace the operator's value with the protocol's separate finalized-block tag.

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
| 409 `UNSEALED_SHARE_BLOCKED` | a default (sealing) full `swm/share` could not seal — a rare capability gap (no local key / non-V10 adapter); **Working Memory is preserved** | Resolve the signing capability, or pass `skipSeal:true` to share unsealed (then seal later via `wm/finalize` `layer:"swm"`) |
| 409 `VM_PUBLISH_PRECONDITION` | `vm/publish` on an assertion that is not finalized (e.g. shared with `skipSeal`), or has no quads in SWM | Seal it — `wm/finalize` (`layer:"swm"` if the content is already in SWM), then publish; or `swm/share` first if it isn't in SWM |
| 409 `WM_DRAFT_CONFLICT` | `wm/pull-from` onto an existing dirty WM draft | Pass `onConflict: "replace"`, or `wm/discard` the draft first |
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
6. **Publish** the sealed assertion to VM (`POST /api/knowledge-assets/{name}/vm/publish`) — mints on chain and returns the **UAL** in the response body (`{ kaId, ual, txHash, ... }`); store the UAL to reference the asset later. **On a brand-new project** the CG isn't registered on-chain yet — `vm/publish` now **auto-registers** it on first publish (no flag needed; see §5 "Registering the CG for VM").

> Shortcut: a full `swm/share` **seals by default**, so steps 4–5 collapse into a single
> `swm/share` for the common case (see §5 VM). The explicit finalize in step 4 is still
> available when you want custom attestation options. You can also pass `quads` directly to
> `dkg_knowledge_asset_create` (step 2) to write+seal in one call (stops at a sealed WM
> draft) — add **`alsoShareSwm:true`** to also share to SWM in the same call, landing a
> publish-ready KA (`dkg_knowledge_asset_create({ quads, alsoShareSwm:true })`). It stops at
> SWM; mint with `dkg_knowledge_asset_publish` (which auto-registers a never-registered CG).

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
