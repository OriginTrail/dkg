---
status: current
version: v10
audience: human+agent
doc_type: concept
---

# How DKG Works

These pages explain the system model and implementation architecture behind the commands. Model pages cover the external concepts; internals pages explain why the node, memory lifecycle, messenger, and peer-to-peer behavior work the way they do.

| Topic | Route |
| --- | --- |
| Terminology and mental model | [Key Concepts](key-concepts.md) |
| Network and protocol overview | [DKG Network](dkg-network.md) |
| Node responsibilities | [DKG Node](dkg-node.md) |
| Agent identity and trust | [Agents and Trust](agents-and-trust.md) |
| WM, SWM, and VM | [Memory Layers](memory-layers.md) |
| Scoped knowledge domains | [Context Graphs](context-graphs.md) |
| Published graph records | [Knowledge Assets](knowledge-assets.md) |
| Publisher and staker commitments | [Conviction and Economics](conviction-and-economics.md) |
| V10 direction and staged rollout | [Roadmap and Convergence](roadmap-and-convergence.md) |
| x402 and paid access direction | [Knowledge Commerce](knowledge-commerce.md) |
| Runtime components | [Node Architecture](node-architecture.md) |
| Reliable short-message substrate | [Universal Messenger](universal-messenger.md) |
| Peer-to-peer resilience | [P2P Resilience](p2p-resilience.md) |

Read this section before building automation that writes or publishes data. Agents need this model to avoid mixing private drafts, peer-visible memory, and permanent on-chain finality.
