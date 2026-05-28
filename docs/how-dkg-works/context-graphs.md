---
status: current
version: v10
audience: human+agent
doc_type: concept
---

# Context Graphs

A Context Graph is a scoped knowledge domain. It answers: "Which project, team, workspace, or topic does this knowledge belong to?"

The Node UI may call context graphs projects. The protocol term remains Context Graph.

Context Graphs can contain sub-graphs such as:

- `chat`
- `code`
- `tasks`
- `decisions`
- `github`
- `meta`

Use sub-graphs to keep one domain navigable without creating unrelated projects. For example, a codebase context graph can keep source file triples in `code`, issue state in `tasks`, and architectural decisions in `decisions`.
