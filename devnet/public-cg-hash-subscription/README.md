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
   catch-up job the subscribe minted is readable by its job id, and which names
   find it depends on how it came about (see "Which names a job answers to"):
   - The subscribe request resolved the hash itself (the usual case): the job is
     keyed by the cleartext id, so the cleartext id and the on-chain id name it and
     a lookup by the hash finds none. The test says so on the console, and item 7
     pins the by-hash lookup on purpose.
   - The subscribe answered under the hash: the job is keyed by the hash and the
     test asserts the by-hash lookup. Once the job has settled, it is either a job
     that continued under the cleartext id (then the cleartext and on-chain ids name
     it) or one that settled before the hash resolved and never continued (then the
     hash names it, the on-chain id reaches it through the hash, and the cleartext id
     names no job). The test prints which one it found. That branch did not run in
     any devnet run of this change.
3. A second edge subscribed with `#<on-chain id>` lands on the same cleartext
   graph and converges on the same VM content.
4. A forced catch-up (`forceCatchup`, the operator's recovery) on an already
   converged graph mints a replacement job. Both aliases (cleartext id and
   on-chain id) then name it, the superseded job stays readable by its id, and
   the content is unchanged. The test converges an edge on a graph of its own
   first (see "Structure"). It reads the job that arrangement started by its id
   (the cleartext id may never name it, see item 2) and classifies it before
   forcing.
5. The SWM copy of the shared-only graph (shared but never published) backfills on
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
   sometimes. The adoption and VM tests do not depend on it. Its two edges (one
   subscribed by hash, one by numeric id) are two scenarios run side by side, so
   neither waits for the other's recovery. Afterwards it asserts what is true of
   whichever job is latest: a forced job (made under the cleartext id) is named by
   the cleartext and on-chain ids; a first job that settled under the hash and never
   continued is named by the hash, although the content converged.
6. A graph registered directly on the chain with a name commitment whose
   preimage no node holds stays hash-only: no cleartext row is invented, and its
   catch-up (looked up by the hash) settles as `unreachable` with the
   name-hash-only note, not as a retryable failure.
7. A catch-up job created under a name hash that no peer could reveal stays
   retrievable by that hash after a holder appears and the edge adopts the
   cleartext id (#2779): the same job id comes back by the hash and by its id, with
   the verdict it settled with (`unreachable`), and its identity note now reads
   `resolved` with the cleartext id. That job never continued under the cleartext id,
   so the test also asserts its class: it is the hash-keyed settled job (the cleartext
   id names no job) after a new connection, and it is replaced (the cleartext id names
   the second subscribe's job) on the already-connected path. It is arranged without
   stopping or restarting any node:
   1. The slot is registered straight on the contract with a name whose preimage
      only the suite knows, so no peer can reveal it and edge 5's subscribe by the
      hash is keyed by the hash, with the name-hash-only note.
   2. The job settles as `unreachable` under the hash, and the hash finds it. The
      suite waits for that first, so the hash resolves after the job settled.
   3. Edge 6 subscribes the cleartext id (what a user who knows the name does),
      which makes its node answer the name protocol for the hash.
   4. Edge 5 is asked to dial edge 6 (`POST /api/connect`). The devnet's edges dial
      only the cores, so this is a new connection, and a new connection makes edge
      5's resolver ask the new peer at once: the hash resolves in the background.
      Nothing can undo that dial (there is no disconnect), so on a devnet where an
      earlier run already connected the edges, edge 5 would not ask edge 6 again for
      ten minutes (it asked when it subscribed, and edge 6 knew nothing then). The
      suite then asks the way an operator does, with a second subscribe by the hash:
      an explicit request skips that wait and the route resolves the hash inside
      the request. That subscribe mints its own job under the cleartext id and the
      hash still names the original job, which is asserted. The test says on the
      console which of the two it took, and the second path needs no fresh devnet.

   Not reached: a job that continues under the cleartext id while its first
   catch-up round is still running (`resolvedContextGraphId` set). That needs the
   hash to resolve during a round of a few seconds, which no devnet control can
   time. It is pinned by `packages/cli/test/context-graph-name-hash-catchup-status.test.ts`
   and `context-graph-name-hash-subscribe-route.test.ts`.

The first catch-up job of a subscription can be cut short when the node's RFC-64
authority RPC circuit is open. Only the SWM scenario (5 above, the one that
depends on a holder's authority pipeline) recovers from that: while it waits for
content it re-subscribes with `forceCatchup` once a minute, and afterwards it
asserts what is true of whichever job is latest (a forced job is named by the
cleartext and on-chain ids; see "Which names a job answers to"). Every other
content wait only reads (it never re-subscribes, so the job a test started stays the
latest one until the test replaces it), and reports the latest job's verdict on
timeout. Recovery covers only a short circuit window: a node whose circuit stays
open needs a restart, and the suite fails rather than hiding it. A failed forced
catch-up (a rejected request, a non-200) is retried on the next round; a reply of
the wrong shape is not, it rejects the whole scenario.

## Structure

Every test runs correctly alone or after any other test; none reads state left by
another.

The suite is split so that each scenario's arrangement and assertions are read
together, and the mechanics under them are not:

| file | what it holds |
| --- | --- |
| `automated.test.ts` | the seven tests: each scenario's arrangement and its assertions |
| `fixture.ts` | the graphs (types, creation through the daemon API, registration straight on the contract, funding a throwaway wallet, the artifact files); the devnet, the author node, the run stamp and the artifact directory are passed in, not read from module state |
| `daemon.ts` | typed reads and posts through the validators, and the observation and recovery helpers built on them (content polls, subscribe retry, adoption waits, the no-row check, the arrange step, forced catch-up, dialing); nodes and expected content are arguments, and the transport is injected |
| `catchup-jobs.ts` | the pure classification of a graph's latest catch-up job |
| `wire.ts` | the reply validators |
| `flows.ts` | side-by-side scenarios |
| `*.test.ts` other than `automated.test.ts` | unit tests of the above; no devnet |

- **Fixture** (`beforeAll`, `fixture.ts`): the graphs are created once, before any
  test, and never change afterwards: two published to VM (`vm`, `forced`), one only
  shared to SWM (`swm`), and one registered on chain with a name nobody can resolve
  (`unheld`), and one registered on chain with a name only the suite knows (`late`,
  revealed by test 7 alone). No test creates a graph (test 7 reveals a name to the
  network by subscribing it; the slot it uses is in the fixture). The devnet
  detection and identity setup is shared the same way.
- **Arrange** (inside each test): a test makes the edge state it needs. No
  (edge, graph) pair is used by two tests:

  | test | edge | graph | subscribed |
  | --- | --- | --- | --- |
  | 2 | edge 5 | `vm` | by name hash |
  | 3 | edge 6 | `vm` | by numeric id |
  | 4 | edge 5 | `forced` | arranged converged, then forced catch-up |
  | 5 | edges 5 and 6 | `swm` | by hash and by numeric id |
  | 6 | edge 6 | `unheld` | by hash |
  | 7 | edges 5 and 6 | `late` | edge 5 by hash, edge 6 by cleartext id, then edge 5 dials edge 6 |

  Tests 2, 3, 5, 6 and 7 have a subscribe as their subject, so they need an edge with
  no subscribed row for the graph, and they check that instead of asserting on
  leftovers (the edge's chain poller may already know the slot: that is not a
  subscription).
  Test 4 is the only one that needs a state a subscribe leaves behind (an edge
  converged on VM), so it makes it itself with an idempotent arrange step
  (`ensureConverged`: subscribe only when the edge has no row for the graph, then
  wait for adoption and content). It uses a graph of its own so it cannot consume
  test 2's "never seen" precondition when it runs first, and it stays a separate
  test so a failure names the behavior and it can run by name.
- **Wire validators** (`wire.ts`). These daemon replies are read through small
  functions that take the JSON of a 200 reply as `unknown` and either return a
  projection or throw an error naming the endpoint and the missing or mistyped
  field. A renamed `subscriptions`, a retyped `synced` or an identity state spelled
  differently therefore fails at the reply with that message, instead of as an
  `undefined` inside a test. Covered: the subscribe reply, the context-graph list,
  the subscriptions list and its rows, the catch-up status, the `/api/query`
  answers, and the status and connections replies test 7 needs to dial one edge
  from another. The graph-create reply and the `/api/connect` status are still read
  loosely.

  What a validator returns: a new object holding exactly the fields it checked,
  typed by indexed access over the CLI package's own declarations (imported as
  types only). A field it does not check is neither in the value nor in the type,
  so the suite cannot read one by accident, and a field renamed in a declaration
  breaks a type-check of the suite (a throwaway tsconfig or an editor; nothing in CI
  type-checks devnet suites).

  What that is not: it validates mainly the fields this suite reads (and a few
  it does not, such as `synced`, `coreHosted` and the subscribe reply's
  `catchup.status`, which therefore fail here too if they change), not the daemon's
  contract. The routes build these bodies inline and export no schema, and the CLI
  client's declarations are hand-written, so the canonical contract (one schema that
  the route builds its reply from and every client parses with) would live at the
  CLI boundary. A field it does not check can change without failing here.
  The catch-up job states are the CLI's own `CATCHUP_JOB_STATES`, and the suite's
  terminal-state checks use the CLI's `isTerminalCatchupJobState`: `catchup-status.ts`
  has only type imports, so importing it loads neither the agent nor the CLI
  runtime. The identity-note states have no runtime list there (only a type), so
  `wire.ts` keeps a copy tied to the type.
- **Daemon helpers** (`daemon.ts`). The reads, posts and polls the scenarios use,
  built on an injected transport (the harness's by default). A reply of the wrong
  shape is a failure, never "not yet": `checked()` adds the node to the validator's
  error without changing its type, and every retry or poll lets that error through
  (only a rejected request or a non-200 status is retried). `daemon.test.ts` proves
  it without a devnet, including that a malformed forced-subscribe reply rejects
  the SWM scenario's recovery instead of being swallowed.

  The same holds for "no job". A catch-up lookup by graph id answers "no job" only
  with the route's own 404 (`{ error: "No catch-up job found" }`, matched by status
  and message, because an unmatched route is also a 404). A read made for an
  assertion or a classification throws on any other answer (a 500, a 503, a 403, a
  rejected request, another kind of 404), naming the node, the endpoint, the status
  and the body, so a daemon that could not answer never satisfies "the cleartext id
  names no job". A poll that waits for a job retries such a failure until its budget
  is spent, and its timeout says what the last lookup answered.
- **Which names a job answers to** (`catchup-jobs.ts`, `daemon.ts`
  `expectLatestJobNamed`). A catch-up job is keyed by the id its subscribe was made
  with. The cleartext id names it when it was made under the cleartext id or
  continued under it (the hash resolved while it ran); a job that settled under the
  hash before the hash resolved never continues, so only the hash and its job id name
  it (and the on-chain id, which falls back to the hash) while the cleartext id names
  no job, or a later job made under it. Asserting "the cleartext id names the latest
  job" is therefore wrong for that job although the content converged. A pure
  classification (continued, replaced, hash-keyed settled; anything else is a
  failure) decides which of the three a job is, once it has settled, and the test
  asserts what is true of that state and prints the decision. `catchup-jobs.test.ts`
  and `daemon.test.ts` cover all three states without a devnet. On a devnet, test 7
  produces two of them: the hash-keyed settled job on the first run after a fresh
  `devnet.sh start` (the edge is dialed, so nothing mints a job under the cleartext
  id), and the replaced one on every later run (the already-connected path). The
  forced catch-up and SWM scenarios produced neither in any run of this change
  (their subscribe resolved the hash within the request, so their first job was
  made under the cleartext id); for them the unit tests are the evidence that a
  settled hash-keyed job is handled.
- **Side-by-side scenarios** (`flows.ts`). The SWM test's two edges are scenario
  records (node, requested id, label) run through `runLabeledFlows`: all flows are
  awaited to their end even after one fails (so none keeps polling unobserved into
  the next test), and every failure is reported under its label.
- **Unit tests without a devnet**: `wire.test.ts` (each validator accepts a
  real-shaped payload, the catch-up status ones built by the daemon's own
  `toCatchupStatusResponse`, and rejects a renamed or retyped field),
  `daemon.test.ts`, `catchup-jobs.test.ts` and `flows.test.ts`. They run with the
  suite's vitest config and need no devnet:
  `pnpm exec vitest run --config devnet/public-cg-hash-subscription/vitest.config.ts wire.test daemon.test catchup-jobs.test flows.test`.

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

Node 1 (core) is the author; nodes 5 and 6 (edges) subscribe and read, and test 7
has edge 5 dial edge 6. The suite creates and mutates only its own Context Graphs
(the ISOLATION INVARIANT in `devnet/_bootstrap/harness.ts`),
and throwaway funded wallets for the hash-only and late-holder graphs; it never
touches a node's wallet or the shared `devnet-test` graph, and it does not stop or
restart nodes or warp the chain clock. The one change it leaves behind is the
connection from edge 5 to edge 6 that test 7 dials (the daemon has no disconnect,
so it lasts until either edge restarts); the rest of the devnet is as it was, and
the ephemeral graphs and subscriptions it made stay, as with every suite here.
