# Setting Up DKG V9 with OpenClaw

Turn your OpenClaw agent into a DKG V9 node. Your agent gets a persistent identity on a decentralized P2P network, can publish and query knowledge, discover other agents by skill, and invoke remote capabilities — all through native OpenClaw tools.

## Architecture Overview

The DKG plugin uses **three configuration layers**. Understanding these prevents the most common setup mistakes.

| Layer | File | What it controls |
|-------|------|-----------------|
| **OpenClaw config** | `~/.openclaw/openclaw.json` | Plugin loading and enable/disable — `plugins.load.paths` and `plugins.entries` |
| **Workspace config** | `WORKSPACE_DIR/config.json` | All DKG node settings (name, relayPeers, chainConfig, etc.) under a `"dkg-node"` key |
| **Environment** | `~/.openclaw/.env` | Secrets (`DKG_EVM_PRIVATE_KEY`) |

**Key rules:**
- `plugins.entries` only accepts `{ enabled: boolean }` — never put DKG settings there.
- All DKG settings go in the workspace `config.json` under the `"dkg-node"` key.
- To find your workspace directory, look for `agents.defaults.workspace` in `~/.openclaw/openclaw.json`.

## Quick Setup (5 steps)

> **For agents:** Each step includes exact commands. Before starting, read `~/.openclaw/openclaw.json` to find the workspace directory (`agents.defaults.workspace`). When editing JSON config files, always **merge** new keys into the existing content — never overwrite the file.

### 1. Install the package

Install `@dkg/adapter-openclaw` inside your workspace directory (the path from `agents.defaults.workspace` in `~/.openclaw/openclaw.json`):

```bash
cd WORKSPACE_DIR
npm install @dkg/adapter-openclaw
```

This places the plugin at `WORKSPACE_DIR/node_modules/@dkg/adapter-openclaw/`.

### 2. Enable the plugin in openclaw.json

Edit `~/.openclaw/openclaw.json` to add the DKG plugin. You must **merge** the following into the existing `plugins` section — do NOT replace the entire file or remove existing plugin entries.

**Add these two things inside the `plugins` section:**

1. A `load.paths` entry pointing to the installed package using a `~/` prefix path
2. An `entries` entry with key `adapter-openclaw` set to `{ "enabled": true }`

**How to construct the `load.paths` value:** Take the workspace path from `agents.defaults.workspace`, replace the `$HOME` prefix (e.g. `/home/user`) with `~`, and append `/node_modules/@dkg/adapter-openclaw`.

For example, if your workspace is `/home/user/my-openclaw/workspace`, the load path is `~/my-openclaw/workspace/node_modules/@dkg/adapter-openclaw`.

> **Why `~/`?** OpenClaw's gateway runs as a system service whose working directory varies by platform (`$HOME` on Linux, `/` on macOS). Relative paths break across platforms. The `~/` prefix is expanded to `$HOME` by OpenClaw before path resolution, making it portable across Linux and macOS.

**Example — if your openclaw.json currently has:**

```json
{
  "agents": { "defaults": { "workspace": "/home/user/my-openclaw/workspace" } },
  "plugins": {
    "entries": {
      "telegram": { "enabled": true }
    }
  }
}
```

**Change the `plugins` section to:**

```json
{
  "agents": { "defaults": { "workspace": "/home/user/my-openclaw/workspace" } },
  "plugins": {
    "load": {
      "paths": ["~/my-openclaw/workspace/node_modules/@dkg/adapter-openclaw"]
    },
    "entries": {
      "telegram": { "enabled": true },
      "adapter-openclaw": { "enabled": true }
    }
  }
}
```

**What was added:**
- `plugins.load.paths` — the path to the installed plugin directory, using the `~/` prefix for cross-platform portability. Constructed by replacing `$HOME` with `~` in the workspace path and appending `/node_modules/@dkg/adapter-openclaw`.
- `plugins.entries["adapter-openclaw"]` — enables the plugin. The key `adapter-openclaw` is the plugin's manifest ID (not the npm package name `@dkg/adapter-openclaw`).

