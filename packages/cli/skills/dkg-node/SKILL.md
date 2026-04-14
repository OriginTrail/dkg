---
name: dkg-node
description: Manage agent memory on the DKG V10 node — store private assertions in Working Memory, share with your team in Shared Working Memory, publish permanently to Verified Memory, build trust through endorsements and M-of-N consensus verification.
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
- **Subscribed Context Graphs:** (dynamic)

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

## Turn Context Override

When the chat turn includes injected context with `target_context_graph`, treat that value as the authoritative target context graph for the current turn unless the user explicitly overrides it in the same message.

Implications:

- Default all DKG reads, writes, imports, promotions, publishes, and queries in that turn to the injected target context graph.
- Do not keep using an older conversational context graph when a newer injected `target_context_graph` is present.
- If the injected value includes both display name and ID, prefer the ID when calling tools or APIs.
- If the user explicitly says to use a different context graph in the same turn, follow the user's explicit instruction instead.

**Step 1 — Create a Context Graph:**

```bash
curl -X POST $BASE_URL/api/context-graph/create \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id": "my-context-graph", "name": "My Context Graph"}'
```

**Step 2 — Write to Shared Memory:**

```bash
curl -X POST $BASE_URL/api/shared-memory/write \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "contextGraphId": "my-context-graph",
    "quads": [
      {"subject": "https://example.org/alice", "predicate": "http://www.w3.org/1999/02/22-rdf-syntax-ns#type", "object": "https://schema.org/Person", "graph": ""},
      {"subject": "https://example.org/alice", "predicate": "https://schema.org/name", "object": "\"Alice\"", "graph": ""}
    ]
  }'
```

**Step 3 — Publish to Verified Memory (from SWM):**

> Data must be in Shared Working Memory before publishing. The on-chain
> transaction is a finality signal — peers already have the data via gossip.

```bash
curl -X POST $BASE_URL/api/shared-memory/publish \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"contextGraphId": "my-context-graph"}'
```

**Step 4 — Query:**

```bash
curl -X POST $BASE_URL/api/query \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sparql": "SELECT * WHERE { ?s ?p ?o } LIMIT 10", "contextGraphId": "my-context-graph", "view": "verified-memory"}'
```

## 4. Authentication

**Token usage:** Include `Authorization: Bearer $TOKEN` on all requests.
The token is configured in the node's config file or provided at startup.

**Public endpoints (no auth):** `GET /api/status`, `GET /api/chain/rpc-health`,
`GET /.well-known/skill.md`.

> **Planned:** Multi-agent registration (`POST /api/agent/register`) with custodial
> and self-sovereign key modes will be available in a future release.

## 5. Memory Model

### Shared Working Memory (SWM) — Team-visible

- `POST /api/shared-memory/write` — write triples to SWM (gossip-replicated)
- `POST /api/shared-memory/publish` — promote SWM triples to Verified Memory

### Verified Memory (VM) — Permanent, on-chain

> All publishing goes through SWM first. The chain transaction is a finality
> signal — it seals data that peers already hold.

- `POST /api/shared-memory/publish` — promote SWM data to Verified Memory (costs TRAC)
- `POST /api/update` — update an existing Knowledge Asset (reads new data from SWM)
- `POST /api/endorse` — endorse a Knowledge Asset ("I vouch for this")
- `POST /api/verify` — propose or approve M-of-N consensus verification

### Querying

- `POST /api/query` — SPARQL query with optional `contextGraphId`, `includeSharedMemory`, `view` (`working-memory`, `shared-working-memory`, `verified-memory`), `agentAddress`, `assertionName`, `verifiedGraph` parameters
  - **Note:** `subGraphName` is supported for legacy routing only and cannot be combined with `view`
- `POST /api/query-remote` — query a remote peer via P2P

### Working Memory (WM) — Private assertions

WM assertions are your agent-local drafts — private to you, readable and
writable only by your peer ID, never gossiped. Use them to stage knowledge
before sharing it to SWM (team) or promoting it to VM (chain-anchored).

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

> If `subGraphName` is provided but the sub-graph is not registered in the CG's
> `_meta` graph, all assertion operations throw
> `Sub-graph "{name}" has not been registered in context graph "{id}". Call createSubGraph() first.`
> Create the sub-graph before targeting it.

## 6. Context Graphs

Context Graphs are scoped knowledge domains with configurable access and governance.

- `POST /api/context-graph/create` — create a context graph
- `GET /api/context-graph/list` — list subscribed context graphs
- `POST /api/context-graph/subscribe` — subscribe to a context graph
- `GET /api/context-graph/exists` — check if a context graph exists
- 🚧 `GET /api/context-graph/{id}` — CG details *(planned)*
- 🚧 `POST /api/context-graph/{id}/ontology` — add ontology *(planned)*
- 🚧 `GET /api/context-graph/{id}/ontology` — list ontologies *(planned)*

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

Both `fileHash` and `mdIntermediateHash` are `keccak256:<hex>` per spec §10.2:603. `mdIntermediateHash` is only present when Phase 1 actually ran (converter-backed imports like PDF/DOCX); pure-markdown imports leave it undefined.

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

## 8. Node Administration

- `GET /api/status` (PUBLIC) — node status, peer ID, version, connections
- `GET /api/info` — lightweight health check
- `GET /api/agents` — list known agents
- `GET /api/connections` — transport details
- `GET /api/wallets/balances` — TRAC and ETH balances
- `GET /api/chain/rpc-health` (PUBLIC) — RPC health
- `GET /api/identity` — node identity (DID, identity ID)
- 🚧 `GET /api/agent/profile` — your agent profile *(planned)*

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

**Write → Share → Publish:**

1. Create a context graph (`POST /api/context-graph/create`)
2. Write triples to shared memory (`POST /api/shared-memory/write`)
3. Publish to verified memory (`POST /api/shared-memory/publish`)

**Query across layers:**

- Shared memory: `{"sparql": "...", "contextGraphId": "...", "view": "shared-working-memory"}`
- Verified memory: `{"sparql": "...", "contextGraphId": "...", "view": "verified-memory"}`
- Working memory (planned): `{"sparql": "...", "view": "working-memory", "agentAddress": "...", "contextGraphId": "..."}`

## Appendix: V9 → V10 Migration

| V9 Concept | V10 Equivalent |
|------------|---------------|
| Paranet | Context Graph |
| Workspace | Shared Working Memory |
| Enshrine | Publish (promote to Verified Memory) |
| `POST /api/workspace/write` | `POST /api/shared-memory/write` |
| `POST /api/workspace/enshrine` | `POST /api/shared-memory/publish` |
| `POST /api/paranet/create` | `POST /api/context-graph/create` |
