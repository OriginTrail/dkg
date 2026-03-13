# @origintrail-official/dkg-network-sim

Network simulation tool for DKG V9. A Vite-based web application for orchestrating multi-node devnet testing, running load tests, and observing network behavior.

## Features

- **Multi-node orchestration** — spin up and manage multiple DKG node instances for local testing
- **Load testing** — automated publish and query workloads to stress-test the network
- **Network visualization** — real-time view of node connections, message flow, and gossip propagation
- **Scenario runner** — pre-defined and custom test scenarios (partition, high-load, peer churn)

## Usage

```bash
# Start the simulation UI
pnpm dev

# Build for production
pnpm build

# Preview the built app
pnpm preview
```

The simulation UI proxies to locally running DKG nodes. Start your test nodes first, then open the simulator to observe and control them.

## Internal Dependencies

None — standalone React/Vite application. Communicates with DKG nodes via their HTTP APIs.
