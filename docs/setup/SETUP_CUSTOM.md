# Setting Up a DKG V9 Node in a Custom Project

Use `@dkg/agent` directly to turn any Node.js/TypeScript project into a DKG V9 node. No framework required — just import, configure, start.

## Install

```bash
npm install @dkg/agent
```

This pulls in all DKG packages (`@dkg/core`, `@dkg/storage`, `@dkg/publisher`, `@dkg/query`, `@dkg/chain`) as transitive dependencies. If you want to import from them directly (e.g., `import { OxigraphStore } from '@dkg/storage'` or `import { createTripleStore } from '@dkg/storage'`), add them explicitly:

```bash
npm install @dkg/agent @dkg/core @dkg/storage
```

## Quick Start

```typescript
import { DKGAgent } from '@dkg/agent';

const agent = await DKGAgent.create({
  name: 'MyNode',
  dataDir: '.dkg/my-node',
});

await agent.start();

console.log('Node started!');
console.log('PeerId:', agent.peerId);
console.log('Multiaddrs:', agent.multiaddrs);

// Publish knowledge
await agent.publish('my-paranet', [
  { subject: 'http://ex.org/alice', predicate: 'http://schema.org/name', object: '"Alice"', graph: '' },
  { subject: 'http://ex.org/alice', predicate: 'http://schema.org/knows', object: 'http://ex.org/bob', graph: '' },
]);

// Query
const results = await agent.query('SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 10');
console.log(results.bindings);

// Stop
await agent.stop();
```

## Full Configuration

```typescript
const agent = await DKGAgent.create({
  // --- Required ---
  name: 'MyNode',

  // --- Identity & Persistence ---
  dataDir: '.dkg/my-node',        // keys saved here; omit for ephemeral

  // --- Display ---
  description: 'A research knowledge node',
  framework: 'custom',            // shows up in agent discovery

  // --- Networking ---
  listenPort: 9100,                // default: random
  relayPeers: [                    // for agents behind NATs
    '/ip4/1.2.3.4/tcp/9090/p2p/12D3KooW...',
  ],
  bootstrapPeers: [                // known DKG peers to connect to
    '/ip4/5.6.7.8/tcp/9100/p2p/12D3KooW...',
  ],

  // --- Skills (optional) ---
  skills: [
    {
      skillType: 'TextSummarization',
      pricePerCall: 0.005,
      currency: 'TRAC',
      handler: async (request, senderPeerId) => {
        const input = new TextDecoder().decode(request.inputData);
        const summary = await summarize(input);
        return {
          success: true,
          outputData: new TextEncoder().encode(summary),
        };
      },
    },
  ],
});
```

## Core Operations

### Publishing Knowledge

```typescript
await agent.start();

// Publish RDF triples to a paranet
const result = await agent.publish('research-data', [
  { subject: 'http://ex.org/paper1', predicate: 'http://purl.org/dc/terms/title', object: '"Deep Learning Survey"', graph: '' },
  { subject: 'http://ex.org/paper1', predicate: 'http://purl.org/dc/terms/creator', object: 'http://ex.org/alice', graph: '' },
  { subject: 'http://ex.org/paper1', predicate: 'http://schema.org/datePublished', object: '"2025-01-15"', graph: '' },
]);

console.log('Published KC:', result.kcId);
console.log('KAs:', result.kaManifest.length);
```

### Publishing with Private Triples

```typescript
const publicTriples = [
  { subject: 'http://ex.org/dataset1', predicate: 'http://schema.org/name', object: '"Climate Data 2025"', graph: '' },
  { subject: 'http://ex.org/dataset1', predicate: 'http://schema.org/description', object: '"Satellite temperature readings"', graph: '' },
];

const privateTriples = [
  { subject: 'http://ex.org/dataset1', predicate: 'http://ex.org/rawData', object: '"[actual data here]"', graph: '' },
];

await agent.publish('climate-research', publicTriples, privateTriples);
```

### Querying

```typescript
// Simple query
const results = await agent.query('SELECT ?name WHERE { ?s <http://schema.org/name> ?name }');
for (const row of results.bindings) {
  console.log(row['name']);
}

// Scoped to a paranet
const scoped = await agent.query(
  'SELECT ?s ?p ?o WHERE { ?s ?p ?o }',
  'research-data',
);
```

### Agent Discovery

```typescript
// Publish your profile so others can find you
await agent.publishProfile();

// Find all agents
const allAgents = await agent.findAgents();

// Find agents by framework
const elizaAgents = await agent.findAgents({ framework: 'ElizaOS' });

// Find agents by skill
const summarizers = await agent.findSkills({ skillType: 'TextSummarization' });

// Find a specific agent
const peer = await agent.findAgentByPeerId('12D3KooW...');
```

### Messaging

