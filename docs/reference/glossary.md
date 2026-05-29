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
| DKG network | Peer-to-peer and on-chain system where nodes exchange, verify, and finalize graph knowledge. |
| DKG node | Local gateway into the DKG network. Owns storage, API, auth, wallets, networking, integrations, and UI. |
| Core Node | Infrastructure node that supports network storage, replication, and protocol services. |
| Edge Node | Local gateway for users, teams, apps, and agents. |
| Context Graph | Scoped knowledge domain. The Node UI may call it a project. |
| Sub-graph | Named slice inside a Context Graph, such as `chat`, `code`, `tasks`, `decisions`, `github`, or `meta`. |
| Working Memory | Private local memory layer for drafts and agent-local state. |
| Shared Working Memory | Peer-visible memory layer replicated through the network. |
| Verified Memory | On-chain finalized memory layer for selected knowledge. |
| Knowledge Asset | Published graph data with provenance and integrity commitments. |
| Knowledge Collection | Publish batch that groups one or more Knowledge Assets for on-chain finalization. |
| UAL | Universal Asset Locator. Durable identifier for a published Knowledge Asset. |
| Agent | Software actor using a node through MCP, Hermes, OpenClaw, or custom SDK/API integration. |
| Curator | Authority for a curated Context Graph. Controls membership and publish policy. |
| Integration | External workflow connected to a DKG node through a supported public interface. |
| Publisher | Human or automated actor that triggers PUBLISH, UPDATE, or VERIFY operations. |
| Staker | Participant that locks TRAC to support network infrastructure. |
| SHARE | Operation that makes selected local knowledge visible in Shared Working Memory. |
| PUBLISH | Operation that finalizes selected knowledge into Verified Memory. |
| TRAC | Utility token used for on-chain DKG operations and staking. |
| Publishing Conviction Account | Publisher commitment account represented by a V10 conviction NFT. Used for publishing allowance, agent registration, and discount paths. |
| Publisher Conviction NFT | ERC-721 receipt for a Publishing Conviction Account. |
| Staker Conviction NFT | ERC-721 receipt for a staker conviction position. |
| Context Oracle | Roadmap pattern for consuming matured verified knowledge as oracle-ready agent context. |
| x402 | Roadmap payment pattern for HTTP-based agent payments and paid knowledge access. |
| Universal Messenger | Reliability substrate for DKG short peer-to-peer protocols. |
| Node Skill | Canonical agent-facing operational contract at `packages/cli/skills/dkg-node/SKILL.md`. |
