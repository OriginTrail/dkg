---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Build with DKG

Use these routes when you want a node running, an agent connected, or a first memory operation working.

## Fast paths

| Goal | Route |
| --- | --- |
| Run a standalone node | [Install a Node](install-node.md) |
| Connect MCP-aware coding agents | [Connect MCP](connect-mcp.md) |
| Connect Hermes | [Connect Hermes](connect-hermes.md) |
| Connect OpenClaw | [Connect OpenClaw](connect-openclaw.md) |
| Write and publish knowledge | [Publish Knowledge](publish.md) |
| Query memory | [Query Knowledge](query.md) |

## Default install shape

Most users start with the umbrella CLI:

```bash
npm install -g @origintrail-official/dkg
dkg init
dkg start
```

Framework setup commands such as `dkg mcp setup`, `dkg hermes setup`, and `dkg openclaw setup` bootstrap the node when needed, start the daemon by default, optionally fund testnet wallets, and verify the integration.

