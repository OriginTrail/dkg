---
status: current
version: v10
audience: human+agent
doc_type: reference
---

# Glossary

Use these terms when reading the guides or asking an agent to work with DKG knowledge.

| Term | Meaning |
| --- | --- |
| DKG V10 | Version 10 of the OriginTrail DKG, a neuro-symbolic AI network connecting people, organizations, and agents through shared, verifiable knowledge. |
| Neuro-symbolic AI | Combining model capabilities with explicit graph relationships, evidence, queries, and rules. The DKG connects this work across a network of contributions. |
| Graph reasoning | Deriving conclusions by applying explicit rules to connected facts. Integrated reasoning workflows are part of the development direction. |
| Graph neural network (GNN) | A model that learns from graph entities and relationships, for example to rank candidates or predict links. Integrated DKG graph-ML services are part of the development direction. |
| Provenance | Information about a record's source, authorship, and history that lets a reader trace the evidence used in a result. |
| Verifiability | The ability to check specific properties of a record, such as its attribution and content integrity, against supporting evidence. Factual correctness also requires evaluating the claim and its sources. |
| DKG network | Independently operated nodes exchanging knowledge and supporting publication with provenance and integrity commitments. |
| DKG node | A participant's connection to the network. Manages knowledge, identities, access, peer connections, and publication for agents and applications. |
| Core Node | Infrastructure node that supports network storage, replication, and protocol services. |
| Edge Node | Node connecting users, teams, applications, and agents to DKG knowledge and network services. |
| Context Graph | Knowledge and participants organized around a project, topic, or collaboration, with scoped access and publication policies. The Node UI may call it a project. |
| Sub-graph | Named slice inside a Context Graph, such as `chat`, `code`, `tasks`, `decisions`, `github`, or `meta`. |
| Working Memory | Private local memory layer for drafts and agent-local state. |
| Shared Working Memory | Selected knowledge shared with authorized participants through the Context Graph's supported policy. |
| Verifiable Memory | Network-stored knowledge with on-chain commitments binding its published versions to content that readers can check. |
| Knowledge Asset | A named unit of graph knowledge that starts as a WM draft and can be sealed, shared, and published. A first on-chain publication mints one ERC-721 token, which can describe multiple entities; updates retain the asset identity and UAL. |
| Knowledge Collection | Legacy term for the publish unit, replaced by Knowledge Asset. A new published asset can contain several related entities without a separate collection wrapper. |
| Assertion | Legacy name for a Knowledge Asset while it is still a Working Memory draft. The term survives in the `dkg assertion` CLI commands and the `dkg:Assertion` lifecycle record. |
| UAL | Universal Asset Locator. Durable identifier for a published Knowledge Asset, stable across updates; use a version or commitment as well when citing exact historical content. |
| Agent | Software actor that uses a node to investigate tasks, retrieve evidence, contribute findings, and collaborate under its credentials and permissions. |
| Curator | Authority for a curated Context Graph. Controls membership and publish policy. |
| Integration | A connection that lets an existing agent or application use and contribute DKG knowledge through supported tools or APIs. A chat bridge can have a narrower capability. |
| Publisher | Human or automated actor that triggers PUBLISH, UPDATE, or VERIFY operations. |
| Staker | Participant that locks TRAC to support network infrastructure. |
| SHARE | Operation that makes selected local knowledge visible in Shared Working Memory. |
| PUBLISH | Operation that publishes selected shared knowledge with an on-chain commitment and durable provenance record, preserving the graph's access policy. |
| TRAC | Utility token used for on-chain DKG operations and staking. |
| Publishing Conviction Account | Publisher commitment account represented by a V10 conviction NFT. Used for publishing allowance, agent registration, and discount paths. |
| Publisher Conviction NFT | ERC-721 receipt for a Publishing Conviction Account. |
| Staker Conviction NFT | ERC-721 receipt for a staker conviction position. |
| Context Oracle | Roadmap pattern for consuming matured verified knowledge as oracle-ready agent context. |
| x402 | Roadmap payment pattern for HTTP-based agent payments and paid knowledge access. |
| Universal Messenger | Reliability substrate for DKG short peer-to-peer protocols. |
| Node Skill | Canonical agent-facing operational contract at `packages/cli/skills/dkg-node/SKILL.md`. |

See [Node + agent](../how-dkg-works/node-and-agent.md) for the working model and [the roadmap](../how-dkg-works/roadmap-and-convergence.md#reasoning-and-learning-over-shared-knowledge) for integrated reasoning and GNN directions. [Feature availability](availability.md) distinguishes the reviewed release surface from proposals.
