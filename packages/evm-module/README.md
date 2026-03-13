# @origintrail-official/dkg-evm-module

DKG V9 smart contracts and deployment scripts. Forked from the V8 `dkg-evm-module` and adapted for the V9 architecture. This is a Hardhat project — it compiles Solidity, runs tests, and deploys to EVM chains.

## Features

- **Solidity contracts** — Knowledge Collection registry, paranet management, staking, token contracts, and access control
- **ABI exports** — compiled contract ABIs available at `./abi/*.json` for use by `@origintrail-official/dkg-chain`
- **Hardhat deployment** — deploy scripts for localhost, testnet (Base Sepolia), and other EVM chains
- **Test suite** — unit and integration tests via Hardhat's testing framework

## Usage

This package is consumed as an ABI source by `@origintrail-official/dkg-chain`. You don't need to interact with it directly unless you're modifying or deploying contracts.

```bash
# Compile contracts
pnpm build

# Run tests
pnpm test

# Deploy to localhost (requires a running Hardhat node)
pnpm deploy:localhost

# Deploy to testnet
pnpm deploy:testnet
```

## ABI Imports

```typescript
import HubAbi from '@origintrail-official/dkg-evm-module/abi/Hub.json';
import ParanetAbi from '@origintrail-official/dkg-evm-module/abi/Paranet.json';
```

## Internal Dependencies

None — standalone Solidity/Hardhat project. Consumed by `@origintrail-official/dkg-chain`.
