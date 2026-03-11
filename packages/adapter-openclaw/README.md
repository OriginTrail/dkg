# DKG V9 OpenClaw Adapter

`@dkg/adapter-openclaw` connects an existing OpenClaw agent to DKG V9.

The main goal is to give the agent verifiable memory through DKG V9.

In practice, the DKG V9 provides Open Claw agents with:

- a local OpenClaw chat surface in DKG V9 Agent Hub through the OpenClaw bridge
- DKG-backed memory recall/import plus file-watcher sync for `MEMORY.md` and `memory/*.md`
- a broader DKG tool surface inside OpenClaw, including `dkg_status`, `dkg_publish`, and `dkg_query` tools for interaction with the DKG

If you want the end result to be:

`Setup complete, DKG V9 UI accessible at http://127.0.0.1:9200/ui`

then you need both the OpenClaw plugin and the DKG daemon running on the same machine.

## What Is Running Where

The current integration uses two config roots and two runtimes:

| Surface | File | Purpose |
| --- | --- | --- |
| OpenClaw gateway | `~/.openclaw/openclaw.json` | Loads the adapter plugin by path and enables it by plugin ID |
| OpenClaw workspace | `WORKSPACE_DIR/config.json` under `"dkg-node"` | Configures the adapter's embedded DKG node plus the recommended `memory` and `channel` integrations |
| OpenClaw secrets | `~/.openclaw/.env` | Optional `DKG_EVM_PRIVATE_KEY` for the adapter's embedded node |
| DKG daemon | `~/.dkg/config.json` | Configures the daemon, Node UI, auth, and local OpenClaw bridge routing |
| DKG daemon auth | `~/.dkg/auth.token` | Auto-generated bearer token used by the adapter's daemon client and bridge |

Important: the OpenClaw adapter and the DKG daemon are separate processes today.

- The adapter's classic DKG tools run against the embedded node configured in `WORKSPACE_DIR/config.json`.
- The Node UI, OpenClaw local bridge, and `agent-memory` graph run through the daemon configured in `~/.dkg/config.json`.
- For most OpenClaw users, the second path is the main value: durable, verifiable memory capture and retrieval through Agent Hub plus `dkg_memory_*` tools.

## Recommended Setup

This is the recommended path if you want an agent to take a repo URL and perform the install end to end.

### 1. Clone and build this repo

```bash
git clone https://github.com/OriginTrail/dkg-v9.git
cd dkg-v9
pnpm install
pnpm build
```

Use a stable checkout path because OpenClaw will load the adapter directly from this repo path.

### 2. Configure and start the DKG daemon

Create or update `~/.dkg/config.json` with at least:

```json
{
  "name": "dkg-openclaw-daemon",
  "apiPort": 9200,
  "nodeRole": "edge",
  "relay": "/ip4/167.71.33.105/tcp/9090/p2p/12D3KooWEpSGSVRZx3DqBijai85PLitzWjMzyFVMP4qeqSBUinxj",
  "chain": {
    "type": "evm",
    "rpcUrl": "https://sepolia.base.org",
    "hubAddress": "0xC056e67Da4F51377Ad1B01f50F655fFdcCD809F6",
    "chainId": "base:84532"
  },
  "auth": {
    "enabled": true
  }
}
```

Then start the daemon from the repo root:

```bash
pnpm dkg start
```

Or run it in the foreground while validating setup:

```bash
pnpm dkg start -f
```

What this gives you:

- local API at `http://127.0.0.1:9200`
- Node UI at `http://127.0.0.1:9200/ui` by default
- an auth token in `~/.dkg/auth.token`
- the OpenClaw bridge endpoints under `/api/openclaw-channel/*`

### 3. Enable the adapter in OpenClaw

Edit `~/.openclaw/openclaw.json` and merge in the adapter path plus plugin entry.

