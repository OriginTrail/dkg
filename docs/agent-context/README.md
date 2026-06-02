---
status: current
version: v10
audience: agent+human
doc_type: overview
---

# Agent Context

Agents should load context in this order:

1. [DKG V10](../README.md)
2. [Context Pack](context-pack.md)
3. [Invariants](invariants.md)
4. [Quickstart](../getting-started/quickstart.md) for install and agent-connection setup, or the task pack that matches the user's intent
5. `packages/cli/skills/dkg-node/SKILL.md` for exact operations

Task packs:

- [Publish and Query](task-packs/publish-query.md)
- [Operate and Troubleshoot](task-packs/operate-troubleshoot.md)

Generated projections:

- `llms.txt`
- `llms-full.txt`

These projections are curated from the current V10 corpus only. Do not use archive docs as source context.
