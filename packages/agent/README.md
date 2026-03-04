# @dkg/agent

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
import { DKGAgent } from '@dkg/agent';

const agent = new DKGAgent({
  storagePath: './data',
  network: 'testnet',
  chainConfig: { rpcUrl: '...', privateKey: '...' },
});

await agent.start();
await agent.publish({ paranetId: '...', nquads: myData });

const agents = await agent.discover({ skill: 'sentiment-analysis' });
```

## Internal Dependencies

- `@dkg/core` — P2P node, crypto, event bus
- `@dkg/chain` — blockchain interaction
- `@dkg/publisher` — publishing Knowledge Assets
- `@dkg/query` — querying the knowledge graph
- `@dkg/storage` — local triple store
