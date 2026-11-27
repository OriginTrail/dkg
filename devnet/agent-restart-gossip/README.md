# agent-restart-gossip - devnet validation

A subscribed node that restarts must keep receiving its context graphs' Shared
Working Memory (SWM) gossip. `DKGAgent.stop()` then `start()` on the SAME
instance builds a new `GossipSubManager` on a new libp2p node; before the fix
the agent kept its "topic X is already subscribed" registries across that swap,
so the subscribe helpers short-circuited and the restarted node went deaf to
every graph.

## What it proves

Both checks run on a public context graph the suite creates on core node1;
nothing pre-existing or shared is mutated.

| Check | Setup | Assertion | Fails without the fix? |
| --- | --- | --- | --- |
| **A** regression | Edge node5 (a real daemon) subscribes; node1 shares; node5 is restarted with `devnet.sh restart-node 5` | node5 receives the share made after its restart | No. A new process rehydrates its subscriptions at startup, so this only guards the daemon path |
| **B** discriminating | An SDK `DKGAgent` (edge role, real libp2p, Hardhat chain adapter) joins the devnet, subscribes, then `stop()` and `start()` on the same instance | The agent rejoins the SWM topic without any `subscribe()` call, a gossip message on that topic reaches it, and its shared-memory handler applies node1's next share. Automatic catch-up (`syncOnConnectEnabled`, `syncReconcilerEnabled`) is off, so only a live delivery can bring the write | **Yes** |

The daemon exposes no in-process agent restart or reload route, which is why B
runs an SDK agent inside the test process instead of restarting a node.

## Run

```bash
pnpm run build:packages
pnpm --dir packages/cli run build:prepared
./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
pnpm test:devnet:agent-restart-gossip
```

Needs the default layout (nodes 1-4 core, 5-6 edge). Runtime about 3 minutes.
Check A restarts node5 through `devnet.sh restart-node`, so expect that edge to
blip during the run. The suite was validated on
`DEVNET_ENABLE_PUBLISHER=1 ./scripts/devnet.sh start 6`; it does not itself
need the publisher.
