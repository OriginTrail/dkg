# #2963 — durable synchronous share recovery

## Status and scope

[PR #3300](https://github.com/OriginTrail/dkg/pull/3300) gives synchronous shares a durable owner before SWM promotion. The original request could commit sealed SWM content, fail during lifecycle/catalog completion, and return an error with no async job responsible for recovery. The exact failing store call in [the original incident](https://github.com/OriginTrail/dkg/issues/2963#issuecomment-6217273362) remains unknown. Injected boundaries characterize partial commits; they do not establish that unknown call.

**Current validation is incomplete.** Historical candidate `92fb35e4d218c8151a36dd61b779b11129bbb9ce` passed matched live recovery and actual process-restart validation, detailed below. Later commits fix additional corrupt-state and lease-takeover cases; they require a fresh live comparison. Baseline6's separate runtime exposed a preload-resolution error, so neither intended fault fired. Its 256 outcomes, including three natural pre-SWM authority-unavailable 503s, are retained through the fixed deadline rather than counted as injected coverage. Baseline7 was superseded during preparation when #3320 merged; it never started measured traffic. Baseline8/candidate12 will use the same corrected runtime-bound preload on the updated canary base. Current CI/review and code-owner approval remain outstanding. No merge is authorized.

The PR targets `testnet-canary`; performance [#3253](https://github.com/OriginTrail/dkg/pull/3253) merged on 2026-10-16 at 18:08:57Z and its scope remains unchanged. The next optimized baseline is clean `069f3dbdf3e30be491843d02f66927309dff5814` (including #3320); baseline6/7 used `31599fc08ab1c3e1999b7a7d6f3b4c931d9cf0d6`. Required acceptance contracts are described below; earlier live successes are not evidence that unmeasured later revisions pass.

## Evidence location

Per the user's direction, the repository retains this report and reproduction harness; generated exports stay in the local `Projects/dkg-archive/issue-2963/` directory. The historical `2026-10-17-ee2fe18ec/` archive contains 244 hashed files/10,252,350 bytes, with checksum-list SHA-256 `892123720bea1cb3a0cc577ad53fcf2c48112b63c0ba14ab595b622b630b1ccd`. Separate round17–22 and round24 archives preserve subsequent checks. `2026-10-17-baseline5-preparation/` retains 33 hashed setup-failure artifacts. `2026-10-17-baseline6-injection-gap/` retains 32 hash-verified files, including all 304 measured request outcomes and the missed-injection/read-only collection gaps. `2026-10-17-baseline7-superseded-preparation/` retains 21 hashed files proving no measured traffic, the exact prepared starting set and reconciled claim release.

Archive paths below are local references, not repository links. Reviewers need a separately supplied archive to inspect full generated evidence. Previously pushed exports remain in Git history; no history was rewritten. Homes, credentials, raw jobs containing claim capabilities and raw daemon logs remain private. Exports are allowlisted and checked against private values before archival.

## Historical matched run (exact runtime below)

All times below are UTC on 2026-10-17. The baseline ran and its failures were preserved before the corresponding recovery changes were built and measured. The original baseline on #3253's then-current head also preceded the initial implementation; its results remain summarized below and its full records are preserved in the local archive.

| Result | Optimized baseline4 | Recovery candidate11 |
| --- | --- | --- |
| Exact runtime commit | `e3d134dd7c5fef1b479362bcc91a9de620b31277` | `92fb35e4d218c8151a36dd61b779b11129bbb9ce` |
| Runtime version / clean build UTC | 10.0.25 / 00:34:16.757 | 10.0.25 / 01:32:57.983 |
| Traffic interval | 00:52:35.717–00:59:39.143 | 01:49:12.246–01:56:34.474 |
| Synchronous request denominator | 256: 254 HTTP 200, two injected 503 | 256: 254 HTTP 200, two injected 503 |
| Naturally successful measured requests | 254/254 | 254/254 |
| Injected operations automatically completed | 0/2 | 2/2 |
| Fault-to-durable-success time | Neither completed by deadline | 61.058 s; 62.121 s |
| First original-author descriptor 200, response completion after fault | Unavailable by deadline | 70.920 s; 71.065 s |
| Publications admitted / finalized | 48/48 | 48/48 |
| Publication p50 / p90 | 175.517 s / 318.306 s | 182.113 s / 319.903 s |
| Full-cohort makespan / throughput | 356.153 s / 0.134774 per s | 356.022 s / 0.134823 per s |
| Exact inventory / catalog / descriptor coverage | 434/436; only the two injected assets absent | 436/436 |
| First complete catalog observation | Never by deadline | 02:01:10.155; 275.681 s after traffic end |
| Fixed catalog deadline | 01:19:39.143 | 02:16:34.474 |
| Full readback timestamp | 01:19:52.221 (+13.078 s) | 02:16:35.469 (+0.995 s) |
| Original seals and whole-graph payloads preserved | 436/436 | 436/436 |
| Unique creation events and exact publication carriers | 48/48 | 48/48 |
| Complete successful signer nonce interval / gaps | 98 transactions / 0 | 98 transactions / 0 |
| Manual repairs / share replays | 0 / 0 | 0 / 0 |

The two one-shot faults interrupt the promoted lifecycle INSERT after its DELETE and after SWM content has committed. `catalog-140` raises a typed definitely-not-started store failure; `catalog-141` raises an untyped failure. Each fault captures eight committed payload triples, the original seal and operation intent, and incomplete lifecycle metadata. Both arms use the same faults and frozen runner. Baseline jobs never exist; its two descriptors remain 404. Candidate error responses identify original durable owners, each of which succeeds on attempt two. All 436 candidate owners succeeded before the deadline. Continuous sampled observations establish timely convergence independently of the slightly later full readbacks.

Candidate preparation separately encountered one natural HTTP 503. Its original owner completed automatically in 60.829 seconds, with no HTTP replay; the exact failing dependency was not captured. The remaining 435 preparation requests returned 201. This one startup failure is retained separately and is not added to either the 254 natural measured requests or the two injected requests. Baseline preparation's smoke plus 435 requests all succeeded.

Baseline summary (`baseline4/summary.json` in the local archive), candidate summary (`candidate11/summary.json` in the local archive), all baseline requests (`baseline4/requests.csv` in the local archive), all candidate requests (`candidate11/requests.csv` in the local archive), candidate independent assertions (`candidate11/independent-proof-assertions.json` in the local archive) and startup evidence (`candidate11/startup-recovery.json` in the local archive) preserve full denominators. Publication p50 increased 3.76% and p90 0.50%; full-cohort throughput was essentially unchanged. This sequential public-testnet pair supports recovery correctness without an observed publication/catalog correctness regression. It does not establish causal performance equivalence or improvement; alternating replication remains [#3310](https://github.com/OriginTrail/dkg/issues/3310).

## Actual daemon process-exit recovery

The separately reported one-request crash trial followed the full main deadline on the same candidate runtime and retained Blazegraph store. The fsynced hook exited the daemon at **02:20:02.367 UTC** after SWM commit and before promoted lifecycle insertion. The request disconnected and was never replayed. The existing supervisor automatically replaced the worker at 02:20:03.641167; the store remained running. The witness proves process disappearance/replacement; it does **not** capture OS exit status. Code 86 is the injected implementation, not a claimed observed OS status.

Original job `8b275066-a219-40ae-b33b-efabb6827ad4` retained its running state, immutable binding and normal 900000 ms lease, expiring at 02:35:01.118. The ordinary worker completed attempt two at **02:35:03.821**, **901.454 seconds after the fault**. The descriptor was first observed available at 02:35:18.180. The first completed observation with job success, descriptor 200, exactly 437 catalog rows and zero incomplete rows was **02:35:48.399**, **946.032 seconds after the fault**. Observation continued through the fixed 02:40:02.367 deadline, ending at 02:40:02.370. All **78 observations** are retained; none failed to read.

Full readback at **02:40:09.744** and independent proof at **02:40:18.492** verified the same original job/binding/seal/version/intent, exact eight-triple crash payload, completed lifecycle and cleared WM. All **437/437** inventory/catalog tuples and complete payloads match. Every original 436-asset seal/intent/lifecycle record and payload graph is unchanged from the main snapshot. All 48 publication effects and all ten signer nonces remain unchanged. Runtime version, commit, build timestamp and peer identity are identical after process replacement. Manual request replays, process restarts and repairs: **zero**.

See deadline outcome (`candidate11/restart-regression/outcome.json` in the local archive), process witness (`candidate11/restart-regression/process-restart-proof.json` in the local archive), original and recovered binding proof (`candidate11/restart-regression/identity-proof.json` in the local archive), whole-cohort content proof (`candidate11/restart-regression/whole-cohort-content-proof.json` in the local archive) and all observations (`candidate11/restart-regression/observations.json` in the local archive). This is a separate one-request scenario, not part of the matched 256-share denominator. A functioning worker/supervisor and retained durable home/store are required; disabling workers suspends automatic recovery as documented.

## Fixed environment and protocol

macOS 26.3 arm64, Node 22.23.3, pnpm 10.28.1; host 10 CPUs/32 GiB, Docker 10 CPUs/~8 GiB. Store image `islandora/blazegraph:6.4.3@sha256:015e308ae0a296cdb87c83c10da976ed970d2bfa971290aa1147593df8cf445d`, limited to 4 CPUs/4 GiB; actual JVM heap 1 GiB verified with `jcmd` (image ignores `JAVA_OPTS=-Xmx2g`). Native daemon heap 4 GiB. Auto-update disabled, API authentication verified 401/200. Public chain Base Sepolia 84532, Hub `0xC056e67Da4F51377Ad1B01f50F655fFdcCD809F6`; six publisher wallets from exclusively claimed `batch-1`, no PCA. Public signer identities and starting balances/nonces are in each archived environment manifest.

Sequential arms use fresh homes, namespaces and registered private graphs; API/store ports 9298/9998. Carry only the author's monotonic KA-number floor. Before any asset, require current finalized catalog authority; before timing, verify exact 180 inventory/catalog identities, 256 sealed drafts and no publication history. Candidate additionally retains 180 succeeded preparation owners as an inherent implementation difference. Each asset has 8 triples. Send 48 publications at concurrency 6 and 256 synchronous shares at concurrency 4, each POST once with 120-second timeout. Publication deadline 20 minutes from traffic start; catalog deadline 20 minutes after traffic end. Keep all failures and incompletes; manual repairs never count as automatic recovery.

Two measured targets receive identical one-shot lifecycle-insert faults; 254 other shares are the natural denominator. Require actual fault latches, original metadata/content preimages and runtime-module attestations before counting injected coverage. Poll descriptors every 15 seconds. Preserve full fixed-deadline readback even after early convergence. Actual process exit/restart is a separate trial with unchanged 15-minute lease and 20-minute deadline. All used signer receipts and pending/latest nonces must reconcile after owned writers stop, before releasing the matching wallet claim.

Historical runner/hook/snapshot SHA-256s respectively: `80c72964a23a633cfa355589d0806d79628f87dc9a965b6027f96a49e697a682`, `1aa663c1368f64da6454db1a2c2c4bab0f9575c2de90e25580ecc96f5e753c8c`, `4b602b763eb633a0f8288b6573c105d3b633578f700f0ad17304a0a0a36ccbb5`. New arms record the corrected hook separately before preparation. No task-owned builds/tests overlap measured windows. The host is shared and public-chain load uncontrolled; resource telemetry records this limitation. These sequential runs do not establish causal performance equivalence; alternating replication remains [#3310](https://github.com/OriginTrail/dkg/issues/3310).

## Recovery contract and acceptance

Admission binds the original operation, author, seal/version/content, policy and recipients under the lifecycle lock. Replay validates them and current authority without resealing. Uncertain admission never starts inline mutation. Uncertain bookkeeping retains the original lease; only certified not-started bookkeeping can retry directly. Publication and nonce allocation are unchanged.

Share preparation now holds the publisher lifecycle lock before real finalization. An existing bound owner skips finalization and retains the original binding-validation/admission path; ordinary unbound promotion is refused before resealing. A preparation already in progress completes before the worker can clean WM.

Fresh claim/state/expiry checks fence publisher and post-publisher mutation sections, including after lifecycle-lock acquisition. A replacement can heartbeat while old domain work finishes, then resumes the same obligation. This process-local serialization supports the single-daemon contract and normal process replacement; it is not a distributed multi-daemon lock or cancellation of an already-dispatched uncertain write. Deterministic corrupt/mismatched replay authority revokes a stale completion certificate and retains inspection evidence. Transient unreadable evidence preserves the certificate. Valid losing preparation returns 409 without invalidating the winner. Legacy no-ops require no unfinished bound ownership; missing intent cannot bypass an existing inventory obligation.

| #2963 requirement | Contract / verification |
| --- | --- |
| Consistent diagnostics | Expose `lastError.diagnosticCode`; retrying rows retain `retryable:true`. |
| Safe clear/cancel | Reject deletion of sweep-eligible or unfinished bound obligations, including inspection holds. |
| Immediate versus sweep | Bound recoverable post-commit failures enter retry immediately and survive the ordinary cap; legacy unbound jobs retain their bounded startup/30-second sweep. |
| Actionable synchronous failures | Additive original job/status handles for owned replay-safe failure; permanent/uncertain errors retain their contracts. |
| Automatic completion | Success requires lifecycle completion and authorized durable inventory handoff; projection converges from persisted inventory. Historical live evidence above; latest revision pending. |
| Guidance | [Lifecycle documentation](../docs/use-dkg/knowledge-asset-lifecycle.md#async-share-recovery) explains ownership, worker availability, leases, inspection and downgrade limits. |

## Regression and review

Round24 verification passed: 124 publisher lifecycle/mutation cases, 196 HTTP/real queue/worker cases (including six reconcile-response cases), 64 actual-daemon/native-reopen cases, 53 Node/10 Python evidence cases, CI routing, lint, unchanged size limits and 2,648-file routing. The lifecycle-lock wait test passes with current fencing and fails on stale marker mutation when the post-lock claim check is removed. Separate-runtime preload tests verify one-shot injection through each runtime's own storage module. Earlier negative runs removing the legacy ownership or tail fence also reproduce failures. Counts overlap across rounds and must not be summed. A clean runtime build follows this test revision before candidate measurement.

Evidence reducers compare exact RDF node kinds, datatype/language/lexical values and multiplicity in authoritative metadata and payload graphs. They validate original and final operation records independently and connect restart bindings to the original captured intent. All seven historical main reductions and three restart proofs pass stronger offline checks without changing original timestamps or erasing baseline incompletes. Missing/incomplete captures fail validation.

Major review fixes cover admission, replay validation, ownership, execution fencing and overlapping real finalization. Structural consolidation is deferred under the user's explicit direction: queue-format capabilities [#3322](https://github.com/OriginTrail/dkg/issues/3322), pure evidence reducers [#3323](https://github.com/OriginTrail/dkg/issues/3323), RDF normalization [#3324](https://github.com/OriginTrail/dkg/issues/3324), execution-authority ownership [#3325](https://github.com/OriginTrail/dkg/issues/3325), and splitting the existing broad regression module [#3326](https://github.com/OriginTrail/dkg/issues/3326). The runtime remains one PR because admission, queue ownership, replay and catalog handoff form one activation contract. Generated evidence is excluded from current diffs.

Round26 local checks passed: 199 HTTP/real worker cases (including three real-finalizer overlap/read-failure cases), 14 agent cases, 124 publisher cases, CI routing, lint, unchanged size budgets and the 2,652-file inventory. Removing the preparation fence reproduces a succeeded original job with leftover WM; the fixed schedules preserve exact payload, original binding and publication readiness. The clean runtime build and daemon checks follow this revision before live candidate measurement.

## Preserved unsuccessful attempts

| Attempt | Retained outcome / limitation |
| --- | --- |
| Original readiness-invalid baseline | All 48 publications/256 shares retained, 434 inventory/393 catalog at early readback; missing fault preimages, excluded from controlled comparison. |
| Baseline 2 `9436b5c927f9fc8e5eb0cd5523da785dfa1cdd75` / candidate `7dfc334200bb2a716e7dc11cf25ec7a033cd9481` | Optimized #3253 head before initial fix; 0/2 versus 2/2 injected recovery, 434 versus 436 catalog. |
| Baseline 3 `2aba84de35754e5663b52018f9781a6e6c8b948d` / candidate 9 `f7fdbdfaedc9bb3b8e1ff2307ec50a856d4010e7` / candidate 10 `a76cb38a5aacf2261d888c69c7e2abd5dbb0878c` | 0/2 versus 2/2 recovery; all 48 publications and 98 accounted transactions per completed arm. Candidate 9/10 actual restart succeeded after unchanged lease. |
| Candidate 2–8 | Preparation-only, one natural startup 503 each recovered automatically, zero measured publications; candidate 7 readiness unresolved. Not benchmark samples. |
| Baseline 5 `31599fc08` | 180 initial shares succeeded but catalog stopped at 150 with 30 legacy rows during authority initialization; no measured traffic or replay. All 436 assets retained; two setup transactions/ten signers reconciled and claim released. |
| Baseline 6 `31599fc08` | Exact starting gate passed; 253/256 shares returned 200, three natural pre-SWM authority-unavailable 503s. These do not replace partial-commit coverage. Neither intended injection fired because preload imported another checkout's module. Fixed readback at 10:55:52.570 UTC retained 433 catalog identities; the three exact eight-triple WM payloads and all 436 seals are unchanged. All 48 publications finalized; 98 transactions accounted, no nonce gaps. All 436 descriptors return 200, which alone does not establish SWM completion. Repeat with corrected runtime resolution. |

The [execution plan](../agent-docs/plans/2026-10-16-2963-durable-share-recovery.md) and [harness guide](../scripts/testnet-share-recovery/README.md) define ownership, verification and failure handling. Current-head CI, current-head review and required code-owner approval must all converge before readiness; no merge or background automation is enabled.
