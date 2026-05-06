# DKG V10 Hermes Adapter

`@origintrail-official/dkg-adapter-hermes` connects a local
[Hermes Agent](https://github.com/nousresearch/hermes-agent) profile to a DKG
V10 node.

The adapter is a thin bridge into the DKG node. It does not run its own DKG
node or own Hermes runtime state. The DKG daemon owns graph state, wallets,
auth, context graphs, `/.well-known/skill.md`, the local-agent registry, Node
UI chat routing, and DKG-backed chat persistence. Hermes owns its profile
directory, `config.yaml`, `.env`, session state, tools, plugins, and runtime
logs.

This package contains:

- `src/` - TypeScript setup helpers, daemon client helpers, and Hermes channel
  payload/client contracts.
- `hermes-plugin/` - Python Hermes memory provider plugin and DKG daemon
  client.
- `setup-entry.mjs` - setup-safe package entry used by the DKG CLI and daemon.

## What It Does

- installs the DKG memory provider plugin into a selected Hermes profile
- elects DKG as Hermes' external memory provider
- exposes the DKG tool surface listed in `packages/cli/skills/dkg-node/SKILL.md`
  plus Hermes-native helpers such as `dkg_memory` and `dkg_share`
- stores provider memory facts in the `memory` assertion of the `agent-context`
  context graph by default
- syncs completed Hermes turns into DKG Working Memory with stable turn IDs and
  duplicate-turn protection
- bridges the DKG Node UI right-panel chat to Hermes' OpenAI-compatible API
  server
- keeps connected-agent chat history persisted in DKG memory so Node UI reloads
  do not lose the conversation
- registers Hermes as a DKG local-agent integration for status, connect,
  refresh, and disconnect flows

## Scope Boundaries

- it does not run its own DKG node; configure and start the node with
  `dkg init` and `dkg start` before running Hermes setup
- it does not start Hermes for you; run the Hermes gateway separately
- it does not copy DKG API tokens into Hermes config files
- it does not overwrite an existing non-DKG Hermes memory provider
- it does not expose standalone HTTP route stubs from the adapter package;
  Hermes channel routes are served by the DKG CLI daemon

## Quick Start

Install the DKG CLI, create/start a DKG node, and set up the default Hermes
profile:

```bash
npm install -g @origintrail-official/dkg
dkg init
dkg start
dkg hermes setup
```

Enable Hermes' API server and start the gateway:

```bash
echo 'API_SERVER_ENABLED=true' >> ~/.hermes/.env
hermes gateway run --replace -v
```

Then open the DKG Node UI at `http://127.0.0.1:9200/ui`, choose **Agents** in
the right panel, and connect Hermes. A healthy setup lets Hermes run
`dkg_status`, search memory, write DKG memory, and use the DKG tool table from
the node skill file.

For a named Hermes profile:

```bash
dkg hermes setup --profile research
```

The named profile resolves to `~/.hermes/profiles/research`. If `HERMES_HOME`
is set, setup uses that exact profile home.

### Flags

| Flag | Default | Purpose |
| --- | --- | --- |
| `--profile <name>` | default profile | Target `~/.hermes/profiles/<name>` instead of `~/.hermes`. |
| `--daemon-url <url>` | `http://127.0.0.1:9200` | DKG daemon URL. |
| `--gateway-url <url>` | `http://127.0.0.1:8642` | Hermes OpenAI-compatible API server URL for Node UI chat. |
| `--bridge-url <url>` | unset | Custom same-host Hermes bridge URL. Loopback only; use `--gateway-url` for WSL2 or remote transports. |
| `--bridge-health-url <url>` | derived from transport | Optional health URL override. It must belong to the configured bridge/gateway base. |
| `--port <port>` | `9200` | Shortcut for `--daemon-url http://127.0.0.1:<port>`. |
| `--no-start` | off | Configure files without best-effort local-agent registration against the daemon. It does not start or stop the daemon in this release. |
| `--no-verify` | off | Skip the post-setup verification pass. |
| `--dry-run` | off | Preview planned file changes without writing anything. |

## Verification

A healthy setup should satisfy all of the following:

- `dkg hermes verify` reports the selected profile as configured
- Hermes gateway logs show `Memory provider 'dkg' registered`
- `dkg_status` works from Hermes
- the DKG Node UI loads at `http://127.0.0.1:9200/ui`
- the right-side chat surface can connect to Hermes and send a message
- the conversation survives Node UI reload because turns are persisted in DKG
  memory
- `dkg_memory` writes can be read from the `memory` assertion in
  `agent-context`

## Config Files

| File | Owner | Purpose |
| --- | --- | --- |
| `~/.dkg/config.json` | DKG node | node config: networking, chain, auth, API |
| `$HERMES_HOME/config.yaml` | Hermes | active Hermes provider selection; setup writes only an ownership-marked DKG memory provider block |
| `$HERMES_HOME/dkg.json` | DKG adapter | daemon URL, resolved DKG home, memory assertion, tool guards, and transport config |
| `$HERMES_HOME/plugins/dkg/` | DKG adapter | installed Hermes memory provider plugin |
| `$HERMES_HOME/skills/dkg-node/SKILL.md` | DKG adapter | Hermes profile copy of the node skill file |
| `$HERMES_HOME/.dkg-adapter-hermes/` | DKG adapter | setup state and ownership metadata |

## Adapter Config

These keys live in `$HERMES_HOME/dkg.json`. `dkg hermes setup` writes the file
with ownership metadata and leaves a non-managed file untouched.

| Key | Default | Purpose |
| --- | --- | --- |
| `daemon_url` | `http://127.0.0.1:9200` | DKG daemon HTTP URL. Env `DKG_DAEMON_URL` overrides at runtime. |
| `dkg_home` | resolved from the target daemon | DKG config home used to read `auth.token`; supports monorepo `.dkg-dev` and packaged `.dkg` installs. |
| `bridge.gatewayUrl` | `http://127.0.0.1:8642` | Hermes OpenAI-compatible API server base used by Node UI chat. |
| `bridge.url` | unset | Optional custom loopback `/health`, `/send`, `/stream` bridge. |
| `bridge.healthUrl` | derived | Optional health check URL tied to the configured transport base. |
| `context_graph` | `agent-context` | Default context graph for provider memory facts. Env `DKG_CONTEXT_GRAPH` overrides at runtime. |
| `memory_assertion` | `memory` | Working Memory assertion used by `dkg_memory`. Env `DKG_MEMORY_ASSERTION` overrides at runtime. |
| `memory_mode` | `provider` | Stored setup mode for status/reconnect/uninstall. |
| `publish_tool` / `allow_direct_publish` | direct / `true` | Controls exposure of direct publish tools. Env `DKG_ALLOW_DIRECT_PUBLISH=false` hides them. |
| `allow_context_graph_admin_tools` | `true` | Controls mutating project-admin tools. Env `DKG_ALLOW_CONTEXT_GRAPH_ADMIN_TOOLS=false` hides them. |
| `import_roots` | `[]` | Optional safe roots for `dkg_assertion_import_file`; env import-root settings also apply. |

Environment token override order is `DKG_API_TOKEN`, `DKG_AUTH_TOKEN`, the
setup-resolved `dkg_home`, `DKG_HOME`, then `~/.dkg`.

## Hermes Memory Provider

Hermes uses DKG as its memory provider. Setup installs and selects DKG by
writing a managed `memory.provider: dkg` block. If the target profile already
has another provider configured, this release stops before changing it so setup
never silently replaces an existing memory backend. To switch that profile to
DKG, remove or change the existing `memory.provider` entry in `config.yaml`,
then rerun `dkg hermes setup`. For a clean start, use a fresh Hermes profile.

Once DKG is the active provider, Hermes receives DKG-backed memory recall,
`dkg_memory`, `memory_search`, `dkg_query`, `dkg_share`,
assertion/sub-graph helpers, and status/wallet/network helpers.

## Node UI Connect, Refresh, And Disconnect

The Node UI **Connect Hermes** button registers Hermes in the local-agent
registry and probes the configured Hermes API server/bridge. If Hermes is
online, the panel becomes chat-ready. If Hermes is offline, the panel records a
degraded state and tells the user to run `dkg hermes setup` or refresh after
Hermes starts.

**Refresh** re-probes Hermes health and updates ready/degraded state. It does
not reinstall the adapter.

**Disconnect** runs Hermes reverse setup for the stored profile metadata, then
disables the local-agent integration. It removes only adapter-owned provider
election/artifacts and preserves Hermes sessions, logs, `.env`, and unrelated
profile data.

## Local-Agent Routes

Hermes uses Hermes-specific daemon routes for this release. These routes are
supported by the DKG CLI daemon; this adapter package provides the setup,
client, and payload contracts that call into them.

| Route | Purpose |
| --- | --- |
| `GET /api/hermes-channel/health` | Probe configured Hermes bridge/gateway health and update local-agent readiness. |
| `POST /api/hermes-channel/send` | Forward a non-streaming Node UI message to Hermes. |
| `POST /api/hermes-channel/stream` | Forward a streaming Node UI message and proxy SSE frames back to the UI. |
| `POST /api/hermes-channel/persist-turn` | Persist a completed Hermes turn through DKG chat memory with duplicate-turn protection. |

The daemon forwards Node UI chat to Hermes' OpenAI-compatible API server at
`http://127.0.0.1:8642` by default. Set `API_SERVER_ENABLED=true` in the active
Hermes profile `.env`, then restart `hermes gateway run --replace -v`. Use
`dkg hermes setup --gateway-url <url>` when the Hermes API server is reachable
through WSL2 or a remote gateway. `--bridge-url` is reserved for a custom
loopback bridge that implements `/health`, `/send`, and `/stream`.

Attachment references are node-owned assertion refs. The daemon verifies their
provenance before forwarding them to Hermes.

## Auth And Security

- Non-public DKG daemon routes use the existing bearer token auth.
- The Python client reads the DKG token from token environment variables first,
  then the setup-resolved `dkg_home` written to `$HERMES_HOME/dkg.json`, then
  `DKG_HOME`/`~/.dkg`; it does not copy the token into Hermes config.
- Setup registration uses the same bearer source.
- Standalone loopback Hermes bridge calls use a route-scoped
  `x-dkg-bridge-token` header. Non-loopback `bridgeUrl` values are rejected;
  use `gatewayUrl` for remote transports. Gateway targets do not receive that
  bridge token.
- Hermes `send` and `stream` routes fail closed when the Hermes integration is
  not enabled in the DKG local-agent registry. `persist-turn` remains
  daemon-authenticated so the active Hermes provider can persist completed
  turns even when UI chat registration is unavailable.
- Direct publish tools are model-callable by default to match the node skill
  surface. Publishing Verified Memory is permanent and may cost TRAC; operators
  can hide direct publish exposure with `DKG_ALLOW_DIRECT_PUBLISH=false`.
- Context-graph admin mutation tools are enabled by default for collaboration;
  operators can hide them with `DKG_ALLOW_CONTEXT_GRAPH_ADMIN_TOOLS=false`.
- `dkg_assertion_import_file` requires an operator-approved import root. Use
  `DKG_HERMES_IMPORT_ROOTS`, `HERMES_DKG_IMPORT_ROOTS`, `DKG_IMPORT_ROOTS`, or
  adapter `import_roots` to approve document locations explicitly.

## Troubleshooting

### Provider conflict

If setup reports an existing `memory.provider`, the target profile is already
using another memory backend. To switch it to DKG in this release, remove or
change that provider entry in the profile `config.yaml`, then rerun
`dkg hermes setup`. For a clean start, use a fresh Hermes profile.

### Hermes chat offline

If Node UI says Hermes is degraded or offline:

1. Confirm Hermes is running for the same profile.
2. Confirm `API_SERVER_ENABLED=true` is present in the active
   `$HERMES_HOME/.env`.
3. Confirm `http://127.0.0.1:8642/health` responds, or configure the DKG
   local-agent integration with the correct gateway URL.
4. Run `dkg hermes doctor --profile <name>`.
5. Refresh the Hermes connected-agent panel in the Node UI.

### Windows and WSL2

Hermes does not support native Windows. Run Hermes inside WSL2. If the DKG
daemon runs on Windows, use a daemon URL reachable from WSL:

```bash
dkg hermes setup --profile research --daemon-url http://<windows-host-ip>:9200
```

### Uninstall and reconnect

`disconnect` is reversible:

```bash
dkg hermes disconnect --profile research
dkg hermes reconnect --profile research
```

Use `uninstall` when you want to remove adapter-owned files:

```bash
dkg hermes uninstall --profile research
```

## Development

```bash
pnpm --filter @origintrail-official/dkg-adapter-hermes run build
pnpm --filter @origintrail-official/dkg-adapter-hermes test
python -m py_compile packages/adapter-hermes/hermes-plugin/__init__.py packages/adapter-hermes/hermes-plugin/client.py
```

## More Setup Detail

See [Hermes setup](../../docs/setup/SETUP_HERMES.md).

## License

Apache-2.0