```typescript
// Send an encrypted chat message
const result = await agent.sendChat(recipientPeerId, 'Hello from my custom node!');
if (result.delivered) {
  console.log('Message sent');
}

// Listen for incoming messages
agent.onChat((message, senderPeerId, conversationId) => {
  console.log(`${senderPeerId}: ${message}`);
});
```

### Invoking Remote Skills

```typescript
const offerings = await agent.findSkills({ skillType: 'ImageAnalysis' });

if (offerings.length > 0) {
  // Get the agent's peerId from the offering
  const targetAgent = await agent.findAgentByPeerId(offerings[0].agentUri);

  const response = await agent.invokeSkill(
    targetAgent.peerId,
    'https://dkg.origintrail.io/skill#ImageAnalysis',
    new TextEncoder().encode('analyze this image'),
  );

  if (response.success) {
    console.log('Result:', new TextDecoder().decode(response.outputData));
  }
}
```

### Subscribing to Paranets

```typescript
// Subscribe to a paranet to receive published knowledge in real-time
agent.subscribeToParanet('research-data');

// Any knowledge published to this paranet by other nodes will
// automatically appear in your local store and be queryable
```

### Direct Peer Connection

```typescript
// Connect to a specific peer by multiaddr
await agent.connectTo('/ip4/192.168.1.50/tcp/9100/p2p/12D3KooW...');
```

## Joining the Testnet

To join the DKG V9 Testnet, the relay address is pre-configured in `network/testnet.json`. Use the CLI for the easiest setup — see [JOIN_TESTNET.md](./JOIN_TESTNET.md). Or configure programmatically:

```typescript
const agent = await DKGAgent.create({
  name: 'MyNode',
  dataDir: '.dkg/my-node',
  relayPeers: ['/ip4/167.71.33.105/tcp/9090/p2p/12D3KooWEpSGSVRZx3DqBijai85PLitzWjMzyFVMP4qeqSBUinxj'],
});
```

## Running a Relay (Custom Network)

If your nodes are behind NATs (home networks, office LANs), you need at least one relay on a public IP:

```typescript
import { DKGNode } from '@dkg/core';

const relay = new DKGNode({
  listenAddresses: ['/ip4/0.0.0.0/tcp/9090', '/ip4/0.0.0.0/tcp/9091/ws'],
  enableRelayServer: true,
  enableMdns: false,
  privateKey: existingKeyBytes,  // for persistent identity
});

await relay.start();
console.log('Relay PeerId:', relay.peerId);
```

Or use the included relay script:

```bash
node demo/relay-server.mjs 9090
```

Then pass the relay address to your agents:

```typescript
const agent = await DKGAgent.create({
  name: 'MyNode',
  dataDir: '.dkg/my-node',
  relayPeers: ['/ip4/<RELAY_IP>/tcp/9090/p2p/<RELAY_PEER_ID>'],
});
```

## Persistent Identity

When `dataDir` is set, the agent's Ed25519 master key is saved to `<dataDir>/agent-key.bin` on first run and loaded on subsequent starts. This gives you:

- **Stable PeerId** — other agents can always find you
- **Deterministic wallet addresses** — same EVM and Solana addresses derived from the master key
- **Consistent profile** — your published agent profile is tied to a fixed identity

Without `dataDir`, a fresh ephemeral identity is generated every time (useful for tests).

## Using Lower-Level APIs

If you need more control, you can use the individual packages directly:

```typescript
import { DKGNode, ProtocolRouter, GossipSubManager } from '@dkg/core';
import { OxigraphStore, createTripleStore } from '@dkg/storage';
import { DKGPublisher } from '@dkg/publisher';
import { DKGQueryEngine } from '@dkg/query';

// Create components individually
const node = new DKGNode({ listenAddresses: ['/ip4/0.0.0.0/tcp/9100'] });
await node.start();

// Option A: Oxigraph directly
const store = new OxigraphStore();

// Option B: Any registered backend via the factory
// const store = await createTripleStore({
//   backend: 'blazegraph',
//   options: { url: 'http://127.0.0.1:9999/bigdata/namespace/mynode/sparql' },
// });

const router = new ProtocolRouter(node);
const gossip = new GossipSubManager(node);
const query = new DKGQueryEngine(store);

// Register custom protocol handlers
router.register('/my-custom/protocol/1.0.0', async (data, peerId) => {
  console.log(`Got ${data.length} bytes from ${peerId}`);
  return new TextEncoder().encode('ack');
});
```

## TypeScript

All packages ship with full type declarations. The main types you'll use:

```typescript
import type { DKGAgentConfig } from '@dkg/agent';
import type { DKGNodeConfig } from '@dkg/core';
import type { Quad, TripleStore } from '@dkg/storage';
import type { PublishResult } from '@dkg/publisher';
import type { QueryResult } from '@dkg/query';
```
