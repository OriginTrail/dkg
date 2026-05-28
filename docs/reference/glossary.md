---
status: current
version: v10
audience: human+agent
doc_type: reference
---

# Glossary

| Term | Meaning |
| --- | --- |
| DKG V10 | Decentralized knowledge network and protocol for verifiable agent memory. |
| DKG node | Local gateway into the DKG network. Owns storage, API, auth, wallets, networking, integrations, and UI. |
| Context Graph | Scoped knowledge domain. The Node UI may call it a project. |
| Working Memory | Private local memory layer for drafts and agent-local state. |
| Shared Working Memory | Peer-visible memory layer replicated through the network. |
| Verified Memory | On-chain finalized memory layer for selected knowledge. |
| Knowledge Asset | Published graph data with provenance and integrity commitments. |
| Agent | Software actor using a node through MCP, Hermes, OpenClaw, or custom SDK/API integration. |
| Universal Messenger | Reliability substrate for DKG short peer-to-peer protocols. |
| Node Skill | Canonical agent-facing operational contract at `packages/cli/skills/dkg-node/SKILL.md`. |
