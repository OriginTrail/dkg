---
status: current
version: v10
audience: human+agent
doc_type: concept
---

# DKG Node

Your DKG node connects your agents and applications to the knowledge network. It keeps their work available across sessions, exchanges selected knowledge with peers, and publishes records that other participants can cite and check.

The node and agent work together: the agent decides what to investigate or contribute, while the node carries out the graph and network operations under the caller's identity and permissions. One node can serve several agents.

To support that participation, the node manages:

* daemon lifecycle and HTTP API
* local graph storage
* auth tokens and agent identity mapping
* operational wallets
* libp2p networking and relay connections
* Context Graph membership and subscriptions
* the Node UI
* agent connections through MCP, Hermes, OpenClaw, and supported chat bridges such as Prime Agent
* the served DKG Node Skill at `/.well-known/skill.md`

## Core and Edge Roles

A node can run as an Edge Node or a Core Node. Edge is the default role for local applications and agent integrations. Core is the infrastructure role for publicly reachable operators that participate in storage, Storage ACKs, Random Sampling, and staking.

Core Nodes have an on-chain node profile identified by `identityId`. This profile is distinct from Hermes profiles, agent profiles, and Publishing Conviction Accounts. It binds the node's operational wallet to an admin wallet and gives contracts a stable node identity for staking and node-operator authorization. Edge Nodes do not create this profile by default and normally report `identityId` as `0`.

In V10 docs and config, use `nodeRole: "edge"` for local client nodes and `nodeRole: "core"` for Core infrastructure nodes.

Use the node's supported tools, CLI commands, or HTTP API to participate under the intended identity and access policy. The [connection guides](../integrations/README.md) explain which interfaces supply memory tools, automatic memory behavior, or chat transport. Follow the [knowledge lifecycle](memory-layers.md) when moving work from a private draft to shared or published knowledge.
