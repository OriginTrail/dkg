---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Connect an MCP client

Use an installed MCP-aware client such as Cursor, Claude Code, Claude Desktop, Windsurf, VS Code with Copilot, Cline, or Codex CLI. DKG supplies tools over MCP stdio; the client supplies the model and conversation.

```bash
npm install -g @origintrail-official/dkg
dkg mcp setup --network testnet
```

Setup initializes a fresh node, starts it, and offers to register DKG in detected clients. Restart the chosen client. Existing nodes keep their network. Use `dkg mcp setup --dry-run` to inspect changes first.

## Verify

1. Run `dkg status` in the terminal.
2. Inspect the client's DKG tool list. Ask it to call the discovered status and Context Graph listing tools.
3. Complete the [quickstart](../getting-started/quickstart.md), including retrieval in a new conversation.

If the client cannot find tools, confirm that setup detected the intended installation, restart it, and inspect its MCP logs. A source checkout and a globally installed CLI use different setup modes and homes; see the [package reference](https://github.com/OriginTrail/dkg/blob/testnet-canary/packages/mcp-dkg/README.md).

## Remove the connection

```bash
dkg mcp uninstall --dry-run
dkg mcp uninstall
```

Removal disconnects clients; it does not delete graph data. For a single client, use the documented `--client` selector in the [CLI reference](../references/cli.md).
