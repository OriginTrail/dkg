# Durable blob group-commit evaluation

This is an isolated, optional candidate based on foundation0af290930. Defaults remain legacy files. It is not a default-rollout decision, closure of the performance P1, live testnet evidence, or merge readiness. No Oxigraph fork or extra native dependency is involved. The user requires retaining the guarantee while reducing the heavy cost; no budget waiver was accepted.

## Contract and implementation

Stock Node SQLite owns the blob database and its WAL. Writer connections verify WAL/FULL/fullfsync/checkpoint_fullfsync, application/version/UTF-8/rowid schema, and exact bytes/SHA. Up to eight ready writes (2 MiB, except one larger term) share one native COMMIT; only those members acknowledge. Failed transactions close their native connection and retry normally; worker loss never certifies an uncertain write. Immutable refs enter RDF only after the corresponding commit. A separate bounded read-only worker allows hydration during a slow writer commit. Queries enforce byte limits before native BLOB allocation. Wrapper/owner close drains accepted work, including detached canceled reads. Existing files are retained/readable; a non-destructive offline export uses the same durable legacy writer for rollback.

Runtime: native macOS arm64, Node22.23.3, SQLite3.51.3, libuv1.51.0, pnpm10.28.1. The option requires the [upstream WAL-reset fix](https://www.sqlite.org/wal.html#walreset), including its3.50.7/3.44.6 backports; unsupported runtimes reject before opening the DB. See [FULL synchronous policy](https://www.sqlite.org/pragma.html#pragma_synchronous) and [large-row layout rationale](https://www.sqlite.org/withoutrowid.html). No physical power-loss experiment was performed.

## Validation

- Full storage:1,683passed/110files,45existing environment-gated skips.
- New native/integrated cases:30(part of the full cohort), including last-ACK whole-process SIGKILL before any RDF write and exact fresh-process readback; native FULL; pre/post-COMMIT worker death; same-write retry with no premature RDF/changelog; exact batch coverage and late arrivals; independent read progress; close/cancellation drainage; bounded allocation; legacy compatibility and tested rollback export.
- Counterfactuals fail as intended: acknowledging before COMMIT creates a dangling RDF ref; unconditionally materializing a16MiB value violates the allocation assertion. Correct source restored and rebuilt.
- Runtime dependency closure, source/type/package/prepared-CLI builds pass. Lint, source-size and disabled-test ratchets pass without increased budgets. Later metadata-only documentation changes do not alter these results.

## Method and limits

Same factory workload as the reviewer: persistent worker, blob decorator, graph index and enabled changelog; eight writers/two continuous readers;80KiB literals;1,200measured writes/case. Each case uses a fresh directory and checks write/user-graph counts and read results. Setup/warmup/final flush/close are excluded; normal background snapshots remain. Three orders alternate base/files/candidate, candidate/base/files, files/candidate/base. Unrelated host load is uncontrolled, so retain all rounds and avoid a production-SLA claim.

Base is an archived f9b5f2524 build with the same dependency closure. The worker files control uses564467092 compiled storage: its only additional source differences from0af are Blazegraph helpers unused by this worker workload. The separate Blazegraph sample uses an exact archived0af files control. Candidate runtime code is actually integrated through the explicit factory option, except the initial preliminary probe noted below.

The committed benchmark is `packages/storage/scripts/literal-blob-group-commit-benchmark.mjs`. Run the same source against separately built checkouts, setting `BENCH_N=1200 BENCH_CONCURRENCY=8` and `BENCH_BLOB_PERSISTENCE=sqlite-wal` only for the candidate. `BENCH_ENTROPY=random BENCH_READ_MODE=hydrate` selects incompressible80KiB prefixes and actual80KiB hydration; `BENCH_WRITER_INTERVAL_MS=80 BENCH_N=240` supplies the separate equal-rate control. Fresh hashes remain unique. Raw measurements/progress/host load are retained in the task-owned ignored `.tmp/pr3405-performance` directory; no raw node state or credentials are committed.

## Expanded worker results

The actual integrated option was measured with incompressible values, full80KiB hydration and both one/eight writers:72cases/86,400writes. Median writes/s:

| Case | Base | Durable files | Candidate | Candidate/base |
|---|---:|---:|---:|---:|
| small-1 | 3,261.84 | 3,904.45 | 4,127.77 | 126.5% |
| small-8 | 6,335.43 | 6,059.16 | 5,408.18 | 85.4% |
| replay-1 | 665.71 | 1,744.77 | 1,870.46 | 281.0% |
| replay-8 | 822.66 | 3,116.39 | 3,460.55 | 420.7% |
| fresh-1 | 456.83 | 149.30 | 222.53 | 48.7% |
| fresh-8 | 494.88 | 280.46 | 883.55 | 178.5% |
| mixed-1 | 1,549.78 | 588.83 | 780.39 | 50.4% |
| mixed-8 | 1,575.60 | 1,120.79 | 2,550.41 | 161.9% |

The eight-writer fresh/mixed throughput budget is met in this sample. The one-writer fresh/mixed cases retain approximately half the base throughput: a lone write still pays its own durable commit. Do not present group commit as removing that cost or as universal performance acceptance.

Hydrated read p99, milliseconds:

| Case | Base | Durable files | Candidate |
|---|---:|---:|---:|
| small-1 | 8.452 | 6.769 | 3.843 |
| small-8 | 3.153 | 4.208 | 5.011 |
| replay-1 | 14.129 | 6.672 | 4.446 |
| replay-8 | 4.011 | 19.982 | 18.953 |
| fresh-1 | 5.261 | 4.550 | 3.461 |
| fresh-8 | 4.051 | 8.899 | 5.206 |
| mixed-1 | 3.860 | 3.857 | 3.003 |
| mixed-8 | 3.979 | 8.611 | 4.280 |

Saturated read tails vary with the offered RDF throughput; some remain above base. A separate equal-rate three-pair control(36cases/8,640writes,roughly90–95writes/s) gives:

| Case | Base read p99 | Files read p99 | Candidate read p99 |
|---|---:|---:|---:|
| small-8 | 4.142 | 4.990 | 3.286 |
| replay-8 | 3.483 | 3.946 | 2.811 |
| fresh-8 | 3.654 | 5.210 | 3.272 |
| mixed-8 | 3.799 | 4.269 | 2.920 |

Mixed small-write p95 at equal rate is12.064/3.997/4.412ms(base/files/candidate). These controls do not establish that no latency tradeoff exists.

## Pinned Blazegraph sample

Owned isolated container from `islandora/blazegraph:6.4.3@sha256:015e308ae0a296cdb87c83c10da976ed970d2bfa971290aa1147593df8cf445d`; loaded webapp/library policy verified as DiskRW, ForceMetadata, `/data/bigdata.jnl`. Fresh owned namespaces use Identical collation consistently for all controls. Eight writers/two small SELECT readers,240writes/case,three alternating groups:36cases/8,640writes. No owned build/test job overlaps measurement. Every count/read check passes. Only the exact labeled container and its anonymous volumes were removed; unrelated services were left running.

| Case | Base writes/s | Files writes/s | Candidate writes/s | Candidate/base |
|---|---:|---:|---:|---:|
| small | 66.72 | 64.12 | 66.12 | 99.1% |
| replay | 55.27 | 66.93 | 65.57 | 118.6% |
| fresh | 52.32 | 65.80 | 66.93 | 127.9% |
| mixed | 65.45 | 68.62 | 63.52 | 97.1% |

Small-write p95 is150.453/145.920/152.808ms; mixed small p95 is146.954/138.048/161.218ms. Candidate meets the proposed80%-throughput/1.25x-small-p95 budgets in this sample. This is local backend evidence, not live publishing, a new Blazegraph crash proof, or production saturation evidence.

## Earlier alternatives and remaining gates

Directory-only barrier batching was slower and discarded. An early WITHOUTROWID/4KiB/1ms prototype retained only73% fresh/92% mixed throughput, missing the fresh budget. Refined rowid/8KiB prototypes were promising. A preliminary actual-owner adapter(small reads,36cases/43,200writes) gave base/files/candidate fresh535.21/255.65/803.95 and mixed1654.88/1035.38/2566.66 writes/s. These are preliminary observations, not substitutes for the integrated results above.

The first integrated single-worker version improved concurrent writes but blocked hydration behind native commits; that version was rejected. The retained independent reader passes a held-COMMIT progress test and the equal-rate controls above. Full raw rounds for the retained worker sample follow, rather than selecting one favorable baseline. Cold startup and one-writer cost remain tradeoffs. The optional layout changes disk format and runtime requirements; default rollout, human scope/performance/design acceptance, current-head remote review/CI, upper review fixes and combined-tip live validation remain outstanding. No merge or auto-merge is authorized.

## Worker raw throughput rounds

| Case | Base rounds | Files rounds | Candidate rounds |
|---|---|---|---|
| small-1 | 3261.84, 4173.37, 1972.46 | 4144.41, 3608.27, 3904.45 | 4127.77, 4717.59, 4049.11 |
| small-8 | 6335.43, 5596.88, 9791.93 | 6222.00, 5290.84, 6059.16 | 5408.18, 6291.67, 4286.20 |
| replay-1 | 720.29, 219.63, 665.71 | 1744.77, 1951.50, 1736.81 | 1870.46, 1880.53, 1660.30 |
| replay-8 | 822.66, 810.12, 1343.20 | 3289.53, 2740.30, 3116.39 | 3071.90, 3460.55, 4069.22 |
| fresh-1 | 456.83, 308.48, 624.39 | 157.87, 149.30, 137.33 | 228.16, 222.53, 207.56 |
| fresh-8 | 490.73, 494.88, 832.26 | 279.09, 280.46, 284.14 | 883.55, 849.70, 932.65 |
| mixed-1 | 1549.78, 1489.48, 2420.47 | 595.39, 583.15, 588.83 | 799.91, 780.39, 755.62 |
| mixed-8 | 1495.46, 1575.60, 2754.34 | 1120.79, 1097.66, 1159.99 | 2550.41, 2584.72, 1855.26 |
