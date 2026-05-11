# @origintrail-official/dkg-evm-module

DKG V9 smart contracts and deployment scripts. Forked from the V8 `dkg-evm-module` and adapted for the V9 architecture. This is a Hardhat project — it compiles Solidity, runs tests, and deploys to EVM chains.

## Features

- **Solidity contracts** — Knowledge Collection registry, contextGraph management, staking, token contracts, and access control
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
import ContextGraphAbi from '@origintrail-official/dkg-evm-module/abi/ContextGraph.json';
```

## Committed ABIs are the runtime contract surface

The files under `abi/*.json` are checked into git and consumed at runtime by
`@origintrail-official/dkg-chain`. **Nodes never run `hardhat compile` during
install or auto-update** — neither `install.sh` nor `packages/cli/src/daemon/auto-update.ts`
invoke any `hardhat` command. This makes node updates fast and removes the most
failure-prone step (cold solc on small VPS / ARM64 used to OOM and abort the
slot swap).

That contract is enforced by the `abi-freshness` job in
`.github/workflows/ci.yml`: every PR that touches `contracts/`, `hardhat.*`,
or `package.json` runs `npx hardhat compile` (default config — picks up
`hardhat-abi-exporter`) and then `git diff --exit-code -- packages/evm-module/abi/`.
Any drift fails the PR with an explicit remediation message.

> Note: the package's `pnpm build` script intentionally runs Hardhat with
> `--config hardhat.node.config.ts`, which does **not** load
> `hardhat-abi-exporter`. Use `npx hardhat compile` (no `--config`) when you
> need to regenerate `abi/*.json`.

If you change a `.sol` file, regenerate and commit ABIs in the same change:

```bash
cd packages/evm-module && npx hardhat compile && cd -
git add packages/evm-module/abi/
```

## Internal Dependencies

None — standalone Solidity/Hardhat project. Consumed by `@origintrail-official/dkg-chain`.
