# PR 3397: live baseline/PR latency comparison

## Executive Summary

**No end-to-end publication latency improvement was observed.** The clean matched pair completed all 48 publications per version. PR median acceptance-to-terminal latency was 176.421 s versus baseline 173.012 s (2.0% higher); P90 was 298.398 s versus 290.891 s (2.6% higher). Full-cohort throughput was 8.346 versus 8.532 publications/minute. The exploratory PR arm was also slower than its baseline. These observations do not establish a causal regression: public-RPC/retry variation remains, and only one pair has the full fixture-isolation guarantee. They provide no evidence for an end-to-end latency gain from this PR in this workload.

The original long post-finality/store-lane bottleneck was not reproduced: the clean pair's lifecycle store-operation medians were about 20 ms, and observed store queue maxima were below 350 ms. The controlled cache-query reduction remains valid mechanism evidence; issue #3252's sustained-load performance acceptance remains open.

Two earlier exploratory arms are retained separately because fresh node homes reused some unpublished fixture IDs. Their measured on-chain publication IDs were distinct, but those fixtures do not provide the same isolation guarantee. Across all four arms, 192/192 publications finalized and passed independent receipt, contract-root and exact RDF checks. See the readback observation limitation below.

## Method

- Baseline: `abb89dff7f04a6c396847c8fbb01da429fb1d5b6`, the PR merge base; PR: `d2870b18b98676806a77bd6953a033fe9abe039b`. Builds report `-dirty` only because this task added an untracked Markdown plan; tracked runtime source was unchanged.
- Order: A1 baseline, B1 PR (exploratory), B2 PR, A2 baseline (clean pair). One daemon and one exclusively claimed funded batch at a time; six publisher wallets, same operational author.
- macOS ARM64 / Node 22.23.3 / pnpm 10.28.1; native host 10 CPUs and 32 GiB RAM. One pinned Blazegraph container, 4 CPU / 4 GiB limits, 3 GiB JVM heap; fresh namespace/home/private Context Graph for each arm. Actual listeners were API `127.0.0.1:19326` and Blazegraph `127.0.0.1:19454`.
- Base Sepolia 84532; Hub `0xC056e67Da4F51377Ad1B01f50F655fFdcCD809F6`; prepared batch-1. Operational author `0x247B02C301B34E52e9021728F34C3457F81f2dFc`. No wallet funding transfers or PCA provisioning.
- 180 initially shared assets, including the 48 publication targets, plus 256 sealed drafts as capacity for a continuous synchronous `/swm/share` worker. All 436 input datasets match across arms, and the 48 publication roots match by asset index. Each asset has 20 deterministic RDF triples: for asset index `i` and triple index `n`, subject `urn:issue3252:bench:i:n`, predicate `urn:issue3252:value`, and literal `payload i-n` (indices substituted as decimal integers). Enqueue 48 publications with six wallets; run one share worker until the publication cohort settles. Query one WM asset every 2.5 seconds; sample jobs, backpressure and status every 5 seconds.
- Restart after preparation; require current/accepted/complete private-CG authority, at least three connected peers, and publisher availability; wait 30 seconds. Initial catalog expected/applied counts were checked. Defaults include finalized snapshot cleanup disabled and the existing normal store lane limit of two.
- Primary clock: existing unthresholded `DKG_ASYNC_PUBLISH_COMPLETION_TRACE` native `hrtimeNs`, from `accepted_primary_committed` to `terminal_operation_settled`. All 48 accepted jobs are retained, including retries. Percentiles use linear interpolation. Claim timing uses the first native claimed outcome, not the last claim timestamp after a retry.
- Existing post-finality messages at both info/debug levels and delegating store-scheduler wrappers are captured identically. Timing wrappers buffer data and flush once/second. Required work and returned results are unchanged. Readback/receipt validation occur after publication timing.

## Publication results

| Arm | Role | Completed | Median s | P90 s | P95 s | Max s | Full-cohort pub/min | Retries / retried jobs |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| A1 | Baseline / exploratory | 48/48 | 176.348 | 303.062 | 313.837 | 319.653 | 8.503 | 15 / 13 |
| B1 | PR / exploratory | 48/48 | 198.950 | 335.609 | 354.423 | 365.597 | 7.447 | 27 / 18 |
| B2 | PR / clean | 48/48 | 176.421 | 298.398 | 310.324 | 324.997 | 8.346 | 14 / 13 |
| A2 | Baseline / clean | 48/48 | 173.012 | 290.891 | 306.713 | 317.606 | 8.532 | 10 / 9 |

## Stage coverage and store work

| Arm | First claim median / P90 s (n) | Finality → terminal median / P90 s (n) | Terminal primary → operation median / P90 ms (n) |
|---|---:|---:|---:|
| A1 | 120.041 / 259.038 (48) | 0.198 / 0.407 (45) | 75.949 / 153.434 (48) |
| B1 | 145.841 / 282.911 (48) | 0.200 / 0.329 (46) | 68.168 / 160.945 (48) |
| B2 | 126.171 / 249.574 (48) | 0.204 / 0.417 (45) | 81.744 / 135.897 (48) |
| A2 | 124.938 / 249.808 (48) | 0.217 / 0.357 (44) | 87.359 / 157.401 (48) |

