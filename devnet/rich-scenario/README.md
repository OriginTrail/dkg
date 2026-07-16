# Devnet rich scenario (~10 min)

Composed gate for **4 core + 2 edge** devnet (`./scripts/devnet.sh start 6`).

| Phase | What it proves |
|-------|----------------|
| 1 | Edge agents on nodes 5 & 6 create **four CG policy combos** (public/private × curated/open) and register on-chain |
| 1b | Smoke VM publish on edge **pub-open** + **pub-cur** CGs |
| 2 | **20 lifecycle ops** on `devnet-isolation` from core1: WM-only, WM→SWM, WM→SWM→VM (cores already sync this CG) |
| 3 | **Greenfield updates** with `precomputedUpdateAttestation` on VM KAs from phase 2 |
| 4 | Conviction staking create → withdraw |
| 5 | Random sampling: mine blocks, poll core provers, `solved=true` on-chain |

## Run

```bash
pnpm run build
./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
pnpm test:devnet:rich-scenario
```

Shorter smoke (fewer publishes): `RICH_VM_COUNT=4 RICH_WM_COUNT=3 RICH_SWM_COUNT=3 pnpm test:devnet:rich-scenario`

Skip staking: `SKIP_STAKE=1`

## Env knobs

| Variable | Default | Purpose |
|----------|---------|---------|
| `DEVNET_CONTEXT_GRAPH` | `devnet-isolation` | Bulk publish target CG |
| `RICH_WM_COUNT` | 6 | WM-only assertions |
| `RICH_SWM_COUNT` | 6 | WM→SWM (promote) |
| `RICH_VM_COUNT` | 8 | WM→SWM→VM |
| `RICH_UPDATE_COUNT` | 4 | Owner-seal updates |
| `RS_TIMEOUT` | 90 | RS poll seconds |
| `MINE_BLOCKS` | 120 | `hardhat_mine` after VM batch |
| `SKIP_STAKE` | 0 | Set `1` to skip phase 4 |
| `PUBLISH_PACE_MS` | 800 | Delay between VM publishes |

Default total publish ops = 20. Typical runtime **5–9 minutes** depending on VM count and chain pace.
