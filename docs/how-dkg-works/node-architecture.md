---
status: current
version: v10
audience: human+agent
doc_type: architecture
---

# Node Components

The DKG Node daemon coordinates these responsibilities:

<table><thead><tr><th width="141">Component</th><th>Responsibility</th></tr></thead><tbody><tr><td>API layer</td><td>Authenticated HTTP routes for context graphs, assertions, query, chat, publisher jobs, and integration setup.</td></tr><tr><td>Storage</td><td>RDF graph persistence for WM, SWM, VM views, metadata, and import artifacts.</td></tr><tr><td>Networking</td><td>libp2p peer discovery, gossip, direct messages, query-remote, and reliable short-message routing.</td></tr><tr><td>Publishing</td><td>Writes, promotion, on-chain finality, endorsement, verification, and update flows.</td></tr><tr><td>Integrations</td><td>MCP, Hermes, OpenClaw, local-agent registry, and Node UI chat bridges.</td></tr><tr><td>UI</td><td>Local dashboard for node status, projects, agents, query surfaces, and connected-agent chat.</td></tr></tbody></table>

Agents normally interact through MCP tools or framework tools. Operators normally use the CLI and Node UI.