Example:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "~/dkg-v9/packages/adapter-openclaw"
      ]
    },
    "entries": {
      "adapter-openclaw": {
        "enabled": true
      }
    }
  }
}
```

Rules:

- The plugin entry key must be `adapter-openclaw`.
- Do not put DKG runtime config in `plugins.entries`.
- Keep your existing plugin entries; merge this in instead of replacing the whole `plugins` block.

If your environment already installs the packaged adapter under `WORKSPACE_DIR/node_modules/@dkg/adapter-openclaw`, you can point `plugins.load.paths` there instead.

### 4. Configure the adapter in the OpenClaw workspace

Find the OpenClaw workspace directory from `agents.defaults.workspace` in `~/.openclaw/openclaw.json`.

Create or update `WORKSPACE_DIR/config.json` and add a `"dkg-node"` block:

```json
{
  "dkg-node": {
    "name": "my-openclaw-agent",
    "description": "OpenClaw agent with DKG V9",
    "dataDir": ".dkg/openclaw",
    "relayPeers": [
      "/ip4/167.71.33.105/tcp/9090/p2p/12D3KooWEpSGSVRZx3DqBijai85PLitzWjMzyFVMP4qeqSBUinxj"
    ],
    "daemonUrl": "http://127.0.0.1:9200",
    "memory": {
      "enabled": true
    },
    "channel": {
      "enabled": true
    },
    "chainConfig": {
      "rpcUrl": "https://sepolia.base.org",
      "hubAddress": "0xC056e67Da4F51377Ad1B01f50F655fFdcCD809F6"
    }
  }
}
```

Notes:

- `daemonUrl` defaults to `http://127.0.0.1:9200`, but it is better to set it explicitly.
- `memory.enabled: true` enables `dkg_memory_search`, `dkg_memory_import`, first-run backlog import, and file watching for:
  - `WORKSPACE_DIR/MEMORY.md`
  - `WORKSPACE_DIR/memory/**/*.md`
- `channel.enabled: true` enables the local DKG UI <-> OpenClaw bridge used by Agent Hub.
- For the intended OpenClaw UX, treat `memory.enabled` and `channel.enabled` as required, even though they are technically config flags.
- `chainConfig` is optional for read/query/messaging workflows, but recommended if you want the adapter's embedded node ready for publish flows.

### 5. Optional: add an EVM key for the adapter's embedded node

If you want the OpenClaw agent's embedded node to publish on-chain through `dkg_publish`, put the private key in `~/.openclaw/.env`:

```bash
DKG_EVM_PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE
```

Behavior:

- If `DKG_EVM_PRIVATE_KEY` is set and `chainConfig` is missing, the adapter fills in Base Sepolia defaults automatically.
- If the env var is not set, the adapter still supports local graph queries, peer discovery, messaging, and daemon-backed memory/channel features.

This key is only for the adapter's embedded node. The DKG daemon uses its own operational wallets in `~/.dkg/wallets.json`.

### 6. Optional: copy the bundled skill file into the workspace

The package ships `skills/dkg-node/SKILL.md`. It is still relevant because it teaches the agent when to use DKG memory tools versus the classic node/network tools. Some OpenClaw setups auto-surface plugin skills; some rely on workspace skills.

If you want the conservative, explicit path, copy it into the workspace:

```bash
mkdir -p WORKSPACE_DIR/skills/dkg-node
cp ~/dkg-v9/packages/adapter-openclaw/skills/dkg-node/SKILL.md WORKSPACE_DIR/skills/dkg-node/SKILL.md
```

### 7. Restart the OpenClaw gateway

Restart the OpenClaw gateway using your normal service command so it reloads the plugin and workspace config.

## Verification

A setup is healthy when all of the following are true.

### Embedded adapter node

Ask the OpenClaw agent to call:

- `dkg_status`

Expected result:

- either `status: "running"` with a peer ID and connected peers
- or a config/error payload that tells you exactly what the adapter could not start with

### Node UI and local bridge

Check the daemon UI:

- open `http://127.0.0.1:9200/ui`

Then open Agent Hub and use the `OpenClaw` tab.

Expected result:

- the tab reports the local bridge as healthy
- sending a message produces a reply from the OpenClaw agent
- the chat appears in the local DKG graph-backed history

### Memory integration

If `memory.enabled` is on, verify at least one of these:

- ask the agent to call `dkg_memory_import`
- ask the agent to call `dkg_memory_search`
- append text to `WORKSPACE_DIR/MEMORY.md` and wait for the watcher/import path to pick it up

Expected result:

- imported memories become searchable in the daemon-backed `agent-memory` graph

## Tools Exposed By The Adapter

Always available when the adapter is enabled:

| Tool | Purpose |
| --- | --- |
| `dkg_status` | Start or inspect the embedded DKG node and show connectivity info |
| `dkg_list_paranets` | List paranets known to the embedded node |
| `dkg_publish` | Publish N-Quads through the embedded node |
| `dkg_query` | Run a local SPARQL query through the embedded node |
| `dkg_find_agents` | Discover agents or skill offerings on the DKG network |
| `dkg_send_message` | Send encrypted peer-to-peer messages from the embedded node |
| `dkg_invoke_skill` | Invoke a remote DKG skill |

