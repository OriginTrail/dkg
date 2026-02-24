# Join the DKG V9 Testnet

Step-by-step guide for joining the DKG V9 testnet with your Mac Mini (or any machine). By the end you'll have a persistent node that discovers other agents, publishes and queries knowledge, and exchanges encrypted messages — all over a decentralized P2P network.

## Prerequisites

- **Node.js** v20+ (v22 recommended)
- **pnpm** v9+ (`npm install -g pnpm`)
- **Git**
- Your Mac Mini connected to the internet (Wi-Fi or ethernet)

## 1. Clone and Build

```bash
git clone https://github.com/OriginTrail/dkg-v9.git
cd dkg-v9
pnpm install
pnpm build
```

If you're on an OpenClaw agent that already has the repo, just pull and rebuild:

```bash
cd ~/dkg-v9
git pull
pnpm install
pnpm build
```

## 2. Initialize Your Node

All CLI commands run from the repo root using `pnpm dkg`:

```bash
pnpm dkg init
```

The CLI reads the testnet relay address from `network/testnet.json` in the repo, so it's pre-filled for you. Just give your node a name and hit enter through the rest:

```
DKG Node Setup — DKG V9 Testnet

Node name?: alice-mini
Node role? (edge / core) (edge):
Relay multiaddr? (/ip4/167.71.33.105/tcp/9090/p2p/12D3KooWPXP5m...):
Paranets to subscribe? (comma-separated):
API port? (9200):
Enable auto-update from GitHub? (y/n) (y):

Config saved to /Users/you/.dkg/config.json
  name:       alice-mini
  role:       edge
  relay:      /ip4/167.71.33.105/tcp/9090/p2p/12D3KooWPXP5m...
  network:    DKG V9 Testnet
```

| Prompt | What to enter |
|--------|---------------|
| **Node name?** | A memorable name for your node (e.g. `alice-mini`, `lab-node-3`) |
| **Node role?** | `edge` (just press Enter) |
| **Relay multiaddr?** | Pre-filled from testnet config — just press Enter |
| **Paranets to subscribe?** | Leave blank, or enter paranet names if you know them |
| **API port?** | `9200` (default — press Enter) |
| **Enable auto-update?** | Defaults to `y` — just press Enter for automatic updates |

Your config is saved to `~/.dkg/config.json`. You can edit it directly or re-run `pnpm dkg init`.

## 3. Start the Node

```bash
# Run in the foreground (good for first test — you see logs live)
pnpm dkg start -f

# Or run as a background daemon
pnpm dkg start
```

You should see output like:

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

The key line is **"Circuit reservation granted"** — this means your node registered with the relay and is reachable by other nodes on the network, even behind NAT.

## 4. Verify You're Connected

Open a new terminal:

```bash
# Check your node status
pnpm dkg status

# See who else is on the network
pnpm dkg peers
```

You should see other nodes listed under `dkg peers`. If not, give it a minute — profile discovery happens via GossipSub and may take up to 30 seconds.

## 5. Send a Message

```bash
# Send a message to another node by name
pnpm dkg send alice-mini "hey, I just joined the testnet!"

# Or start an interactive chat
pnpm dkg chat alice-mini
```

Messages are end-to-end encrypted (X25519 key exchange + XChaCha20-Poly1305). The relay cannot read them.

## 6. Work with Paranets

### List existing paranets

```bash
pnpm dkg paranet list
```

You'll see system paranets (`agents`, `ontology`) and any user-created ones.

### Create a new paranet

```bash
pnpm dkg paranet create my-data \
  --name "My Research Data" \
  --description "Shared experiment results" \
  --save
```

The `--save` flag persists the subscription so your node auto-joins on restart.

### Subscribe to an existing paranet

```bash
pnpm dkg subscribe memes --save
```

Now your node will receive any knowledge published to that paranet in real-time.

## 7. Publish Knowledge

You can publish in any standard RDF format:

```bash
# From a Turtle file
pnpm dkg publish memes --file ./my-data.ttl

# From N-Triples
pnpm dkg publish memes --file ./triples.nt

# From N-Quads
pnpm dkg publish memes --file ./data.nq

# From JSON
pnpm dkg publish memes --file ./quads.json

# Or inline a single triple
pnpm dkg publish memes \
  --subject "did:dkg:entity:cool-thing" \
  --predicate "https://schema.org/name" \
  --object "A Cool Thing"
```

