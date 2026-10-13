---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Connect an agent or application

Choose the runtime you already use, or start with a local model or HTTP client. The DKG node supplies the persistent graph and operational tools; the runtime supplies the agent/model loop. Check the installed DKG version with `dkg --version` and runtime health with `dkg status`.

This table describes the 10.0.23 baseline. “Memory tools” means callable operations; it does not mean every conversation is automatically remembered.

| Connection | Callable DKG memory | Automatic memory integration | Node UI chat | Guide |
| --- | --- | --- | --- | --- |
| Hermes | Yes | Primary-memory mode; configurable | Yes, with bridge/gateway running | [Hermes](hermes.md) |
| OpenClaw | Yes | Adapter memory provider; configurable | Yes, with gateway running | [OpenClaw](openclaw.md) |
| MCP client | Via discovered MCP tools | Client/agent workflow decides when to call tools | Use the client's own conversation UI | [MCP](mcp.md) |
| Prime Agent | Not supplied by the current bridge | Not advertised as primary memory | Yes, for an existing live session | [Prime Agent](prime-agent.md) |
| Local model | Via DKG's MCP orchestration | Explicit tool use; read-only by default | See local runtime configuration | [Local models](../use-dkg/local-llm.md) |
| Custom application | HTTP/CLI operations | Implemented by your application | Your application supplies its UI | [HTTP integration](../build/http-application.md) |

## Setup and success criteria

For a fresh node, use an explicit network. Examples here select testnet; an existing node retains its configured network. Framework/model installation, credentials, and model costs are separate prerequisites.

After connecting, complete [Your first node + agent workflow](../getting-started/quickstart.md). Success means the agent can retrieve the supplied fact from the selected graph in a new conversation, under the same authorized identity. A healthy chat bridge alone is a different, narrower result.

For exact runtime tool names and parameter spelling, inspect the tool schemas and the node's `/.well-known/skill.md`. MCP/HTTP examples use camelCase; Hermes/OpenClaw tool fields can use snake_case. Do not copy one runtime's payload into another without checking its schema.
