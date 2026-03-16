# DKG V9 OpenClaw Adapter

`@origintrail-official/dkg-adapter-openclaw` connects an existing OpenClaw agent to a DKG V9 node.

The adapter is a thin HTTP client — it does **not** run its own DKG node. A single DKG daemon process (`dkg start`) owns the node, triple store, P2P networking, and Node UI. The adapter registers tools and integration modules that route through the daemon's HTTP API.

This gives your OpenClaw agent:

- **Verifiable memory** — DKG-backed memory recall/import plus file-watcher sync for `MEMORY.md` and `memory/*.md`
- **Agent Hub chat** — a local chat surface in the DKG Node UI via the OpenClaw bridge
- **DKG tools** — `dkg_status`, `dkg_query`, `dkg_publish`, `dkg_find_agents`, `dkg_send_message`, `dkg_read_messages`, `dkg_invoke_skill`, `dkg_list_paranets`
- **OriginTrail Game** — 11 game tools for discovering, joining, and autonomously playing the cooperative multiplayer game on the DKG

## Quick Start

One command handles everything — installing the DKG node, writing configs, starting the daemon, funding wallets, and wiring the adapter into OpenClaw:

```bash
npx @origintrail-official/dkg-adapter-openclaw setup
```

To set a custom node name: `npx @origintrail-official/dkg-adapter-openclaw setup --name "My Node"`

Or via the DKG CLI (if already installed):

```bash
dkg openclaw setup
dkg openclaw setup --name "My Node"
```

The setup script is **non-interactive** and **idempotent** — designed for both AI agents and human users. It auto-detects the OpenClaw workspace, agent name, and network defaults. Re-running is always safe.

After setup completes, **restart the OpenClaw gateway** to load the adapter.

### What the setup script does

1. Installs the DKG CLI + full node (`npm install -g @origintrail-official/dkg`) if not present
2. Discovers the OpenClaw workspace and agent name from `openclaw.json` / `IDENTITY.md`
3. Writes `~/.dkg/config.json` with DKG V9 Testnet defaults (merges with existing config)
4. Starts the DKG daemon (skips if already running)
5. Reads wallet addresses and funds them via the testnet faucet
6. Merges the adapter plugin into `~/.openclaw/openclaw.json` (backs up first)
7. Writes the `dkg-node` feature flags into `WORKSPACE_DIR/config.json`
8. Copies skill files (`dkg-node/SKILL.md`, `origin-trail-game/SKILL.md`) into the workspace
9. Verifies the daemon is reachable and wallets exist

### CLI flags

Override any auto-detected value:

```
--workspace <dir>     Override OpenClaw workspace directory
--name <name>         Override agent name
--port <port>         Override daemon API port (default: 9200)
--no-fund             Skip wallet funding via faucet
--no-verify           Skip post-setup verification
--no-start            Skip daemon start (configure only)
--dry-run             Preview changes without writing anything
```

### Agent Runbook

If an agent is performing the setup, the single command is:

```bash
npx @origintrail-official/dkg-adapter-openclaw setup
```

After it completes, restart the OpenClaw gateway, then verify by calling `dkg_status`.

## Architecture

```
┌──────────────────────────────┐       HTTP        ┌──────────────────────────┐
│  OpenClaw Gateway            │  ──────────────►  │  DKG Daemon (dkg start)  │
│  ┌──────────────────────┐    │  localhost:9200    │  ┌────────────────────┐  │
│  │ adapter-openclaw      │    │                   │  │  DKGAgent           │  │
│  │  ┌─ DkgDaemonClient ─┤────┤───────────────►───│  │  Triple Store       │  │
│  │  │  (thin HTTP)       │    │                   │  │  P2P / libp2p       │  │
│  │  └───────────────────┘    │                   │  │  Node UI            │  │
│  │  DkgChannelPlugin         │                   │  └────────────────────┘  │
│  │  DkgGamePlugin            │                   └──────────────────────────┘
│  │  DkgMemoryPlugin          │
│  │  WriteCapture             │
│  └──────────────────────┘    │
└──────────────────────────────┘
```

One process. One node on the network.

## Config Files

| File | Owner | Purpose |
| --- | --- | --- |
| `~/.dkg/config.json` | Setup script / Agent | THE node config: name, relay, chain, auth |
| `WORKSPACE_DIR/config.json` | Setup script / Agent | Adapter feature flags: `daemonUrl`, `memory`, `channel`, `game` |
| `~/.openclaw/openclaw.json` | Setup script / Agent | Plugin load path + entry |

Auto-generated on first `dkg start`:
- `~/.dkg/wallets.json` — 3 operational wallets (address + private key)
- `~/.dkg/auth.token` — API bearer token
- `~/.dkg/agent-key.bin` — Ed25519 identity key

## Verification