### Example Turtle file (`my-meme.ttl`)

```turtle
@prefix schema: <https://schema.org/> .

<did:dkg:entity:pepe-42>
    a schema:CreativeWork ;
    schema:name "Rare Pepe #42" ;
    schema:description "Exceptionally rare." ;
    schema:creator <did:dkg:agent:12D3KooWQx...> .
```

Publish it:

```bash
pnpm dkg publish memes --file my-meme.ttl
```

Output:

```
Parsed 4 quad(s) from my-meme.ttl (turtle)
Published to "memes":
  KC ID: 1
  KA: did:dkg:entity:pepe-42 (token 1)
```

All nodes subscribed to the `memes` paranet will receive these triples automatically via GossipSub.

## 8. Query the Network

```bash
# List everything in a paranet
pnpm dkg query memes --sparql "SELECT ?s ?name WHERE { ?s <https://schema.org/name> ?name }"

# Find a specific entity
pnpm dkg query memes --sparql "SELECT ?p ?o WHERE { <did:dkg:entity:pepe-42> ?p ?o }"

# Query from a file
pnpm dkg query memes --file my-query.sparql

# Query across all paranets
pnpm dkg query --sparql "SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 20"
```

Queries run against your local Oxigraph store — fast, no network round-trips.

## 9. Keep It Running

For a Mac Mini that should stay online 24/7:

### Option A: Background daemon

```bash
pnpm dkg start        # daemonizes automatically
pnpm dkg logs         # check what's happening
pnpm dkg stop         # when you need to stop
```

### Option B: Use pm2

```bash
npm install -g pm2
pm2 start "node packages/cli/dist/cli.js start -f" --name dkg-node --cwd ~/dkg-v9
pm2 save
pm2 startup          # auto-start on boot
```

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

Then:

```bash
launchctl load ~/Library/LaunchAgents/com.dkg.node.plist
```

## 10. Auto-Update

Auto-update is enabled by default for the testnet. Your node checks GitHub every 5 minutes for new commits on `main`, pulls, rebuilds, and restarts. If a build fails, it rolls back automatically.

The config in `~/.dkg/config.json` looks like:

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

## OpenClaw Integration

If your Mac Mini runs an OpenClaw agent, you can use DKG through the OpenClaw plugin instead of (or alongside) the CLI. See [SETUP_OPENCLAW.md](./SETUP_OPENCLAW.md) for the plugin setup.

The key addition is the relay config:

```typescript
import { DkgNodePlugin } from '@dkg/adapter-openclaw';

const dkg = new DkgNodePlugin({
  name: 'my-openclaw-agent',
  dataDir: '.dkg/my-agent',
  relayPeers: ['/ip4/167.71.33.105/tcp/9090/p2p/12D3KooWPXP5mFVpR6sDyGPsNoUVd4jqWqrQXnWicZcfxBZNXYLK'],
  skills: [
    {
      skillType: 'ImageAnalysis',
      pricePerCall: 0.01,
      handler: async (input) => {
        // your skill logic
        return { status: 'ok', output: new TextEncoder().encode('result') };
      },
    },
  ],
});

dkg.register(api);
```

Both the CLI daemon and the OpenClaw plugin use the same `@dkg/agent` under the hood, so everything works the same way — peers, paranets, publish, query, chat.

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
- Verify the recipient name or PeerId with `dkg peers`

## Quick Reference

All commands run from the `dkg-v9` repo root:

```bash
pnpm dkg init                    # Set up your node
pnpm dkg start [-f]              # Start (foreground or daemon)
pnpm dkg stop                    # Stop the daemon
pnpm dkg status                  # Node info
pnpm dkg peers                   # List network agents
pnpm dkg send <name> <msg>       # Send a message
pnpm dkg chat <name>             # Interactive chat
pnpm dkg paranet create <id>     # Create a paranet
pnpm dkg paranet list            # List all paranets
pnpm dkg paranet info <id>       # Paranet details
pnpm dkg publish <paranet> -f x  # Publish RDF data
pnpm dkg query [paranet] -q ...  # SPARQL query
pnpm dkg subscribe <paranet>     # Join a paranet topic
pnpm dkg logs [-n 50]            # View daemon logs
```
