# public-cg-hash-subscription - devnet coverage

Subscribing to a public Context Graph by its on-chain name hash, on a real
local devnet (Hardhat chain, real libp2p, real daemons and stores).

## Why

`ContextGraphStorage` commits only `nameHash = keccak256(utf8(id))`; the
cleartext id is never on-chain. An edge that learns a public graph from the
`ContextGraphCreated` event can therefore subscribe by hash, but every holder
keys the graph's data by the cleartext id, so before #2744 such a subscription
stayed "subscribed" and synced 0 quads. #2744 resolves the cleartext id through
a peer and adopts it only after `keccak256(utf8(id))` equals the on-chain hash;
#2777 binds an ontology claim only when this chain proves it; #2758 and #2779
cover numeric on-chain ids and catch-up status by hash. The agent and CLI unit
suites pin that logic with a mocked chain. Nothing exercised it across real
nodes.

## What it proves

1. A public graph registered through the daemon API commits exactly
   `keccak256(utf8(id))` on the real `ContextGraphStorage`.
2. An edge subscribed with the hash alone ends up with a row keyed by the
   verified cleartext id (and none keyed by the hash), and holds the SWM copy
   shared before it subscribed and the finalized VM copy, each identical to the
   author's. The catch-up job the subscribe minted is reachable by its job id,
   the cleartext id and the on-chain id, and always names the cleartext graph.
3. A second edge subscribed with `#<on-chain id>` lands on the same cleartext
   graph and converges on the same content.
4. A graph registered directly on the chain with a name commitment whose
   preimage no node holds stays hash-only: no cleartext row is invented, and its
   catch-up (looked up by the hash) settles as `unreachable` with the
   name-hash-only note, not as a retryable failure.

The first catch-up job of a subscription can be cut short when the node's RFC-64
authority RPC circuit is open (chain reads timing out on a loaded machine); the
suite re-subscribes with `forceCatchup` once a minute while it waits for content,
as an operator would, and reports the last job's verdict on timeout.

## Run

```bash
pnpm run build:packages && pnpm --dir packages/cli run build:prepared
./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
pnpm test:devnet:public-cg-hash-subscription
```

Node 1 (core) is the author; nodes 5 and 6 (edges) only read. The suite creates
and mutates only its own Context Graphs, and a throwaway funded wallet for the
hash-only case; it never touches a node's wallet or the shared `devnet-test`
graph, and it does not restart nodes or warp the chain clock.
