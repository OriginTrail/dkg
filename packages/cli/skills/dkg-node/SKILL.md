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

- `POST /api/query` — SPARQL query with optional `view` (`working-memory`, `shared-working-memory`, `verified-memory`), `agentAddress`, `assertionName`, `verifiedGraph`, `subGraphName`, `includeSharedMemory`, `contextGraphId` parameters
- `POST /api/query-remote` — query a remote peer via P2P

### Working Memory (WM) — Private assertions (🚧 Planned)

> The following WM assertion endpoints are planned for a future release:

- `POST /api/assertion/create` — create a named private assertion
- `PUT /api/assertion/{name}` — write triples to an assertion
- `POST /api/assertion/{name}/import` — import N-Triples/Turtle/JSON-LD
- `POST /api/assertion/{name}/import-file` — import PDF/DOCX/Markdown (multipart)
- `GET /api/assertion/{name}` — read assertion contents
- `DELETE /api/assertion/{name}` — delete assertion
- `POST /api/assertion/{name}/promote` — promote assertion to SWM

## 6. Context Graphs

Context Graphs are scoped knowledge domains with configurable access and governance.

- `POST /api/context-graph/create` — create a context graph
- `GET /api/context-graph/list` — list subscribed context graphs
- `POST /api/context-graph/subscribe` — subscribe to a context graph
- `GET /api/context-graph/exists` — check if a context graph exists
- 🚧 `GET /api/context-graph/{id}` — CG details *(planned)*
- 🚧 `POST /api/context-graph/{id}/ontology` — add ontology *(planned)*
- 🚧 `GET /api/context-graph/{id}/ontology` — list ontologies *(planned)*

## 7. File Ingestion (🚧 Planned)

> File ingestion via `import-file` depends on the Working Memory assertion API (§5)
> and will be available when those endpoints ship. The extraction pipeline
> infrastructure (MarkItDown converter) is already in place on the node.

Supported formats depend on available extraction pipelines (see Node Info §1).
When available, usage will be:

```bash
curl -X POST $BASE_URL/api/assertion/my-assertion/import-file \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@paper.pdf" \
  -F "contextGraph=my-context-graph"
```

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

## 10. Workflow Recipes

For detailed step-by-step workflow recipes and the full endpoint reference, see
the supporting files in the skill directory:

- `workflows.md` — 10 workflow recipes with curl examples
- `api-reference.md` — full endpoint reference grouped by workflow
- `examples/sparql-recipes.md` — SPARQL query patterns

## Appendix: V9 → V10 Migration

| V9 Concept | V10 Equivalent |
|------------|---------------|
| Paranet | Context Graph |
| Workspace | Shared Working Memory |
| Enshrine | Publish (promote to Verified Memory) |
| `POST /api/workspace/write` | `POST /api/shared-memory/write` |
| `POST /api/workspace/enshrine` | `POST /api/shared-memory/publish` |
| `POST /api/paranet/create` | `POST /api/context-graph/create` |
