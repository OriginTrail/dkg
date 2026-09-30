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
   `keccak256(utf8(id))` on the real `ContextGraphStorage`, and the author holds
   the content it published and shared.
2. An edge subscribed with the hash alone ends up with a row keyed by the
   verified cleartext id (and none keyed by the hash), and holds the finalized
   VM copy published before it subscribed, identical to the author's. The
   catch-up job the subscribe minted is reachable by its job id, the cleartext
   id and the on-chain id, and always names the cleartext graph.
   (A lookup by the hash itself is asserted only when the job was created under
   the hash; when the subscribe request resolved the hash, the job is keyed by
   the cleartext id and the by-hash lookup finds none, so that path is not
   covered here.)
3. A second edge subscribed with `#<on-chain id>` lands on the same cleartext
   graph and converges on the same VM content.
4. A forced catch-up (`forceCatchup`, the operator's recovery) on an already
   converged graph mints a replacement job. Both aliases (cleartext id and
   on-chain id) then name it, the superseded job stays readable by its id, and
   the content is unchanged. The test converges an edge on a graph of its own
   first (see "Structure").
5. The SWM copy of a second graph, shared but never published, backfills on
   both edges after they subscribe by hash (edge 5) and by numeric id (edge 6).
   This is its own graph and its own test because it depends on something the
   hash path does not: holders serve a graph's shared working memory only once
   their RFC-64 authority pipeline has accepted it (a finalized authority index
   polled every few minutes), and right after `devnet.sh start` that pipeline can
   lag or trip its RPC circuit for many minutes (`chain event log moved`,
   `RFC-64 authority RPC circuit is open`). This is the least stable test of the
   suite: on freshly started devnets it failed in some runs for an edge that
   subscribed by hash and, in a control, for one that subscribed by cleartext id,
   so it is not the hash path, and a forced re-subscribe recovers it only
   sometimes. The adoption and VM tests do not depend on it.
6. A graph registered directly on the chain with a name commitment whose
   preimage no node holds stays hash-only: no cleartext row is invented, and its
   catch-up (looked up by the hash) settles as `unreachable` with the
   name-hash-only note, not as a retryable failure.

The first catch-up job of a subscription can be cut short when the node's RFC-64
authority RPC circuit is open. Only the SWM scenario (5 above, the one that
depends on a holder's authority pipeline) recovers from that: while it waits for
content it re-subscribes with `forceCatchup` once a minute, and afterwards it
expects the aliases to name whichever job is latest. Every other content wait
only reads, and reports the latest job's verdict on timeout. Recovery covers only
a short circuit window: a node whose circuit stays open needs a restart, and the
suite fails rather than hiding it.

## Structure

Every test runs correctly alone or after any other test; none reads state left by
another.

- **Fixture** (`beforeAll`): the graphs are created once, before any test, and
  never change afterwards: two published to VM (`vm`, `forced`), one only shared
  to SWM (`swm`), and one registered on chain with a name nobody can resolve
  (`unheld`). No test creates a graph. The devnet detection and identity setup is
  shared the same way.
- **Arrange** (inside each test): a test makes the edge state it needs. No
  (edge, graph) pair is used by two tests:

  | test | edge | graph | subscribed |
  | --- | --- | --- | --- |
  | 2 | edge 5 | `vm` | by name hash |
  | 3 | edge 6 | `vm` | by numeric id |
  | 4 | edge 5 | `forced` | arranged converged, then forced catch-up |
  | 5 | edges 5 and 6 | `swm` | by hash and by numeric id |
  | 6 | edge 6 | `unheld` | by hash |

  Tests 2, 3, 5 and 6 have a subscribe as their subject, so they need an edge that
  has never seen the graph, and they check that instead of asserting on leftovers.
  Test 4 is the only one that needs a state a subscribe leaves behind (an edge
  converged on VM), so it makes it itself with an idempotent arrange step
  (`ensureConverged`: subscribe only when the edge has no row for the graph, then
  wait for adoption and content). It uses a graph of its own so it cannot consume
  test 2's "never seen" precondition when it runs first, and it stays a separate
  test so a failure names the behavior and it can run by name.
- **Wire types** come from the daemon's own declarations
  (`packages/cli/src/catchup-status.ts` for the catch-up status and the identity
  note, `packages/cli/src/api-client.ts` for the subscribe and list replies),
  imported as types only, so a renamed field fails the type-check instead of a
  long devnet run. The one row shape with no exported declaration (an entry of
  `GET /api/context-graph/subscriptions`) is stated locally, with a comment naming
  the route.

## Run

```bash
pnpm run build:packages && pnpm --dir packages/cli run build:prepared
./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
pnpm test:devnet:public-cg-hash-subscription
```

One test alone, by a name filter (the fixture is still created first; the filter is
a regex, so use plain words):

```bash
pnpm exec vitest run --config devnet/public-cg-hash-subscription/vitest.config.ts -t "forced catch-up mints"
```

Node 1 (core) is the author; nodes 5 and 6 (edges) only read. The suite creates
and mutates only its own Context Graphs, and a throwaway funded wallet for the
hash-only case; it never touches a node's wallet or the shared `devnet-test`
graph, and it does not restart nodes or warp the chain clock.
