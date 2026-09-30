# subscription-persist-restart - devnet regression

Live devnet coverage for durable context-graph subscription state across a real
daemon restart.

## What it proves

Context-graph subscription store writes run through the same keyed persist
scheduler as membership writes: serialized per context graph, bounded, closed
and drained by `DKGAgent.stop()`, and reopened by `start()`. This suite checks
that the integrated stack keeps its promise on real daemons:

| Step | Assertion |
|------|-----------|
| 1 | The suite creates 8 public context graphs on node 1 and churns subscribe / unsubscribe / re-subscribe on edge node 5. Immediately after the last acknowledged request it runs `devnet.sh restart-node 5`. After the restart, `GET /api/context-graph/subscriptions` lists exactly the last acknowledged state. |
| 2 | A second churn round rewrites rows that already exist, then `stop-node 5` and a start. The node again serves exactly the acknowledged state. |
| 3 | A restarted node still persists new changes: one more change, one more restart, the same check. |
| 4 | `daemon.log` of node 5 gains no subscription or membership persistence drain timeout, no `CG_SUBSCRIPTION_PERSIST_SHUTDOWN_TIMEOUT`, and no failed subscription persist. |

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

Runtime is about 5-8 minutes. Node 5 (an edge) blips three times. Set
`DEVNET_SPR_EDGE_NODE` to churn a different edge node.

The suite mutates only context graphs it creates (`spr-<stamp>-<n>`) and never
touches the shared `devnet-test` context graph. It does not time-warp the
chain, so it can run anywhere in a sweep.
