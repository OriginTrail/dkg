# #2963 — durable synchronous share recovery

## Executive Summary

The final matched live comparison validates automatic synchronous-share recovery on **`c3a3cf42f1834d312edb317f544766bb496cbbe7`**. Both injected partial commits recovered through their original jobs without HTTP replay, resealing or republishing. The candidate reached an exact 436/436 inventory/catalog and passed a separate real daemon-exit recovery trial with the normal 15-minute lease. The optimized pre-fix baseline preserved the same two interruptions without recovery: 434/436 entries. All 48 publications completed in each arm; no content, identity, nonce or duplicate-effect regression was observed in this workload.

Live validation passed; merge readiness also depends on current checks and required review. [PR #3300](https://github.com/OriginTrail/dkg/pull/3300) still requires the repository's current-head checks and review requirements. All received substantive feedback was addressed before this final pair; required code-owner approval and a reliable overall remote-review completion signal were unconfirmed at the live-run preflight. The final PR status is reported separately. No merge is authorized or performed.

## Cause and recovery contract

The [original synchronous failure](https://github.com/OriginTrail/dkg/issues/2963#issuecomment-6217273362) committed SWM content before lifecycle/catalog completion and had **no async share job owning its retry**. A later explicit retry preserved identity, proving manual recovery only. The exact original failing store call remains unknown; these injected cases characterize the documented partial-commit boundary without claiming to identify that call.

The fix durably admits and leases an immutable seal/operation binding before synchronous SWM mutation. The ordinary worker resumes that same obligation after transient failures or process death. Completion requires lifecycle pointers and authorized durable inventory handoff; catalog projection then converges from persisted inventory. Current authorization, catalog authority, claim and execution-fencing checks remain in force. Permanent integrity/policy failures retain inspection evidence. Recovery does not reset nonces or submit a second publication. Unknown writes are not blindly retried.

| #2963 acceptance | Implemented and verified behavior |
| --- | --- |
| Observable diagnostics | `lastError.diagnosticCode` identifies recoverable failures; retrying rows retain `retryable:true`. |
| Safe clear/cancel | Sweep-eligible async jobs and unfinished bound synchronous obligations cannot be cleared; inspection evidence survives. |
| Recovery ownership and timing | Legacy unbound async jobs retain the documented bounded 30-second sweep. Bound post-commit failures retry immediately with backoff and retain ownership beyond the ordinary attempt cap. Real queue/worker tests cover both. |
| Actionable synchronous failure | Existing success contracts remain; owned recoverable 503 responses add the original recovery job and status URL. Both live injections return these handles. |
| Lifecycle guidance | [Lifecycle documentation](../docs/use-dkg/knowledge-asset-lifecycle.md#async-share-recovery) explains worker availability, leases, inspection, compatibility and downgrade limits. |

## Final matched comparison

All times are UTC on 2026-10-17. Baseline9 ran first and was verified, stopped, reconciled, released and archived before candidate19 acquired the same wallet batch. The current committed 61-file harness was hash-identical in both arms. Candidate production code is unchanged from `9bbb01ad252d2e1ca7e2235e3ba3df2d70ab92a2`; `c3a3cf42f` adds the reviewed signed-transaction evidence correction. The later report and test-list ordering change do not alter production code or the harness.

| Result | Optimized baseline9 | Recovery candidate19 |
| --- | --- | --- |
| Runtime commit | `069f3dbdf3e30be491843d02f66927309dff5814` | `c3a3cf42f1834d312edb317f544766bb496cbbe7` |
| Clean build UTC | 11:18:04.554Z | 20:12:45.960Z |
| Traffic start → end | 20:24:18.146Z → 20:31:15.064Z | 21:07:34.321Z → 21:15:16.248Z |
| Fixed catalog deadline | 20:51:15.064Z | 21:35:16.248Z |
| Full snapshot observed | 20:51:34.467Z | 21:35:17.698Z |
| Publications admitted / finalized by deadline | 48/48 | 48/48 |
| Synchronous responses /256 | 254 HTTP 200 + 2 injected 503 | 254 HTTP 200 + 2 injected 503 |
| Natural measured failures /254 | 0 | 0 |
| Injected operations automatically recovered | 0/2 | 2/2; original jobs, attempt 2 |
| Fault → durable success | Neither by deadline | 57.222s; 66.010s |
| Exact inventory / catalog identities | 434/436 | 436/436 |
| Descriptors /436 | 434 HTTP 200; 2 HTTP 404 | 436 HTTP 200 |
| First full catalog observation | Not reached | 21:20:06.545Z; 290.297s after traffic |
| Original seals and exact payloads preserved | 436/436 | 436/436 |
| Unique publication effects / accounted transactions | 48/98 | 48/98 |
| Publication latency p50 /p90 | 182.425s /307.285s | 186.096s /324.082s |
| Publication makespan /throughput | 358.091s /8.043 per minute | 354.978s /8.113 per minute |
| All-response share latency p50 /p90 | 6.229s /9.327s | 6.954s /10.193s |
| Manual request replay / repair | 0/0 | 0/0 |

All 304 measured requests per arm remain in the denominators. Preparation is separate: one readiness smoke plus 435 requests returned HTTP 201 in each arm, with no mutation retries. Candidate startup also retained two early connection-refused **readiness reads**, before its API listener opened and before any setup mutation; subsequent authentication and setup succeeded.

The two identical one-shot faults interrupt promoted-lifecycle insertion after SWM content committed: `catalog-140` raises a typed definitely-not-started store error; `catalog-141` raises an untyped error. Both latches and original content/metadata preimages were captured. Baseline has no synchronous owners; both assets retain incomplete lifecycle, missing catalog/inventory entries and HTTP 404 descriptors. Candidate's original jobs finish automatically on attempt 2. Exact all-scope inventory selection, signed head/object commitments, original operation, projection/bundle commitments and full RDF-term comparisons pass. Every signed publication transaction binds the original asset/operation and registered graph to the canonical receipt and historical Hub emitter. All 98 transactions—48 publications, 49 approvals and 1 graph registration—account for every used signer nonce, with no gaps or duplicates.

Candidate catalog authority was unresolved in six sampled observations from 21:15:16.286 through 21:16:32.077, then accepted/current at 21:16:47.566 without intervention. This transient is retained; its exact dependency cause was not established. Complete/current 436-row status was observed before the deadline and retained through it. Full post-deadline snapshots are timestamped above; job finish times and continuous observations establish timely recovery/convergence rather than retroactively treating late readback as an earlier observation.

Percentiles use identical linear interpolation; publication latency is admission→finalization and makespan starts at protocol traffic start. Candidate publication throughput changed **+0.88%**, while all-response share p50 changed **+11.65%**. These sequential public-chain/shared-host measurements do not establish causal performance equivalence. They demonstrate the recorded recovery and correctness outcomes; alternating replication remains [#3310](https://github.com/OriginTrail/dkg/issues/3310).

## Separate process-exit recovery

After the complete main window and proof checks, one synchronous create+share request exited the daemon at **21:38:52.292Z**, after SWM commit and before promoted lifecycle insertion. Its disconnected response was preserved and never replayed. The existing supervisor automatically replaced the process at **21:38:53.523088Z**, retaining the same home/store. Process disappearance and replacement were witnessed; OS exit status was not captured. Exit 86 is the injected implementation, not a claimed observed exit status.

Original job `a207e26a-6ab5-49f8-9136-e8e603510f8e` retained its immutable binding and unmodified 900000 ms lease. The ordinary worker completed attempt 2 at **21:53:53.767Z**, **901.475s after the fault**. Complete job/descriptor/catalog convergence was first observed at **21:54:28.322Z**, **936.030s after the fault**. Observation continued through **21:58:52.292Z**, retaining all 80 observations and 1 read error.

The final 437/437 inventory/catalog identities, payloads and commitments match. The original job, binding, operation, seal, version and content are unchanged; lifecycle is complete and WM is cleared. All original 436-asset metadata/payload graphs, 48 publication effects and ten signer nonces remain unchanged. Runtime commit/build/peer identity is unchanged after replacement. Manual request replay, process restart, lease edits and repairs: 0. This separate one-request scenario is not added to the matched 256-share denominator.

## Environment and reproducible protocol

Native macOS 26.3 arm64; Node 22.23.3; pnpm 10.28.1. Host 10 CPUs/32 GiB; Docker 10 CPUs/~8 GiB. Pinned Blazegraph image `islandora/blazegraph:6.4.3@sha256:015e308ae0a296cdb87c83c10da976ed970d2bfa971290aa1147593df8cf445d`, limited to 4 CPUs/4 GiB; actual JVM maximum 1 GiB verified with `jcmd` (the image ignores `JAVA_OPTS=-Xmx2g`). Native daemon heap 4 GiB. An unrelated existing Docker service remained running; shared-host contention and public-chain load were uncontrolled. No task-owned builds or tests overlapped measured windows.

Both arms use authenticated API 9298 (401 without token, 200 with token), store 9998, initial direct P2P TCP 64756 (baseline) /51518 (candidate), with candidate TCP 54410 after restart, disabled auto-update, fresh homes/namespaces and registered private graphs. Only the author's monotonic KA-number floor is carried forward. Batch 1 is exclusively claimed through the DKG testnet skill; its same six publisher addresses/order are retained, with no PCA or profile provisioning. Chain 84532; Hub `0xC056e67Da4F51377Ad1B01f50F655fFdcCD809F6`; token `0x2A58BdD13176D85906D804cdbFFA0D9119282DC8`. Public addresses, funding/nonce checks, actual configuration, startup module attestations and resource samples are in the archived environment evidence.

Before asset preparation, require accepted/current finalized catalog authority. Before timing, require exact 180 shared catalog/inventory entries, 256 sealed drafts and zero publication history. Candidate additionally has 180 succeeded preparation owners—an implementation effect, not copied history. Each asset has 8 public triples. Send 48 publications at concurrency 6 and 256 synchronous shares at concurrency 4, each POST once with 120-second timeout. Publication deadline: 20 minutes from traffic start. Catalog deadline: 20 minutes from traffic end, retained after early convergence. The separate crash trial uses the unchanged 15-minute lease and 20-minute observation deadline. See the [harness guide](../scripts/testnet-share-recovery/README.md).

## Regression, review and limits

The final production changes passed 89 worker/admission cases, 39 adjacent publisher cases, 62 daemon cases, 5 native-process regressions and 2 native SQLite reopen cases. Evidence corrections passed 92 Node and 10 Python cases, 31 routing/inventory-surface tests, the 2663-file inventory audit, lint and unchanged file-size limits. Counts overlap and must not be summed. Negative controls reproduce stale ownership, pre-commit signer admission, scope/commitment substitution and wrong-graph publication acceptance when their specific guards are removed. The five PR Mermaid diagrams rendered successfully and their source is unchanged. Current-runtime live testing above adds real Blazegraph, worker/queue and process-restart coverage.

Preflight CI on `c3a3cf42f` completed 69 successful checks with 4 skips. The unchanged libp2p abort test's earlier `reset EINVAL` failure and subsequent successful Linux job (2387 core tests) are preserved in [#3330](https://github.com/OriginTrail/dkg/issues/3330); no networking assertion was weakened. Structural work remains explicitly deferred: queue formats [#3322](https://github.com/OriginTrail/dkg/issues/3322), pure reducers [#3323](https://github.com/OriginTrail/dkg/issues/3323), RDF normalization [#3324](https://github.com/OriginTrail/dkg/issues/3324), queue-owned fencing [#3325](https://github.com/OriginTrail/dkg/issues/3325), and test decomposition [#3326](https://github.com/OriginTrail/dkg/issues/3326).

While the final run was in progress, `testnet-canary` advanced from the frozen baseline to `2361a863df64be70b012cb611d3fed1e81d3789b` through #3327, #3328 and #3333. The only textual merge conflict was two additions at the same test-list insertion point. Moving this PR's two existing entries beside the promotion tests preserves the exact test multiset and makes the merge clean; it changes no production or harness code. The synthetic merged tree retains all upstream and recovery tests. After this adjustment, both affected suites pass all 24 cases, 25 routing/surface cases pass, and the 2663-file inventory, lint and size checks pass. Current merged-ref CI checks the updated integration; the live pair above remains evidence for its exact frozen revisions.

This public-payload, single-author/single-daemon campaign does not establish private-payload transfer/download behavior, distributed multi-daemon fencing or universal absence of regressions. Recovery requires the worker and durable home/store to remain available. Integrity failures continue to fail closed. The exact original incident store call remains an evidence gap.

## Evidence, historical failures and cleanup

Per user direction, Git retains this concise report and reproduction tooling. Full generated evidence stays locally under `Projects/dkg-archive/issue-2963/`; reviewers need a separately supplied archive to inspect it. Each archive has a checksum list and manifest. Public proof inputs include complete inventory scopes, catalog objects, RDF snapshots and confirmed signed transactions. Homes, credentials, queue claim capabilities and raw daemon logs are excluded from shareable exports and retained privately. All exports are scanned against campaign secrets, including individual API tokens.

- `2026-10-17-baseline9-final-matched-control/`: current optimized baseline, all failures and incomplete operations preserved.
- `2026-10-17-candidate19-final-matched-recovery/`: current candidate main results and public proof inputs.
- `2026-10-17-candidate19-restart/`: separate restart results, every observation and exact 437-asset proofs.
- `2026-10-17-baseline9-candidate19-comparison/`: metrics, method, source hashes and prior report for historical context.

Earlier arms are not relabeled as current validation. Baseline8/candidate17 lacked complete historical scope capture and signed transaction inputs; supplemental selected-row checks cannot repair those historical coverage gaps. Their original exports remain intact. Baseline6 missed its intended injections and had three natural pre-SWM authority failures; baseline5 had a preparation/catalog-readiness failure. Candidate16's natural pre-SWM operation-claim conflict remains unexplained in [#3329](https://github.com/OriginTrail/dkg/issues/3329); a successful later run does not establish its cause or resolution. Candidate18 was stopped during preparation on user instruction, with no measured workload. Earlier preparation failures, partial commits, superseded runs and manual interruptions remain in their archives and prior report history, excluded from the final matched denominators.

Baseline owned writers/store stopped at 20:54:40.580932Z; candidate cleanup at 21:59:41.683565Z. Each matching claim was released only after owned processes/listeners stopped and all ten signer nonces freshly reconciled. No manual repairs were performed. [#3253](https://github.com/OriginTrail/dkg/pull/3253) remains unchanged and merged; #3300 targets `testnet-canary`. No merge or background automation is enabled.

Post-validation coverage (2026-10-18 local): a focused mixed public/private suite uses the real PrivateContentStore, closes/reopens the persisted RDF store, reconstructs agent/publisher/queue and lets the real worker complete the original synchronous obligation. The original combined seal, version, operation and exact public/private payloads are unchanged, with WM cleanup. Same-count private substitution and missing-private controls remain terminal failures without completion certificates or cleared obligations. All3 cases and80 adjacent synchronous/inventory cases pass; the2664-file test inventory and lint pass. This is local regression coverage, not an extension of the public-payload live campaign. Production and the live harness are unchanged.
