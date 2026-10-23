# Durable blob group-commit evaluation

This is an isolated, optional candidate incorporating foundation7656690ee/testnet-canary556ad8d483. Earlier samples below remain attributed to their original foundation0af290930 source. Initial measurements below cover47969201e; the final review-revision comparison is recorded separately at the end. Defaults remain legacy files. It is not a default-rollout decision, closure of the performance P1, live testnet evidence, or merge readiness. No Oxigraph fork or extra native dependency is involved. The user requires retaining the guarantee while reducing the heavy cost; no budget waiver was accepted.

## Contract and implementation

Stock Node SQLite owns the blob database and its WAL. Writer connections verify WAL/FULL/fullfsync/checkpoint_fullfsync, application/version/UTF-8/rowid schema, and exact bytes/SHA. Up to eight ready writes (2 MiB, except one larger term) share one native COMMIT; only those members acknowledge. Failed transactions close their native connection and retry normally; worker loss never certifies an uncertain write. Immutable refs enter RDF only after the corresponding commit. A separate bounded read-only worker allows hydration during a slow writer commit. Queries enforce byte limits before native BLOB allocation. Wrapper/owner close drains accepted work, including detached canceled reads. Existing files are retained/readable; a non-destructive offline export uses the same durable legacy writer for rollback.

