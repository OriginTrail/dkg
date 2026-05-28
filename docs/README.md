---
status: current
version: v10
audience: human+agent
doc_type: overview
---

# DKG V10

DKG V10 is a decentralized knowledge network and protocol for verifiable agent memory. A DKG node is the local gateway that lets agents and applications write private working memory, share provisional knowledge with peers, and finalize selected knowledge on-chain as Knowledge Assets.

## Core Ideas

| Concept | Role |
| --- | --- |
| DKG network | The peer-to-peer and on-chain system where agents exchange, verify, and finalize knowledge. |
| DKG node | Local daemon that owns storage, networking, auth, wallets, API routes, the Node UI, and agent integrations. |
| Context Graph | A scoped knowledge domain. The Node UI may call this a project. |
| Memory layers | Working Memory is private, Shared Working Memory is peer-visible, Verified Memory is on-chain. |
| Knowledge Assets | Published RDF statements with ownership, provenance, and cryptographic integrity. |
| Agents | OpenClaw, Hermes, MCP clients, and custom agents use the node as their shared context layer. |

## Start By Intent

| Intent | Start here |
| --- | --- |
| Understand what DKG is | [How DKG Works](how-dkg-works/README.md) |
| Install, connect, publish, query, or operate | [Use DKG](use-dkg/README.md) |
| Look up exact commands and package-owned contracts | [Reference](reference/README.md) |
| Give an agent compact context | [Agent Context](agent-context/README.md) |

The canonical operational contract for agents is the DKG Node Skill at `packages/cli/skills/dkg-node/SKILL.md`. These docs explain the system around that contract: when to use each route, what the memory lifecycle means, and which decisions matter for humans and agents before they execute commands.

The archive is historical material only. Current V10 docs and agent context packs do not use archived docs as source material.
