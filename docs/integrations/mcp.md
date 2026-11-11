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

On Windows, Claude Desktop may keep its config in `%APPDATA%\Claude` or `%LOCALAPPDATA%\Claude-Data\claude_<id>`. Setup detects both, choosing the most recently modified existing config when multiple profiles remain. Uninstall checks all supported profiles for older DKG registrations. Check the displayed destination with `--dry-run`; the existing app preferences and other MCP entries are preserved. If detection misses your installation, open **Settings → Developer → Edit Config** in Claude Desktop and paste the entry from `dkg mcp setup --print-only`, then fully quit and restart the client.

## Verify

1. Run `dkg status` in the terminal.
2. Inspect the client's DKG tool list. Ask it to call the discovered status and Context Graph listing tools.
3. Complete the [quickstart](../getting-started/quickstart.md), including retrieval in a new conversation.

The Context Graph listing defaults to `scope: "mine"`, matching **My Context Graphs** in the Node UI: explicit caller membership, or a matching curator identity for older list responses. Discovery and subscription alone do not establish membership. Use `scope: "all"` to inspect every known graph, including discovered and system graphs; unresolved names are labelled rather than repeated as names. Query-catalog discovery uses the same membership rule.

If the client cannot find tools, confirm that setup detected the intended installation, restart it, and inspect its MCP logs. A source checkout and a globally installed CLI use different setup modes and homes; see the [package reference](https://github.com/OriginTrail/dkg/blob/main/packages/mcp-dkg/README.md).

## Configure a client manually

If setup does not find your client, print the entry for the Node installation, CLI, and DKG home you intend to use:

```bash
dkg mcp setup --print-only
```

This prints configuration without initializing a node or editing client files. Initialize and start your node with the [quickstart](../getting-started/quickstart.md) first if you have not already done so. Merge the printed `dkg` entry into the client's existing server map; keep its other entries.

The canonical JSON shape is:

```json
{
  "mcpServers": {
    "dkg": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/node_modules/@origintrail-official/dkg/dist/cli.js",
        "mcp",
        "serve"
      ],
      "env": {
        "DKG_HOME": "/absolute/path/to/your/.dkg"
      }
    }
  }
}
```

Use the absolute paths printed on your machine. GUI clients may not inherit the terminal's `PATH`, so an entry that only runs `dkg` or `node` can fail even when the terminal command works. Retain the generated `env.DKG_HOME`: it makes the server use the same node configuration and credentials as setup, including a custom home or the source-checkout `~/.dkg-dev` home. It is not universally required for every launch, but an explicit matching home avoids relying on a GUI client's working directory or version-dependent discovery defaults.

For a native Windows installation, the equivalent entry might look like this. Replace `your-user` and the installation paths with the output from your own `--print-only` command; JSON requires doubled backslashes.

```json
{
  "mcpServers": {
    "dkg": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\Users\\your-user\\AppData\\Roaming\\npm\\node_modules\\@origintrail-official\\dkg\\dist\\cli.js",
        "mcp",
        "serve"
      ],
      "env": {
        "DKG_HOME": "C:\\Users\\your-user\\.dkg"
      }
    }
  }
}
```

These are native-process examples. For a node running inside WSL, run setup inside the intended distribution so Windows clients receive its `wsl.exe` launch wrapper. `--print-only` prints the native entry, not that wrapper; see the [WSL guidance](https://github.com/OriginTrail/dkg/blob/main/packages/mcp-dkg/README.md#troubleshooting).

### Find the client's configuration

In Claude Desktop, use **Settings → Developer → Edit Config** to open the file used by that installation instead of guessing its location. See the [local MCP setup guide](https://modelcontextprotocol.io/docs/develop/connect-local-servers). In VS Code, **MCP: Open User Configuration** opens the current profile's file; the [VS Code configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) also covers workspace configuration.

The following are the standard locations supported by DKG setup. Here, `~` means your user home (`%USERPROFILE%` on Windows). `<app-config>` means `~/Library/Application Support` on macOS, `%APPDATA%` on Windows, or `$XDG_CONFIG_HOME` on Linux, falling back to `~/.config` when unset.

| Client | Standard configuration file | Server map |
| --- | --- | --- |
| Cursor | `~/.cursor/mcp.json` | `mcpServers.dkg` |
| Claude Code | `~/.claude.json` | `mcpServers.dkg` |
| Claude Desktop | `<app-config>/Claude/claude_desktop_config.json` | `mcpServers.dkg` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers.dkg` |
| VS Code + Copilot | `<app-config>/Code/User/mcp.json`; profiles and workspace `.vscode/mcp.json` can differ | `servers.dkg` |
| Cline | `<app-config>/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` | `mcpServers.dkg` |
| Codex CLI | `~/.codex/config.toml` | `mcp_servers.dkg` (TOML) |

For VS Code, use `servers` instead of `mcpServers`, preserving the inner `dkg` block. For Codex CLI, translate that block into TOML under `[mcp_servers.dkg]`, with its environment under `[mcp_servers.dkg.env]`; do not paste JSON into the TOML file. Custom profiles, portable installs, and relocated folders can use other paths. Some Windows Claude Desktop installations use `%LOCALAPPDATA%\Claude-Data\claude_<id>\claude_desktop_config.json`; the in-app **Edit Config** action is the reliable way to select the active file.

## Connection settings and precedence

Put environment settings in the MCP client's server entry when the client starts the server; exporting them in a terminal may not affect a GUI client. The server reads these at startup, so restart the client after changing them.

| Variable | Purpose and default |
| --- | --- |
| `DKG_HOME` | Explicit node state directory. Prefer the absolute home printed by setup. With it set, `config.json` takes precedence over `config.yaml` in that home; workspace and node-home discovery are skipped. |
| `DKG_API` | Daemon base URL. The selected node home supplies its daemon endpoint; keep it aligned with the running node's API port. Without an explicit home or workspace YAML, the discovered local node home supplies it; only when no home or YAML endpoint is found is the fallback `http://localhost:9200`. |
| `DKG_TOKEN` | Bearer token override or fallback, depending on the configuration source below. A daemon home, including a discovered one, normally supplies its `auth.token`; there is no built-in token. When `DKG_API` selects an endpoint other than the discovered home's, set `DKG_TOKEN` for it. |
| `DKG_PROJECT` | Default Context Graph ID for tools that use a default. Configuration files may supply one; otherwise there is no default. The historical variable name does not refer to a separate UI object. |
| `DKG_AGENT_URI` | Operator agent URI for attribution. YAML may supply `agent.uri`; otherwise there is no default agent URI. |
| `DKG_API_READ_TIMEOUT_MS` | GET request deadline in milliseconds, default `30000`. Context Graph, sub-graph, PCA, and publisher-job lists use at least `60000`. |
| `DKG_API_LONG_TIMEOUT_MS` | Deadline for non-GET requests, default `240000`, never lower than the read deadline. |

The server uses one configuration source: `DKG_HOME` when it is set; otherwise the nearest workspace `.dkg/config.yaml`; otherwise the local node home. That home is `~/.dkg` or the source-checkout home `~/.dkg-dev`, chosen by the same resolver as the other DKG adapters: the home whose node is running, then the one whose recorded API port matches `DKG_API`, then the one whose node started most recently. An explicit home or workspace configuration therefore always takes precedence over the discovered home.

Configuration precedence depends on the file format:

- **Daemon home (`config.json`)**: non-empty `DKG_API`, `DKG_TOKEN`, `DKG_PROJECT`, and `DKG_AGENT_URI` take precedence. Otherwise the node home supplies the daemon endpoint, the first non-comment token in `auth.token`, and the first configured Context Graph, where present. A discovered home uses the running node's recorded API port before its saved `apiPort`, and its token and Context Graph default apply only to that local endpoint: when `DKG_API` selects another endpoint, set `DKG_TOKEN` and `DKG_PROJECT` for it. With an explicit `DKG_HOME`, the saved port is used; if the running node's port differs from it, verify the selected endpoint or set `DKG_API` explicitly.
- **Workspace-shaped YAML (`config.yaml`)**: `node.api`, `contextGraph` (or legacy `project`), and `agent.uri` take precedence over environment defaults. Token order is `node.token`, then `node.tokenFile`, then the environment. A relative `tokenFile` is resolved from the YAML file's directory; `~/` is expanded. Without an explicit home, the server searches upward from its working directory for `.dkg/config.yaml`. `dkg-mcp join` writes this file. It authenticates with `--token` or `DKG_TOKEN` first, then an explicit `--token-file`, then an existing workspace or `DKG_HOME` binding, and only then automatically discovered credentials. When that token was read from a file, `node.tokenFile` records that file. Otherwise, as after `--token`, `DKG_TOKEN` or a literal `node.token`, it records the `--token-file` value or its default `~/.dkg/auth.token`, because a literal token is never written to the file; check that this file holds the token the client should use.
- **Tool arguments**: an explicit Context Graph argument takes precedence over the default for that tool. It does not override the server's API URL or credentials.

Legacy aliases are also accepted: `DKG_API` precedes `DEVNET_API`; token environment order is `DKG_TOKEN`, `DEVNET_TOKEN`, then `DKG_AUTH`. Timeout values must be positive whole milliseconds; explicit client-library timeout options precede environment settings, then the defaults above. See [client request timeouts](../references/cli.md#client-request-timeouts).

## Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| Setup does not list an installed client | Its active config is outside the detected locations, or has not been created yet. | Open the client's config, run `dkg mcp setup --print-only`, and merge the entry using the client's server-map format above. |
| Tools appear and status works, but authenticated tools return `401 Unauthorized` | The server is using an empty or stale token, a different DKG home, or a different daemon URL. | Read the `mcpAuth` field of `dkg_status`. `missing-token` means no credential was loaded: set `env.DKG_HOME` to the running node's home or set `DKG_TOKEN`, then restart the client. `token-configured` means a token was loaded, not that the daemon accepted it: check `DKG_API` and token overrides against the precedence above, and verify that home's `auth.token`. When `DKG_API` selects an endpoint other than the discovered home's, set its own `DKG_TOKEN`; the discovered token is never sent there. MCP startup logs show the selected API/config path and `token=[set]` or `token=[empty]` without revealing the token. |
| Tools do not appear after an edit | The client retained its old server process, the JSON/TOML is invalid, or a saved executable path is stale. | Fully quit from the system tray or menu bar, then reopen. Check MCP logs and the absolute paths; regenerate the entry after changing the Node or DKG installation. |
| Tools time out or cannot reach the node | The node is stopped, the API URL is wrong, or a request exceeded its deadline. | Run `dkg status` using the same home. Check the API setting and node logs before adjusting the timeout variables. |
| Instructions say “project,” but there is no Projects screen | Older configuration and tool names use “project” for a Context Graph. | Open **Context Graphs** / **My Context Graphs** in the node UI. `DKG_PROJECT` and legacy `projectId` arguments contain a Context Graph ID. |

## Remove the connection

```bash
dkg mcp uninstall --dry-run
dkg mcp uninstall
```

Removal disconnects clients; it does not delete graph data. For a single client, use the documented `--client` selector in the [CLI reference](../references/cli.md).
