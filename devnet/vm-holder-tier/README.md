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
   first live run showed). Cores 2 to 4 are then restarted so they reserve on the
   fresh relay (its restart dropped every reservation, and a node that kept
   finding none waits out a ten minute cooldown), and the suite waits until each
   advertises a circuit address through core 1: that address is the only way an
   edge that knows just their profiles can reach them. Core 4 then creates a graph
   and publishes 6 KAs; cores 2 and 3 sign and hold them. Core 4, the graph's
   curator and author, is then **stopped**, so the curator tier of the recovery
   roster points at an offline peer;
2. restarts edges 5 and 6 with `DEVNET_EDGE_BOOTSTRAP_CORES=1`
   (`scripts/devnet.sh`), so their only bootstrap peer and relay is core 1, and
   with `DKG_SYNC_RECONCILER_ENABLED=0` so the periodic peer-sync reconciler
   does not dial anything; edge 6 also gets `DKG_VM_RECONCILE_HOLDER_TIER=0`
   (the control: the behavior before the tier);
3. asserts that neither edge is connected to a holder core, subscribes both, and
   waits for edge 5 to reach N/N, then checks the log evidence below.

## What it asserts, and what it only records

Asserted on the enabled edge (edge 5), unconditionally, from the daemon's own
log. Together they are a causal chain that only the holder tier can produce:

1. the VM reconcile pass resolved the tier for the graph:
   `VM exact fetch holder tier ...: N hinted ShardingTable holder(s)
   [peers=...] across M identities (... unmatched=0 ...)` with N and M both at
   least 2 and both holder cores among the hinted peers. A peer is hinted only
   when its profile's wallet resolves on chain to a ShardingTable identity, so
   this is the wallet-to-identity binding of both holder cores; `unmatched=0`
   says no core-role row the pass read failed that binding (true here because
   every core-role profile on this devnet is a ShardingTable member's). The
   line's `unbound` count is **not** asserted: the phonebook query admits only
   rows with a well-formed wallet, so it is 0 by construction and shows
   nothing;
2. the recovery pass then found a hinted holder that was **not connected** and
   dialed it itself (`VM exact fetch dialing hinted ShardingTable holder ...:
   not connected`), after the tier resolved. A peer an earlier connection had
   already made reachable is never dialed, so this line is absent when
   something else connected the edge first;
3. an exact fetch from that dialed holder came back `disposition=found`;
4. the edge reaches N/N KAs.

A change that disables the tier or hides its hints removes 1 to 3 and fails the
suite, whatever else still delivers the data. Also asserted: neither edge starts
connected to a holder core.

**The tier-off control (edge 6, `DKG_VM_RECONCILE_HOLDER_TIER=0`) is
informational, not a pass criterion for the feature.** Its KA count and both
edges' connections are only recorded in `.devnet/vm-holder-tier-evidence.json`.
The one thing asserted about it is that the kill switch is honoured: it logs no
holder-tier line and no hinted-holder dial. The subscribe catch-up walks the
phonebook and dials core-role profiles that advertise a relay on its own
(`primeCatchupConnections`, capped at 8 dials on an Edge that fetches the
phonebook on demand), and the VM sweep's cached-miss check primes again on later
sweeps, so the control can reach the holders without the tier: it reached N/N
that way in 7 of 11 live runs. On a devnet the only address either path has for a
holder is the relay circuit its profile advertises (loopback addresses are never
published), which means no topology here can keep priming from ever reaching a
holder while still letting the tier reach it. Whether the control converges
within the wait is therefore timing rather than evidence. Set
`HOLDER_TIER_STRICT_CONTROL=1` to also require that the control does not
converge (it holds when priming does not reach the holders in time; on a network
with many core-role profiles that are not ShardingTable members, such as Base
mainnet in September 2026 with about 58 core-role profiles and 5 in the table,
the walk can spend its dials elsewhere).

The reverse race is possible as well: if priming connected the enabled edge to a
holder before the recovery pass needed it, step 2 does not happen and the suite
fails with the holders it saw dialed and connected in the message. That is a
failed precondition, not a false pass: rerun.

The discriminating evidence for "without the tier the holder is never reached"
lives in `packages/agent`: the in-process libp2p suite
(`vm-reconcile-holder-tier.integration.test.ts`: a real unconnected holder, a
profile without a wallet, a forger serving tampered content, junk profiles ahead
of the real one) and the Hardhat suite
(`vm-reconcile-holder-tier.chain.e2e.test.ts`: the deployed contracts'
`getShardingTable()` and wallet-to-identity binding). A devnet runs only honest
nodes, so it cannot stage a forger.

## Run

```bash
pnpm run build
./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
pnpm test:devnet:vm-holder-tier
```

Tuning: `HOLDER_TIER_CONVERGE_MS` (default 600000) bounds the wait for the edge
and `HOLDER_TIER_CONTROL_EXTRA_MS` (default 90000) is how much longer the
control is given.

The suite restarts nodes 1 to 6 (node 1 with VM reconciliation off) and stops
node 4 (never identities, wallets or chain state) and publishes only into its
own freshly created Context Graph; restart the devnet before running another
suite that needs core 4.
