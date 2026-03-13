# Agent Lifecycle

How a DKG agent boots, joins the network, and shuts down. Relevant for
developers integrating the DKG into their own agents (e.g. OpenClaw, ElizaOS).

## Sequence diagram

```mermaid
sequenceDiagram
    actor Dev as Developer / Framework
    participant Agent as @origintrail-official/dkg-agent<br/>DKGAgent
    participant Wallet as @origintrail-official/dkg-agent<br/>AgentWallet
    participant Node as @origintrail-official/dkg-core<br/>DKGNode
    participant Store as @origintrail-official/dkg-storage<br/>TripleStore
    participant Chain as @origintrail-official/dkg-chain<br/>EVMChainAdapter
    participant EVM as EVM Blockchain
    participant Gossip as @origintrail-official/dkg-core<br/>GossipSub
    participant Peers as DKG Network

    Note over Dev,Peers: Phase 1 — Initialization

    Dev ->> Agent: DKGAgent.create(config)
    Agent ->> Agent: Generate operationId (connect)

    alt dataDir exists
        Agent ->> Wallet: AgentWallet.load(dataDir)
        Wallet -->> Agent: Existing Ed25519 + X25519 keypairs
    else First run
        Agent ->> Wallet: AgentWallet.generate()
        Wallet -->> Agent: New keypairs
        Agent ->> Wallet: wallet.save(dataDir)
    end

    Agent ->> Store: new OxigraphStore() or configured backend
    Agent ->> Store: Load genesis triples (ontology + system paranets)

    alt Chain config provided
        Agent ->> Chain: new EVMChainAdapter(rpcUrl, key, hub)
        Note right of Chain: Resolves contracts from Hub<br/>on first use (lazy init)
    else No chain config
        Agent ->> Agent: Use NoChainAdapter (offline mode)
        Note right of Agent: P2P and local queries work<br/>On-chain operations throw
    end

    Agent ->> Node: new DKGNode(listenAddresses, bootstrapPeers)
    Agent -->> Dev: DKGAgent instance (not yet started)

    Note over Dev,Peers: Phase 2 — Network Join

    Dev ->> Agent: agent.start()
    Agent ->> Node: node.start()
    Node ->> Node: Create libp2p host
    Node ->> Node: Listen on TCP + WebSocket
    Node -->> Agent: PeerId assigned

    Agent ->> Agent: Register protocol handlers
    Note right of Agent: /dkg/publish/1.0.0<br/>/dkg/access/1.0.0

    Agent ->> Gossip: Subscribe to paranet topics
    Note right of Gossip: dkg/paranet/id/publish<br/>for each configured paranet

    opt bootstrapPeers configured
        Node ->> Peers: Connect to bootstrap nodes
        Peers -->> Node: Peer connections established
        Node ->> Peers: mDNS / relay discovery
    end

    Agent -->> Dev: Ready

    Note over Dev,Peers: Phase 3 — Steady State

    Dev ->> Agent: agent.publish(paranetId, triples)
    Dev ->> Agent: agent.query(sparql, paranetId)
    Dev ->> Agent: agent.update(kcId, paranetId, triples)

    Note right of Agent: GossipSub messages arrive<br/>Publish handler processes<br/>incoming data from peers

    Note over Dev,Peers: Phase 4 — Shutdown

    Dev ->> Agent: agent.stop()
    Agent ->> Gossip: Unsubscribe from all topics
    Agent ->> Node: node.stop()
    Node ->> Peers: Graceful disconnect
    Agent ->> Store: store.close()
    Agent -->> Dev: Stopped
```

## Configuration reference

```typescript
interface DKGAgentConfig {
  // Network
  listenAddresses?: string[];      // Default: random TCP + WS ports
  bootstrapPeers?: string[];       // DKG bootstrap multiaddrs
  enableMdns?: boolean;            // Default: true (local discovery)
  nodeRole?: 'core' | 'edge';     // Default: 'edge'

  // Chain (optional — omit for offline mode)
  chain?: {
    rpcUrl: string;                // e.g. https://sepolia.base.org
    privateKey: string;            // 0x-prefixed hex
    hubAddress: string;            // Hub contract address
  };

  // Storage
  dataDir?: string;                // Persistent data directory
  store?: TripleStore;             // Custom store (default: Oxigraph)

  // Identity
  publisherPrivateKey?: string;    // EVM key for on-chain publishing
}
```

## Integration example (OpenClaw / ElizaOS)

```typescript
import { DKGAgent } from '@origintrail-official/dkg-agent';

const agent = await DKGAgent.create({
  dataDir: './my-agent-data',
  bootstrapPeers: ['/dns4/bootstrap.dkg.io/tcp/9000/...'],
  chain: {
    rpcUrl: 'https://sepolia.base.org',
    privateKey: process.env.EVM_KEY!,
    hubAddress: '0x...',
  },
});

await agent.start();

// Publish knowledge
const result = await agent.publish('my-paranet', [
  { subject: 'https://example.org/Alice', predicate: 'http://schema.org/name', object: '"Alice"', graph: '' },
]);

// Query knowledge
const query = await agent.query('SELECT ?name WHERE { ?s <http://schema.org/name> ?name }', 'my-paranet');

await agent.stop();
```
