# AskStorage event validation

`AskStorage` 10.0.3 emits the new value after each successful mutation of its current or previous weighted ask sum and active stake. An indexer can reconstruct the integer-divided current and previous quotes from ordered receipts. Reverted transactions emit no events. Events are additive; the pricing formulas, authorization and storage fields are unchanged.

The regression runs real Solidity bytecode and reads transaction receipts. It covers all eight mutations, quote reconstruction after every update (including zero stake), maximum-width values, Hub authorization and reverted arithmetic. Run it on the in-process EVM:

```sh
pnpm --dir packages/evm-module exec hardhat test --network hardhat --config hardhat.node.config.ts test/unit/AskStorage.events.test.ts
```

To exercise a separate local JSON-RPC process, start a disposable Hardhat devnet in one terminal:

```sh
pnpm --dir packages/evm-module exec hardhat node --no-deploy --hostname 127.0.0.1 --port 18545 --config hardhat.node.config.ts
```

Then run the same receipt assertions over RPC:

```sh
RPC_LOCALHOST=http://127.0.0.1:18545 pnpm --dir packages/evm-module exec hardhat test --network localhost --config hardhat.node.config.ts test/unit/AskStorage.events.test.ts
```

Use an isolated devnet: the fixture creates contracts and uses EVM snapshots. Stop that owned process when finished. This verifies the contract-to-log boundary, not a complete DKG node indexer. Deploying the new contract version and teaching an indexer to consume these events are separate rollout steps; existing deployments do not gain events from a repository update. An index starting after deployment must bootstrap the four current fields at a pinned block before applying subsequent logs, or replay from deployment.
