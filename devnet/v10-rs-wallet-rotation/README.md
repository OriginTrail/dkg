# Devnet scenario: V10 Random Sampling operational-wallet rotation

End-to-end validation, against a **live devnet**, of the Phase-4 dispatcher
behaviour: random-sampling writes (`createChallenge` / `submitProof`) rotate
across a node's **registered** operational wallets instead of pinning wallet #0.

The rotation *logic* — fail-closed registered-wallet eligibility, native-only
funding, prefer-idle, and the `ProfileDoesntExist` self-heal — is proven
deterministically in `packages/chain/test/evm-adapter.unit.test.ts`. This
scenario proves the parts a unit test can't reach: the **deployed** contracts +
the **real prover loop** + an **actual multi-wallet** node.

## What it asserts

1. **Fail-closed (the core safety property, deterministic):** every RS
   transaction the node sends is signed by a wallet that resolves to the node's
   identity on-chain (`IdentityStorage.getIdentityId(sender) === identityId`).
   A stray / unregistered sender would revert `ProfileDoesntExist` and burn the
   proof period — this proves that never happens.
2. **Rotation:** over a window that includes a full `create → submit` cycle, the
   node's RS senders span **≥2** wallets. `createChallenge` and `submitProof`
   each advance the round-robin cursor, so within a period they differ.

## Why sender-based, not draw-based

Like `v10-rs-prune`, the network-wide **draw** selects across every weighted CG,
so the draw *target* isn't deterministically observable on a shared devnet.
The **sender identity** of the node's own RS txs, however, is deterministic and
is the net-new, devnet-only evidence: the deployed contracts + real prover
actually rotate the signer across registered wallets, and never onto a
non-registered one.

## Setup

The suite ensures the observed node has ≥2 registered operational wallets — if
it starts with only the primary, it adds a throwaway one via the node-admin
route (`POST /api/operational-wallets`, the same on-chain-verified path
`pr1370-admin-op-wallet` exercises) and funds it with gas.

## ⚠️ Validation status

The scaffolding and assertions follow the established devnet pattern, but the
**RS-timing orchestration** (how long to watch / whether to warp proof periods
for the prover to emit a full `create → submit` cycle) has **not yet been tuned
against a live network**. Expect to adjust `DKG_RS_ROT_WINDOW` and, on a quiet
devnet, add proof-period time-warps to match your devnet's proofing-period
length.

## Run

```bash
./scripts/devnet.sh clean
./scripts/devnet.sh start 6
pnpm test:devnet:v10-rs-wallet-rotation
```

## Tuning

- `DKG_RS_ROT_NODE` (default `1`) — which node to observe.
- `DKG_RS_ROT_WINDOW` (default `300000`) — ms to watch for the node's RS txs.
