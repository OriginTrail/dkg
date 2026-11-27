# ack-candidate-isolation - devnet regression

Read-only live devnet coverage for ACK candidate isolation.

## What it proves

An edge node can have a live transport peer set that includes stale relay
peers. The configured ACK candidate list must RANK the active network's core
peer IDs first without excluding any connected peer (a hard exclusion filter
capped the mainnet pool at the bundled relay list and made ACK quorum
unreachable in the 2026-07-07 Base/Gnosis incident; chain-side ACK
verification, not candidacy, is what keeps stale peers out of quorum). The
test uses node5's generated local-devnet core bootstrap peers as the
preferred ACK set, injects the known public Base testnet relay IDs as stale
connected peers, and verifies the ordering places all four active devnet
cores ahead of the stale non-core peers while keeping everyone dialable. It
also asserts devnet daemons never install the public-network preference list
in the first place.

## Run

```bash
pnpm run build
./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
pnpm test:devnet:ack-candidate-isolation
```

The suite does not publish, restart nodes, or mutate chain state.