Runtime: native macOS arm64, Node22.23.3, SQLite3.51.3, libuv1.51.0, pnpm10.28.1. The option requires the [upstream WAL-reset fix](https://www.sqlite.org/wal.html#walreset), including its3.50.7/3.44.6 backports; unsupported runtimes reject before opening the DB. See [FULL synchronous policy](https://www.sqlite.org/pragma.html#pragma_synchronous) and [large-row layout rationale](https://www.sqlite.org/withoutrowid.html). No physical power-loss experiment was performed.

## Validation

- Full storage at final runtime source8bcd97b62:1,736passed/114files,45existing environment-gated skips. The later765 test-only fixture binding passes the exact17 routing and7crash cases; it does not change runtime source.
- Current native/integrated cases:68(part of the full cohort), including last-ACK whole-process SIGKILL before any RDF write and exact fresh-process readback; native FULL; pre/post-COMMIT worker death; same-write retry with no premature RDF/changelog; exact batch coverage and late arrivals; independent read progress; close/cancellation drainage; bounded allocation; legacy compatibility and tested rollback export.
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


## Review revision: shared owners, configuration and corruption

Review5631520192 identified configuration propagation and requested shared drain/format code and read-side corruption coverage. Agent, standalone publisher and managed configuration builders now preserve the explicit layout while retaining the files default. A real agent-default/factory/reopen test covers both layouts(two cases); managed configuration/startup suite40passes. StoreWorkDrain provides separate nonserializing lifetime instances for wrapper/physical owner and composes TwoPhaseMutationQueue; capacity and serialized-tail concerns remain separate. SQLite format identity/schema, bounded projection and verified decoding are shared by worker/exporter. Real altered UTF-8 BLOBs reject on read/hydration despite a valid legacy file, and export shares strict schema/integrity checks. Removing read-side hash verification makes both native-owner and wrapper corruption tests fail; correct source is restored/rebuilt. Current fullstorage1,687, runtime/type/package/prepared-CLI and unchanged hygiene ratchets pass. These results add no live/merge readiness.

A fresh final-source three-pair expanded worker comparison uses exact archived f9/0af controls, incompressible80KiB values and two full-hydration readers,1and8writers,72cases/86,400writes. All counts/read-value checks pass; no owned build/test overlaps measurement. Median writes/s:

| Case | Base | Files | Candidate | Candidate/base |
|---|---:|---:|---:|---:|
| small-1 | 3406.22 | 3137.24 | 3593.76 | 105.51% |
| small-8 | 5392.04 | 5230.63 | 4306.09 | 79.86% |
| replay-1 | 668.63 | 1650.01 | 1725.57 | 258.07% |
| replay-8 | 759.48 | 3443.31 | 3095.39 | 407.57% |
| fresh-1 | 435.35 | 153.75 | 211.06 | 48.48% |
| fresh-8 | 425.32 | 283.31 | 816.96 | 192.08% |
| mixed-1 | 1454.36 | 570.80 | 712.87 | 49.02% |
| mixed-8 | 1468.33 | 1118.65 | 2175.27 | 148.15% |

Fresh/mixed eight-writer throughput improves substantially and meets80% of base. **Small-only eight-writer throughput is79.86% of base, slightly below that budget**; do not round it into a pass. One-writer fresh/mixed still retain roughly49% of base. Saturated replay readp99 remains higher as offered RDF write throughput grows; no blanket regression-free claim is made. The earlier equal-rate and Blazegraph samples retain their revision/workload boundaries. Defaults/adoption and human performance acceptance remain open.

Final-source hydrated readp99(ms) and all raw throughput rounds:

| Case | Base read99 | Files read99 | Candidate read99 | Base rounds | Files rounds | Candidate rounds |
|---|---:|---:|---:|---|---|---|
| small-1 | 6.582 | 13.223 | 5.415 | 1995.51, 3406.22, 4936.98 | 959.50, 3280.03, 3137.24 | 3593.76, 3585.81, 7755.39 |
| small-8 | 2.769 | 4.128 | 4.357 | 721.11, 5392.04, 9573.01 | 5230.63, 4871.93, 9675.75 | 2611.09, 4306.09, 6277.88 |
| replay-1 | 5.664 | 7.778 | 5.517 | 322.86, 668.63, 836.74 | 746.67, 1763.18, 1650.01 | 1725.57, 1636.60, 3021.89 |
| replay-8 | 4.745 | 25.334 | 31.325 | 179.68, 759.48, 1417.82 | 2962.99, 3443.31, 4713.52 | 2601.37, 3095.39, 3807.53 |
| fresh-1 | 5.381 | 4.690 | 3.776 | 259.67, 435.35, 587.40 | 153.75, 150.15, 217.23 | 211.06, 206.07, 241.33 |
| fresh-8 | 5.599 | 8.613 | 5.578 | 146.36, 425.32, 872.83 | 276.68, 283.31, 285.12 | 775.25, 816.96, 886.39 |
| mixed-1 | 5.299 | 3.944 | 3.498 | 472.26, 1454.36, 2622.39 | 560.14, 570.80, 891.65 | 691.26, 712.87, 839.11 |
| mixed-8 | 4.177 | 8.777 | 4.847 | 468.15, 1468.33, 2736.32 | 1036.24, 1118.65, 1174.29 | 2175.27, 2056.69, 3328.18 |

The final full-storage rerun passes1,687 cases. Exact UTF-8/BOM preservation is covered in the shared decoder; this final character-preservation correction follows the comparison and changes no barrier or batch policy.

## Round3 contract evidence

The final local cohort passes1,694storage tests/110files with45existing gated skips;41native/integrated cases are included. Actual writer connections expose the required four effective settings on first open and failure-driven reopen. Each injected native downgrade rejects before blob ACK/RDF publication, then ordinary retry reinstates the full policy. Fresh-owner and lost-ACK matching-row adoption fail on a real native SQLite readonly error at full-byte INSERT, despite readable existing bytes; retry re-submits exact hash/byte length/payload hash. Unsupported runtime rejection allocates zero RDF workers. Counterfactuals removing factory preflight, accepting downgraded policy or skipping matching-row writes fail their distinguishing cases; correct source is restored and rebuilt. One session registry and canonical worker-error transport replace duplicated generic state/protocol. The actual057 CI packaging failure is corrected with shared Node engines metadata; patched SQLite is still checked separately for the optional mode. Runtime/types/package/preparedCLI, release-pack verification and hygiene pass. No later performance result or physical power-loss proof is implied.

## Published6f74e6973 production comparison

After round3, the actual published production code was remeasured without owned local builds/tests competing. The subsequent round4 changes concern only tests, their fixture load and this report; production format, timing, capacity and native barriers are unchanged. Exact archived f9b5f2524/0af controls use the same installed dependency closure. This supplements all earlier rounds rather than replacing a less favorable result. Other host load remains uncontrolled.

Three alternating expanded worker groups:72cases/86,400writes, incompressible80KiB values, one/eight writers and two readers hydrating80KiB values. Median writes/s and candidate/base:

| Case | Base | Durable files | Candidate | Candidate/base |
|---|---:|---:|---:|---:|
| small-1 | 4,274.80 | 4,129.55 | 4,633.15 | 108.38% |
| small-8 | 6,338.60 | 5,999.81 | 6,197.93 | 97.78% |
| replay-1 | 797.82 | 2,020.56 | 1,945.34 | 243.83% |
| replay-8 | 1,009.07 | 3,494.42 | 3,712.43 | 367.90% |
| fresh-1 | 603.72 | 165.51 | 227.04 | 37.61% |
| fresh-8 | 548.40 | 290.72 | 871.53 | 158.92% |
| mixed-1 | 1,805.30 | 611.26 | 825.83 | 45.75% |
| mixed-8 | 1,726.73 | 1,199.90 | 2,743.67 | 158.89% |

Concurrent fresh/mixed throughput clears the proposed80% budget in this sample. This does not establish overall acceptance: lone fresh/mixed writes retain37.61%/45.75% ofbase. Small-only eight-writer p95 is2.354/4.191/3.598ms(base/files/candidate), candidate1.53xbase, beyond a1.25x latency budget. Saturated replay readp99 is2.606/29.971/36.972ms. Earlier round2 small-only throughput79.86% remains relevant evidence of control variance.

Raw expanded throughput rounds (writes/s):

| Case | Base rounds | File rounds | Candidate rounds |
|---|---|---|---|
| small-1 | 3956.37, 4274.80, 7497.46 | 3540.22, 4256.33, 4129.55 | 4633.15, 4248.16, 8301.31 |
| small-8 | 6338.60, 6031.88, 9754.03 | 4995.62, 5999.81, 8656.05 | 6197.93, 7189.76, 5403.42 |
| replay-1 | 757.91, 797.82, 1281.21 | 1922.38, 2058.14, 2020.56 | 1945.34, 1921.85, 2829.71 |
| replay-8 | 895.50, 1009.07, 1433.87 | 3438.40, 3494.42, 4689.51 | 3079.82, 3712.43, 4020.20 |
| fresh-1 | 603.72, 493.29, 841.42 | 162.28, 171.69, 165.51 | 227.04, 225.37, 277.73 |
| fresh-8 | 548.40, 533.41, 871.82 | 290.72, 280.92, 292.56 | 871.53, 807.77, 997.63 |
| mixed-1 | 1805.30, 1644.75, 2723.69 | 599.57, 611.26, 753.35 | 825.83, 806.60, 923.59 |
| mixed-8 | 1612.37, 1726.73, 2697.24 | 1199.90, 1133.90, 1215.20 | 2583.90, 2743.67, 3504.54 |

Equal-rate controls (80ms/writer,8writers,240writes/case,36cases/8,640writes) retain approximately79.8–94.9writes/s. Readerp99 and small-writep95 below are medians, milliseconds.

| Case | Readp99 base/files/candidate | Smallp95 base/files/candidate |
|---|---|---|
| small-8 | 4.720 / 4.661 / 3.199 | 5.857 / 5.621 / 6.623 |
| replay-8 | 4.878 / 5.406 / 3.113 | n/a / n/a / n/a |
| fresh-8 | 4.996 / 5.629 / 3.258 | n/a / n/a / n/a |
| mixed-8 | 4.472 / 5.129 / 2.681 | 14.589 / 4.680 / 7.111 |

Current native Blazegraph: same exact pinned image, verified loaded DiskRW/ForceMetadata journal policy, fresh Identical namespaces,8writers/two small SELECT readers,240writes/case,3alternating groups,36cases/8,640writes. This is a local backend workload, not live chain publication.

| Case | Base writes/s | Files writes/s | Candidate writes/s | Smallp95 base/files/candidate ms |
|---|---:|---:|---:|---|
| small | 91.57 | 78.38 | 80.71 | 114.369 / 150.023 / 136.339 |
| replay | 74.73 | 87.18 | 84.55 | n/a / n/a / n/a |
| fresh | 67.28 | 86.95 | 86.23 | n/a / n/a / n/a |
| mixed | 76.60 | 87.37 | 87.55 | 132.756 / 114.128 / 115.423 |

The proposed throughput/small-p95 budgets are met in this native Blazegraph sample, including the small-only control. Counts/read values are checked; the exact labeled container and anonymous volumes were removed and its ownership manifest records cleanup. No wallets or live signing were used. Native Blazegraph evidence does not erase the worker single-writer/saturated-tail costs or grant default/adoption/human acceptance. Raw rounds, host-load records and ownership are retained under task-owned r3-* evidence.

Raw native Blazegraph throughput rounds (writes/s):

| Case | Base rounds | File rounds | Candidate rounds |
|---|---|---|---|
| small | 44.89, 91.57, 93.52 | 64.81, 78.38, 89.84 | 69.85, 82.18, 80.71 |
| replay | 46.71, 74.73, 79.04 | 64.75, 87.75, 87.18 | 81.52, 84.55, 89.00 |
| fresh | 52.46, 69.88, 67.28 | 64.67, 86.95, 88.63 | 86.23, 85.07, 96.29 |
| mixed | 61.57, 86.82, 76.60 | 62.87, 94.67, 87.37 | 86.80, 87.55, 102.75 |

## Round4 review and CI regressions

The writer-replacement regression now issues a distinct write after the old writer callback and asserts that no additional worker is allocated; removing identity-checked deletion fails it. Two deterministic composed-store groups collect eight distinct values and fail at actual SQLite FULL or pre-COMMIT worker death. Every member rejects, no RDF/changelog references appear, close drains, and ordinary retries produce exact values and the expected contiguous sequences. Rejecting only one member fails the explicit settlement guard; exact owned workers are terminated on that failing counterfactual. The fixture loads the fixed relative production build, allowing the CI dependency tracer to follow it without an exception list.

Final full storage1,696/110files(45existing gated skips),43native/integrated cases and780repository script assertions pass. An initial concurrently contended full run exceeded the default5s total in a new three-reopen case; the redundant final reopen was removed, preserving the failure/close/retry/content/sequence checks. Final full rerun passes with unchanged timeouts and no added skips/budgets. Production source remains identical to6f74e6973; that revision's runtime/types/package/preparedCLI and release-pack verification remain applicable. Current-head remote review/fullCI and human/default acceptance remain separate gates.

## Round5 preallocation validation

A new review reply on the previously resolved startup thread identified invalid JSON persistence reaching the wrapper after backend allocation. Pure directory/threshold/layout validation is now shared by direct construction and factory resolution before backend creation; patched SQLite preflight remains separate. Six invalid JSON cases and the existing unsupported-runtime case assert zero backend invocations and zero real workers. The regression uses a factory probe that captures a real persistent worker handle only for cleanup when the bug is deliberately restored, so intentional close prevents respawn. Restoring late validation fails all six distinguishing assertions without hook/cleanup failures. This changes startup validation only, preserving valid-config physical write/read, format, group timing, barriers and defaults. The earlier measured production hot path remains applicable; no new performance or live claim is implied. Current source passes 1,702 storage tests across 110 files (45 existing gated skips), including 49 native/integrated cases; storage/agent/CLI types and builds, release-pack verification and hygiene pass. The prior complete script run passed 780 assertions; the refreshed dependency-trace check passes all 17 cases.

## Round6 rollback interruption and fixed connection ownership

Rollback publication now stages and syncs complete bytes through the existing legacy writer, atomically hard-links a complete hash without replacing conflicts, and re-certifies final bytes/name through that writer's barriers. A failed partial re-submission cannot truncate already complete bytes. Only the invocation's own staging directory is cleaned; an abandoned partial stage remains ignored. Destination filesystems must support hard links. Normal legacy write policy and source SQLite data are preserved. Tests inject an actual FileHandle.writeFile prefix plus ENOSPC at both staging and final re-submission, then run a fresh exporter, verify exact legacy hydration and unchanged source DB bytes, and separately protect an unrelated conflicting hash. Direct-final and overwrite-publication counterfactuals fail their distinguishing cases.

CLI configuration imports/re-exports the canonical storage type without a runtime dependency; its typed persistence contract fails against the old three-field interface. Reader/writer connection mode now comes from the immutable worker role, removing promotion/writable state while preserving missing reads, read-only refusal and failure-driven reopen. Focused53native/integrated cases, runtime dependency/type/package/preparedCLI builds, dependency routing and hygiene pass; final full storage also passes1,706cases/110files, with45existing gated skips. Release-pack verification passes. No timeout, skip or source-size budget was increased. These changes do not imply new performance acceptance, default adoption or live testnet proof.

## Round7 native schema identity regression

Independent native reproduction confirmed the review finding: the old name-only validation acknowledged a write after a same-name trigger deleted its row, allowed composed RDF/changelog publication, accepted legal sqliteX objects hidden by LIKE's underscore wildcard, and adopted an unclaimed foreign database. All10new owner/composed/export regressions fail against the previous production code.

Both adoption and strict format checks now share a literal SQLite-internal prefix scan, while always exposing executable/unknown object types. The expected single user object must be a table named blobs associated with that table; existing version/encoding/rowid/column checks remain. Same-name and sqliteX triggers/tables reject before ACK/RDF/changelog/export publication, preserving source rows/bytes and foreign identity. Focused63native/integrated cases pass; final full storage also passes1,716cases/110files with45existing gated skips. Runtime dependency/type/package/preparedCLI, release-pack verification,17dependency-routing cases and hygiene pass with no increased budgets or skips. The preceding c2c published source has a completed fresh72case/86,400write worker comparison and36case/8,640write equal-rate/nativeBlazegraph controls; these remain revision-limited and do not claim global performance/default/live acceptance.

## Final published c2c1722ae performance controls

This complete rerun covers published c2c1722ae, before the subsequent startup/adoption-only schema rejection fix. Valid-format native write/read/commit scheduling is unchanged; these figures are tied to c2c, not claimed as a fresh measure of a later tip. No owned local builds or tests competed. Exact archived f9b5f2524/0af controls share the installed dependency closure. Other host load remains uncontrolled. All144cases/103,680writes complete with expected counts/read values and exact labeled nativeBlazegraph container/volume cleanup.

Expanded worker (72cases/86,400writes), median writes/s:

| Case | Base | Files | Candidate | Candidate/base |
|---|---:|---:|---:|---:|
| small-1 | 5053.24 | 4989.37 | 5034.47 | 99.63% |
| small-8 | 6902.78 | 6514.90 | 6863.43 | 99.43% |
| replay-1 | 908.72 | 2092.67 | 2130.33 | 234.43% |
| replay-8 | 956.36 | 3259.55 | 3494.62 | 365.41% |
| fresh-1 | 568.08 | 176.17 | 233.87 | 41.17% |
| fresh-8 | 554.55 | 285.59 | 853.62 | 153.93% |
| mixed-1 | 1791.43 | 698.33 | 841.52 | 46.97% |
| mixed-8 | 1873.67 | 1155.31 | 2674.04 | 142.72% |

Concurrent throughput and small-write-p95 budgets pass in this sample: small-only p95 base/files/candidate2.854/2.812/3.000ms; mixed-small p958.426/0.742/3.137ms. It remains no overall acceptance: single-writer fresh/mixed retain41.17%/46.97% ofbase; saturated replay readp99 is3.519/40.547/19.159ms. Earlier79.86% small-only throughput and1.53x small-p95 samples remain disclosed.

Raw expanded throughput rounds (writes/s):

| Case | Base rounds | Files rounds | Candidate rounds |
|---|---|---|---|
| small-1 | 2842.54, 5501.43, 5053.24 | 7953.63, 4686.39, 4989.37 | 4707.96, 5857.69, 5034.47 |
| small-8 | 11986.77, 5018.26, 6902.78 | 9795.35, 6369.61, 6514.90 | 7401.89, 6284.97, 6863.43 |
| replay-1 | 1011.89, 858.24, 908.72 | 3160.95, 2092.67, 2012.68 | 2146.92, 2105.09, 2130.33 |
| replay-8 | 1487.77, 942.64, 956.36 | 4857.77, 2270.10, 3259.55 | 3502.45, 3494.62, 3407.01 |
| fresh-1 | 811.20, 568.08, 549.40 | 223.41, 175.31, 176.17 | 233.87, 238.25, 199.76 |
| fresh-8 | 934.31, 554.55, 549.82 | 285.82, 283.96, 285.59 | 853.62, 877.48, 836.37 |
| mixed-1 | 2840.65, 1753.52, 1791.43 | 876.69, 677.80, 698.33 | 841.52, 862.50, 632.00 |
| mixed-8 | 2687.87, 1757.02, 1873.67 | 1119.40, 1172.60, 1155.31 | 2568.15, 2674.04, 2964.47 |

Equal-paced controls(36cases/8,640writes), readerp99 and small-writep95 in milliseconds:

| Case | Readerp99 base/files/candidate | Smallp95 base/files/candidate |
|---|---|---|
| small-8 | 6.291 / 4.895 / 3.763 | 3.776 / 5.610 / 3.883 |
| replay-8 | 5.239 / 6.602 / 3.582 | n/a / n/a / n/a |
| fresh-8 | 6.195 / 6.272 / 3.741 | n/a / n/a / n/a |
| mixed-8 | 3.266 / 5.263 / 3.148 | 7.998 / 6.465 / 4.395 |

Pinned nativeBlazegraph(36cases/8,640writes), verified loaded DiskRW/ForceMetadata and fresh Identical namespaces:

| Case | Base writes/s | Files writes/s | Candidate writes/s | Smallp95 base/files/candidate ms |
|---|---:|---:|---:|---|
| small | 71.04 | 75.93 | 75.97 | 162.920 / 137.749 / 130.521 |
| replay | 65.78 | 76.05 | 76.11 | n/a / n/a / n/a |
| fresh | 62.70 | 74.43 | 76.32 | n/a / n/a / n/a |
| mixed | 73.38 | 75.76 | 81.94 | 143.764 / 134.407 / 127.238 |

NativeBlazegraph meets the proposed throughput/small-p95 budgets in this sample. Raw throughput rounds:

| Case | Base rounds | Files rounds | Candidate rounds |
|---|---|---|---|
| small | 56.24, 71.04, 90.73 | 73.08, 84.00, 75.93 | 71.68, 77.89, 75.97 |
| replay | 58.66, 65.78, 74.15 | 75.85, 81.81, 76.05 | 72.24, 76.11, 76.32 |
| fresh | 57.59, 62.70, 70.64 | 73.92, 74.43, 79.66 | 78.81, 76.32, 69.98 |
| mixed | 67.69, 76.67, 73.38 | 75.76, 78.02, 63.27 | 81.94, 78.56, 89.04 |

All current sample budgets that pass remain separate from human acceptance/default rollout. Single-writer/saturation costs remain material. There was no live chain publication, no wallet claim and no physical power-loss experiment. The combined final stack still requires live testnet validation after source/default decisions converge.

## Round8 bounded-work composition

A shared FIFO BoundedWork now owns slot transfer/release for both single-flight preparation and the SQLite physical owner. Separate instances retain logical preparation admission,4reader/8writer capacities and StoreWorkDrain registration. Pending cache identity still precedes callbacks; cache/coalescing/eviction, failure retry and abort/close drainage remain intact. Observable FIFO/new-arrival and synchronous-throw cases pass; omitting handoff or making the slot stealable fails the distinguishing test without native resources. Actual held native COMMIT/read probes assert8write/4read RPC limits and progress through the independent role. The prior63native/integrated cases and6single-flight tests pass; new physical bounds cases pass separately. Final full storage passes1,720cases/111files with45existing gated skips, including65native/integrated cases. Runtime/types/package/preparedCLI, release-pack verification,17dependency-routing cases and hygiene pass without increased budgets/timeouts/skips. Final published-source timing follows; no rollout/performance/live acceptance is implied.

## Round9 exact byte-split acknowledgement membership

Test-only deterministic collection now combines with successive native COMMIT holds. Eight600KiB values split3/3/2; one oversized value followed by7small values splits1/7. While each later commit is held, exact prior members alone settle and appear through independent native reads. Final release yields every exact value and expected commit count. A production counterfactual acknowledging queued nonmembers after the first commit fails both cases; every hold is released and accepted work drains. Correct worker restored/rebuilt. Production source is unchanged from published955; final full storage passes1,722cases/111files with45existing gated skips, including67native/integrated cases. Current release-pack verification,17dependency-route cases and hygiene pass; the unchanged955production runtime/type/CLI build remains applicable. No budgets/timeouts/skips were increased. No new performance/default/live acceptance is implied.

## Published955eab3da performance refresh

The full144case/103,680write matrix was repeated after the bounded-work refactor, with no owned local build/test competition. The subsequent round9 adds tests only; production code is identical. Same exact f9/0af controls, three alternating groups, raw outputs and uncontrolled other-host-load limits apply.

Worker medians (72cases/86,400writes), writes/s:

| Case | Base | Files | Candidate | Candidate/base |
|---|---:|---:|---:|---:|
| small-1 | 5502.77 | 4949.45 | 4991.45 | 90.71% |
| small-8 | 6375.06 | 6434.88 | 6919.75 | 108.54% |
| replay-1 | 926.59 | 2115.27 | 2258.33 | 243.72% |
| replay-8 | 998.30 | 3709.45 | 3621.13 | 362.73% |
| fresh-1 | 588.14 | 188.98 | 237.22 | 40.33% |
| fresh-8 | 607.47 | 276.07 | 920.57 | 151.54% |
| mixed-1 | 1810.72 | 726.45 | 858.66 | 47.42% |
| mixed-8 | 1953.24 | 1091.10 | 2992.44 | 153.20% |

Concurrent throughput/small-p95 budgets pass in this sample: small p952.957/2.956/2.903ms, mixed-small p958.637/1.170/2.339ms(base/files/candidate). Single-writer fresh/mixed retain40.33%/47.42% ofbase; saturated read costs remain separate. Raw throughput rounds:

| Case | Base rounds | Files rounds | Candidate rounds |
|---|---|---|---|
| small-1 | 8731.10, 4743.23, 5502.77 | 8534.95, 4949.45, 2989.31 | 4175.34, 4991.45, 5810.70 |
| small-8 | 10168.99, 6375.06, 6336.45 | 9596.05, 4784.91, 6434.88 | 7920.70, 6703.49, 6919.75 |
| replay-1 | 1349.36, 926.59, 890.92 | 3137.21, 2115.27, 1958.59 | 1157.77, 2258.33, 2298.22 |
| replay-8 | 1481.25, 923.33, 998.30 | 4016.53, 3222.45, 3709.45 | 3621.13, 3439.48, 3730.96 |
| fresh-1 | 879.07, 588.03, 588.14 | 221.25, 184.20, 188.98 | 213.54, 239.34, 237.22 |
| fresh-8 | 922.89, 457.66, 607.47 | 262.19, 276.07, 284.83 | 962.74, 920.57, 882.84 |
| mixed-1 | 2886.38, 1746.57, 1810.72 | 754.87, 726.45, 663.55 | 858.66, 886.82, 850.32 |
| mixed-8 | 2924.09, 1850.29, 1953.24 | 1072.33, 1091.10, 1171.25 | 2992.44, 2809.91, 3085.98 |

Worker readp99 (unpaced saturation), milliseconds:

| Case | Base | Files | Candidate |
|---|---:|---:|---:|
| small-1 | 3.701 | 3.972 | 3.801 |
| small-8 | 3.340 | 3.292 | 3.341 |
| replay-1 | 2.676 | 5.297 | 3.749 |
| replay-8 | 3.127 | 35.933 | 26.061 |
| fresh-1 | 2.867 | 2.531 | 2.544 |
| fresh-8 | 3.282 | 8.745 | 3.305 |
| mixed-1 | 2.795 | 2.534 | 1.899 |
| mixed-8 | 2.407 | 8.669 | 3.018 |

Equal-paced reader controls (36cases/8,640writes), readp99 in milliseconds:

| Case | Base | Files | Candidate |
|---|---:|---:|---:|
| small-8 | 1.955 | 2.062 | 1.866 |
| replay-8 | 1.887 | 2.263 | 1.483 |
| fresh-8 | 2.094 | 2.478 | 1.829 |
| mixed-8 | 1.980 | 1.816 | 1.249 |

Pinned nativeBlazegraph (36cases/8,640writes), loaded DiskRW/ForceMetadata and fresh Identical namespaces verified:

| Case | Base writes/s | Files writes/s | Candidate writes/s | Smallp95 base/files/candidate ms | Readp99 base/files/candidate ms |
|---|---:|---:|---:|---|---|
| small | 68.42 | 85.00 | 90.58 | 145.966 / 115.257 / 110.125 | 42.072 / 32.712 / 33.408 |
| replay | 59.44 | 82.96 | 82.64 | n/a / n/a / n/a | 35.468 / 32.868 / 33.959 |
| fresh | 66.30 | 80.06 | 79.56 | n/a / n/a / n/a | 30.804 / 35.796 / 34.994 |
| mixed | 79.55 | 86.54 | 78.19 | 128.635 / 118.042 / 141.486 | 31.315 / 35.973 / 39.618 |

The proposed throughput/small-write-p95 budgets pass in this nativeBlazegraph sample. Mixed readp99 is26.5% abovebase(39.618vs31.315ms); do not call this a universal no-regression pass. Raw throughput rounds:

| Case | Base rounds | Files rounds | Candidate rounds |
|---|---|---|---|
| small | 68.42, 76.91, 68.16 | 84.22, 86.54, 85.00 | 90.58, 90.86, 59.17 |
| replay | 59.44, 77.99, 58.02 | 84.29, 82.96, 75.84 | 82.64, 91.45, 63.87 |
| fresh | 66.30, 70.92, 64.55 | 88.74, 80.06, 72.19 | 79.56, 93.11, 64.25 |
| mixed | 79.55, 83.73, 72.26 | 86.54, 89.55, 68.15 | 89.65, 78.19, 73.71 |

Counts and read values pass throughout. Exact owned container/volumes were removed; unrelated services and wallets were untouched. Earlier unfavorable samples are retained. Human budget/scope/default acceptance and final combined-tip live testnet remain open; no new publication or physical power-loss proof is claimed.


## Round10 stored-row integrity and standalone publisher configuration


Round10 local validation: full storage1,723/111files passes with45existing gated skips, including68native/integrated cases. The stored-row conflict test uses altered valid UTF-8 of exactly the original byte length, so byte comparison rather than size alone must reject; independent native row inspection verifies retention after fresh-owner close. Disabling that guard acknowledges the write and fails the regression. Both standalone runtime and inspector reconstruct a real worker store with config.store omitted and hydrate a SQLite-only literal; removing the layout spread makes both fail with missing legacy blobs. Restored CLI composition/managed suites pass46cases/3files, including actual stock managed HTTP process restart without certification. CLI type contracts,17dependency-route and7execution-route cases, lint/size/disabled/diff pass. No production changes from955, new timeouts/skips, default adoption, live or merge claim. Current-head review/full CI remain pending.


## Round11 direct physical-owner delegation


Round11 validation: all1,723storage tests/111files pass(45existing gated skips), including68native/integrated cases and the existing file barrier/coalescing/drain regressions. Storage source/types and release-pack checks pass; real publisher composition5cases passes after rebuilding storage; lint/size/disabled/diff pass with unchanged budgets. The only runtime diff since955 is removal of the file-only forwarding hop plus constructor-local path storage; SQLite engine/queues/policy/batch timing are unchanged. Earlier955benchmark results retain their exact revision attribution; no fresh benchmark or universal performance claim is implied. Because completed f3 review has only this mechanical nit and all semantic regressions remain green, overlap new-head full test-only CI/EVM with review rather than waiting another review window to start CI. Both must finish on the exact published head before technical convergence. Rollout/human and combined-live gates remain open.


## Updated-base final-source comparison (2026-10-23 UTC)

Candidate runtime source: `8bcd97b62` (subsequent foundation765 integration changes only the crash test/plan). Base: `556ad8d483`; durable-files foundation: `ab5facfea`. Fresh archived controls use the same installed/built556 dependency closure. Node22.23.3/SQLite3.51.3/macOS arm64; three alternating groups, with no owned local build/test competing during measurement. All prior samples and limits above remain retained.

Observed complete cohorts: worker72cases/86,400writes; equal-paced worker36/8,640; pinned native Blazegraph36/8,640. Every expected count/read assertion passes. The native journal reports DiskRW/ForceMetadata, with Identical namespaces; exact labeled container and anonymous volumes were removed. The worker uses incompressible80KiB prefixes and full hydration readers. Native Blazegraph uses repeated80KiB prefixes and two small SELECT readers; it is not a full-hydration or live publication benchmark.

Median worker writes/s:

| Case | Base | Files | Candidate | Candidate/base |
|---|---:|---:|---:|---:|
| small-1 | 6,587.50 | 6,159.92 | 6,563.75 | 99.64% |
| small-8 | 9,039.83 | 7,993.21 | 14,309.58 | 158.29% |
| replay-1 | 1,070.72 | 2,668.09 | 2,690.21 | 251.25% |
| replay-8 | 1,097.50 | 4,424.70 | 4,961.88 | 452.11% |
| fresh-1 | 649.04 | 197.46 | 289.09 | 44.54% |
| fresh-8 | 671.01 | 284.41 | 999.28 | 148.92% |
| mixed-1 | 2,140.46 | 682.87 | 1,121.28 | 52.38% |
| mixed-8 | 2,202.15 | 1,141.37 | 3,605.73 | 163.74% |

Concurrent worker throughput and small-write-p95 budgets pass in this sample; single-writer fresh/mixed retain44.54%/52.38% of base and remain a disclosed cost. Small-only eight-writer p95 is1.962/2.122/0.942ms(base/files/candidate); use the raw summary for exact per-round evidence. This is not universal performance acceptance.

Equal-paced worker hydrated read p99(ms):

| Workload | Base | Files | Candidate |
|---|---:|---:|---:|
| small-8 | 2.952 | 4.180 | 1.939 |
| replay-8 | 2.818 | 3.096 | 1.867 |
| fresh-8 | 3.267 | 4.093 | 1.968 |
| mixed-8 | 2.340 | 2.885 | 1.583 |

Native Blazegraph medians:

| Workload | Base writes/s | Files writes/s | Candidate writes/s | Candidate/base |
|---|---:|---:|---:|---:|
| small | 90.76 | 93.38 | 68.62 | 75.61% |
| replay | 75.25 | 92.55 | 84.56 | 112.38% |
| fresh | 60.20 | 95.49 | 86.99 | 144.50% |
| mixed | 86.43 | 101.92 | 91.87 | 106.29% |

**Native small-only budgets FAIL in this sample.** Throughput retains75.61% of base (<80%); small-write p95 is103.820/104.996/137.645ms, with candidate/base1.326 (>1.25). Fresh/mixed throughput passes. Native small-read p99 is33.087/33.333/42.398ms; replay34.827/37.159/42.151; fresh33.506/30.095/38.150; mixed35.617/31.546/36.112(base/files/candidate). Do not claim an overall native or no-regression pass.

The native small-only per-round throughput is base55.26/90.76/110.23, files77.16/93.38/96.09 and candidate68.62/68.59/93.54. This variation and changing host load do not establish causality. Retain the failed sample and perform a bounded focused diagnostic after one common server warmup, with all six order permutations and unchanged source/policy/budgets. No runtime change or performance waiver is justified merely by a noisy or favorable run.

Current component validation: full storage1,736/114files,45existing gated (including68 native/integrated); agent defaulting/same-instance reuse/reopen2; managed/publisher45; runtime/source/types/packages and release-pack at parenta427; current storage/types and final exact routing17/crash7 pass. The765 fixture binding is test-only, with no changed runtime/declarations or benchmark code. Fresh current-head review/fullCI/EVM, human/default/adoption decisions and final combined-tip live proof remain required.

## Bounded native small-write diagnostic

Same runtime source8bcd97b62, base556 and filesab5, same pinned journal policy and thresholds. One common server warmup for each variant (three unmeasured240-write cases), then all six order permutations,600measured writes/case and two small SELECT readers: **18cases/10,800writes**. No owned build/test overlaps. All count/read checks pass and the exact labeled container/volumes are removed. SQL initialization still occurs per case before the measured interval; this is not an initialization-latency or power-loss claim.

| Variant | Median writes/s | Small-write p95 ms | Read p99 ms | Six throughput samples |
|---|---:|---:|---:|---|
| base | 81.93 | 128.854 | 39.624 | 72.74 / 81.65 / 89.10 / 84.00 / 82.22 / 53.32 |
| files | 78.30 | 126.764 | 38.431 | 72.64 / 78.60 / 77.65 / 78.01 / 82.10 / 80.95 |
| candidate | 77.11 | 127.296 | 41.513 | 77.27 / 76.94 / 81.94 / 77.31 / 72.02 / 72.53 |

The warmed balanced diagnostic meets the proposed small-write budgets: **94.11% of base throughput and 0.988x base p95**. Read p99 is 1.048x base. This supports a viable steady-state path; it does not erase the original75.61%/1.326x miss, establish its cause, prove no regression, or accept a rollout. No runtime change or budget relaxation was made in response to the miss.

Single-writer costs, initial blob preparation outside the timer, native read tails, uncontrolled host load and the failed complete native sample remain disclosed. Defaults stay files and the optional engine is not adopted into3406. Human performance/design/adoption review, current-head completed automated review/fullCI/EVM and fresh combined-tip live proof remain gates; no merge or activation is authorized.