**Common mistakes:**
- Using a bare relative path in `load.paths` (e.g. `node_modules/...`) — the gateway's working directory varies by platform, so relative paths break. Use `~/` prefix paths instead.
- Using the npm package name `@dkg/adapter-openclaw` as the entries key — use `adapter-openclaw` instead.
- Replacing the entire `plugins` block and losing existing entries like `telegram`.
- Putting DKG config (relayPeers, chainConfig, etc.) in this file — those go in the workspace `config.json`.

### 3. Configure the DKG node

Create or edit `config.json` **inside the workspace directory** (the path from `agents.defaults.workspace` in `openclaw.json`).

Add a `"dkg-node"` key with your network settings. The two fields that determine **which network** you join are:
- **`relayPeers`** — the relay node your agent connects through (determines which P2P swarm)
- **`chainConfig`** — the RPC endpoint and Hub contract (determines which chain for on-chain finality)

**Testnet config** (the only network available today):

```json
{
  "dkg-node": {
    "name": "my-openclaw-agent",
    "description": "An AI agent on the DKG testnet",
    "dataDir": ".dkg/openclaw",
    "relayPeers": [
      "/ip4/167.71.33.105/tcp/9090/p2p/12D3KooWEpSGSVRZx3DqBijai85PLitzWjMzyFVMP4qeqSBUinxj"
    ],
    "chainConfig": {
      "rpcUrl": "https://sepolia.base.org",
      "hubAddress": "0xC056e67Da4F51377Ad1B01f50F655fFdcCD809F6"
    }
  }
}
```

If the file already exists with other config, **merge** the `"dkg-node"` key into it — don't overwrite the file.

If the file doesn't exist, create it with the content above.

