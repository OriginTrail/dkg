---
status: current
version: v10
audience: human+agent
doc_type: architecture
---

# Node Components

The DKG Node daemon coordinates these responsibilities:

| Component | Responsibility |
| --- | --- |
| API layer | Authenticated HTTP routes for context graphs, assertions, query, chat, publisher jobs, and integration setup. |
| Storage | RDF graph persistence for WM, SWM, VM views, metadata, and import artifacts. |
| Networking | libp2p peer discovery, gossip, direct messages, query-remote, and reliable short-message routing. |
| Publishing | Writes, promotion, on-chain finality, endorsement, verification, and update flows. |
| Integrations | MCP, Hermes, OpenClaw, local-agent registry, and Node UI chat bridges. |
| UI | Local dashboard for node status, projects, agents, query surfaces, and connected-agent chat. |

Agents normally interact through MCP tools or framework tools. Operators normally use the CLI and Node UI.
