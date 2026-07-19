# Experiment results

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
