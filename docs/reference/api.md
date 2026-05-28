---
status: current
version: v10
audience: human+agent
doc_type: reference
---

# API

The canonical route contract is generated from the running daemon and exposed to agents through the DKG Node Skill:

- `packages/cli/skills/dkg-node/SKILL.md`
- `GET /.well-known/skill.md` on a running daemon

Use this page as a lookup pointer, not as a duplicate API definition. The highest-risk route families are:

| Area | Route family |
| --- | --- |
| Context graphs | `/api/context-graph/*` |
| Assertions | `/api/assertion/*` |
| Shared memory and VM publish | `/api/shared-memory/*` |
| Query | `/api/query` |
| Agents and messaging | `/api/agents`, `/api/chat`, `/api/messages`, `/api/invoke-skill` |
| Messaging SLOs | `/api/slo` |
| Node status and peers | `/api/status`, `/api/peer-info`, `/api/wallets/balances` |

For exact request bodies, response shapes, and MCP tool names, use [Node Skill](node-skill.md).
