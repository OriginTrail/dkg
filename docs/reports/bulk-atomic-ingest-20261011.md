# Bulk atomic ingestion: completed local comparison

The fresh nine-trial run completed after disk space was made available. All nine
trials passed full inventory/root coverage and bounded query readiness. Reopening
the journals preserved the expected identities, stored metadata roots, and data
counts in the source and all nine receiver namespaces. Owned processes stopped
and their ports were released; evidence and journals remain preserved.

Median query-ready time is 2.9–4.5% lower than the historical baseline. Measured
atomic-write time is 6.7–7.8% lower. This is a modest local result, not evidence of
a large performance gain or a mainnet timing guarantee. The comparison includes
different resource conditions and later core-cache hardening in the candidate;
it does not isolate the ingestion change's causal contribution.

## Provenance and unchanged workload

- Measured checkout: `ddd219dd5cb276206babe0d9191e418c4fb2c7af`.
- Runtime implementation: `f1ee15204c01ad5739f3c71cbcb3e0de6a89f9e7`; the subsequent
  commit changed only documentation. Compiled storage hashes match the earlier
  interrupted attempt.
- Candidate base: `b8e0bfa197da0eece6b428a457865f4aa14b1df2`.
- Historical baseline: `ac9989454d9c3259195516ca657948f0f7bdc4bb`.
- Version: 10.0.23, built from unreleased PR source.
- Three trials per mode, each using a fresh receiver namespace; nine new trials
  were run together. No results from the interrupted attempt are mixed in.
- All 564 corpus files were checked against their archived SHA-256 digests.
- Corpus: 564 assets, 3,751,526 data quads, 580,640,763 raw input bytes. Every
  completed transfer matched the baseline's 56,140,435 encoded payload bytes and
  1,060,848,527 serialized bytes.
- Real isolated Hardhat contracts, real DKG libp2p exact-batch streaming, two
  native persistent Blazegraph stores, one supplier, 10-asset requests and a
  two-asset stream window. Each store retains its 3 GiB heap limit and four active
  processors. Source and receiver agents share a Node.js process, with separate
  verification workers.
- The receiver's opt-in native staging option is the only measurement-fixture
  change from baseline. Test deadlines, grading, transfer settings, and the
  original 7 GiB disk guard are unchanged.

The [machine-readable results](bulk-atomic-ingest-20261011.json) include exact
timings, fixture/manifest/dependency/controller/build hashes, all nine outcomes,
restart proof, and limitations. The [interrupted comparison](bulk-atomic-ingest-20261010.md)
remains available separately.

## Results

Times below are medians over three trials per mode on each side. Query-ready
includes complete inventory/root checks and a bounded entity query through
`DKGAgent.query`, matching all three expected facts.

| Mode | Baseline query-ready | Candidate query-ready | Reduction | Baseline atomic writes | Candidate atomic writes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Core cache, cold | 284.97 s | 276.80 s | 2.87% | 132.23 s | 123.38 s |
| Core cache, warm | 232.93 s | 225.54 s | 3.18% | 130.85 s | 121.87 s |
| RPC-only | 286.79 s | 273.76 s | 4.55% | 132.49 s | 122.18 s |

All candidate query-ready measurements, in trial order within each mode:

| Mode | Trial 1 | Trial 2 | Trial 3 |
| --- | ---: | ---: | ---: |
| Core cache, cold | 280.67 s | 276.80 s | 270.78 s |
| Core cache, warm | 225.54 s | 232.92 s | 220.00 s |
| RPC-only | 277.57 s | 271.96 s | 273.76 s |

The earlier interrupted attempt's slower RPC-only result did not repeat here.
It remains in that attempt's record; the rerun does not prove that disk pressure
caused it. Trial variation and baseline differences prevent a strong attribution
of these single-digit improvements to the storage change alone.

The measured test, including source preparation, took 2,624.12 seconds; journal
restart checks followed. Source preparation took 243.84 seconds and is excluded
from individual sync/query-ready timings. Free space started at 41.12 GiB and
the minimum recorded during the timed test was 27.67 GiB, so the disk guard never
fired. Peak recorded one-minute load was 12.24 on a shared 24 GiB system. No
additional local build or test suite ran concurrently with the measurement.

## Correctness and scope

Each of nine trials committed all 564 assets and passed inventory/root equality
and the bounded entity query. After the journals were reopened, the source and
all nine receivers each retained 564 expected identities, matching stored roots,
and 3,751,526 physical data quads. This persistence check does not freshly
recompute every assertion's Merkle root after restart.

The runtime implementation is unchanged from the version that passed 1,297
storage tests (34 skipped), 27 focused bulk-ingestion tests included in that
total, three native-engine contract tests, an additional partial-upload probe,
the agent/dependency build, and the 12-asset live smoke. Those earlier checks are
carried forward by unchanged source and compiled hashes; they were not rerun
concurrently with the full benchmark.

This feature bulk-loads one asset's assertion and metadata into staging graphs,
then publishes the pair atomically with a receipt. It remains opt-in and does
not combine multiple assets into one transaction. Each asset still incurs
publication, readback and cleanup work. The result supports investigating
cross-asset commit amortization separately, with explicit atomicity, version,
failure-recovery, and acknowledgement contracts; that behavior is not part of
this PR.

Cold/warm labels refer to source application caches, not reset OS/database page
caches. RPC-only uses the new coherent snapshot implementation. The dataset is
a reconstructed public RDF projection, not a byte-identical historical network
replay. Timings exclude startup, embedding/index construction and model warmup;
overlapping stage totals must not be summed as separate wall-clock costs. The
bounded query check makes no claim about the broad all-variable query-planning
issue recorded in the preceding baseline preparation attempt.
