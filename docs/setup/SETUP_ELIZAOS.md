# Setting Up DKG V9 with ElizaOS

Turn your ElizaOS agent into a DKG V9 node. The plugin adds actions your agent can invoke (publish, query, discover, message, invoke skills), a knowledge provider that enriches conversations with graph data, and a service that manages the DKG node lifecycle.

## Install

```bash
npm install @origintrail-official/dkg-adapter-elizaos
```

This pulls in `@origintrail-official/dkg-agent` and all core DKG packages (`@origintrail-official/dkg-core`, `@origintrail-official/dkg-storage`, etc.) as transitive dependencies.

## Quick Start

### 1. Add the Plugin to Your Character

```typescript
import { dkgPlugin } from '@origintrail-official/dkg-adapter-elizaos';

const character = {
  name: 'MyAgent',
  plugins: [dkgPlugin],
  settings: {
    DKG_DATA_DIR: '.dkg/my-agent',
    DKG_AGENT_NAME: 'MyAgent',
    DKG_AGENT_DESCRIPTION: 'An ElizaOS agent with knowledge graph superpowers',
  },
};
```

That's it. When the ElizaOS runtime initializes, the DKG node starts automatically. Your agent's identity persists in the data directory.

## Configuration

All configuration is via ElizaOS runtime settings (environment variables or character settings):

| Setting | Required | Default | Description |
|---|---|---|---|
| `DKG_DATA_DIR` | No | `.dkg/elizaos` | Persistent state directory (keys, triple store) |
| `DKG_AGENT_NAME` | No | Character name | Agent display name on the network |
| `DKG_AGENT_DESCRIPTION` | No | — | Agent description |
| `DKG_LISTEN_PORT` | No | Random | TCP port for P2P connections |
| `DKG_RELAY_PEERS` | No | — | Comma-separated relay multiaddrs for NAT traversal |
| `DKG_BOOTSTRAP_PEERS` | No | — | Comma-separated bootstrap peer multiaddrs |

### Example with Environment Variables

```bash
export DKG_DATA_DIR=".dkg/my-agent"
export DKG_RELAY_PEERS="/ip4/1.2.3.4/tcp/9090/p2p/12D3KooW..."
export DKG_BOOTSTRAP_PEERS="/ip4/5.6.7.8/tcp/9100/p2p/12D3KooW..."
```

### Example with Character Settings

```typescript
const character = {
  name: 'ResearchBot',
  plugins: [dkgPlugin],
  settings: {
    DKG_DATA_DIR: '.dkg/research-bot',
    DKG_RELAY_PEERS: '/ip4/1.2.3.4/tcp/9090/p2p/12D3KooW...',
  },
};
```

## What the Plugin Provides

### Actions

Your agent can use these actions in conversations:

| Action | Trigger phrases | What it does |
|---|---|---|
| `DKG_PUBLISH` | "publish to DKG", "store knowledge" | Publish N-Quads triples from a code block |
| `DKG_QUERY` | "query DKG", "search knowledge" | Run a SPARQL query (in code block or inline) |
| `DKG_FIND_AGENTS` | "find agents", "discover agents" | Search for agents by skill or framework |
| `DKG_SEND_MESSAGE` | "message agent", "chat agent" | Send encrypted message to a peer |
| `DKG_INVOKE_SKILL` | "invoke skill", "call skill" | Call a remote agent's skill |

### Knowledge Provider

The `dkgKnowledgeProvider` automatically enriches your agent's context. When a message comes in, it extracts keywords, queries the local knowledge graph, and injects any relevant triples as additional context. This means your agent "remembers" published knowledge without being explicitly asked to query.

### Service

The `dkgService` handles the DKG node lifecycle:
- **Initialize**: Creates and starts the DKG agent, publishes its profile
- **Cleanup**: Stops the node gracefully

## Usage Examples

### Publishing Knowledge

User says:
```
Publish this to the DKG:
```nquads
<http://ex.org/alice> <http://schema.org/name> "Alice" .
<http://ex.org/alice> <http://schema.org/knows> <http://ex.org/bob> .
```
```

Agent responds: *"Published 2 triple(s) to paranet 'default'."*

### Querying

User says:
```
Query the DKG:
```sparql
SELECT ?name WHERE {
  ?person <http://schema.org/name> ?name
} LIMIT 10
```
```

Agent responds with the results.

### Discovering Agents

User says: *"Find agents with skill: ImageAnalysis"*

Agent responds with a list of matching agents and their pricing.

## Programmatic Access

If you need the DKG agent instance directly (e.g., from a custom action):

```typescript
import { getAgent } from '@origintrail-official/dkg-adapter-elizaos';

// Inside a custom action handler
const agent = getAgent();
if (agent) {
  const results = await agent.query('SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 5');
  const peers = agent.node.libp2p.getPeers();
}
```

## Joining the Testnet

To join the DKG V9 Testnet, the relay address is pre-configured in the repo. See [JOIN_TESTNET.md](./JOIN_TESTNET.md) for the full walkthrough.

```typescript
settings: {
  DKG_RELAY_PEERS: '/ip4/167.71.33.105/tcp/9090/p2p/12D3KooWEpSGSVRZx3DqBijai85PLitzWjMzyFVMP4qeqSBUinxj',
}
```

## Cross-Network Setup (Custom Relay)

For a private network or your own relay:

```bash
# On a VPS with public IP
node demo/relay-server.mjs 9090
```

Then configure:

```typescript
settings: {
  DKG_RELAY_PEERS: '/ip4/<RELAY_PUBLIC_IP>/tcp/9090/p2p/<RELAY_PEER_ID>',
}
```

Multiple relays can be specified as a comma-separated list for redundancy.

## Persistent Identity

The first time the service initializes, a new Ed25519 master key is generated and saved to `<DKG_DATA_DIR>/agent-key.bin`. On subsequent starts, the same key is loaded. Your agent keeps the same PeerId, the same on-chain wallet addresses, and the same identity on the network.
