---
status: current
version: v10
audience: human+agent
doc_type: concept
---

# DKG Node

The DKG Node is the local authority for one operator's participation in the network.

The DKG Node owns:

* daemon lifecycle and HTTP API
* local graph storage
* auth tokens and agent identity mapping
* operational wallets
* libp2p networking and relay connections
* Context Graph membership and subscriptions
* the Node UI
* framework integrations such as MCP, Hermes, and OpenClaw
* the served DKG Node Skill at `/.well-known/skill.md`

## Core and Edge Roles

A node can run as an Edge Node or a Core Node. Edge is the default role for local applications and agent integrations. Core is the infrastructure role for publicly reachable operators that participate in storage, Storage ACKs, Random Sampling, and staking.

Core Nodes have an on-chain node profile identified by `identityId`. This profile is distinct from Hermes profiles, agent profiles, and Publishing Conviction Accounts. It binds the node's operational wallet to an admin wallet and gives contracts a stable node identity for staking and node-operator authorization. Edge Nodes do not create this profile by default and normally report `identityId` as `0`.

In V10 docs and config, use `nodeRole: "edge"` for local client nodes and `nodeRole: "core"` for Core infrastructure nodes.

Agents should treat the node as the system boundary. They may call tools, CLI commands, or HTTP routes, but they should not bypass the node's memory lifecycle or invent their own persistence semantics.
