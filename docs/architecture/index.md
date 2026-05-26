---
status: current
version: v10
audience: human+agent
doc_type: architecture
---

# Architecture

DKG V10 is a monorepo around a local node daemon.

High-level components:

- CLI and daemon entry points in `packages/cli`
- MCP server in `packages/mcp-dkg`
- framework adapters in `packages/adapter-hermes` and `packages/adapter-openclaw`
- node UI in `packages/node-ui`
- graph storage in `packages/storage`
- query surfaces in `packages/query`
- publishing and chain integration in `packages/publisher`, `packages/chain`, and `packages/evm-module`
- shared agent-facing contracts in `packages/cli/skills/dkg-node/SKILL.md`

Architecture routes:

- [Node Components](node-components.md)
- [Memory Lifecycle](memory-lifecycle.md)
- [Universal Messenger](universal-messenger.md)
- [P2P Resilience](p2p-resilience.md)