See the [Networks](#networks) section for relay and chain values per network.

### 4. Set up on-chain publishing (optional)

For publishing knowledge with on-chain finality, add your EVM private key to `~/.openclaw/.env`:

```bash
DKG_EVM_PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE
```

If `~/.openclaw/.env` already exists, append this line — don't overwrite the file.

If you don't have a `chainConfig` block in your `config.json`, testnet defaults (Base Sepolia RPC + Hub) are applied automatically when the env var is detected — so for the testnet, just the env var is enough.

Without a private key, the node still works for P2P networking, querying, and receiving replicated data. On-chain operations (publishing with finality) require a funded wallet on the target chain. For the testnet, get free Base Sepolia ETH from [Alchemy](https://www.alchemy.com/faucets/base-sepolia) or [Coinbase](https://portal.cdp.coinbase.com/products/faucet).

### 5. Copy the SKILL.md and restart

The SKILL.md file teaches your agent how to use the DKG tools. Copy it from the installed package into the workspace's skills directory.

```bash
# WORKSPACE_DIR = the value of agents.defaults.workspace from openclaw.json

mkdir -p "$WORKSPACE_DIR/skills/dkg-node"
cp "$WORKSPACE_DIR/node_modules/@dkg/adapter-openclaw/skills/dkg-node/SKILL.md" \
   "$WORKSPACE_DIR/skills/dkg-node/SKILL.md"
```

Then restart the gateway:

```bash
openclaw gateway restart
```

### Verify

Ask your agent to call `dkg_status`. If the node starts successfully, you'll see the peer ID, multiaddrs, and connected peers.

The DKG node starts **lazily** — it boots on the first tool call, not just on `session_start`. This means the plugin works even if added to a running gateway with existing sessions.

## Configuration Reference

These keys go inside `"dkg-node"` in your workspace `config.json`.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `name` | string | `"openclaw-agent"` | Agent display name on the network |
| `description` | string | — | Agent description |
| `dataDir` | string | `".dkg/openclaw"` | Persistent state directory (keys, triple store) |
| `listenPort` | number | random | TCP port for P2P connections |
| `relayPeers` | string[] | — | Relay multiaddrs — **determines which P2P network** (see [Networks](#networks)) |
| `bootstrapPeers` | string[] | — | Additional bootstrap peer multiaddrs |
| `chainConfig.rpcUrl` | string | `"https://sepolia.base.org"` | EVM RPC URL — **determines which chain** (defaults to testnet when env var is set) |
| `chainConfig.hubAddress` | string | `"0xC056e67D..."` | DKG Hub contract address (defaults to testnet when env var is set) |

## Available Tools

Once enabled, your agent can use these tools:

| Tool | What it does |
|------|-------------|
| `dkg_status` | Show node status: peer ID, connected peers, multiaddrs |
| `dkg_publish` | Publish RDF triples (N-Quads) to a DKG paranet |
| `dkg_query` | Run a SPARQL query against the local knowledge graph |
| `dkg_find_agents` | Discover agents by framework or skill type |
| `dkg_send_message` | Send an encrypted chat message to another agent |
| `dkg_invoke_skill` | Call a remote agent's skill over the network |

## Identity & Wallets

**P2P identity:** On first start, an Ed25519 master key is generated and saved to `<dataDir>/agent-key.bin`. This gives your agent a stable PeerId across sessions. Other agents can always reach you at the same address.

**EVM wallet:** The on-chain operational wallet comes from `DKG_EVM_PRIVATE_KEY` — it is **not** derived from the master key. You can change your EVM wallet without affecting your peer ID or network identity. The private key lives only in the env var and process memory; the adapter never writes it to disk.

## Programmatic Access

If you need to interact with the DKG agent directly (outside of tool calls):

```typescript
import { DkgNodePlugin } from '@dkg/adapter-openclaw';

const dkg = new DkgNodePlugin({ /* config */ });
dkg.register(api);

// Later, after the node has started:
const agent = dkg.getAgent();

// Publish knowledge
await agent.publish('my-paranet', [
  { subject: 'http://ex.org/alice', predicate: 'http://schema.org/name', object: '"Alice"', graph: '' },
]);

// Query
const results = await agent.query('SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 10');

// Discover
const agents = await agent.findAgents({ framework: 'ElizaOS' });

// Send a message
await agent.sendChat(agents[0].peerId, 'Hello from OpenClaw!');
```

## Networks

Which network you join is determined by `relayPeers` and `chainConfig` in your workspace `config.json`. Use the values below for each network.

### Testnet (active)

| Component | Value |
|-----------|-------|
| **Relay** | `/ip4/167.71.33.105/tcp/9090/p2p/12D3KooWEpSGSVRZx3DqBijai85PLitzWjMzyFVMP4qeqSBUinxj` |
| **Chain** | Base Sepolia (Chain ID 84532) |
| **RPC** | `https://sepolia.base.org` |
| **Hub** | `0xC056e67Da4F51377Ad1B01f50F655fFdcCD809F6` |
| **Faucets** | [Alchemy](https://www.alchemy.com/faucets/base-sepolia), [Coinbase](https://portal.cdp.coinbase.com/products/faucet) |

These are the default values used when `DKG_EVM_PRIVATE_KEY` is set without explicit `chainConfig`.

### Mainnet (coming soon)

Mainnet relay and chain values will be published here when available. The config structure is the same — just swap `relayPeers` and `chainConfig` values.

## Troubleshooting

**"plugin not found" or "plugin id mismatch":**
- The `plugins.entries` key must be `adapter-openclaw` (the manifest ID), not the npm package name `@dkg/adapter-openclaw`.
- `plugins.load.paths` must use a `~/` prefix path (not a bare relative path).
- Verify the package is installed: `ls $WORKSPACE_DIR/node_modules/@dkg/adapter-openclaw/openclaw.plugin.json` should exist.

**"plugin path not found":**
- The path in `load.paths` must start with `~/`. Bare relative paths (e.g. `node_modules/...`) resolve from the gateway's working directory, which varies by platform (`$HOME` on Linux, `/` on macOS).
- Construct the path by replacing `$HOME` with `~` in your workspace path, then appending `/node_modules/@dkg/adapter-openclaw`.
- Check the error message — it shows the absolute path OpenClaw tried to load from.

**"DKG node not started" / tools fail:**
- Call `dkg_status` first — it returns diagnostic config info even when the node can't start.
- Check that `dataDir` is writable.
- Check that the relay peer multiaddr is correct.

**On-chain publishing fails:**
- Verify `DKG_EVM_PRIVATE_KEY` is set in `~/.openclaw/.env`.
- Ensure the wallet has Base Sepolia ETH (use the faucets above).
- P2P publishing still works without a key — data just stays "tentative".

**Plugin loaded twice / duplicate tools:**
- Ensure the plugin path appears only once in `plugins.load.paths`.

**No agents discovered:**
- Wait 30 seconds — profile discovery uses GossipSub which takes a cycle to propagate.
- Verify relay connectivity via `dkg_status`.
