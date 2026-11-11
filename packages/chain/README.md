# @origintrail-official/dkg-chain

Blockchain abstraction layer for DKG V10. Provides a `ChainAdapter` interface with implementations for EVM chains and testing.

## Features

- **ChainAdapter interface** — unified API for on-chain operations (KC creation, contextGraph management, staking, token transfers)
- **EVMChainAdapter** — production adapter using ethers.js to interact with deployed DKG smart contracts on EVM chains (Base Sepolia, etc.)
- **MockChainAdapter** — in-memory mock for local CLI daemon dev mode (`type: 'mock'`). All CI tests use EVMChainAdapter with Hardhat.
- **NoChainAdapter** — no-op adapter for workspace/feeless publishing mode where chain interaction is not needed

## Usage

```typescript
import { EVMChainAdapter } from '@origintrail-official/dkg-chain';

const chain = new EVMChainAdapter({
  rpcUrl: 'https://sepolia.base.org',
  privateKey: process.env.PRIVATE_KEY,
  adminPrivateKey: process.env.ADMIN_PRIVATE_KEY,
  hubAddress: '0x...',
});

const tx = await chain.createKnowledgeAsset(merkleRoot, size, epochs);
```

## Transaction fees

On Gnosis (100) and Chiado (10200), automatic EIP-1559 pricing keeps a
2 gwei minimum **maximum fee** and at least three times the current base fee
plus the RPC's suggested priority fee. The **tip** follows that suggestion;
it is not raised to 1 gwei when the RPC supplies a lower value. The fee ceiling
provides headroom for base-fee spikes and is not charged in full.

If the RPC cannot suggest a tip, the existing ethers-compatible 1 gwei fallback
still applies. A low suggested tip can take longer to reach a willing block
producer; the ceiling does not guarantee inclusion or cover every future spike.
Explicit caller fees and the operator's `chain.maxFeePerGasWei` retain their
existing behavior. Wallets still need enough balance to cover the maximum fee
when signing, even when the eventual charge is lower.

Bounded same-nonce replacement remains available to standalone writes and
synchronous publish/update calls. Durable asynchronous publication still tracks
one transaction hash and does **not** opt into replacement. This fee change does
not add multi-hash recovery, alter receipt deadlines, or retry unknown outcomes.

## Internal Dependencies

- `@origintrail-official/dkg-core` — configuration types, logging
- `@origintrail-official/dkg-evm-module` — contract ABIs for DKG smart contracts
