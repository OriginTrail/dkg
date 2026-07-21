# WAL-013 local durability-floor evidence — 2026-07-20

This is a characterization result, not a passing end-to-end release gate.

## Environment and command

- Commit state: uncommitted WAL-013 implementation on
  `codex/wal-005-iblt-lab`.
- Runtime: Node `v24.11.1`, `darwin-arm64`.
- Workload: three fresh-process repetitions per arm, alternating order; 250
  measured and 25 warmup operations per repetition; 100 quads per operation.
- Receipt: `/tmp/dkg-wal-013-shadow-write-20260720-v5.json`.
- Receipt SHA-256:
  `b3212a35c984654d5b7237d4c2cd6133a58682c3cb2b9d5eaa5e1e86dad0f3a9`.

```bash
/Users/otlegend/.nvm/versions/node/v24.11.1/bin/node --import tsx \
  packages/agent/scripts/wal-shadow-write-benchmark.ts \
  --operations=250 --warmup=25 --quads-per-operation=100 \
  --repetitions=3 \
  --output=/tmp/dkg-wal-013-shadow-write-20260720-v5.json
```

## Result

| Measurement | Current-sync-authoritative local arm | Parallel shadow-WAL arm | Overhead |
|---|---:|---:|---:|
| Samples | 750 | 750 | — |
| Median latency | 0.909 ms | 19.191 ms | — |
| p95 latency | 1.397 ms | 22.617 ms | 1519.03% |
| p99 latency | 1.962 ms | 23.629 ms | 1104.59% |
| Median CPU | 0.308 s | 6.889 s | 2137.15% |
| Median peak RSS | 404,111,360 B | 427,032,576 B | 5.67% |

The graph-operation totals were identical across arms and neither arm performed
a WAL-specific graph query. The parallel arm committed exactly one complete
signed `WalObjectV1` and one checkpoint per measured or warmup operation. It
made zero global-propagation claims.

The p95 and p99 gates fail. This result is intentionally retained: a fully
signed, `synchronous=FULL` local WAL commit adds roughly 20 ms to a baseline
whose entire operation takes roughly 1 ms. The peak-RSS gate and correctness
gates pass. The remaining WAL-013 performance decision requires the same
working network-confirmed current-sync workload in both arms; the current sync
mechanism is not assumed correct merely because it is production-authoritative.
