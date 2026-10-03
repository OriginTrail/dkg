# RandomSampling 10.6.1 rollout

RandomSampling 10.6.1 rejects conventional contract operational wallets and
EIP-7702 delegated operational EOAs at `createChallenge()`. Existing storage is
kept: only the RandomSampling logic contract is redeployed and the Hub pointer
is replaced.

The deployment helper reuses any manifest entry with `deployed: true`; it does
not compare Solidity source, bytecode, or `version()`. The committed manifests
therefore mark RandomSampling `deployed: false` for these existing deployments:

- `base_sepolia_v10`
- `base_mainnet`
- `gnosis_mainnet`

Do not restore those flags without completing the corresponding on-chain
cutover and recording the resulting 10.6.1 address.

## Per-network procedure

Run from `packages/evm-module`. Set the network-specific RPC and signer variable
used by `utils/network.ts`. The signer must be the Hub owner or an authorized
multisig owner.

```bash
export NETWORK=base_sepolia_v10
# export RPC_BASE_SEPOLIA_V10=...
# export EVM_PRIVATE_KEY_BASE_SEPOLIA_V10=...
```

For mainnet, use `base_mainnet` with `RPC_BASE_MAINNET` and
`EVM_PRIVATE_KEY_BASE_MAINNET`, or `gnosis_mainnet` with
`RPC_GNOSIS_MAINNET` and `EVM_PRIVATE_KEY_GNOSIS_MAINNET`. Mainnet configuration
has no fallback signer.

Confirm the manifest is armed for redeployment and still agrees with the live
10.6.0 contract registered in the Hub:

```bash
node scripts/verify-random-sampling-10.6.1.mjs predeploy "$NETWORK"
```

Compile and run the focused contract tests before broadcasting:

```bash
pnpm exec hardhat compile --config hardhat.node.config.ts
pnpm exec hardhat test --network hardhat --config hardhat.node.config.ts \
  test/unit/RandomSampling.test.ts
```

Rehearse the exact manifest on a fork before each public-network transaction.
Confirm that RandomSampling is the only entry with `deployed: false`, that it is
the only newly deployed contract, and that reused storage addresses do not
change.

Run the complete deployment. Do not use `--tags RandomSampling`: tagged runs
skip the untagged final registration and manifest-save steps. The full run ends
with `Hub.setAndReinitializeContracts`, which registers the new RandomSampling
address and initializes its storage references atomically. It also reinitializes
reused contracts that expose `initialize()`, so inspect the fork receipt and
the exact `newContracts` list before broadcasting.

```bash
pnpm exec hardhat deploy --network "$NETWORK" \
  --config hardhat.node.config.ts
```

The deploy helper rewrites the selected manifest with the new address,
`version: "10.6.1"`, and `deployed: true`. Verify that metadata against live
bytecode and confirm the Hub pointer, active status, version, and initialized
storage references. The postdeploy check compares the live runtime code against
`artifacts/contracts/RandomSampling.sol/RandomSampling.json` with the trailing
solc metadata blob stripped, so run it from the same checkout that was compiled
above: an address deployed from a different checkout or with different compiler
settings still reports `10.6.1` from `version()` and is caught only here.

```bash
node scripts/verify-random-sampling-10.6.1.mjs postdeploy "$NETWORK"
```

Require the `Hub.setAndReinitializeContracts` receipt, then exercise one real
challenge/proof cycle and confirm that pre-cutover storage-backed challenge
state remains readable. Commit the postdeploy manifest for that network only
after all checks succeed.

The helper writes the new manifest entry before Hub activation. If deployment
stops after that write, the manifest can say `10.6.1` and `deployed: true` while
the Hub still points to 10.6.0. On every retry, compare the manifest with the
Hub first. If they differ, register and initialize the already-deployed
manifest address; do not deploy another copy or reset the manifest blindly.

## Compatibility consequence

Nodes using ordinary EOA operational keys continue unchanged. A Safe,
ERC-4337 wallet, other contract wallet, or EIP-7702 delegated EOA cannot call
`createChallenge`; rotate or add an undelegated EOA operational key before the
cutover. `submitProof()` remains available to every registered operational key.
