# DKG V9 OpenClaw Adapter

`@dkg/adapter-openclaw` connects an existing OpenClaw agent to a DKG V9 node.

The adapter is a thin HTTP client — it does **not** run its own DKG node. A single DKG daemon process (`dkg start`) owns the node, triple store, P2P networking, and Node UI. The adapter registers tools and integration modules that route through the daemon's HTTP API.

This gives your OpenClaw agent:

- **Verifiable memory** — DKG-backed memory recall/import plus file-watcher sync for `MEMORY.md` and `memory/*.md`
- **Agent Hub chat** — a local chat surface in the DKG Node UI via the OpenClaw bridge
- **DKG tools** — `dkg_status`, `dkg_query`, `dkg_publish`, `dkg_find_agents`, `dkg_send_message`, `dkg_read_messages`, `dkg_invoke_skill`, `dkg_list_paranets`
- **OriginTrail Game** — 10 game tools for discovering, joining, and autonomously playing the cooperative multiplayer game on the DKG

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
| `~/.dkg/config.json` | Agent (during setup) | THE node config: name, relay, chain, auth |
| `WORKSPACE_DIR/config.json` | Agent (during setup) | Adapter feature flags: `daemonUrl`, `memory`, `channel`, `game` |
| `~/.openclaw/openclaw.json` | Agent (merge) | Plugin load path + entry |

Auto-generated on first `dkg start`:
- `~/.dkg/wallets.json` — 3 operational wallets (address + private key)
- `~/.dkg/auth.token` — API bearer token
- `~/.dkg/agent-key.bin` — Ed25519 identity key

## Setup

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
pnpm dkg start
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

Replace the wallet addresses with the ones from `wallets.json`. Each wallet receives ETH (for gas) and TRAC (for on-chain operations). See the [full faucet reference](../../docs/setup/TESTNET_FAUCET.md) for rate limits, dry-run, and error handling.

What the running daemon provides:
- Local API at `http://127.0.0.1:9200`
- Node UI at `http://127.0.0.1:9200/ui`
- OpenClaw bridge endpoints under `/api/openclaw-channel/*`

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

Notes:
- `daemonUrl` defaults to `http://127.0.0.1:9200`, but set it explicitly for clarity.
- `memory.enabled: true` enables `dkg_memory_search`, `dkg_memory_import`, first-run backlog import, and file watching for `WORKSPACE_DIR/MEMORY.md` and `WORKSPACE_DIR/memory/**/*.md`.
- `channel.enabled: true` enables the DKG UI ↔ OpenClaw bridge used by Agent Hub.
- `game.enabled: true` enables the 10 OriginTrail Game tools. Autopilot requires `channel.enabled: true` for agent consultation; without it, only manual `game_vote` is available.

### 6. Copy the skill files into the workspace

The package ships two skill files that teach the agent how to use DKG tools and game tools:

```bash
mkdir -p WORKSPACE_DIR/skills/dkg-node WORKSPACE_DIR/skills/origin-trail-game
cp ~/dkg-v9/packages/adapter-openclaw/skills/dkg-node/SKILL.md WORKSPACE_DIR/skills/dkg-node/SKILL.md
cp ~/dkg-v9/packages/adapter-openclaw/skills/origin-trail-game/SKILL.md WORKSPACE_DIR/skills/origin-trail-game/SKILL.md
```

- `dkg-node/SKILL.md` — teaches memory, publishing, querying, and agent discovery tools
- `origin-trail-game/SKILL.md` — teaches game mechanics, actions, strategy, and autopilot usage

### 7. Restart the OpenClaw gateway

Restart the OpenClaw gateway so it reloads the plugin and workspace config.

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

If `memory.enabled` is on:
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

### When `game.enabled` is true (10 additional tools)

