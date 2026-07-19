# WAL rateless IBLT profile lab

## Abstract

This directory is the explicit tuning laboratory for
`ProtocolV1IbltReconciliationAlgorithm`. The single production implementation
lives in `packages/wal`; this lab imports it and varies candidate mapping,
window, and fallback values without copying protocol code. Reconciled elements
remain only 32-byte `WalObjectId` values, and a complete `WalObjectV1` remains
the sole durable content-addressed synchronization atom.

The lab is intentionally not a second protocol package. Its JSON configs and
sweep output are experimental records used to choose good values. Stable
encoding, validation, resource limits, head binding, commitment logic, tests,
cross-language vectors, E2E proofs, and benchmarks live beside the production
implementation in `packages/wal`.

## Commands

```sh
pnpm --filter @origintrail-experiments/wal-iblt-profile-v1 typecheck
pnpm --filter @origintrail-experiments/wal-iblt-profile-v1 sweep
```

The sweep writes JSON to standard output. Capture the source revision, machine,
runtime, and full candidate config with every retained result.

## Layout

- `PROFILE.md` records frozen architecture invariants and tunable choices.
- `configs/` contains explicit candidate values.
- `scripts/sweep.ts` runs candidate comparisons against `packages/wal`.
- `RESULTS.md` records retained observations and their limits.
- `STATUS.md` points to the completed WAL-005 verification surface.

The algorithm is adapted from the paper authors' MIT-licensed Go reference at
`yangl1996/riblt`; the notice was promoted to `packages/wal/THIRD_PARTY_NOTICES.md`.
