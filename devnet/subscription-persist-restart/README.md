# subscription-persist-restart - devnet regression

Live devnet coverage for durable context-graph subscription state across a real
daemon restart.

## What it proves

Context-graph subscription store writes run through the same keyed persist
scheduler as membership writes: serialized per context graph, bounded, closed
and drained by `DKGAgent.stop()`, and reopened by `start()`. This suite checks
that the integrated stack keeps its promise on real daemons.

The suite is three scenarios. Each is one `it` that runs a sequence of named
phases (create graphs, churn, bounce the edge, check the durable state) over
context graphs it creates itself, with its own expected-state map and its own
log window. A scenario can be selected by its name (`vitest -t`) and the
scenarios can run in any order; none reads state another one left behind.

| Scenario | Phases and assertion |
|----------|----------------------|
| churns subscribe and unsubscribe on an edge node, then restart-node keeps the acknowledged state | Creates 8 public context graphs on node 1 and churns subscribe / unsubscribe / re-subscribe on edge node 5. Immediately after the last acknowledged request it runs `devnet.sh restart-node 5`. After the restart, `GET /api/context-graph/subscriptions` lists exactly the scenario's last acknowledged state. |
| a second churn round rewrites rows that already exist and survives stop-node followed by a start | Creates its own graphs, runs the first churn round and a restart that shows those rows are durable, then a second round rewrites the rows that exist, followed by `stop-node 5` and a start. The node again serves exactly the acknowledged state. |
| a restarted edge still persists new subscription changes | Creates its own graphs, churns and restarts the edge, then makes one more change on the restarted node, restarts again and runs the same check. |

Every scenario also runs inside a log check on `daemon.log` of node 5: it gains
no subscription or membership persistence drain timeout, no
`CG_SUBSCRIPTION_PERSIST_SHUTDOWN_TIMEOUT`, and no failed subscription persist
while the scenario runs. Only lines written after a byte offset recorded before
the scenario's first action count. If the log was rotated (a shorter file, or
changed bytes before the offset), the offset is void and the rotation has
discarded lines, so the check fails: it reports every matching line still in the
log and says that a clean run cannot be confirmed. A line the daemon was still
writing when the offset was recorded stays
inside the window, however long it already is. The check runs whether the
scenario passed or failed: a failing scenario is rethrown with the daemon's
trouble lines added to its message. An `afterAll` check over the whole run backs
it up for lines logged between two scenarios.

A scenario leaves the edge running: if it fails between `stop-node` and the
start, its cleanup restarts the node, so one failure does not take down the
scenarios after it. The cleanup also unsubscribes the scenario's graphs (best
effort): the edge rehydrates every durable subscription on each start under an
activation cap, so subscriptions left behind by many scenarios or runs would
slow a later scenario's restart down. What is not isolated: the devnet and the
edge daemon are shared by all scenarios, and a scenario that hangs the daemon or
the devnet fails the ones after it.

The daemon's SQLite writes are fast, so this suite cannot hold one open across
`stop()`. The drain itself is pinned by
`packages/agent/test/e2e-subscription-persist-lifecycle.test.ts`, which uses a
deliberately slow on-disk store, and by the unit tests beside it.

## Run

```bash
pnpm run build:packages && pnpm --dir packages/cli run build:prepared
./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
pnpm test:devnet:subscription-persist-restart
```

Node 5 (an edge) is bounced five times across the three scenarios, so expect
several minutes (Vitest prints each scenario's duration). Set
`DEVNET_SPR_EDGE_NODE` to churn a different edge node.
To run one scenario, add its name: `pnpm test:devnet:subscription-persist-restart -t "a restarted edge still persists"`.
The name is a regular expression, so leave out characters such as `(` and `.`.

`log-window.test.ts` beside the suite pins that log-window helper and the
per-scenario log check. It needs no devnet and runs with the suite's vitest
config
(`pnpm vitest run --config devnet/subscription-persist-restart/vitest.config.ts log-window`
runs it alone).

The suite mutates only context graphs it creates
(`spr-<stamp>-<scenario>-<n>`) and never touches the shared `devnet-test`
context graph. It does not time-warp the chain, so it can run anywhere in a
sweep.
