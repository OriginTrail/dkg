# Experiment results

## 2026-07-19 floating-point versus integer-only A/B

Revision under test: `codex/wal-005-iblt-lab` at `ba0141a71` plus the isolated
working-tree integer candidate and comparison harness. Hardware was an Apple
M3 with 8 logical CPUs and 16 GiB RAM; runtime was Node v25.2.1 on Darwin
arm64. Each candidate ran in a fresh process for three repetitions. Size order
rotated, candidate order reversed each repetition, and both candidates used
the identical sorted input, seed, 32-ID symmetric difference, limits, encoder,
decoder, CBOR, and correctness oracle.

| N per side | Floating median total | Integer median total | Integer / float | Floating stream | Integer stream | Symbols / bytes, both |
|---:|---:|---:|---:|---:|---:|---:|
| 10,000 | 195.853 ms | 235.421 ms | 1.202x | 47.566 ms | 85.291 ms | 47 / 3,454 |
| 100,000 | 1.775 s | 2.180 s | 1.228x | 473.668 ms | 874.716 ms | 65 / 4,788 |
| 1,000,000 | 16.962 s | 20.821 s | 1.228x | 4.446 s | 8.327 s | 52 / 3,882 |
| 10,000,000 | 171.266 s | 207.357 s | 1.211x | 50.512 s | 86.957 s | 56 / 4,232 |

Median setup time was effectively equal: integer/floating ratios were 1.012x,
1.009x, 1.012x, and 0.998x from 10K through 10M. The measurable penalty is in
symbol streaming, where the TypeScript exact-integer candidate was 1.72x–1.87x
slower. Median peak RSS stayed effectively equal; at 10M it was 1,728.8 MiB
for floating point and 1,731.8 MiB for integer-only.

Both candidates recovered the exact expected difference in all 24 measured
runs. For this workload they required the same number of symbols and same
canonical encoded byte length at every size, so the current integer candidate
provided no bandwidth reduction to offset its 20%–23% end-to-end CPU cost.

A separate deterministic sweep compared 3,200,000 mapping steps from 100,000
64-bit seeds. It found 42,700 different indices across 11,603 seeds, but no
divergence within symbol index 4,096. Forty-one seeds diverged within the full
1,048,576-symbol safety limit. Therefore the two schedules are not generally
identical, even though they agree in the small window exercised by this fixed
`k=32` benchmark.

Raw evidence is retained in:

- `results/mapping-comparison-latest.json`;
- `results/mapping-schedule-agreement.json`.

**Conclusion:** on the current TypeScript implementation, the benchmarked
binary64 mapping remains the performance baseline. The integer-only candidate
buys exact language-independent arithmetic at a measured 20%–23% end-to-end
cost for this workload. It should not replace the floating baseline without an
explicit portability decision or an optimized integer implementation followed
by the same A/B.

## 2026-07-19 quick sweep

Revision under test: `codex/wal-005-iblt-lab` based on DKG main
`a6f33e408`. Workloads used equal-size provider/receiver sets with symmetric
differences split evenly by direction. Each row below has only three
deterministic repetitions, so it is a harness smoke test—not a parameter
selection result.

### Mapping offset

The decoder consumed symbols one at a time to measure the exact mathematical
decode point, independent of transport batching.

| Mapping offset | Mean exact symbols / difference | Maximum observed |
|---:|---:|---:|
| 1.25 | 1.654 | 2.10 |
| 1.50 (paper baseline) | 1.624 | 2.00 |
| 1.75 | 1.640 | 2.40 |

The sample is too small to modify the paper's `1.5` value. It does prove that
the sweep can distinguish mapping behavior once window overfetch is removed.

### Transport window overfetch

For the paper-baseline mapping, the exact decode points were replayed through
doubling window policies:

| Initial window | Mean wire symbols / difference | Maximum observed |
|---:|---:|---:|
| 4 | 2.44 | 2.8 |
| 8 | 2.96 | 4.0 |
| 16 | 4.36 | 8.0 |
| 32 | 7.15 | 16.0 |

The 32-symbol baseline is clearly too coarse for the sampled sparse
differences. `configs/small-window-v0.json` records an initial-window-4
candidate for broader RTT/byte experiments. This is not a recommendation to
freeze four: smaller requests cost more round trips for larger differences,
and the quick sweep did not simulate latency, loss, multiplexing, or frame
amortization.

### WAL-005 scale and benchmark follow-up

- the production acceptance suite now passes 100,000 deterministic
  reconciliation seeds;
- fixed `k=32` now passes at `N = 10^4`, `10^5`, and `10^6`;
- the tracked encoded-byte baseline runs each size in a fresh process and
  records provider setup, receiver setup, stream and total timings, symbol
  count, wire bytes, operation count, process memory, and accounted memory;
- the matrix covers `N = 10^4`, `10^5`, `10^6`, and `10^7`, supports rotated
  repetitions, and reports min/median/p95/max summaries;
- on the recorded Apple M3 baseline, N=10,000,000 completed in 176.109 seconds
  at 1,721.5 MiB peak RSS and used 56 symbols / 4,232 canonical bytes for the
  32-ID symmetric difference.

The next empirical sweep should add:

- disjoint sets and `k` buckets from one through the fallback threshold;
- separate symbol-generation CPU, decoder CPU, peak memory, encoded CBOR
  bytes, request count, and wall time;
- network models covering direct/relay RTT, loss, cancellation, and provider
  switching;
- malicious checksum/count/core/resource cases;
- comparison with sorted-ID enumeration and a fixed-size IBLT baseline.

Only after those results should a stream window or fallback threshold be
proposed for Protocol V1.
