# WAL-000 accepted hermetic reference

## Result

The clean `all` profile completed successfully on 2026-07-19. This reference
freezes DKG semantics, crypto/authorization behavior, VM lifecycle, and storage
safety. It does **not** declare the current sync implementation correct.
Legacy-sync functional and performance results are non-normative
characterization only.

| Evidence field | Value |
| --- | --- |
| Harness commit | `4fe41ec2c4caf5eb093765b29947746a5bff38d8` |
| Frozen `origin/main` base | `a6f33e408335930f009c49781684bc79dd322b7b` |
| Clean at start/end | yes |
| Matrix SHA-256 | `327d2ae6b1c47d61f7286f67a5ddf41181fe594cd24172c7e977347c97c2b06f` |
| Evidence summary digest | `6671d00636f808a6f1c5da19a50b100bf1a24165412984f125b3413781f97b9a` |
| Full receipt SHA-256 | `68164d37a2068269817519c6f0d2cae3994188cc66a1f221d80c1357d80c0d6f` |
| Local raw receipt | `/tmp/dkg-wal-000-accepted-4fe41ec2c/evidence.json` |
| Environment | Node 25.2.1; pnpm 10.28.1; Apple M3; 8 logical CPUs; 16 GiB RAM |

The local receipt path is intentionally not portable or committed. A reviewer
creates a fresh external receipt with `pnpm wal:baseline`; the fixed schema,
matrix, semantic oracle, source digests, and command inventory make the result
comparable without checking generated logs into Git.

## Normative DKG oracle

| Scenario | Passed | Skipped | Oracle |
| --- | ---: | ---: | --- |
| Memory-layer lifecycle | 46 | 0 | matched |
| SWM conflict and expiry semantics | 7 | 0 | matched |
| Private authorization and Sender Keys | 58 | 0 | matched |
| VM chain finality and reorg | 34 | 0 | matched |
| Publish, update, Merkle, and SWM boundary | 75 | 2 | matched |
| Private publisher boundary | 28 | 0 | matched |
| Chain crypto contract | 31 | 0 | matched |
| Storage restart and durability | 10 | 5 | matched |
| **Total** | **289** | **7** | **all normative digests matched** |

The seven skips predate WAL-000 and are frozen as skips, not passes. They are
the two existing RC11/PR1 private-update cases and five live-Blazegraph
changelog cases described in `PATH-INVENTORY.md`.

## Non-normative current-sync characterization

The functional characterization ran 105 existing assertions: 82 for
equal/reconnect/late-join/recovery/retry behavior and 23 for current durable
materialization/failure behavior. They passed in this run, but the receipt tags
both groups `non-normative-sync-characterization` and states that they MUST NOT
be used as WAL correctness or parity oracles.

The following timings are diagnostic observations, each from three repetitions.
The responder script's raw `new` label means the current legacy page-copy path;
it does not mean the proposed WAL protocol.

| Current legacy responder dataset | Transfer bytes | Requests | Page extraction median | p95 | p99 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 10,000 rows | 1,498,910 | 20 | 0.065 ms | 0.168 ms | 0.168 ms |
| 100,000 rows | 15,089,090 | 200 | 0.693 ms | 0.757 ms | 0.757 ms |
| 1,000,000 rows | 152,790,890 | 2,000 | 2.813 ms | 6.120 ms | 6.120 ms |

The complete responder command, including dataset construction and its existing
old/current comparison, had 5,124.870 ms median and 5,219.167 ms p95/p99 wall
time; 6.37 s median CPU; and 572,751,872-byte median peak RSS. The fixture starts
after snapshot materialization, so it records one snapshot read and zero
triplestore operations.

| Characterization | Median | p95 | p99 | Median CPU | Median peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| Sync worker parse/filter | 435.49 ms | 500.80 ms | 500.80 ms | 0.68 s | 128,385,024 B |
| Worker-thread duration under responsiveness load | 443.68 ms | 450.92 ms | 450.92 ms | 0.87 s | 266,272,768 B |
| Worker max event-loop delay | 12.66 ms | 19.13 ms | 19.13 ms | — | — |

These microbenchmarks issue one worker request per run and zero triplestore
operations. They measure replacement cost and known pathologies only; they are
not performance gates for WAL.

## Safety evidence and remaining scope

- Every scenario used a separate temporary `DKG_HOME` and `TMPDIR`.
- Credentials and configured DKG/chain endpoints were stripped; non-loopback
  endpoint configuration is rejected before execution.
- The existing Hardhat global setup rewrote its tracked localhost deployment
  manifest nine times. Each exact generated digest and restoration is present
  in the full receipt, and Git state was clean at every scenario boundary.
- No WAL protocol, worker, state directory, configuration default, or network
  handler was added or enabled.
- This hermetic reference does not claim live-devnet sync correctness. WAL must
  instead satisfy the RFC's reconciliation, completeness, crash, authorization,
  and convergence acceptance tests independently of current-sync behavior.
