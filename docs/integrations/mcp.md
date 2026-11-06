---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Connect an MCP client

Use DKG knowledge from the agent client you already work in. MCP exposes node tools so the agent can query relationships, inspect sources, and contribute knowledge through the normal sharing and publication lifecycle.

Use an installed MCP-aware client such as Cursor, Claude Code, Claude Desktop, Windsurf, VS Code with Copilot, Cline, or Codex CLI. DKG supplies tools over MCP stdio; the client supplies the model and conversation.

```bash
npm install -g @origintrail-official/dkg
dkg mcp setup --network testnet
```

Setup initializes a fresh node, starts it, and offers to register DKG in detected clients. Restart the chosen client. Existing nodes keep their network. Use `dkg mcp setup --dry-run` to inspect changes first.

For a manually configured client, run `dkg mcp setup --print-only` and copy the generated entry, including `env.DKG_HOME`. GUI clients do not inherit your terminal environment. Without an explicit home or workspace `.dkg/config.yaml`, the MCP server discovers the local node home using the same resolver as the other adapters; an explicit workspace or home keeps precedence.

If tools appear but return **401 Unauthorized**, check `dkg_status`'s `mcpAuth` field and the MCP client's startup log. `missing-token` means no credential was loaded; set `DKG_HOME` to your node home or set `DKG_TOKEN` in the client's environment, then restart it. `token-configured` reports only that a token was loaded, not that the daemon accepted it. An explicitly selected remote API needs its own explicit token; the server does not forward an automatically discovered local credential to another endpoint.

## Verify

1. Run `dkg status` in the terminal.
2. Inspect the client's DKG tool list. Ask it to call the discovered status and Context Graph listing tools.
3. Complete the [quickstart](../getting-started/quickstart.md), including retrieval in a new conversation.

If the client cannot find tools, confirm that setup detected the intended installation, restart it, and inspect its MCP logs. A source checkout and a globally installed CLI use different setup modes and homes; see the [package reference](https://github.com/OriginTrail/dkg/blob/main/packages/mcp-dkg/README.md).

## Remove the connection

```bash
dkg mcp uninstall --dry-run
dkg mcp uninstall
```

Removal disconnects clients; it does not delete graph data. For a single client, use the documented `--client` selector in the [CLI reference](../references/cli.md).
