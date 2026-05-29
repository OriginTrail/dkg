---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Use DKG

Use these routes when you want a node running, an agent connected, memory operations working, or an operator workflow recovered.

## Fast paths

| Goal | Route |
| --- | --- |
| Run a standalone node | [Install a Node](install-node.md) |
| Start, stop, and inspect the daemon | [Run a Node](run-node.md) |
| Connect MCP, Hermes, or OpenClaw | [Connect an Agent](connect-agent.md) |
| Write, publish, and query knowledge | [Publish and Query](publish-and-query.md) |
| Fund testnet wallets | [Funding](funding.md) |
| Manage Publishing Conviction Accounts | [Publishing Conviction](publishing-conviction.md) |
| Configure relays and peer reachability | [Relays and Peers](relays-and-peers.md) |
| Expose the storage SPARQL endpoint | [Storage SPARQL HTTP](storage-sparql-http.md) |
| Manually subscribe a host-mode node | [Host-Mode Manual Subscribe](host-mode-manual-subscribe.md) |
| Update or roll back | [Updates and Rollback](updates-and-rollback.md) |
| Migrate a git checkout to npm auto-update | [Migrate to npm](migrate-to-npm.md) |
| Diagnose common failures | [Troubleshooting](troubleshooting.md) |

## Default install shape

Most users start with the umbrella CLI:

```bash
npm install -g @origintrail-official/dkg
dkg init
dkg start
```

Framework setup commands such as `dkg mcp setup`, `dkg hermes setup`, and `dkg openclaw setup` bootstrap the node when needed, start the daemon by default, optionally fund testnet wallets, and verify the integration.