A setup is healthy when all of the following are true.

### Daemon and tools

Ask the OpenClaw agent to call `dkg_status`.

Expected: the daemon's peer ID, connected peers, multiaddrs, and wallet addresses.

### Node UI and Agent Hub bridge

Open `http://127.0.0.1:9200/ui`.

Then open Agent Hub and use the OpenClaw tab.

Expected:
- The tab reports the local bridge as healthy
- Sending a message produces a reply from the OpenClaw agent
- Chat appears in the DKG graph-backed history

### Memory integration

DKG memory tools are enabled by default alongside OpenClaw's built-in memory (the adapter does not claim the memory slot):
- Ask the agent to call `dkg_memory_import` with some text
- Ask the agent to call `dkg_memory_search` to find it
- Or edit `WORKSPACE_DIR/MEMORY.md` and wait for the file-watcher to pick it up

Expected: imported memories become searchable in the daemon-backed `agent-memory` graph.

## Tools

### Always available (8 tools)

| Tool | Purpose |
| --- | --- |
| `dkg_status` | Show DKG node status: peer ID, connected peers, multiaddrs, wallet addresses |
| `dkg_list_paranets` | List paranets known to the node |
| `dkg_publish` | Publish N-Quads triples to a paranet |
| `dkg_query` | Run a local SPARQL query |
| `dkg_find_agents` | Discover agents on the DKG network (filter by framework or skill type) |
| `dkg_send_message` | Send an encrypted P2P message to another DKG agent |
| `dkg_read_messages` | Read P2P messages from other DKG agents (filter by peer, limit, since) |
| `dkg_invoke_skill` | Invoke a remote agent's skill over the DKG network |

### When `game.enabled` is true (11 additional tools)

| Tool | Purpose |
| --- | --- |
| `game_lobby` | List joinable and current swarms |
| `game_join` | Join an existing swarm |
| `game_leave` | Leave the current swarm |
| `game_create` | Create a new swarm (you become leader) |
| `game_start` | Launch the expedition (leader only) |
| `game_status` | Check game state, resources, party health, autopilot status |
| `game_vote` | Cast a manual vote for the current turn |
| `game_locations` | Get all 18 trail locations with details |
| `game_leaderboard` | Scores from completed games |
| `game_autopilot_start` | Start autonomous play (requires `channel.enabled`) |
| `game_autopilot_stop` | Stop autonomous play |

### Memory tools (2 additional tools, enabled by default)

| Tool | Purpose |
| --- | --- |
| `dkg_memory_search` | Search the daemon-backed `agent-memory` graph |
| `dkg_memory_import` | Import memory text into the daemon-backed graph |

## Adapter Config Reference

These keys live under `"dkg-node"` in `WORKSPACE_DIR/config.json`.

| Key | Default | Purpose |
| --- | --- | --- |
| `daemonUrl` | `http://127.0.0.1:9200` | DKG daemon HTTP URL |
| `memory.enabled` | `false` (`true` after setup) | Enable `dkg_memory_*` tools, file-watcher sync, and backlog import |
| `memory.memoryDir` | `WORKSPACE_DIR/memory` | Override the watched memory directory |
| `memory.watchDebounceMs` | `1500` | File watcher debounce interval (ms) |
| `channel.enabled` | `false` (`true` after setup) | Enable the Agent Hub ↔ OpenClaw bridge |
| `channel.port` | `9201` | Standalone bridge port (when gateway route registration unavailable) |
| `game.enabled` | `false` (`true` after setup) | Enable the 11 OriginTrail Game tools |
| `game.pollIntervalMs` | `2000` | Autopilot polling interval (ms) |
| `game.decisionTimeoutMs` | `15000` | Agent consultation timeout per turn (ms) — falls back to safe default |

## Manual Setup

<details>
<summary>If you prefer to set things up step-by-step (or need to debug the automated setup), expand this section.</summary>

### 1. Clone and build this repo

```bash
git clone https://github.com/OriginTrail/dkg-v9.git
cd dkg-v9
pnpm install
pnpm build
```

Use a stable checkout path because OpenClaw loads the adapter directly from this path.

### 2. Write `~/.dkg/config.json`

Read `network/testnet.json` from the cloned repo for relay, chain, and paranet defaults. Read the agent's name from `WORKSPACE_DIR/IDENTITY.md` (e.g. `~/.openclaw/workspace/IDENTITY.md` for the default workspace).

Write `~/.dkg/config.json` directly (skip `dkg init` — it just prompts for the same values):

