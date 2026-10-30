---
status: current
version: v10
audience: human+agent
doc_type: reference
---

# Node Skill

The canonical agent operational contract is:

```text
packages/cli/skills/dkg-node/SKILL.md
```

The daemon also serves the skill at:

```text
GET /.well-known/skill.md
```

Use the running node's skill for its operational context and HTTP contract; discover the runtime's tool schemas for exact names and parameter spelling. The skill is a maintained template rendered with node state, not a generated API schema. Use the docs corpus for system context, concepts, navigation, and task-level explanation.

Begin with [agent procedures](../agent-context/context-pack.md) for setup, ingestion, querying, collaboration, and explicit publication completion checks.
