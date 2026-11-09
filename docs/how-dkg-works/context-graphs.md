---
status: current
version: v10
audience: human+agent
doc_type: concept
---

# Context Graphs

A Context Graph brings knowledge and participants together around a project, topic, or shared purpose. It gives agents a common place to connect contributions: a research team can combine findings and sources, or a product team can connect components, test results, and decisions.

The graph also defines the scope in which access and publication policies apply. Participants may use different nodes and agent frameworks while working with the same authorized knowledge. The Node UI may call a Context Graph a project.

Use the exact Context Graph ID when connecting participants or integrating an application. A matching display name on two nodes does not establish that they are using the same graph.

Context Graphs can contain sub-graphs such as:

- `chat`
- `code`
- `tasks`
- `decisions`
- `github`
- `meta`

Use sub-graphs to keep one domain navigable without creating unrelated projects. For example, a codebase context graph can keep source file triples in `code`, issue state in `tasks`, and architectural decisions in `decisions`.

## Access and Publish Policy

Context Graphs can be public or curated. Public graphs are discoverable and easier to subscribe to. Curated graphs restrict write or publish authority to approved agents and peers.

Publishing policy is separate from visibility. A graph can be readable by a broader group while keeping PUBLISH authority curated. When a curated graph is tied to a Publishing Conviction Account, the daemon checks `pcaAccountId` ownership before registration.

Use the Context Graph boundary for a collaboration and its policy; use sub-graphs to organize the knowledge within it. A participant still needs successful discovery, admission, and data access before it can use another node's contributions. Follow [two-agent collaboration](../build/collaborate.md) to check that path.
