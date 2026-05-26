---
status: current
version: v10
audience: human+agent
doc_type: overview
---

# Overview

DKG V10 is a local node and protocol stack for verifiable agent memory. It lets agents and applications write structured knowledge, share it with peers, and finalize selected knowledge on-chain as Knowledge Assets.

The system has five core ideas:

| Concept | Role |
| --- | --- |
| DKG Node | Local daemon that owns storage, networking, auth, wallets, API routes, the Node UI, and agent integrations. |
| Context Graph | A scoped knowledge domain. The Node UI may call this a project. |
| Memory layers | Working Memory is private, Shared Working Memory is peer-visible, Verified Memory is on-chain. |
| Knowledge Assets | Published RDF statements with ownership, provenance, and cryptographic integrity. |
| Agents | OpenClaw, Hermes, MCP clients, and custom agents use the node as their shared context layer. |

Use the docs by intent:

| Intent | Start here |
| --- | --- |
| Install or connect an agent | [Build with DKG](build/index.md) |
| Understand the model | [Understand DKG](understand/index.md) |
| Run and maintain a node | [Operate a Node](operate/index.md) |
| Look up commands and package-owned references | [Reference](reference/index.md) |
| Give an agent compact context | [For AI Agents](for-ai-agents/index.md) |

The canonical operational contract for agents is the DKG Node Skill at `packages/cli/skills/dkg-node/SKILL.md`. These docs explain the system around that contract: when to use each route, what the memory lifecycle means, and which decisions matter for humans and agents before they execute commands.

