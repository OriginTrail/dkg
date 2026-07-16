# Greenfield devnet gate (~10 min)

Validates **publish → update (owner seal) → staking → random sampling** on a live 6-node devnet.

## Prerequisites

```bash
pnpm run build
./scripts/devnet.sh clean
./scripts/devnet.sh start 6
```

Optional: seed extra stake/publishes for UI work:

```bash
node devnet/_bootstrap/bootstrap.cjs
```

## Run

```bash
pnpm test:devnet:greenfield-10min
```

Tune RS wait (default 150s):

```bash
RS_TIMEOUT=180 pnpm test:devnet:greenfield-10min
```

## Phases

| Phase | What | Budget |
|-------|------|--------|
| 1 | `dkg ka create --share` + `dkg ka publish` one KA from core1 into `devnet-test` | ~2 min |
| 2 | `POST /api/update` with `precomputedUpdateAttestation`; UAL stable, merkle rotates | ~2 min |
| 3 | `DKGStakingConvictionNFT.createConviction` → `withdraw` | ~4 min |
| 4 | Poll `/api/random-sampling/status` until proof + `RandomSamplingStorage.solved` | ~2.5 min |

Related: `pnpm test:devnet:v10-e2e` (RS-first ordering, no greenfield update seal).
