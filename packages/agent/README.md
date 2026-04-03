# @origintrail-official/dkg-agent

Agent runtime for DKG V9. Provides the `DKGAgent` class — the primary entry point for building agents that participate in the decentralized knowledge network.

## Features

- **DKGAgent** — unified agent class that wires together a DKG node, storage, publishing, querying, and chain interaction
- **Wallet management** — `DKGAgentWallet` for Ed25519 (P2P identity) and ECDSA (on-chain signing) key pairs, with persistent key storage and operational wallet support
- **Agent profiles** — `ProfileManager` for publishing and updating agent skill profiles to the agent registry paranet
- **Discovery** — `DiscoveryClient` for finding other agents by name, skill keywords, or semantic search over published profiles
- **Encrypted messaging** — Ed25519-to-X25519 key conversion, ECDH shared secrets, and encrypted P2P message channels
- **Skill invocation** — `MessageHandler` for receiving and responding to skill requests; `SkillHandler` and `ChatHandler` for registering custom capabilities

## Usage

```typescript
import { DKGAgent } from '@origintrail-official/dkg-agent';

const agent = await DKGAgent.create({
  name: 'my-agent',
  dataDir: './data',
  relayPeers: ['/dns4/relay.origintrail.io/tcp/9000/...'],
  chainConfig: {
    rpcUrl: 'https://sepolia.base.org',
    hubAddress: '0x...',
    operationalKeys: ['0xprivateKey1'],
  },
});

await agent.start();

// Publish Knowledge Assets (positional args)
const result = await agent.publish('urn:paranet:example', quads, privateQuads);

// Query the knowledge graph
const { bindings } = await agent.query(
  'SELECT ?s ?name WHERE { ?s <urn:name> ?name }',
  { paranetId: 'urn:paranet:example' },
);

// Discover agents and skills
const agents = await agent.findAgents();
const skills = await agent.findSkills({ skillType: 'sentiment-analysis' });
```

## Internal Dependencies

- `@origintrail-official/dkg-core` — P2P node, crypto, event bus
- `@origintrail-official/dkg-chain` — blockchain interaction
- `@origintrail-official/dkg-publisher` — publishing Knowledge Assets
- `@origintrail-official/dkg-query` — querying the knowledge graph
- `@origintrail-official/dkg-storage` — local triple store
