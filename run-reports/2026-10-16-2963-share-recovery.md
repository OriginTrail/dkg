# #2963 — durable synchronous share recovery

## Status and scope

[PR #3300](https://github.com/OriginTrail/dkg/pull/3300) gives synchronous shares a durable owner before SWM promotion. The original request could commit sealed SWM content, fail during lifecycle/catalog completion, and return an error with no async job responsible for recovery. The exact failing store call in [the original incident](https://github.com/OriginTrail/dkg/issues/2963#issuecomment-6217273362) remains unknown. Injected boundaries characterize partial commits; they do not establish that unknown call.

**Current validation is incomplete.** The branch conflict is resolved with optimized `testnet-canary` base `069f3dbdf3e30be491843d02f66927309dff5814`. Baseline8 completed before the latest recovery changes. Candidate15 completed its entire measured window, but review identified missing restart discovery for unregistered authors, inventory signing admission and ambiguous seal-evidence checks. Those fixes passed local regressions, but candidate16 stopped during preparation after a natural operation-claim failure. CI exposed two startup scheduling regressions now being corrected. A fresh candidate and actual restart remain required. Candidate15 is explicitly superseded, not final-revision proof. Required code-owner approval and remote review completion remain unconfirmed. No merge is authorized.

The PR targets `testnet-canary`; performance [#3253](https://github.com/OriginTrail/dkg/pull/3253) merged on 2026-10-16 at 18:08:57Z and its scope remains unchanged. The current optimized baseline is clean `069f3dbdf3e30be491843d02f66927309dff5814` (including #3320); baseline6/7 used `31599fc08ab1c3e1999b7a7d6f3b4c931d9cf0d6`. Required acceptance contracts are described below; earlier live successes are not evidence that unmeasured later revisions pass.

## Evidence location

Per the user's direction, the repository retains this report and reproduction harness; generated exports stay in the local `Projects/dkg-archive/issue-2963/` directory. The historical `2026-10-17-ee2fe18ec/` archive contains 244 hashed files/10,252,350 bytes, with checksum-list SHA-256 `892123720bea1cb3a0cc577ad53fcf2c48112b63c0ba14ab595b622b630b1ccd`. Separate round17–22 and round24 archives preserve subsequent checks. `2026-10-17-baseline5-preparation/` retains 33 hashed setup-failure artifacts. `2026-10-17-baseline6-injection-gap/` retains 32 hash-verified files, including all 304 measured request outcomes and the missed-injection/read-only collection gaps. `2026-10-17-baseline7-superseded-preparation/` retains 21 hashed files proving no measured traffic, the exact prepared starting set and reconciled claim release.

Archive paths below are local references, not repository links. Reviewers need a separately supplied archive to inspect full generated evidence. Previously pushed exports remain in Git history; no history was rewritten. Homes, credentials, raw jobs containing claim capabilities and raw daemon logs remain private. Exports are allowlisted and checked against private values before archival.

## Current optimized comparison (superseded candidate)

All times are UTC on 2026-10-17. Both runs use the fixed protocol below. Baseline8's two incomplete operations are preserved without repair.

| Outcome | Baseline8 | Candidate15 (superseded) |
| --- | --- | --- |
| Runtime | `069f3dbdf3e30be491843d02f66927309dff5814` | `0b2010cbdd8b66ca5c8906fad2b7aad5f6f95816` |
| Traffic start/end | 11:30:48.349–11:37:40.080 | 13:25:45.010–13:33:35.623 |
| Fixed catalog deadline | 11:57:40.080 | 13:53:35.623 |
| Publications admitted/finalized | 48/48 | 48/48 |
| Synchronous responses | 254 HTTP200 + 2 injected503 / 256 | 254 HTTP200 + 2 injected503 / 256 |
| Natural request failures / manual repairs | 0 / 0 | 0 / 0 |
| Injected operations automatically recovered | 0/2 | 2/2 before deadline |
| Exact catalog/inventory/descriptors | 434/436 | 436/436 |
| First full catalog observation | Not reached | 13:38:26.401 |
| Original seals/payloads preserved | 436/436 | 436/436 |
| Unique publication effects / accounted transactions | 48 / 98 | 48 / 98 |
| Fresh nonce reconciliation and matching claim release | Passed | Passed |
| Separate restart trial | Not applicable | Skipped: superseded revision |

Candidate15's fixed readback was captured at13:53:36.606 and main proofs completed at13:58:01.627. Strict seal-cardinality verification was subsequently applied to both arms' unchanged raw starting/final snapshots; all436 seals in each arm remain valid and unchanged. Original proof files and their hashes are preserved separately. A passing main run on this older runtime does not validate the newly identified restart/signing cases.

Local archives: `2026-10-17-baseline8-validated/` (38 files), supplemental `2026-10-17-baseline8-strict-seal-revalidation/` (8 files), and `2026-10-17-candidate15-superseded-measured/` (41 files). Preparation-only candidates12/13/14 each preserve20 artifacts and released claims; none started measured traffic. Baseline6 retained all256 responses (253HTTP200 and3 natural authority-unavailable503s) but had zero fired injections because of a wrong-checkout preload, so it is excluded from injected comparison. Baseline7 was preparation-only after a base change. These failures and exclusions remain in the archives described above.

## Natural preparation failure (candidate16)

Runtime `faeab2b29feb6484f7635dd0ca4881897583bbb6`, clean build14:09:51.361Z, used a fresh home/namespace with the same six-wallet and Blazegraph configuration. After a successful readiness smoke, preparation issued179 requests:178 HTTP201 and one HTTP207. No measured publications or injected faults ran. At14:17:27.251, `initial-128` began the request that failed after3.695s with `KA_SHARE_OPERATION_ID_CONFLICT`. Its original job `c1773695-d409-4306-bbad-055b57f671d5` failed on attempt1 before SWM insertion; all8 WM triples and the original seal remained intact. No replay or repair was attempted.

The publisher rejected the operation-claim readback. The original SELECT results were not captured, so the evidence cannot distinguish an actual competing claim from missing or ambiguous readback. A separate isolated1000-operation insert/readback stress test found0 mismatches; that does not establish the original cause. The failed job and raw state remain preserved, rather than counted as automatic recovery. The owned daemon/store were stopped at14:21:02.453; all ten signers reconciled and the matching wallet claim was released. Sanitized local archive `2026-10-17-candidate16-natural-preparation-failure/` retains37 hashed artifacts, including every preparation response and both failure snapshots. This remains an evidence gap.

CI correction retains durable inventory scopes even while a graph is inactive, but filters optional local-author hints until their lane is active. A typed unavailable-policy hint is recorded as absent so accepted policy can wake the same durable scope immediately; unknown read failures retain backoff. Integration tests still require no canonical reconcile before subscription and no retry storm on repeated subscription.

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

Finalization itself now holds the publisher lifecycle lock before reading or changing WM, covering explicit `wm/finalize` and implicit share preparation. An unfinished bound owner refuses finalization; durable share preparation recognizes that typed refusal and continues the original binding-validation/admission path. A finalization already in progress completes before the worker can clean WM. The original claim, admission and post-lock authority checks remain in place.

A refused projection admission or typed projection-readiness failure after acknowledged inventory CAS retains the original retryable share owner. Strict confirmed-public-VM recovery also requires projection admission after inventory removal; the legacy observer keeps its previous committed-removal response, and private VM placement remains owned by its durable repair marker. Replay reuses the unchanged row and wakes the catalog projector after authority returns. Permanent and unclassified refusals still fail closed.

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

Round27 local checks passed: 201 HTTP/real worker cases, 14 agent preparation/handoff cases, 107 broader finalization/policy cases (one pre-existing peer-ID-layout skip), 128 publisher lifecycle/mutation cases, CI routing, lint, unchanged size budgets and the 2,652-file inventory. The explicit HTTP finalizer and real worker retain exact payload, original binding, empty WM and publication readiness. Three independent negative controls fail at behavioral assertions when removing only the shared finalizer guard, only its lock, or only its unfinished-owner check. Five Mermaid diagrams render successfully. The clean runtime build and daemon checks follow this revision before live candidate measurement.

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

Round28 local checks passed: 208 HTTP/real-worker and 37 agent inventory/observer cases, routing/lint/size and the unchanged 2,652-file inventory. The real native-inventory test loses accepted policy after CAS acknowledgement, then the ordinary worker completes the same binding with an unchanged inventory row/head and one signed catalog entry. Removing only projection error translation reproduces the terminal failure. Current clean-build daemon checks and candidate13 live/restart remain pending.

Round29 local checks passed: 209 HTTP/real-worker and38 agent inventory/observer cases, routing/lint/unchanged size budgets and2,652-file inventory. The real-worker regression starts with a reconciled signed catalog, acknowledges the next native inventory CAS, then tests both unavailable policy and actual inactive authority returning false. The same job retries with unchanged binding/rows/head and converges to the exact two-row catalog. Removing only the boolean check reproduces incorrect success. Candidate14 clean-build daemon and live/restart validation remain pending.

Round30 passed209 HTTP/real-worker,40 inventory/observer and3 confirmed-VM worker cases (including marker-backed restart), routing, lint, unchanged size budgets and2,652-file inventory. Restoring premature public projection ownership makes both new cases incorrectly succeed; the correct source is restored. Initial fixture failures from assuming catalog generation1 and RDF query order are preserved locally; final assertions use the observed starting generation and exact unordered RDF tuples. Candidate14 preparation and its20-file archive are preserved, with all ten signer nonces reconciled and matching claim released. Clean runtime build/daemon checks and candidate15 live/restart remain pending.

Round31 adds three raw persisted-format3 upgrade fixtures independent of the current writer/serializer. Reconstructed queues preserve author-only default-lane behavior and conflicts, safely reclaim unstarted expired work, and hold started ambiguous work for inspection. All98 queue tests, routing/lint/size and2,653-file inventory pass. No production change was needed; candidate15 will use the clean test-only revision with runtime code identical to5061c773f.

### Round32 review validation in progress

Restart projection now enumerates validated durable inventory-head scopes, including unregistered authors and empty heads. Discovery does not grant catalog authority; unavailable scopes retain periodic recovery, and corrupt persisted heads fail closed. New operations requiring inventory verify author signing capability before admission or WM consumption. Existing operations avoid a new preflight prerequisite; only typed transient signer transport errors become retryable. Lanes without mandatory inventory preserve pre-signed sharing without a local author key.

The new built-process suite passes four cases: missing signer refusal without owner/WM mutation, pre-signed compatibility on the legacy lane, automatic recovery after post-preflight signer timeout, and SIGKILL after a succeeded job with automatic catalog completion after fresh-process discovery. Native inventory/projection suites pass186 tests; publisher lifecycle/mutation suites129; HTTP/worker suites209; Node evidence tests53. Runtime build/type/export checks pass. Initial package-boundary and fixture failures are retained locally: a missing internal export classification, wrong test-route selection, default catalog activation, bounded asynchronous retry timing, JSON null-prototype comparison and an unsigned synthetic test agent. No production guard was weakened to pass those fixtures. All five Mermaid diagrams render and were visually inspected. Three independent negative controls fail when only durable discovery, signing preflight or strict cardinality validation is removed; all modified files were restored. Clean-build daemon/native-reopen checks passed64 tests. Candidate16 stopped during preparation as detailed above; fresh live/restart validation and remote convergence remain pending.

Round33 CI corrections pass158 native-wiring/backoff/pressure cases and10 scheduling/persistence integration cases. Removing only the typed absent-policy observation reproduces the missed immediate wake-up; the source is restored. The dormant-inventory integration case now explicitly checks retained ownership, zero reconcile calls before subscription and exact retry counts after subscribe/resubscribe.
