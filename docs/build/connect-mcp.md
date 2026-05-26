---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Connect MCP

MCP is the recommended path for coding agents and MCP-aware assistants.

```bash
npm install -g @origintrail-official/dkg
dkg mcp setup
```

`dkg mcp setup` initializes the node if needed, starts it unless `--no-start` is set, optionally funds testnet wallets, detects supported clients, writes the client MCP config, and verifies daemon health.

Supported clients include Cursor, Claude Code, Claude Desktop, Windsurf, VSCode with Copilot Chat, Cline, Codex CLI, and other MCP clients that can run `dkg mcp serve`.

After setup, restart the client and verify that the DKG tool list includes:

- `dkg_assertion_create`
- `dkg_assertion_write`
- `dkg_assertion_promote`
- `dkg_memory_search`
- `dkg_query`

The package-owned reference is `packages/mcp-dkg/README.md`.