| Tool | Purpose |
| --- | --- |
| `game_lobby` | List joinable and current swarms |
| `game_join` | Join an existing swarm |
| `game_create` | Create a new swarm (you become leader) |
| `game_start` | Launch the expedition (leader only) |
| `game_status` | Check game state, resources, party health, autopilot status |
| `game_vote` | Cast a manual vote for the current turn |
| `game_locations` | Get all 18 trail locations with details |
| `game_leaderboard` | Scores from completed games |
| `game_autopilot_start` | Start autonomous play (requires `channel.enabled`) |
| `game_autopilot_stop` | Stop autonomous play |

### When `memory.enabled` is true (2 additional tools)

| Tool | Purpose |
| --- | --- |
| `dkg_memory_search` | Search the daemon-backed `agent-memory` graph |
| `dkg_memory_import` | Import memory text into the daemon-backed graph |

## Adapter Config Reference

These keys live under `"dkg-node"` in `WORKSPACE_DIR/config.json`.

| Key | Default | Purpose |
| --- | --- | --- |
| `daemonUrl` | `http://127.0.0.1:9200` | DKG daemon HTTP URL |
| `memory.enabled` | `false` | Enable `dkg_memory_*` tools, file-watcher sync, and backlog import |
| `memory.memoryDir` | `WORKSPACE_DIR/memory` | Override the watched memory directory |
| `memory.watchDebounceMs` | `1500` | File watcher debounce interval (ms) |
| `channel.enabled` | `false` | Enable the Agent Hub ↔ OpenClaw bridge |
| `channel.port` | `9201` | Standalone bridge port (when gateway route registration unavailable) |
| `game.enabled` | `false` | Enable the 10 OriginTrail Game tools |
| `game.pollIntervalMs` | `2000` | Autopilot polling interval (ms) |
| `game.decisionTimeoutMs` | `15000` | Agent consultation timeout per turn (ms) — falls back to safe default |

## Agent Runbook

If another agent is performing the setup, these are the exact steps:

1. Read `~/.openclaw/openclaw.json` and discover `agents.defaults.workspace`.
2. Clone this repo to a stable path such as `~/dkg-v9`, then `pnpm install && pnpm build`.
3. Read `network/testnet.json` for relay, chain, and paranet defaults.
4. Read the agent name from `WORKSPACE_DIR/IDENTITY.md`.
5. Write `~/.dkg/config.json` programmatically using the agent name and network defaults. Include `"openclawAdapter": true`.
6. Run `pnpm dkg start` — wallets, auth token, and identity key are auto-generated on first start.
7. Read `~/.dkg/wallets.json` and show the public addresses so the user can fund them with testnet ETH + TRAC for on-chain operations. Remind the user to back up `~/.dkg/wallets.json` securely — never paste private keys into chat, logs, or screenshots. Fund the wallets by calling `POST https://euphoria.origin-trail.network/faucet/fund` with `{"mode": "v9_base_sepolia", "wallets": ["0xADDR1", "0xADDR2", "0xADDR3"]}`. Include an `Idempotency-Key` header. See [Testnet Faucet](../../docs/setup/TESTNET_FAUCET.md) for details.
8. Merge into `~/.openclaw/openclaw.json`: add `"adapter-openclaw"` to `plugins.allow`, add the adapter path to `plugins.load.paths`, and add `adapter-openclaw` to `plugins.entries`.
9. Write the `"dkg-node"` block into `WORKSPACE_DIR/config.json` with `daemonUrl`, `memory.enabled`, `channel.enabled`, and `game.enabled`.
10. Copy `skills/dkg-node/SKILL.md` into `WORKSPACE_DIR/skills/dkg-node/SKILL.md` and `skills/origin-trail-game/SKILL.md` into `WORKSPACE_DIR/skills/origin-trail-game/SKILL.md`.
11. Restart the OpenClaw gateway.
12. Verify:
    - `dkg_status` returns daemon info + wallet addresses
    - `http://127.0.0.1:9200/ui` loads
    - Agent Hub → OpenClaw bridge is healthy
13. Report: `Setup complete, DKG V9 UI accessible at http://127.0.0.1:9200/ui`

Replace the URL if the daemon binds to a different host or port.

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
