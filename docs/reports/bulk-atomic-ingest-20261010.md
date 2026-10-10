# Opt-in bulk atomic ingestion: partial local comparison

The implementation passed the storage and native-engine checks. Six of the
planned nine full-size sync trials completed and passed coverage, direct-query,
and subsequent journal-restart checks. The original controller stopped the run
during the seventh trial when free disk crossed its 7 GiB guard. **The benchmark
is incomplete; this is not a full performance pass or an observed ingestion
failure.** No failed or slow completed result was discarded.

The partial results show a small difference in the core-cache modes and a
regression in RPC-only mode. They do not establish a material end-to-end gain.
The PR remains draft pending a clean full comparison with sufficient headroom.

## Measured code and scope

- Candidate runtime: `f1ee15204c01ad5739f3c71cbcb3e0de6a89f9e7`.
- Candidate base: `b8e0bfa197da0eece6b428a457865f4aa14b1df2` (core-cache implementation).
- Historical baseline: `ac9989454d9c3259195516ca657948f0f7bdc4bb`.
- Package version: 10.0.23; these measurements use unreleased source builds.
- Fixture SHA-256: `6839939f3876c7ff79a1e17fbfa00b04291f41a3ffabbacb6857decd2524dbad`.
- Corpus manifest SHA-256: `d62cc71781ab24a48be25d346f6567e8b479600cabbaf96fbad3b170b06c64b8`.

The receiver enables `SparqlHttpStore.bulkAtomicIngest` with the
`blazegraph-n-quads` format. This bulk-loads **one asset's assertion and metadata**
into private staging graphs, then atomically publishes both with a guarded
DELETE/INSERT and verifies a unique commit receipt. It does not group multiple
assets into one transaction. Default storage behavior is unchanged.

The same external measurement fixture and reconstructed public RDF corpus were
used, with only the receiver storage option changed. The source path, 10-asset
requests, two-asset stream window, single supplier, deadlines, query, and grading
were retained. The baseline predates later core-cache review hardening included
in the candidate base, so this is not a matched-current-base A/B experiment.

## Workload and measurement

The corpus contains 564 assets and 3,751,526 data quads, from 580,640,763 raw input
bytes. Each completed trial transferred exactly 56,140,435 encoded payload bytes
representing 1,060,848,527 serialized bytes, matching the baseline.

The test uses real isolated Hardhat contracts, real DKG libp2p exact-batch
streaming, and two native persistent Blazegraph stores. Source and receiver are
separate DKGAgent instances in one Node.js process, with separate verification
workers. Each store has a 3 GiB maximum heap and four active processors. Every
trial gets a fresh receiver namespace. Cold/warm describes source application
caches; OS and database page caches are not reset. RPC-only uses the coherent
snapshot implementation, not the historical per-asset RPC path.

Timing starts at the sync call after the agents are started and connected. Source
preparation (245.66 seconds in this attempt) and startup are excluded. Query
readiness requires complete inventory/root equality and a bounded entity query
through `DKGAgent.query` matching all three expected facts. It does not include
embeddings, semantic-index construction, model warmup, or a full data export.
A broad all-variable query failed in a preceding baseline preparation attempt;
these results make no claim that the bounded lookup fixes that query-plan issue.

## Partial results

Values are medians: three baseline trials and **two completed candidate trials**
per mode. Seconds are rounded for display; the [result JSON](bulk-atomic-ingest-20261010.json)
preserves individual measurements and provenance.

| Mode | Baseline query-ready | Candidate query-ready | Change | Baseline atomic writes | Candidate atomic writes |
| --- | ---: | ---: | --- | ---: | ---: |
| Core cache, cold | 284.97 s | 281.49 s | 1.22% faster | 132.23 s | 127.01 s |
| Core cache, warm | 232.93 s | 226.83 s | 2.62% faster | 130.85 s | 124.43 s |
| RPC-only | 286.79 s | 298.96 s | 4.24% slower | 132.49 s | 136.97 s |

The two RPC-only query-ready measurements were 285.51 and 312.41 seconds. The
slower result coincided with increasing resource pressure and remains included.
The run used a shared 24 GiB development system with substantial existing swap
usage; the last periodic disk sample was 7.02 GiB free and peak recorded one-minute
load was 15.06. The guard then stopped the test below 7 GiB. Those observations do
not establish how much of the timing difference resource pressure caused.

Atomic-write time improved by about 4–5% in the completed core-cache modes. It
still accounts for roughly two minutes of work. Native staging retains
publication, receipt, and cleanup transactions for every asset; replacing SPARQL
payload parsing alone has not removed that cost. Stage totals overlap and must
not be summed into an independent wall-clock budget.

## Correctness and durability

- Agent and dependency build passed, including type/package-root checks.
- Storage suite: 1,297 passed, 34 skipped; includes 27 focused bulk-ingestion tests.
- Opt-in native Blazegraph contract suite: three passed; a separate native
  partial-upload probe also passed.
- A 12-asset, three-mode live smoke passed, including restart checks for all
  identities, stored roots, and 87,000 data quads per store namespace.
- All six completed full-size trials committed 564 assets, matched inventory and
  stored roots, and passed the bounded query check.
- After reopening the journals, the source and all six completed receivers still
  contained all 564 expected identities, matching metadata roots, and 3,751,526
  physical data quads each. This checks persistence of those facts; it does not
  freshly recompute every assertion's Merkle root after restart.
- The seventh trial was interrupted; the remaining two did not start. They are
  not counted as passes.

Native failure injection exposed a staging hazard in an initial prototype:
Blazegraph could acknowledge a MOVE whose source had disappeared. The measured
implementation instead checks staging counts inside the publication transaction
and requires its unique receipt before success. The disappearing-stage,
partial-upload, and lost-response checks preserve the failure result and coherent
visible assertion/metadata state.

All owned test processes and store processes were stopped and their ports
released. Journals, logs, per-trial evidence, fixture, build hashes, and partial
restart proof were preserved. No test deadline, resource guard, source transfer
setting, or grading requirement was relaxed.

## Required follow-up

Repeat all nine trials from fresh namespaces with enough free disk for retained
journals and swap headroom (approximately 25 GiB free for this setup), ideally
with a matched-base control and stable competing load. Do not combine this
interrupted attempt with three later trials and label it an uninterrupted run.
If the small gain persists, investigate grouped publication/commit amortization
as a separate change with its own cross-asset correctness contract; that behavior
is not implemented here. The earlier empty-store native-load floor is not an
equivalent atomic replacement benchmark.
