# @dkg/chain

Blockchain abstraction layer for DKG V9. Provides a `ChainAdapter` interface with implementations for EVM chains and testing.

## Features

- **ChainAdapter interface** — unified API for on-chain operations (KC creation, paranet management, staking, token transfers)
- **EVMChainAdapter** — production adapter using ethers.js to interact with deployed DKG smart contracts on EVM chains (Base Sepolia, etc.)
- **MockChainAdapter** — in-memory mock for unit and integration testing without a blockchain
- **NoChainAdapter** — no-op adapter for workspace/feeless publishing mode where chain interaction is not needed

## Usage

```typescript
import { EVMChainAdapter } from '@dkg/chain';

const chain = new EVMChainAdapter({
  rpcUrl: 'https://sepolia.base.org',
  privateKey: process.env.PRIVATE_KEY,
  hubAddress: '0x...',
});

const tx = await chain.createKnowledgeCollection(merkleRoot, size, epochs);
```

## Internal Dependencies

- `@dkg/core` — configuration types, logging
- `@dkg/evm-module` — contract ABIs for DKG smart contracts
