# Test coverage (tier-based)

Coverage gates are aligned with the TORNADO / BURA / KOSAVA criticality tiers defined in `vitest.coverage.ts` (see `criticalityTargets`).

## Where thresholds live

- **TypeScript (Vitest):** repo root [`vitest.coverage.ts`](../../vitest.coverage.ts) — per-package ratchet objects (e.g. `tornadoCoreCoverage`, `buraCliCoverage`).
- **Each package:** [`packages/<name>/vitest.config.ts`](../../packages/core/vitest.config.ts) imports the matching export.
- **Solidity:** after `hardhat coverage`, [`scripts/check-evm-coverage.mjs`](../../scripts/check-evm-coverage.mjs) aggregates `packages/evm-module/coverage/lcov.info` and enforces floors.

## Commands

```bash
# All Vitest packages (excludes evm-module — use separate command below)
pnpm turbo test:coverage --filter='!@origintrail-official/dkg-evm-module'

# Smart contracts (~10+ min)
cd packages/evm-module && pnpm test:coverage
```

## Ratchet policy

Baseline numbers are pinned to **current measured coverage** so CI blocks regressions. Raise thresholds toward `criticalityTargets` in `vitest.coverage.ts` when you add tests; do not lower without explicit review.

## CI

`.github/workflows/ci.yml` runs `turbo test:coverage` on TypeScript packages and `pnpm test:coverage` in `evm-module` (includes the lcov ratchet script).
