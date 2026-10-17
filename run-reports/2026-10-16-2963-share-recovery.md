# #2963 — durable synchronous share recovery

## Executive summary

The final matched candidate recovered both interrupted synchronous shares automatically in 61.058 and 62.121 seconds, preserving their original operations, seals, versions and content. The optimized baseline recovered neither interruption by the fixed deadline. Both arms completed all 48 publications. The candidate reached exactly 436 catalog/inventory identities and available descriptors, with no extra identities, duplicate publication effects, nonce gaps or manual repairs.

The cause is missing durable ownership: a synchronous request could commit sealed SWM content before separate lifecycle/head/cleanup and catalog-observer work, then return an error with no async share job responsible for finishing it. The fix admits a sealed, immutable, leased recovery owner before mutation and lets the existing worker resume that same operation. The exact store call in the original incident remains unknown; deterministic live injections characterize its documented partial-commit state rather than establish that unknown call.

Separate [PR #3300](https://github.com/OriginTrail/dkg/pull/3300) targets `testnet-canary`. Performance [PR #3253](https://github.com/OriginTrail/dkg/pull/3253) merged at 2026-10-16T18:08:57Z; its agreed scope is unchanged. The final comparison uses integrated optimized base `e3d134dd7c5fef1b479362bcc91a9de620b31277` and candidate product/runtime `92fb35e4d218c8151a36dd61b779b11129bbb9ce`. Subsequent changes are evidence collectors, regression tests and reports, not production source. No merge is authorized.

**Completion status:** main live correctness and the separately observed actual daemon restart are verified. Evidence revision `ee2fe18ec62545d8bb535dc199c9e5bac841dd18` passed 69 CI checks with four skips, and all 58 collected review threads were addressed. Final-revision review and required human/code-owner approval remain unconfirmed; this is not a claim of merge readiness.

## Local evidence archive

At the user's request, all 244 generated evidence files were moved out of the current source tree into local archive `dkg-archive/issue-2963/2026-10-17-ee2fe18ec/` under the machine's `Projects` directory. The archive contains `evidence/`, `SHA256SUMS`, and `archive-manifest.json`; all 10,252,350 source bytes were verified unchanged against revision `ee2fe18ec62545d8bb535dc199c9e5bac841dd18`. Checksum-list SHA-256: `892123720bea1cb3a0cc577ad53fcf2c48112b63c0ba14ab595b622b630b1ccd`.

Paths below are relative to the archive's `evidence/` directory, not repository links. Full evidence is not accessible from the current checkout unless the local archive is supplied separately. This supersedes the earlier request to publish the full sanitized evidence with the PR. Existing pushed commits still retain their previously published exports; Git history was not rewritten. Private raw evidence, node homes and store data remain in their original local locations.

## Latest matched baseline and candidate

All times below are UTC on 2026-10-17. The baseline ran and its failures were preserved before the final recovery changes were built and measured. The original baseline on #3253's then-current head also preceded the initial implementation; its results remain summarized below and its full records are preserved in the local archive.

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

## Native environment and fixed protocol

macOS 26.3 arm64; native Node 22.23.3 and pnpm 10.28.1. Host: 10 CPUs, 32 GiB RAM; Docker: 10 CPUs, approximately 8 GiB. Blazegraph image `islandora/blazegraph:6.4.3@sha256:015e308ae0a296cdb87c83c10da976ed970d2bfa971290aa1147593df8cf445d`, limited to four CPUs and 4 GiB container memory. Actual JVM maximum heap is 1 GiB, verified with `jcmd VM.flags`; this image ignores the supplied `JAVA_OPTS=-Xmx2g`. Native daemon maximum heap is 4 GiB. Auto-update is disabled. API authentication is enabled.

The chain is Base Sepolia (`base:84532`), Hub `0xC056e67Da4F51377Ad1B01f50F655fFdcCD809F6`, TRAC `0x2A58BdD13176D85906D804cdbFFA0D9119282DC8`. Six publisher-owned TRAC wallets are used without a PCA. Batch `batch-1` is acquired exclusively through the DKG testnet skill's claim helper, with source wallet files unchanged. Each arm uses a fresh home, namespace and registered private context graph. Only the author allocator's monotonic high-water mark is carried forward, preventing unpublished identity reuse.

| Role | Public address |
| --- | --- |
| Author / primary operational | `0x247B02C301B34E52e9021728F34C3457F81f2dFc` |
| Publisher 1 | `0xAddff5D971ec77276Bd38D77AaD2822c41c72611` |
| Publisher 2 | `0x66a70B361C827Ef9B7939AD2Ec21E72bC8927240` |
| Publisher 3 | `0x1dFCC652dc4245C799c79B7984D1F1b7143B2429` |
| Publisher 4 | `0x093ADac4F2937ED691808a61A4297040fD1f45a7` |
| Publisher 5 | `0xBa7FeCe62cDD206323616eB8A05E264029786477` |
| Publisher 6 | `0x1a297f7780777cE38FA9C814bb1Ead1a55198e4A` |

Starting state: exactly 180 catalog and author-inventory identities, verified against their versions and seal digests; 256 additional sealed drafts; no publication-job history. Each payload has eight triples. Measured traffic: 48 publication admissions at concurrency six, concurrent with 256 synchronous shares at concurrency four. Each POST is sent once with a 120-second request timeout. Publication deadline: 20 minutes from traffic start. Catalog deadline: 20 minutes after traffic end. Two of the 256 share requests receive one-shot injected faults; the remaining 254 form the natural-failure denominator. Descriptor probes run every 15 seconds after each injection. Exact snapshots and independent chain receipt/event checks supplement status observations.

This is a sequential comparison on a public testnet; external chain load and native host CPU scheduling are uncontrolled. Fresh publication-job history differs from the original WSL benchmark's 268 historical/smoke jobs. Those limitations preclude claiming a broadly representative performance improvement from one pair.

The latest arms use API/store ports 9298/9998 sequentially (baseline4 and candidate11), distinct homes, containers and graph suffixes. Both pass unauthenticated 401/authenticated 200 probes. Starting metadata/content/catalog sets are equivalent; the candidate additionally retains 180 succeeded preparation recovery owners, an inherent consequence of the implementation. Candidate11's immutable campaign manifest was saved before preparation. Earlier manifests are explicitly labelled historical imports verified against recorded protocols; they do not claim retroactive use by the frozen runner.

Executed runner SHA-256: `80c72964a23a633cfa355589d0806d79628f87dc9a965b6027f96a49e697a682`; fault hook: `1aa663c1368f64da6454db1a2c2c4bab0f9575c2de90e25580ecc96f5e753c8c`; snapshot: `4b602b763eb633a0f8288b6573c105d3b633578f700f0ad17304a0a0a36ccbb5`. No builds or regression suites overlapped measured traffic, fixed catalog drain or the separate crash observation.

## Root cause, compatibility and acceptance

Sources: [#2963](https://github.com/OriginTrail/dkg/issues/2963), [original failure and manual recovery](https://github.com/OriginTrail/dkg/issues/2963#issuecomment-6217273362), [related investigation #3252](https://github.com/OriginTrail/dkg/issues/3252). The original failure had no asynchronous share job owning its retry. Successful manual replay proves recoverability of the original operation, not automatic ownership. Locally recreated characterization covers this boundary without relying on uncommitted benchmark tests or private artifacts from the original report.

Synchronous admission prepares the existing seal and immutable operation intent, then atomically persists a version-4 queue owner and inline lease before SWM mutation. Recovery revalidates the storage author, seal digest, operation, original policy/recipients and catalog authority under the lifecycle lock; it never reseals. Competing unbound mutation, reopening, cancellation and clearing remain fenced until the obligation succeeds. Stale claim tokens cannot mutate the owner. Uncertain admission does not start inline mutation; uncertain start bookkeeping leaves the original lease for worker recovery. Only certified not-started bookkeeping can retry directly. Blockchain publication and nonce allocation are unchanged.

The worker owns explicit start-marker, promotion and result-bookkeeping stages. Bound recoverable post-commit failures enter `failed_retrying` immediately and survive the ordinary retry cap; permanent authorization, schema, integrity and native SQLite corruption failures remain visible for inspection. Legacy unbound async jobs retain their existing bounded startup/30-second sweep. Recovery success requires the complete lifecycle tail and durable authorized inventory handoff; the existing projection supervisor then converges the catalog from persisted inventory. Complete pre-intent legacy SWM/VM operations remain read-only no-ops; missing intent is never fabricated for incomplete content.

| Acceptance criterion | Contract and verification |
| --- | --- |
| Distinguishable, consistent job diagnostics | `lastError.diagnosticCode` is exposed and retrying rows retain `retryable: true`; real worker and HTTP error-contract cases pass. |
| Clear cannot delete a future recovery obligation | Legacy sweep-eligible rows and every unfinished bound obligation, including inspection holds, reject clear/cancel. |
| Explicit immediate-versus-sweep decision | Bound synchronous recovery retries immediately; legacy unbound jobs retain the 30-second sweep. Actual queue/worker tests cover both. |
| Actionable synchronous failure | Additive durable job/status URL fields accompany replay-safe failures; permanent and uncertain outcomes retain their contracts. Live 503 captures verify the handles. |
| Lifecycle guidance | [Recovery documentation](../docs/use-dkg/knowledge-asset-lifecycle.md#async-share-recovery) explains ownership, leases, status, inspection, worker availability and downgrade limits. |
| Automatic synchronous recovery | Matched live injections succeed 2/2 versus baseline 0/2; actual crash evidence is separate from the matched denominator. |

Ordinary and bound execution inputs are now distinct types normalized once. The immutable campaign manifest centralizes evidence cohorts and deadlines. [#3315](https://github.com/OriginTrail/dkg/issues/3315) and [#3316](https://github.com/OriginTrail/dkg/issues/3316) were initially proposed follow-ups and subsequently implemented in this PR. The change exceeds the usual small-PR guideline because admission, durable queue ownership, publisher replay and catalog handoff form one correctness contract; splitting activation would leave recovery partially enabled. Generated evidence and reproduction scripts are assessed separately from production/test changes.

## Regression and evidence validation

Native macOS/Node verification passed runtime builds, TypeScript/contracts and package exports; 132 publisher cases, 113 agent cases, 43 synchronous-share cases, 69 actual-daemon cases, the corrected 87 worker/inventory/VM/result batch and 48 classifier cases. A later 76-case worker batch includes the legacy start-marker failure contract. These overlapping batches must not be summed. Real persisted queue, native SQLite corruption and healthy disk reopening, lost acknowledgements, confirmed-VM handoff, authority/claim fencing and exact original identity are covered; unit tests are not substituted for the live trials.

Main and restart reducers compare complete RDF terms (node kind, datatype, language, lexical value and multiplicity) in the authoritative metadata graph and exact payload graphs. Missing metadata is retained as a failed asset proof. Scoped CONSTRUCT captures explicitly supply the original source graph. Seal hexBinary roots and lifecycle string pointers retain their distinct types. Additional restart checks compare all original payload graphs and lifecycle/seal/intent metadata, as well as every new asset and catalog tuple. Negative fixtures reject relocated metadata, extra/missing subjects/triples/graphs, changed literals and wrong term kinds. All **43 Node and nine Python evidence tests passed** after the fixed restart window. Both preserved historical restart snapshots also passed the added whole-cohort metadata/content checks; their original observation times are retained separately from revalidation timestamps.

Prior failed checks are preserved rather than reclassified as successful: one CLI batch passed 252 cases and failed four stale callback/diagnostic assumptions after bookkeeping moved into the worker; corrected affected suites passed. Earlier CI exposed an ownership-stage diagnostic expectation and missing coverage; both were fixed, without lowering thresholds. Initial evidence fixtures exposed stripped CONSTRUCT graph provenance, distinct seal/pointer datatypes and a zero-publication fixture edge case; corrections changed reducers, not captured data. Read-only RPC collection limits were handled by throttled bounded queries, not repeated workload submissions. Final lint, source-size ratchets and routing of 2,621 test files passed. Detailed sanitized validation summaries (`candidate11/local-validation.json` in the local archive) link private log hashes.

## Preserved earlier attempts and limitations

The first readiness-invalid baseline is excluded from controlled performance comparison: its controller continued after subscription/readiness failure. All 48 publications and 256 share outcomes remain recorded, including two injected 503s and 434 inventory/393 still-draining catalog entries at its early readback. It lacks fault metadata/content preimages and cannot establish the later exact preimage proof. The readiness barrier was corrected before controlled baseline2.

| Preserved arm | Exact runtime revision | Injected automatic recovery | Catalog outcome |
| --- | --- | --- | --- |
| baseline2, original optimized #3253 head | `9436b5c927f9fc8e5eb0cd5523da785dfa1cdd75` | 0/2 | 434/436 |
| first candidate | `7dfc334200bb2a716e7dc11cf25ec7a033cd9481` | 2/2 | 436/436 |
| baseline3, merged optimized base | `2aba84de35754e5663b52018f9781a6e6c8b948d` | 0/2 | 434/436 |
| candidate9 | `f7fdbdfaedc9bb3b8e1ff2307ec50a856d4010e7` | 2/2 | 436/436 |
| candidate10 | `a76cb38a5aacf2261d888c69c7e2abd5dbb0878c` | 2/2 | 436/436 |

Every completed controlled arm finalized 48 publications and retains all 304 measured requests, 436 identities/content checks and 98 accounted transactions. Candidate9/10 also completed actual supervised crash recovery on attempt two after the unchanged lease, in 901.514/901.561 seconds, with full 437-entry convergence in 945.568/947.302 seconds. Each preserves 79 observations including one startup read failure. Earlier successful revisions do not substitute for final runtime validation. Candidate2–8 are preparation-only superseded attempts: each retains one natural startup 503 with automatic recovery, 435 subsequent preparation requests, zero measured publications and two setup transactions; none counts as a benchmark sample. Candidate7's authority readiness remained unresolved, explicitly preventing measurement.

All corrected reducers were rerun against preserved completed snapshots without changing their original observation times. Baseline incompletes remain incompletes. Historical and final evidence, including full request lists, publication timing, fault captures, exact identity tuples, chain events, nonce accounting, environment and cleanup records, are indexed by `README.md` in the local archive. Archived sanitized artifacts use an explicit allowlist, per-file hashes and scans against private wallet/API/claim values. The current repository contains the report; full generated records are local-only by the user’s packaging decision. Raw jobs contain internal claim capabilities and remain private with homes, secrets and raw node logs.

## Ownership and review status

Baseline4's owned writers stopped at 01:22:56.417665 UTC; fresh nonce reconciliation at 01:23:38.412 confirmed all ten signers settled before matching claim release. Candidate11 owned writers/store stopped at 02:40:34.012723 UTC; fresh reconciliation at 02:41:15.961 confirmed all ten signers settled before matching claim release. Its final restart proofs and cleanup are complete. Incomplete baseline assets and store data remain preserved; no manual repair is counted as recovery.

The execution plan is [saved here](../agent-docs/plans/2026-10-16-2963-durable-share-recovery.md); the [harness guide](../scripts/testnet-share-recovery/README.md) describes reproduction. Sixteen accumulated review rounds are preserved. The final bounded window closed at 03:12 UTC with 69 successful/four skipped checks on `ee2fe18ec`, all 58 collected threads addressed, and final-revision/code-owner reviews still requested. Required approval remains unconfirmed, so the full definition of done is not yet met. No merge or background monitoring is enabled. The local-archive packaging change does not alter the tested product source.