Finality coverage is shown explicitly. Missing marks are not zero. The existing tail-step fields are nested in the total and often absent when their step ended before the anchor; they must not be summed with the total or treated as a complete all-job lifecycle sample.

| Arm | Lifecycle store operation execution median / P90 ms (n) | All-store queue median / P90 / max ms | Completed catalog shares inside publication window |
|---|---:|---:|---:|
| A1 | 18.529 / 24.039 (48) | 0.045 / 18.024 / 291.538 | 59 |
| B1 | 18.580 / 22.223 (48) | 0.036 / 17.073 / 256.193 | 65 |
| B2 | 19.695 / 22.685 (48) | 0.047 / 18.879 / 271.236 | 59 |
| A2 | 20.174 / 22.754 (48) | 0.058 / 20.619 / 343.707 | 57 |

| Arm | Recorded broadcast → receipt median / P90 s (n) | Recorded receipt → finalized record median / P90 s (n) |
|---|---:|---:|
| A1 | 6.327 / 7.568 (48) | 1.887 / 2.576 (48) |
| B1 | 6.282 / 8.271 (48) | 2.250 / 3.155 (48) |
| B2 | 6.390 / 7.637 (48) | 2.002 / 2.891 (48) |
| A2 | 6.900 / 8.124 (48) | 2.065 / 2.909 (48) |

## Correctness and limits

- Each finalized transaction has receipt status 1, a matching canonical block and signer, and an independent `DKGKnowledgeAssets.getLatestMerkleRoot` result equal to the submitted/sealed root. All 192 readbacks match canonical input RDF exactly. Each on-chain Context Graph member list equals its 48 expected KA IDs and its name hash matches the requested graph. The CSV retains per-job transaction hashes, public publisher addresses, UALs and timing samples; all six publishers participated in every arm.
- A1 readback was interrupted after nine completed checks and after asset-009 had already reopened WM via pull. That asset retains VM-confirmed status, matching VM/root/receipt/RDF evidence, but its pre-pull published-state observation was not saved. It is flagged in the CSV; 191/192 have the strict pre-pull lifecycle observation. This happened after timing and is not relabelled as a persistence test.
- A1 initially continued catalog work after all publication terminals: 78 recorded successful shares and one drained request, with the next asset still unshared. Subsequent arms stop naturally after the publication cohort settles. Extra A1 tail sharing is outside every publication latency and store timing window.
- A1/B1 reused 388 unpublished fixture UALs across fresh homes. No measured already-minted publication ID was reused. B2/A2 explicitly preserve native allocator watermarks and assert no fixture UAL overlap with any earlier arm. Only B2/A2 are the clean comparison.
- RPC-related authority retries are included, not discarded. The `Catalog floor authority unavailable (name-binding)` classification is emitted only for recognized transient no-transaction RPC read failures in the unchanged publisher path. Retry/provider variation can affect total latency independently of this PR.
- This does not reproduce the original Gnosis / PCA / 4-vCPU-8-GiB / 11-peer host or its full 450-asset nine-scenario campaign, 764-row starting catalog/cap crossing, or accumulated job history. This test uses Base Sepolia, no PCA, four connected peers, 180 starting rows, and smaller uniform payloads. The original long normal-lane and post-finality bottlenecks must not be assumed reproduced.
- The earlier controlled 192→0 unrelated query experiment remains mechanism evidence. It does not establish an end-to-end latency gain. No conclusion here closes issue #3252 or changes #2962 correctness requirements.

## Post-benchmark integration

After measurement, `testnet-canary` advanced to `c1230bc0a46c4ce46ed728badd4f121296b47933`. The PR merges that base, retains both sets of agent imports/tests, and extracts unchanged mutation-writer composition into `internal/agent-mutation-writers.ts` to respect the lowered source-size budget. Runtime build/type checks, lint, size checks, 35 focused agent tests (including real production-agent construction), and 17 CLI runtime/recovery tests passed. These integration checks do not extend the live timing claim beyond the exact tested candidate `d2870b18`.

## Evidence and cleanup

- Per-job portable samples: [2026-10-21-3252-live-latency-comparison.csv](2026-10-21-3252-live-latency-comparison.csv).
- Local raw evidence, native logs, observation streams, harness, exact inputs and receipts: `.tmp/3252-bench/evidence/` and `.tmp/3252-bench/*.mjs`, `*.py`, `*.sh` in the task worktree. No credential/auth files are committed.
- Cleanup completed at 2026-10-21 13:33 UTC: all 372 transactions reconciled, every used signer has equal latest/pending nonces, all owned writers stopped, API/store listeners removed, batch-1 released with its matching token, and 15 copied credential files removed. The source pool is unchanged. Harness, logs, receipts and native databases are retained locally for review.
- Final author allocator next-number floor is **12898**. Preserve that watermark before any later fresh-home run with this author; unpublished allocations are not visible in the chain maximum. The reusable allocator lesson was added to the installed and canonical dkg-testnet validation guidance.

Sources: [issue #3252](https://github.com/OriginTrail/dkg/issues/3252), [10.0.25 evidence](https://github.com/OriginTrail/dkg/issues/3252#issuecomment-6312929898), [prior #3253 comparison](https://github.com/OriginTrail/dkg/pull/3253), [PR #3397](https://github.com/OriginTrail/dkg/pull/3397).
