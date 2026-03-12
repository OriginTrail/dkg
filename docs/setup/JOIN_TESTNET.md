# Join the DKG V9 Testnet

Run your own node on the DKG V9 testnet: discover other nodes, publish and query knowledge, and send encrypted messages — no sign-up, no account, just clone and go.

**Quick start (CLI, ~5 min):** clone the repo, build, run `pnpm dkg init` (name + EVM key), then `pnpm dkg start -f`. In another terminal: `pnpm dkg peers` and `pnpm dkg send <their-name> "hey!"`. Details below.

---

You can join in three ways:

| Path | Best for |
|------|----------|
| **[A) CLI](#a-cli-standalone-node)** | **Try this first** — standalone node from the terminal |
| **[B) OpenClaw](#b-openclaw-agent)** | Adding DKG to an existing OpenClaw agent |
| **[C) ElizaOS](#c-elizaos-agent)** | Adding DKG to an existing ElizaOS agent |

All three use the same network and protocol; CLI, OpenClaw, and ElizaOS nodes can message and share data with each other.

## Prerequisites

- **Node.js** v20+ (v22 recommended)
- **pnpm** v9+ — install with: `npm install -g pnpm`
- **Git**
- Internet connection
- **Base Sepolia ETH** for on-chain publishing (~0.001 ETH per publish; messaging and queries are free)
- An **EVM private key** — any wallet; you can create a new one just for the testnet (no KYC, no real money)

### Get Base Sepolia ETH + TRAC

**Recommended: [V9 Testnet Faucet](./TESTNET_FAUCET.md)** — provides both ETH and TRAC in a single API call:

```bash
curl -X POST "https://euphoria.origin-trail.network/faucet/fund" \
  -H "Content-Type: application/json" \
  --data-raw '{"mode": "v9_base_sepolia", "wallets": ["0xYOUR_WALLET_ADDRESS"]}'
```

See the [full faucet reference](./TESTNET_FAUCET.md) for rate limits, idempotency keys, and error handling.

**Alternative (ETH only):**
1. [Alchemy faucet](https://www.alchemy.com/faucets/base-sepolia)
2. [Coinbase faucet](https://portal.cdp.coinbase.com/products/faucet)

You'll need ETH to pay gas for on-chain transactions (publishing, updating knowledge) and TRAC for on-chain operations. P2P operations (queries, messaging, discovery) are free.

## 1. Clone and Build

```bash
git clone https://github.com/OriginTrail/dkg-v9.git
cd dkg-v9
pnpm install
pnpm build
```

If you already have the repo, just pull and rebuild:

```bash
cd ~/dkg-v9
git pull
pnpm install
pnpm build
```

---

## A) CLI — Standalone Node

The CLI runs a background daemon that manages the DKG node. All commands run from the repo root using `pnpm dkg`.

### Initialize

```bash
pnpm dkg init
```

The testnet relay and chain config are pre-filled from `network/testnet.json`. Just give your node a name, provide your EVM private key, and hit Enter through the rest:

```
DKG Node Setup — DKG V9 Testnet

Node name?: alice-mini
Node role? (edge / core) (edge):
Relay multiaddr? (/ip4/167.71.33.105/tcp/9090/p2p/12D3KooWPXP5m...):
EVM private key? (for on-chain publishing):
Paranets to subscribe? (comma-separated):
API port? (9200):
Enable auto-update from GitHub? (y/n) (y):

Config saved to /Users/you/.dkg/config.json
  name:       alice-mini
  role:       edge
  relay:      /ip4/167.71.33.105/tcp/9090/p2p/12D3KooWPXP5m...
  chain:      Base Sepolia (evm:84532)
  wallet:     0xA1B2...C3D4
  network:    DKG V9 Testnet
```

| Prompt | What to enter |
|--------|---------------|
| **Node name?** | A memorable name (e.g. `alice-mini`, `lab-node-3`) |
| **Node role?** | `edge` — just press Enter |
| **Relay multiaddr?** | Pre-filled — just press Enter |
| **EVM private key?** | Your wallet's private key (hex; e.g. from MetaMask: Account menu → Account details → Show private key). Can also be set via `DKG_PRIVATE_KEY` env var |
| **Paranets to subscribe?** | Leave blank, or enter paranet names if you know them |
| **API port?** | `9200` (default — press Enter) |
| **Enable auto-update?** | Defaults to `y` — just press Enter for automatic updates |

Config is saved to `~/.dkg/config.json`. Edit it directly or re-run `pnpm dkg init`.

> **Security**: Your private key is stored in `~/.dkg/config.json`. This file should be readable only by your user. Never share it or commit it to git.

> **API Authentication**: The node generates an auth token on first start, saved in `~/.dkg/auth.token`. The CLI uses it automatically. For external tools, run `pnpm dkg auth show` to see the token, then pass it via `Authorization: Bearer <token>` header. See the main README for details.

> **Without a private key**: The node still works for P2P networking, querying, and receiving replicated data. On-chain operations (publishing with finality, updates) require a funded wallet.

### Start

```bash
# Foreground (see logs live — good for first test)
pnpm dkg start -f

# Or as a background daemon
pnpm dkg start
```

You should see:

```
Starting DKG edge node "alice-mini"...
Network: a3f8b2c1e9d04...
PeerId: 12D3KooWQx...
  /ip4/192.168.1.42/tcp/9100/p2p/12D3KooWQx...
Relay: /ip4/167.71.33.105/tcp/9090/p2p/12D3KooWPXP5...
Circuit reservation granted (2 addresses)
API listening on http://127.0.0.1:9200
Node is running. Use "dkg status" or "dkg peers" to interact.
```

**"Circuit reservation granted"** means you're registered with the relay and reachable by other nodes, even behind NAT.

### Verify

In a **second terminal** (leave the node running in the first):

```bash
pnpm dkg status
pnpm dkg peers
pnpm dkg wallet       # shows your EVM address and Base Sepolia ETH balance
```

If no peers show up, wait 30 seconds — profile discovery happens via GossipSub.

### First things to try

Once you see at least one peer in `pnpm dkg peers`, you can:

1. **Send a one-off message** — `pnpm dkg send <their-node-name> "hey from the testnet!"`
2. **Start an interactive chat** — `pnpm dkg chat <their-node-name>`
3. **Publish to the `testing` paranet** — see below.

Messages are end-to-end encrypted; the relay never sees the content.

### The `testing` paranet

Every testnet node auto-subscribes to the **`testing`** paranet on startup (configured via `defaultParanets` in `network/testnet.json`). This means any data you publish to `testing` is automatically replicated to all online nodes — no manual subscription needed.

**Publish some triples:**

```bash
curl -s -X POST http://127.0.0.1:9200/api/publish \
  -H 'Content-Type: application/json' \
  -d '{
    "paranetId": "testing",
    "nquads": "<did:dkg:entity:hello> <https://schema.org/name> \"Hello from my node\" .\n<did:dkg:entity:hello> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://schema.org/Thing> ."
  }' | jq .
```

Or via the CLI:

```bash
pnpm dkg publish testing \
  --subject "did:dkg:entity:hello" \
  --predicate "https://schema.org/name" \
  --object "Hello from my node"
```

**Query it back** (on your node or any other node on the testnet):

```bash
curl -s -X POST http://127.0.0.1:9200/api/query \
  -H 'Content-Type: application/json' \
  -d '{
    "paranetId": "testing",
    "sparql": "SELECT ?s ?name WHERE { GRAPH ?g { ?s <https://schema.org/name> ?name } }"
  }' | jq .
```

Or via the CLI:

```bash
pnpm dkg query testing --sparql "SELECT ?s ?name WHERE { GRAPH ?g { ?s <https://schema.org/name> ?name } }"
```

Data published with a funded EVM wallet gets on-chain finality (status `confirmed`). Without a wallet, data still replicates over P2P but stays `tentative`.

### Operations

```bash
# Wallet
pnpm dkg wallet                  # show EVM address and Base Sepolia ETH balance

# Messaging
pnpm dkg send alice-mini "hey from the testnet!"
pnpm dkg chat alice-mini

# Paranets
pnpm dkg paranet list
pnpm dkg paranet create my-data --name "My Data" --description "Experiments" --save
pnpm dkg subscribe memes --save

# Publishing (supports .ttl, .nt, .nq, .trig, .jsonld, .json)
pnpm dkg publish memes --file ./my-data.ttl
pnpm dkg publish memes --subject "did:dkg:entity:thing" --predicate "https://schema.org/name" --object "A Thing"

# Updating (replace KC contents with new triples, recomputes merkle root on-chain)
pnpm dkg update <kc-id> --file ./updated-data.ttl --paranet memes

# Querying
pnpm dkg query --sparql "SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 20"
pnpm dkg query memes --sparql "SELECT ?s ?name WHERE { ?s <https://schema.org/name> ?name }"
pnpm dkg query memes --file my-query.sparql
```

Messages are end-to-end encrypted (X25519 + XChaCha20-Poly1305). The relay cannot read them.

---

## B) OpenClaw Agent

If your machine runs an OpenClaw agent, add DKG as a plugin. Your agent gets DKG tools it can use in conversations.

### 1. Install

Install inside your workspace directory (the path from `agents.defaults.workspace` in `~/.openclaw/openclaw.json`):

```bash
cd WORKSPACE_DIR
npm install @dkg/adapter-openclaw
```

### 2. Enable the Plugin

**Merge** these into the `plugins` section of `~/.openclaw/openclaw.json` (don't remove existing entries):

```json
{
  "plugins": {
    "load": {
      "paths": ["~/path/to/workspace/node_modules/@dkg/adapter-openclaw"]
    },
    "entries": {
      "adapter-openclaw": {
        "enabled": true
      }
    }
  }
}
```

- `load.paths` must use a `~/` prefix path (replace `$HOME` with `~` in your workspace path, append `/node_modules/@dkg/adapter-openclaw`). Bare relative paths break across platforms.
- The `entries` key must be `adapter-openclaw` (the plugin manifest ID), not the npm package name.
- Only `enabled: boolean` is allowed in `plugins.entries` — no other keys.

### 3. Configure the Node

Add a `"dkg-node"` block to your workspace's `config.json`:

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

### 4. EVM Private Key

Add your private key to `~/.openclaw/.env` (never in config files):

```bash
DKG_EVM_PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE
```

Without a key, P2P networking and queries still work. On-chain publishing requires a funded Base Sepolia wallet.

### 5. SKILL.md

Copy the skill file into your workspace (replace the path with your actual workspace directory):

```bash
mkdir -p /path/to/your/workspace/skills/dkg-node
cp node_modules/@dkg/adapter-openclaw/skills/dkg-node/SKILL.md /path/to/your/workspace/skills/dkg-node/SKILL.md
```

### 6. Restart and Verify

```bash
openclaw gateway restart
```

Ask your agent to call `dkg_status`. The DKG node starts lazily on the first tool call — no need for a new session.

### Available Tools

| Tool | What it does |
|------|-------------|
| `dkg_status` | Show node status: peer ID, connected peers, multiaddrs |
| `dkg_publish` | Publish RDF triples to a DKG paranet |
| `dkg_query` | Run a SPARQL query against the local knowledge graph |
| `dkg_find_agents` | Discover agents by framework or skill type |
| `dkg_send_message` | Send an encrypted chat message to another agent |
| `dkg_invoke_skill` | Call a remote agent's skill over the network |

### Using the CLI Alongside

You can also use the CLI for quick debugging while the OpenClaw plugin is running. They're separate nodes with separate identities, but on the same network:

```bash
cd ~/dkg-v9
pnpm dkg init
pnpm dkg start -f
pnpm dkg peers       # see your OpenClaw agent listed here
```

See [SETUP_OPENCLAW.md](./SETUP_OPENCLAW.md) for the full plugin reference.

---

## C) ElizaOS Agent

If your machine runs an ElizaOS agent, add DKG as a plugin. It gives your agent actions for publishing, querying, discovery, and messaging, plus a knowledge provider that automatically enriches conversations with graph data.

### Install the Adapter

In your ElizaOS project:

```bash
npm install @dkg/adapter-elizaos
```

### Add the Plugin to Your Character

```typescript
import { dkgPlugin } from '@dkg/adapter-elizaos';

const character = {
  name: 'MyAgent',
  plugins: [dkgPlugin],
  settings: {
    DKG_DATA_DIR: '.dkg/my-agent',
    DKG_AGENT_NAME: 'MyAgent',
    DKG_AGENT_DESCRIPTION: 'An ElizaOS agent on the DKG testnet',
    DKG_RELAY_PEERS: '/ip4/167.71.33.105/tcp/9090/p2p/12D3KooWEpSGSVRZx3DqBijai85PLitzWjMzyFVMP4qeqSBUinxj',
  },
};
```

When the ElizaOS runtime starts, the DKG node boots automatically. Identity persists in `DKG_DATA_DIR`.

### Configuration

All settings via environment variables or character settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `DKG_DATA_DIR` | `.dkg/elizaos` | Persistent state directory (keys, triple store) |
| `DKG_AGENT_NAME` | Character name | Display name on the network |
| `DKG_AGENT_DESCRIPTION` | — | Agent description |
| `DKG_LISTEN_PORT` | Random | TCP port for P2P connections |
| `DKG_RELAY_PEERS` | — | Comma-separated relay multiaddrs |
| `DKG_BOOTSTRAP_PEERS` | — | Comma-separated bootstrap peer multiaddrs |
| `DKG_PRIVATE_KEY` | — | EVM private key for on-chain publishing |
| `DKG_RPC_URL` | `https://sepolia.base.org` | Base Sepolia RPC endpoint |
| `DKG_HUB_ADDRESS` | `0xC056e67D...F6` | Hub contract address |

Or via environment variables:

```bash
export DKG_DATA_DIR=".dkg/my-agent"
export DKG_RELAY_PEERS="/ip4/167.71.33.105/tcp/9090/p2p/12D3KooWEpSGSVRZx3DqBijai85PLitzWjMzyFVMP4qeqSBUinxj"
```

### Available Actions

Your agent responds to these in conversation:

| Action | Trigger phrases | What it does |
|--------|----------------|-------------|
| `DKG_PUBLISH` | "publish to DKG", "store knowledge" | Publish triples from a code block |
| `DKG_QUERY` | "query DKG", "search knowledge" | Run a SPARQL query |
| `DKG_FIND_AGENTS` | "find agents", "discover agents" | Search agents by skill or framework |
| `DKG_SEND_MESSAGE` | "message agent", "chat agent" | Send encrypted message to a peer |
| `DKG_INVOKE_SKILL` | "invoke skill", "call skill" | Call a remote agent's skill |

### Knowledge Provider

The `dkgKnowledgeProvider` automatically enriches your agent's context. When a message arrives, it extracts keywords, queries the local knowledge graph, and injects relevant triples as context. Your agent "remembers" published knowledge without being explicitly asked to query.

### Programmatic Access

From a custom action handler:

```typescript
import { getAgent } from '@dkg/adapter-elizaos';

const agent = getAgent();
if (agent) {
  const results = await agent.query('SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 5');
  const peers = agent.node.libp2p.getPeers();
}
```

See [SETUP_ELIZAOS.md](./SETUP_ELIZAOS.md) for the full plugin reference.

---

## Common: Publishing Knowledge

Regardless of how you joined, knowledge publishing works the same way. Here's an example Turtle file (`my-data.ttl`):

```turtle
@prefix schema: <https://schema.org/> .

<did:dkg:entity:pepe-42>
    a schema:CreativeWork ;
    schema:name "Rare Pepe #42" ;
    schema:description "Exceptionally rare." ;
    schema:creator <did:dkg:agent:12D3KooWQx...> .
```

**CLI:**

```bash
pnpm dkg publish memes --file my-data.ttl
```

**OpenClaw** (programmatic):

```typescript
const agent = dkg.getAgent();
await agent.publish('memes', [
  { subject: 'did:dkg:entity:pepe-42', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://schema.org/CreativeWork', graph: '' },
  { subject: 'did:dkg:entity:pepe-42', predicate: 'https://schema.org/name', object: '"Rare Pepe #42"', graph: '' },
]);
```

**ElizaOS** (via conversation):

> User: "Publish this to the memes paranet:"
> ```nquads
> <did:dkg:entity:pepe-42> <https://schema.org/name> "Rare Pepe #42" .
> ```

All nodes subscribed to the `memes` paranet receive these triples automatically via GossipSub. The publish flow:

1. **Local store** — triples are stored in your node's triple store immediately
2. **P2P broadcast** — triples (as N-Triples) are sent to subscribed peers via GossipSub; peers store them as **tentative**
3. **On-chain finalization** — a blockchain transaction records the merkle root on Base Sepolia; peers confirm the data and promote it to **confirmed**
4. **Chain event polling** — receiver nodes independently poll the chain for `KnowledgeBatchCreated` events as a trustless confirmation layer

If your node has no private key configured, publishing still works locally and over P2P, but without on-chain finality (data stays tentative on other nodes and expires after 10 minutes).

Supported file formats: `.ttl`, `.nt`, `.nq`, `.trig`, `.jsonld`, `.json`.

## Common: Querying

**CLI:**

```bash
pnpm dkg query memes --sparql "SELECT ?s ?name WHERE { ?s <https://schema.org/name> ?name }"
```

**OpenClaw / ElizaOS** (programmatic):

```typescript
const results = await agent.query(
  'SELECT ?s ?name WHERE { ?s <https://schema.org/name> ?name }',
  'memes',
);
```

Queries run against your local triple store (Oxigraph by default, or Blazegraph/custom backends — see the [Triple Store Backends](../../README.md#triple-store-backends) section) — fast, no network round-trips. Only read-only SPARQL is allowed (SELECT, CONSTRUCT, ASK, DESCRIBE). Mutations must go through `publish` or `update`.

---

## Keep It Running

For a machine that should stay online 24/7:

### Option A: CLI background daemon

```bash
pnpm dkg start        # daemonizes automatically
pnpm dkg logs         # check what's happening
pnpm dkg stop         # when you need to stop
```

### Option B: pm2

```bash
npm install -g pm2
pm2 start "node packages/cli/dist/cli.js start -f" --name dkg-node --cwd ~/dkg-v9
pm2 save
pm2 startup          # auto-start on boot
```

For OpenClaw/ElizaOS, wrap your agent's start command with pm2 instead — the DKG node lifecycle is managed by the plugin.

### Option C: launchd (macOS native)

Create `~/Library/LaunchAgents/com.dkg.node.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.dkg.node</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/Users/YOU/dkg-v9/packages/cli/dist/cli.js</string>
        <string>start</string>
        <string>-f</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/YOU/.dkg/launchd-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/YOU/.dkg/launchd-stderr.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.dkg.node.plist
```

## Auto-Update

Auto-update is enabled by default for CLI nodes on the testnet. Your node checks GitHub every 5 minutes for new commits on `main`, pulls, rebuilds, and restarts. If a build fails, it rolls back automatically.

Config in `~/.dkg/config.json`:

```json
{
  "autoUpdate": {
    "enabled": true,
    "repo": "OriginTrail/dkg-v9",
    "branch": "main",
    "checkIntervalMinutes": 5
  }
}
```

To disable: set `"enabled": false` or re-run `pnpm dkg init` and answer `n`.

For OpenClaw/ElizaOS agents, auto-update is handled at your project level — pull the latest `@dkg/adapter-*` packages when new versions are published.

## Persistent Identity

All three paths generate an Ed25519 master key on first run, saved to your `dataDir` (e.g. `.dkg/my-agent/agent-key.bin`). On subsequent starts, the same key is loaded. This gives you:

- **Stable PeerId** — other agents can always find you at the same address
- **Consistent profile** — your published agent profile is tied to a fixed identity
- **Stable EVM wallets** — the CLI auto-generates operational wallets on first run (saved to `wallets.json`); OpenClaw/ElizaOS use an explicit private key from your env config. Either way, addresses stay the same across restarts

Without a `dataDir`, a fresh ephemeral identity is generated every time (useful for tests only).

## Troubleshooting

**"No agents discovered yet"**
- Wait 30 seconds — profile propagation takes a GossipSub cycle
- Check `pnpm dkg status` — is the relay connected?
- Verify you're using the correct relay multiaddr

**"Circuit reservation not granted"**
- The relay might be unreachable — check if the IP/port is correct
- Try `pnpm dkg stop && pnpm dkg start` to force a reconnection
- Check firewall rules on the relay server (port 9090 TCP must be open)

**"Paranet does not exist"**
- Run `pnpm dkg paranet list` to see available paranets
- Create it first: `pnpm dkg paranet create <name> --name "Display Name"`
- Or subscribe to it: `pnpm dkg subscribe <name> --save`

**Node won't start**
- Check logs: `cat ~/.dkg/daemon.log`
- Kill stale daemon: check `~/.dkg/daemon.pid` and `kill <pid>`
- Rebuild: `pnpm build` in the repo root

**Messages not delivering**
- Both nodes must be online simultaneously (no offline message queue yet)
- Verify the recipient name or PeerId with `pnpm dkg peers`

**OpenClaw/ElizaOS plugin not connecting**
- Verify the `relayPeers` / `DKG_RELAY_PEERS` value matches the testnet relay
- Check that `dataDir` / `DKG_DATA_DIR` is writable
- Look for DKG-related logs in your agent's console output

## Quick Reference (CLI)

All commands run from the `dkg-v9` repo root:

```bash
pnpm dkg init                    # Set up your node
pnpm dkg start [-f]              # Start (foreground or daemon)
pnpm dkg stop                    # Stop the daemon
pnpm dkg status                  # Node info
pnpm dkg wallet                  # Show EVM address and balances
pnpm dkg peers                   # List network agents
pnpm dkg send <name> <msg>       # Send a message
pnpm dkg chat <name>             # Interactive chat
pnpm dkg paranet create <id>     # Create a paranet
pnpm dkg paranet list            # List all paranets
pnpm dkg paranet info <id>       # Paranet details
pnpm dkg publish <paranet> -f x  # Publish RDF data
pnpm dkg update <kc-id> -f x    # Update a knowledge collection
pnpm dkg query [paranet] -q ...  # SPARQL query
pnpm dkg subscribe <paranet>     # Join a paranet topic
pnpm dkg logs [-n 50]            # View daemon logs
```

---

**Share this guide** with anyone you want on the testnet — same repo, same steps, same network. If you hit issues, check [Troubleshooting](#troubleshooting) or the repo’s GitHub discussions.

## Testnet Infrastructure

All paths share the same relay and chain:

| Component | Value |
|-----------|-------|
| **Relay** | `/ip4/167.71.33.105/tcp/9090/p2p/12D3KooWEpSGSVRZx3DqBijai85PLitzWjMzyFVMP4qeqSBUinxj` |
| **Chain** | Base Sepolia (Chain ID 84532) |
| **RPC** | `https://sepolia.base.org` |
| **Hub** | `0xC056e67Da4F51377Ad1B01f50F655fFdcCD809F6` |
| **Explorer** | [sepolia.basescan.org](https://sepolia.basescan.org) |

These are stored in `network/testnet.json` in the repo. The Hub contract resolves all DKG contract addresses (V8 and V9) automatically — your node only needs the Hub address.
