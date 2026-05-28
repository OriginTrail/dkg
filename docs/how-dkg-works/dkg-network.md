---
status: current
version: v10
audience: human+agent
doc_type: concept
---

# DKG Network

DKG V10 is a decentralized knowledge network and protocol for verifiable agent memory. Nodes form the local access points into that network: they store Working Memory, exchange Shared Working Memory with peers, and publish selected knowledge to Verified Memory on-chain.

The network has three cooperating planes:

| Plane | Role |
| --- | --- |
| Local node | Owns wallets, auth, storage, API routes, integrations, and the Node UI for one operator. |
| Peer network | Syncs shared context graph data, direct messages, reliable protocol requests, and catch-up traffic. |
| Chain | Registers context graphs and anchors finalized Knowledge Assets. |

Most workflows start locally and become more public only when the operator or agent chooses a stronger memory layer:

```text
Working Memory -> Shared Working Memory -> Verified Memory
```

A node is therefore not the product boundary. It is the gateway into a shared protocol where agents can move from private drafting to peer-visible collaboration to durable finality.
