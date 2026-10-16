# Prepared-content cache: local 564-KA comparison

All nine trials passed full identity/root coverage and bounded query readiness.
All ten source/receiver journal scopes passed restart checks. An independent
Node.js process then reopened and checksum-validated all 564 prepared assertions,
binding their identities and roots to the saved inventory. Owned services were
stopped and journals, corpus, logs and measurement fixtures were preserved.

## Result

Three repeats per mode, with a fresh receiving namespace for every trial:

| Mode | Median query-ready time | Range | Historical median |
| --- | ---: | ---: | ---: |
| Empty content cache + core chain evidence | 284.39 s | 282.90–285.52 s | 284.97 s |
| Restarted responder + prepared content | 226.74 s | 222.10–234.92 s | 232.93 s |
| Empty content cache + receiver RPC evidence | 285.12 s | 285.09–287.16 s | 286.79 s |

The restarted responder retained warm performance: **226.74 seconds versus
284.39 seconds with an empty cache**, a 57.65-second / 20.3% reduction in this
local comparison. Each restarted-source trial served all 564 KAs with **zero
whole-payload re-exports, zero payload-query time and zero encoding time**.

The historical warm result was 232.93 seconds with the responder kept alive.
That 2.7% difference is not evidence of a new speedup over an already warm memory
cache: the historical value lies within this run's warm range. The implemented
benefit is preserving prepared content across restart and memory eviction.
Cold-cache times were essentially unchanged in these runs.

The timings above remain tied to implementation `f1d680cc5`. Subsequent review
changes replace per-write LRU sorting with ordered-map bookkeeping and add
source-fence/symlink regression tests; the nine-trial timing comparison has not
been repeated for that follow-up. It must not be presented as a new measurement
of the review revision.

## Where time went

| Measured stage | Empty content cache median | Restarted prepared-cache median |
| --- | ---: | ---: |
| Source export (including metadata and preparation) | 82.75 s | 11.66 s |
| Source encoding | 11.66 s | 0.00 s |
| Receiver verification | 60.41 s | 40.60 s |
| Receiver atomic writes | 133.73 s | 127.93 s |

Stage totals overlap and must not be added into a wall-clock total. Source ACK
waits include receiver work. The cache adds no receiver verification shortcut;
shared-process scheduling can also affect these stage measurements. Local
commits remain the largest measured stage and the next optimization opportunity.

Every complete transfer carried 56,140,435 encoded bytes. Each persistent cache
held 564 files totaling 56,518,101 bytes, including manifests. The reconstructed
corpus contains 564 KAs and 3,751,526 data quads (580,640,763 raw N-Quads bytes).
This is not a byte-identical replay of a historical mainnet payload.

## Method and limits

- Implementation: `f1d680cc546a99fa944c082f9124202a1c955a9e`, based on
  `b8e0bfa197da0eece6b428a457865f4aa14b1df2` (#3140). Package version 10.0.23.
  The bulk atomic ingestion branch (#3146) is not included.
- Historical baseline: `ac9989454d9c3259195516ca657948f0f7bdc4bb`.
  It predates later core-cache correctness hardening; this is not a randomized
  A/B on identical base revisions.
- Same corpus, pinned dependencies, local Hardhat contracts, two persistent
  native Blazegraph JVMs, ten-asset requests, two-asset stream window, single
  supplier, existing per-KA receiver commits and original deadlines.
- Source and receiver are separate DKGAgent instances in one Node.js test
  process, with independent verification workers. The warm variant restarts
  the source agent and reconstructs its cache from disk. The additional
  independent-process cache proof checks filesystem persistence separately.
- Each round uses a new empty prepared directory for the cold and RPC-only
  variants. The restarted warm variant reuses only the preceding cold trial's
  prepared directory. As in the historical warm mode, chain snapshot evidence
  is warmed before timing. The cold/warm difference is not a cache-only
  randomized control.
- Timing begins at the sync call after agents start/connect. Source corpus
  preparation, startup, semantic indexing and model warmup are excluded.
  Cold refers to application cache, not a flushed OS/database page cache.
- The RPC-only mode uses the coherent snapshot API, not historical per-KA RPC
  authentication. No legacy-path speedup is claimed.
- This shared development host had transient load spikes and roughly 20 GiB
  of swap during the final round. All repeats are retained. Minimum recorded
  free disk was 15.27 GiB; the 7 GiB guard did not trigger. No builds or extra
  test suites ran during the timed measurement.
- These are local measurements, not a production/WAN five-minute guarantee.
  Large graph chunks, parallel suppliers and grouped commits remain separate
  changes.

## Validation and reproducibility

Runtime package build and agent/CLI type/package-boundary checks passed. All
144 focused agent/cache/stream tests and 151 CLI/configuration tests passed,
as did repository lint and the file-size guard. Runtime source/compiled hashes
and the external fixture hash remained unchanged through the run. The external
measurement fixture was archived and removed from the normal test checkout.

Run identifier: `20261011-prepared-content-cache-v1`.

- Corpus manifest SHA-256: `d62cc71781ab24a48be25d346f6567e8b479600cabbaf96fbad3b170b06c64b8`.
- Measurement fixture SHA-256: `3f04b3e934fdb87546ccda460817ea12239dc075f6f831b96eaf9f830249129b`.
- Controller SHA-256: `0121a695a19a66567288e6a771f213af4a5a2c7103e5740bf0465e024f652b3e`.