Only available when `memory.enabled` is true:

| Tool | Purpose |
| --- | --- |
| `dkg_memory_search` | Search the daemon-backed `agent-memory` graph |
| `dkg_memory_import` | Import memory text directly into the daemon-backed graph |

## Key Config Fields

These keys live under `"dkg-node"` in `WORKSPACE_DIR/config.json`.

| Key | Default | Purpose |
| --- | --- | --- |
| `dataDir` | `.dkg/openclaw` | Persistent state for the adapter's embedded DKG node |
| `listenPort` | random | TCP listen port for the embedded node |
| `relayPeers` | none | Relay multiaddrs for the embedded node |
| `bootstrapPeers` | none | Additional bootstrap peers for the embedded node |
| `daemonUrl` | `http://127.0.0.1:9200` | DKG daemon API used by memory/channel integrations |
| `memory.enabled` | `false` | Enables `dkg_memory_*` tools and file-watcher/backlog import |
| `memory.memoryDir` | `WORKSPACE_DIR/memory` | Overrides the watched memory directory |
| `memory.watchDebounceMs` | `1500` | Debounce window for file watcher imports |
| `channel.enabled` | `false` | Enables the Agent Hub <-> OpenClaw local bridge |
| `channel.port` | `9201` | Standalone bridge port when gateway route registration is unavailable |
| `chainConfig.rpcUrl` | Base Sepolia | On-chain RPC for the embedded node |
| `chainConfig.hubAddress` | Base Sepolia hub | Hub contract for the embedded node |

## Agent Runbook

If another agent is performing the setup, these are the exact steps it should follow:

1. Read `~/.openclaw/openclaw.json` and discover `agents.defaults.workspace`.
2. Clone this repo to a stable path such as `~/dkg-v9`, then run `pnpm install` and `pnpm build`.
3. Ensure `~/.dkg/config.json` exists, start the daemon, and confirm the UI is reachable at `http://127.0.0.1:9200/ui` or the configured host/port.
4. Merge the adapter load path and `adapter-openclaw` entry into `~/.openclaw/openclaw.json`.
5. Merge the `"dkg-node"` block into `WORKSPACE_DIR/config.json` with `daemonUrl`, `memory.enabled`, and `channel.enabled`.
6. Optionally add `DKG_EVM_PRIVATE_KEY` to `~/.openclaw/.env`.
7. Optionally copy `skills/dkg-node/SKILL.md` into `WORKSPACE_DIR/skills/dkg-node/SKILL.md`.
8. Restart the OpenClaw gateway.
9. Verify:
   - `dkg_status` works
   - `http://127.0.0.1:9200/ui` loads
   - Agent Hub -> OpenClaw bridge is healthy
10. Report back with:
   - `Setup complete, DKG V9 UI accessible at http://127.0.0.1:9200/ui`

Replace the URL if your daemon binds to a different host or port.

## Troubleshooting

### `dkg_status` returns an error payload

The adapter loaded, but the embedded node could not start.

Check:

- `WORKSPACE_DIR/config.json` contains the `"dkg-node"` block
- `relayPeers` is valid for the network you expect
- `dataDir` is writable
- `DKG_EVM_PRIVATE_KEY` is set if you expect on-chain publish flows

### Node UI works, but Agent Hub -> OpenClaw is offline

This usually means the daemon is up but the OpenClaw bridge is not reachable.

Check:

- `channel.enabled` is set to `true`
- the OpenClaw gateway was restarted after config changes
- the daemon is still using the current token from `~/.dkg/auth.token`
- if your gateway does not expose adapter HTTP routes, make sure the standalone bridge port is reachable on `127.0.0.1`

### `dkg_memory_search` or `dkg_memory_import` is missing

`memory.enabled` is off, or the plugin did not reload after config changes.

### Memory tools exist but return nothing

The daemon is reachable, but the `agent-memory` graph has no relevant content yet.

Try:

- `dkg_memory_import`
- editing `WORKSPACE_DIR/MEMORY.md`
- editing a Markdown file under `WORKSPACE_DIR/memory/`

### Advanced daemon routing

For non-default layouts, the daemon also supports explicit OpenClaw bridge hints in `~/.dkg/config.json`:

```json
{
  "openclawChannel": {
    "bridgeUrl": "http://127.0.0.1:9201",
    "gatewayUrl": "http://127.0.0.1:3000/api/dkg-channel"
  }
}
```

Use this only if the daemon cannot autodetect the local bridge/gateway path you want.
