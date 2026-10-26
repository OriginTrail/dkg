---
status: current
version: v10
audience: human+agent
doc_type: architecture
---

# Node Components

A request such as “use the findings our partner shared” involves identity checks, graph queries, and access to knowledge from another participant. The DKG node coordinates those operations so agents and applications can work through a common interface.

These components connect the agent workflow to storage, peers, and publication:

<table><thead><tr><th width="141">Component</th><th>Responsibility</th></tr></thead><tbody><tr><td>API layer</td><td>Authenticated HTTP routes for context graphs, knowledge assets, query, chat, publisher jobs, and integration setup.</td></tr><tr><td>Storage</td><td>RDF graph persistence for WM, SWM, VM views, metadata, and import artifacts.</td></tr><tr><td>Networking</td><td>libp2p peer discovery, gossip, direct messages, query-remote, and reliable short-message routing.</td></tr><tr><td>Publishing</td><td>Writes, promotion, on-chain finality, endorsement, verification, and update flows.</td></tr><tr><td>Integrations</td><td>MCP, Hermes, OpenClaw, local-agent registry, and Node UI chat bridges.</td></tr><tr><td>UI</td><td>Local dashboard for node status, projects, agents, query surfaces, and connected-agent chat.</td></tr></tbody></table>

Agents normally interact through MCP or framework tools; applications can use HTTP, and operators use the CLI and Node UI. Together these components support the [node + agent workflow](node-and-agent.md), from an evidence read to a contribution others can use.
