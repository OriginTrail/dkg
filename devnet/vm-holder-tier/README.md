# vm-holder-tier - devnet regression

Live coverage for the VM exact-recovery **holder tier**: an Edge reaches the
full Verifiable-Memory KA count of a public Context Graph when the only peer it
is connected to holds none of it and the graph's curator is offline, because the
ShardingTable Cores that hold it are reachable from unsigned phonebook profiles
that the chain vouches for.

## Topology

The suite builds it itself on a default 6-node devnet (4 cores, 2 edges):

1. restarts core 1 (the edges' only peer) with `DKG_VM_RECONCILER_ENABLED=0`: a
   Core with VM reconciliation off declines every public StorageACK and never
   back-fills a public graph, so it never holds the graph (a Core with it on
   fills its gaps from the other Cores within a minute of a restart, as the
   first live run showed). Core 4 then creates a graph and publishes 6 KAs; cores
   2 and 3 sign and hold them. Core 4, the graph's curator and author, is then
   **stopped**, so the curator tier of the recovery roster points at an offline
   peer;
2. restarts edges 5 and 6 with `DEVNET_EDGE_BOOTSTRAP_CORES=1`
   (`scripts/devnet.sh`), so their only bootstrap peer and relay is core 1, and
   with `DKG_SYNC_RECONCILER_ENABLED=0` so the periodic peer-sync reconciler
   does not dial anything; edge 6 also gets `DKG_VM_RECONCILE_HOLDER_TIER=0`
   (the control: the behavior before the tier);
3. asserts that neither edge is connected to a holder core, subscribes both, and
   waits for edge 5 to reach N/N.

## What it asserts, and what it only records

Asserted:

- edge 5 (default build) reaches N/N KAs and the data came from holder cores;
- when its VM reconcile pass resolved the tier, the resolution is real on the
  devnet's ShardingTable: `VM exact fetch holder tier ...: N hinted
  ShardingTable holder(s)` with N >= 2 and `unbound=0` (every Core's published
  `agentAddress` is a wallet bound to a ShardingTable identity);
- the control never resolves the tier (the kill switch is honoured).

Recorded in `.devnet/vm-holder-tier-evidence.json`, not asserted: the control's
count and both edges' connections. The subscribe catch-up walks the phonebook
and dials core-role profiles on its own (`primeCatchupConnections`, capped at 8
dials on an Edge that fetches the phonebook on demand), so on a six-node devnet
the control can reach the holders without the tier; on a network with many
core-role profiles that are not ShardingTable members (Base mainnet, September
2026: about 58 core-role profiles, 5 of them in the table) that walk can spend
its dials elsewhere. Set
`HOLDER_TIER_STRICT_CONTROL=1` to also require that the control does not
converge.

The discriminating evidence lives in `packages/agent`: the in-process libp2p
suite (`vm-reconcile-holder-tier.integration.test.ts`: a real unconnected
holder, a profile without a wallet, a forger serving tampered content) and the
Hardhat suite (`vm-reconcile-holder-tier.chain.e2e.test.ts`: the deployed
contracts' `getShardingTable()` and wallet-to-identity binding). A devnet runs
only honest nodes, so it cannot stage a forger.

## Run

```bash
pnpm run build
./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
pnpm test:devnet:vm-holder-tier
```

Tuning: `HOLDER_TIER_CONVERGE_MS` (default 600000) bounds the wait for the edge
and `HOLDER_TIER_CONTROL_EXTRA_MS` (default 90000) is how much longer the
control is given.

The suite restarts nodes 1, 5 and 6 (node 1 with VM reconciliation off) and stops node 4 (never identities, wallets
or chain state) and publishes only into its own freshly created Context Graph;
restart the devnet before running another suite that needs core 4.
