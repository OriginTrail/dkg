---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Connect an Agent

MCP is the recommended path for coding agents and MCP-aware assistants. Hermes and OpenClaw use their own setup commands but share the same local DKG daemon model.

## MCP

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

## Hermes

Hermes connects to DKG as an external memory provider and tool surface.

```bash
npm install -g @origintrail-official/dkg
dkg hermes setup
```

Then enable the Hermes API server and start the gateway:

```bash
echo 'API_SERVER_ENABLED=true' >> ~/.hermes/.env
hermes gateway run --replace -v
```

For a named profile:

```bash
dkg hermes setup --profile research
```

Important flags:

| Flag | Purpose |
| --- | --- |
| `--profile <name>` | Target a named Hermes profile. |
| `--memory-mode tools-only` | Expose tools without electing DKG as the memory provider. |
| `--preserve-provider` | Keep an existing non-DKG provider. |
| `--no-start` | Configure without starting the daemon. |
| `--no-fund` | Skip testnet faucet funding. |

The package-owned reference is `packages/adapter-hermes/README.md`.

## OpenClaw

OpenClaw connects to a local DKG daemon through the DKG adapter.

```bash
npm install -g @origintrail-official/dkg
dkg openclaw setup
```

The setup flow is idempotent. It writes DKG node config, merges the adapter into OpenClaw config, starts the daemon unless disabled, and verifies the node.

If the gateway does not auto-reload after setup:

```bash
openclaw gateway restart
```

Healthy setup checklist:

- `dkg_status` works from the OpenClaw agent.
- The Node UI loads at `http://127.0.0.1:9200/ui`.
- The right-panel chat can connect to OpenClaw.
- Chat history survives a UI reload because DKG persists the turns.

The package-owned reference is `packages/adapter-openclaw/README.md`.
