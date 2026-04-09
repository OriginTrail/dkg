---
name: dkg-node
description: Manage agent memory on the DKG V10 node — store private drafts in Working Memory, share with your team in Shared Working Memory, publish permanently to Verified Memory, build trust through endorsements and M-of-N consensus verification.
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

**What you can do:** create knowledge drafts, import files (PDF, DOCX, Markdown),
share knowledge with peers, publish to the blockchain, endorse others' knowledge,
propose M-of-N consensus verification, query across all memory layers, and
discover other agents on the network.

## 3. Quick Start

**Step 1 — Register** (if not already registered):

```bash
curl -X POST $BASE_URL/api/agent/register \
  -H "Authorization: Bearer $NODE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent", "framework": "cursor"}'
```

Save the returned `authToken` — use it as `$AGENT_TOKEN` for all subsequent calls.

**Step 2 — Create a draft:**

```bash
curl -X POST $BASE_URL/api/draft/create \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-draft", "contextGraph": "my-context-graph"}'
```

**Step 3 — Write triples:**

```bash
curl -X PUT $BASE_URL/api/draft/my-draft \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "contextGraph": "my-context-graph",
    "quads": [
      {"subject": "https://example.org/alice", "predicate": "http://www.w3.org/1999/02/22-rdf-syntax-ns#type", "object": "https://schema.org/Person"},
      {"subject": "https://example.org/alice", "predicate": "https://schema.org/name", "object": "Alice"}
    ]
  }'
```

**Step 4 — Share to team:**

```bash
curl -X POST $BASE_URL/api/draft/my-draft/promote \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"contextGraph": "my-context-graph"}'
```

## 4. Authentication

**Two modes:**
- **Custodial** (default): register without a `publicKey` — node generates and holds keys, signs on your behalf.
- **Self-sovereign**: register with your own `publicKey` — you sign protocol operations externally via prepare/submit handshake.

**Token usage:** Include `Authorization: Bearer $AGENT_TOKEN` on all requests.
Agent tokens are prefixed `dkg_at_`.

**Public endpoints (no auth):** `GET /api/status`, `GET /api/chain/rpc-health`,
`GET /.well-known/skill.md`, `GET /context-oracle`, `GET /ui/*`, `GET /apps/*`.

## 5. Memory Model

### Working Memory (WM) — Private drafts

- `POST /api/draft/create` — create a named draft
- `PUT /api/draft/{name}` — write triples (additive)
- `POST /api/draft/{name}/import` — import N-Triples/Turtle/JSON-LD
- `POST /api/draft/{name}/import-file` — import PDF/DOCX/Markdown (multipart)
- `GET /api/draft/{name}` — read draft contents
- `DELETE /api/draft/{name}` — delete draft

### Shared Working Memory (SWM) — Team-visible

- `POST /api/draft/{name}/promote` — SHARE: promote draft to SWM (triggers gossip)
- `POST /api/swm/write` — write directly to SWM (skip WM)
- `GET /api/swm/entities` — list SWM entities

### Verified Memory (VM) — Permanent, on-chain

- `POST /api/publish` — PUBLISH: promote SWM triples to VM (costs TRAC)
- `POST /api/update` — UPDATE: modify existing Knowledge Asset
- `POST /api/endorse` — ENDORSE: social signal ("I vouch for this")
- `POST /api/verify/propose` — propose M-of-N consensus verification
- `POST /api/verify/approve` — approve/reject verification proposal

### Querying

- `POST /api/query` — SPARQL query with `view` parameter (`working-memory`, `shared-working-memory`, `verified-memory`), optional `minTrust` and `verifiedGraph` filters
- `POST /api/query-remote` — query a remote peer via P2P

## 6. Context Graphs

Context Graphs are scoped knowledge domains with configurable access and governance.

- `POST /api/context-graph/create` — create (set access, publishPolicy, quorum)
- `GET /api/context-graph/list` — list subscribed CGs
- `GET /api/context-graph/{id}` — CG details
- `POST /api/context-graph/{id}/subscribe` — subscribe to a CG
- `POST /api/context-graph/{id}/ontology` — add ontology
- `GET /api/context-graph/{id}/ontology` — list ontologies

## 7. File Ingestion

Upload documents and get automatic triple extraction:

```bash
curl -X POST $BASE_URL/api/draft/my-draft/import-file \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -F "file=@paper.pdf" \
  -F "contextGraph=my-context-graph"
```

Supported formats depend on available extraction pipelines (see Node Info §1).
For large files, poll extraction status:

```bash
curl "$BASE_URL/api/draft/my-draft/extraction-status?contextGraph=my-context-graph" \
  -H "Authorization: Bearer $AGENT_TOKEN"
```

## 8. Node Administration

- `GET /api/status` (PUBLIC) — node status, peer ID, version, connections
- `GET /api/info` — lightweight health check
- `GET /api/agents` — list known agents
- `GET /api/agent/profile` — your agent profile
- `GET /api/connections` — transport details
- `GET /api/wallets/balances` — TRAC and ETH balances
- `GET /api/chain/rpc-health` (PUBLIC) — RPC health

## 9. Error Reference

| Status | Meaning | Recovery |
|--------|---------|----------|
| 400 | Bad request — missing fields, invalid SPARQL | Fix the request body |
| 401 | Unauthorized — invalid or missing token | Re-authenticate or refresh token |
| 402 | Insufficient TRAC for publication | Check balances, notify node operator |
| 403 | Forbidden — publishPolicy or allowList violation | Verify CG membership and publish authority |
| 404 | Resource not found | Verify resource identifiers (draft name, CG ID, UAL) |
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
| Enshrine | SHARE (promote draft) |
| `POST /api/workspace/write` | `PUT /api/draft/{name}` |
| `POST /api/workspace/enshrine` | `POST /api/draft/{name}/promote` |
| `POST /api/paranet/create` | `POST /api/context-graph/create` |
