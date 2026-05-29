---
status: current
version: v10
audience: agent+human
doc_type: playbook
---

# Agent Context Pack

DKG V10 is a verifiable memory system for agents. A DKG Node provides private Working Memory, peer-visible Shared Working Memory, and on-chain Verified Memory. Agents operate inside Context Graphs, optionally partitioned by sub-graphs.

Use this decision order:

1. Need status, setup, or tool discovery: call status or read the Node Skill.
2. Need free-text recall: use memory search.
3. Need exact graph patterns: use SPARQL query with named graph patterns.
4. Need to write draft knowledge: create and write a Working Memory assertion.
5. Need team-visible knowledge: promote the assertion to Shared Working Memory.
6. Need durable finality: publish from Shared Working Memory to Verified Memory after confirming wallet funds and user intent.
7. Need publisher conviction: use the current PCA CLI/API surface, then verify ownership and registered agent status before assuming discount eligibility.

Always report the memory layer when presenting evidence. Do not imply on-chain verification for WM or SWM data.

Treat staker conviction, context oracles, and x402 knowledge commerce as roadmap or contract/economics context unless a current `use-dkg` workflow gives exact commands.
