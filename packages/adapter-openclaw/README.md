# Setting Up DKG V9 with OpenClaw

Turn your OpenClaw agent into a DKG V9 node. Your agent gets a persistent identity on a decentralized P2P network, can publish and query knowledge, discover other agents by skill, and invoke remote capabilities — all through native OpenClaw tools.

## Architecture Overview

The DKG plugin uses **two configuration layers**:

| Layer | File | What it controls |
|-------|------|-----------------|
| **OpenClaw config** | `~/.openclaw/openclaw.json` | Plugin enable/disable only (`plugins.entries["@dkg/adapter-openclaw"].enabled: true`) |
| **Workspace config** | `<workspace>/config.json` | All DKG settings (dataDir, relayPeers, chainConfig, etc.) |
| **Environment** | `~/.openclaw/.env` | Secrets (EVM private key) |

OpenClaw's `plugins.entries` only accepts `{ enabled: boolean }` — no other keys. All DKG configuration goes in the workspace `config.json` under a `"dkg-node"` key.

## Quick Setup (5 steps)

### 1. Install

```bash
npm install @dkg/adapter-openclaw
```

OpenClaw discovers the plugin automatically via the `openclaw.extensions` field in the package's `package.json`. No need to add `plugins.load.paths` if you install via npm.

> **Pitfall:** Don't install via both npm AND `plugins.load.paths` — this causes double registration.

### 2. Enable the Plugin

Add the plugin entry to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "@dkg/adapter-openclaw": {
        "enabled": true
      }
    }
  }
}
```

Only `enabled: boolean` is allowed here. Do not put DKG config in this file.

### 3. Configure the Node

Add a `"dkg-node"` block to your workspace's `config.json`. The two fields that determine **which network** you join are:

- **`relayPeers`** — the relay node your agent connects through (determines which P2P network)
- **`chainConfig`** — the RPC endpoint and Hub contract (determines which chain for on-chain finality)

Together, these define the network. Use the values from the table below for your target network.

**Testnet example** (the only network available today):

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

See the [Networks](#networks) section below for relay and chain values per network.

### 4. Set Up On-Chain Publishing

For publishing knowledge with on-chain finality, add your EVM private key to `~/.openclaw/.env`:

```bash
DKG_EVM_PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE
```

If you don't have a `chainConfig` block in your `config.json`, testnet defaults (Base Sepolia RPC + Hub) are applied automatically when the env var is detected — so for the testnet, just the env var is enough.

Without a private key, the node still works for P2P networking, querying, and receiving replicated data. On-chain operations (publishing with finality) require a funded wallet on the target chain. For the testnet, get free Base Sepolia ETH from [Alchemy](https://www.alchemy.com/faucets/base-sepolia) or [Coinbase](https://portal.cdp.coinbase.com/products/faucet).

### 5. Copy the SKILL.md and Restart

The SKILL.md file teaches your agent how to use the DKG tools. Copy it from this package into your workspace's skills directory:

```bash
# Replace <workspace> with your actual workspace path
# (shown in OpenClaw gateway logs on startup, or check openclaw.json)
mkdir -p <workspace>/skills/dkg-node
cp node_modules/@dkg/adapter-openclaw/skills/dkg-node/SKILL.md <workspace>/skills/dkg-node/SKILL.md
```

Then restart the gateway:

```bash
openclaw gateway restart
```

### Verify

Ask your agent to call `dkg_status`. If the node starts successfully, you'll see the peer ID, multiaddrs, and connected peers.

The DKG node starts **lazily** — it boots on the first tool call, not just on `session_start`. This means the plugin works even if added to a running gateway with existing sessions.

## Configuration Reference

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

Which network you join is determined by `relayPeers` and `chainConfig` in your config. Use the values below for each network.

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

**"plugin not found: dkg-node":**
- The plugin entry key in `openclaw.json` must be the **npm package name** `@dkg/adapter-openclaw`, not the plugin ID `dkg-node`. Use `"@dkg/adapter-openclaw": { "enabled": true }`.

**"DKG node not started" / tools fail:**
- Call `dkg_status` first — it returns diagnostic config info even when the node can't start.
- Check that `dataDir` is writable.
- Check that the relay peer multiaddr is correct.

**On-chain publishing fails:**
- Verify `DKG_EVM_PRIVATE_KEY` is set in `~/.openclaw/.env`.
- Ensure the wallet has Base Sepolia ETH (use the faucets above).
- P2P publishing still works without a key — data just stays "tentative".

**Plugin loaded twice / duplicate tools:**
- Only install via ONE method: npm (auto-discovery) OR `plugins.load.paths` — not both.

**No agents discovered:**
- Wait 30 seconds — profile discovery uses GossipSub which takes a cycle to propagate.
- Verify relay connectivity via `dkg_status`.
