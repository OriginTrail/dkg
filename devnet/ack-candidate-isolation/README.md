# ack-candidate-isolation - devnet regression

Read-only live devnet coverage for ACK candidate isolation.

## What it proves

An edge node can have a live transport peer set that includes stale relay peers,
but ACK candidate ordering must still be bounded to the active network's core
peer IDs. The test uses node5's generated local-devnet core bootstrap peers as
the active ACK set, injects the known public Base testnet relay IDs as stale
connected peers, and verifies the candidate ordering returns only the four
active devnet cores.

## Run

```bash
pnpm run build
./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
pnpm test:devnet:ack-candidate-isolation
```

The suite does not publish, restart nodes, or mutate chain state.
