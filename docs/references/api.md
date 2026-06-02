---
status: current
version: v10
audience: human+agent
doc_type: reference
---

# API

The canonical route contract is generated from the running daemon and exposed to agents through the DKG Node Skill:

* `packages/cli/skills/dkg-node/SKILL.md`
* `GET /.well-known/skill.md` on a running daemon

Use this page as a lookup pointer, not as a duplicate API definition. The highest-risk route families are:

<table><thead><tr><th width="273">Area</th><th>Route family</th></tr></thead><tbody><tr><td>Context graphs</td><td><code>/api/context-graph/*</code></td></tr><tr><td>Assertions</td><td><code>/api/assertion/*</code></td></tr><tr><td>Shared memory and VM publish</td><td><code>/api/shared-memory/*</code></td></tr><tr><td>Query</td><td><code>/api/query</code></td></tr><tr><td>Agents and messaging</td><td><code>/api/agents</code>, <code>/api/chat</code>, <code>/api/messages</code>, <code>/api/invoke-skill</code></td></tr><tr><td>Publishing Conviction Accounts</td><td><code>/api/pca/*</code></td></tr><tr><td>Messaging SLOs</td><td><code>/api/slo</code></td></tr><tr><td>Node status and peers</td><td><code>/api/status</code>, <code>/api/peer-info</code>, <code>/api/wallets/balances</code></td></tr></tbody></table>

For exact request bodies, response shapes, and MCP tool names, use [Node Skill](node-skill.md).
