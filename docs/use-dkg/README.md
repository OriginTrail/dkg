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
| Install DKG, connect an agent, or run a standalone node | [Quickstart](../getting-started/quickstart.md) |
| Start, stop, and inspect the daemon | [Daemon Lifecycle](run-node.md) |
| Run a local LLM through the DKG MCP tools | [Local LLM with DKG](local-llm.md) |
| Give a coding agent an exact local-LLM startup procedure | [Local LLM agent runbook](local-llm-agent-runbook.md) |
| Write, publish, and query knowledge | [Publish and Query](publish-and-query.md) |
| Publish large text or external content pointers | [Large Content](large-content.md) |
| Drive named Knowledge Asset lifecycle commands | [Knowledge Asset Lifecycle CLI](knowledge-asset-lifecycle.md) |
| Configure async publisher wallets | [Async Publisher Wallets](async-publisher-wallets.md) |
| Change async queue settings or clean up finished jobs | [Async Queue Operations](async-queue-operations.md) |
| Handle async share and publish job responses in a client | [Async Share and Publish Jobs](../build/async-jobs.md) |
| Size RPC capacity and diagnose admission waits | [RPC Request Budget](rpc-request-budget.md) |
| Import, export, and verify OKF bundles | [OKF Import, Export, and Verify](okf.md) |
| Fund testnet wallets | [Funding](funding.md) |
| Manage Publishing Conviction Accounts | [Publishing Conviction](publishing-conviction.md) |
| Configure relays and peer reachability | [Relays and Peers](relays-and-peers.md) |
| Bootstrap an edge's registry index from network relays or pinned cores | [Authority Index Snapshots](authority-index-snapshots.md) |
| Choose and configure a store backend | [Storage Backends](storage-sparql-http.md) |
| Find where a node is slow: store and queue pressure | [Monitor Store and Queue Pressure](backpressure-observability.md) |
| Manually subscribe a host-mode node | [Host-Mode Manual Subscribe](host-mode-manual-subscribe.md) |
| Update or roll back | [Updates and Rollback](updates-and-rollback.md) |
| Migrate a git checkout to npm auto-update | [Migrate to npm](migrate-to-npm.md) |
| Harden a managed Blazegraph container | [Blazegraph Survivability](blazegraph-survivability.md) |
| Diagnose common failures | [Troubleshooting](troubleshooting.md) |

## Setup entry point

Use [Quickstart](../getting-started/quickstart.md) for first-time setup. It covers Hermes, OpenClaw, MCP-aware clients, and standalone node installation without splitting the same commands across multiple pages.

The default packaged shape is:

```bash
npm install -g @origintrail-official/dkg
dkg init
dkg start
```

Framework setup commands such as `dkg mcp setup`, `dkg hermes setup`, and `dkg openclaw setup` bootstrap the node when needed, start the daemon by default, optionally fund testnet wallets, and verify the integration.