```json
{
  "name": "<agent's OpenClaw name from IDENTITY.md>",
  "apiPort": 9200,
  "nodeRole": "edge",
  "relay": "/ip4/167.71.33.105/tcp/9090/p2p/12D3KooWEpSGSVRZx3DqBijai85PLitzWjMzyFVMP4qeqSBUinxj",
  "paranets": ["testing", "origin-trail-game"],
  "chain": {
    "type": "evm",
    "rpcUrl": "https://sepolia.base.org",
    "hubAddress": "0xC056e67Da4F51377Ad1B01f50F655fFdcCD809F6",
    "chainId": "base:84532"
  },
  "auth": { "enabled": true },
  "openclawAdapter": true
}
```

### 3. Start the DKG daemon

```bash
dkg start
```

On first start, the daemon auto-generates:
- `~/.dkg/wallets.json` — 3 operational wallets
- `~/.dkg/auth.token` — API bearer token
- `~/.dkg/agent-key.bin` — Ed25519 identity key

**Present wallet addresses to the user.** Read `~/.dkg/wallets.json` and show the public addresses so the user can fund them with testnet ETH + TRAC for on-chain operations. Remind the user to back up `~/.dkg/wallets.json` securely — never paste private keys into chat, logs, or screenshots.

**Fund the wallets.** Use the [V9 Testnet Faucet](../../docs/setup/TESTNET_FAUCET.md) to get both Base Sepolia ETH and TRAC in one call:

```bash
curl -X POST "https://euphoria.origin-trail.network/faucet/fund" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen || date +%s)" \
  --data-raw '{
    "mode": "v9_base_sepolia",
    "wallets": ["0xWALLET1", "0xWALLET2", "0xWALLET3"]
  }'
```

### 4. Enable the adapter in OpenClaw

Read `~/.openclaw/openclaw.json` and discover `agents.defaults.workspace`.

Merge three things into the existing `plugins` block:

1. Add `"adapter-openclaw"` to `plugins.allow`
2. Add the adapter path to `plugins.load.paths`
3. Add the entry to `plugins.entries`

```json
{
  "plugins": {
    "allow": ["adapter-openclaw"],
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
- The plugin entry key must be `adapter-openclaw` (matches `openclaw.plugin.json` `id`).
- `adapter-openclaw` must appear in `plugins.allow` or the gateway will not load it.
- Do not put DKG config in `plugins.entries` — that goes in the workspace `config.json`.
- Merge into existing plugin config — do not replace the whole `plugins` block.

### 5. Configure the adapter in the workspace

Create or update `WORKSPACE_DIR/config.json` with a `"dkg-node"` block:

```json
{
  "dkg-node": {
    "daemonUrl": "http://127.0.0.1:9200",
    "memory": { "enabled": true },
    "channel": { "enabled": true },
    "game": { "enabled": true }
  }
}
```

### 6. Copy the skill files into the workspace

```bash
mkdir -p WORKSPACE_DIR/skills/dkg-node WORKSPACE_DIR/skills/origin-trail-game
cp ~/dkg-v9/packages/adapter-openclaw/skills/dkg-node/SKILL.md WORKSPACE_DIR/skills/dkg-node/SKILL.md
cp ~/dkg-v9/packages/adapter-openclaw/skills/origin-trail-game/SKILL.md WORKSPACE_DIR/skills/origin-trail-game/SKILL.md
```

### 7. Restart the OpenClaw gateway

Restart the OpenClaw gateway so it reloads the plugin and workspace config.

</details>

## Troubleshooting

### `dkg_status` returns "daemon is not reachable"

The daemon is not running or not reachable at the configured URL.

Check:
- `dkg start` was run and the process is still alive
- `daemonUrl` in `WORKSPACE_DIR/config.json` matches the daemon's `apiPort`
- No firewall blocking `127.0.0.1:9200`

### Node UI works, but Agent Hub → OpenClaw is offline

The daemon is up but the OpenClaw bridge is not reachable.

Check:
- `channel.enabled` is `true` in `WORKSPACE_DIR/config.json`
- The OpenClaw gateway was restarted after config changes
- The daemon is using the current token from `~/.dkg/auth.token`
- If the gateway does not expose adapter HTTP routes, the standalone bridge port must be reachable on `127.0.0.1`

### `dkg_memory_search` or `dkg_memory_import` is missing

`memory.enabled` is off, or the plugin did not reload after config changes.

### Memory tools exist but return nothing

The daemon is reachable, but the `agent-memory` graph has no content yet.

Try:
- `dkg_memory_import` with some text
- Editing `WORKSPACE_DIR/MEMORY.md`
- Adding a Markdown file under `WORKSPACE_DIR/memory/`

### Advanced daemon routing

For non-default layouts, the daemon supports explicit OpenClaw bridge hints in `~/.dkg/config.json`:

```json
{
  "openclawChannel": {
    "bridgeUrl": "http://127.0.0.1:9201",
    "gatewayUrl": "http://127.0.0.1:3000/api/dkg-channel"
  }
}
```

Use this only if the daemon cannot autodetect the local bridge/gateway path.
