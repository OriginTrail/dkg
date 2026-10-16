# #2963 — durable synchronous share recovery

## Executive summary

Work in progress. The optimized publisher baseline commits the sealed SWM payload before separate lifecycle/head/cleanup and catalog-observer work. A synchronous request has no persistent share-job owner. Two deterministic live interruptions reproduced committed content with missing lifecycle fields and unavailable descriptors. The original incident's exact failing store call remains unknown. The recovery implementation is under validation. The first candidate automatically repaired both injected operations and reached 436/436 catalog entries; its fixed-deadline readback, process-restart regression and remote review remain pending.

The baseline uses performance PR [#3253](https://github.com/OriginTrail/dkg/pull/3253) at `9436b5c927f9fc8e5eb0cd5523da785dfa1cdd75`; its scope is unchanged. The separate branch is `codex/2963-durable-share-recovery`. See the [execution plan](../agent-docs/plans/2026-10-16-2963-durable-share-recovery.md) and [reproduction harness](../scripts/testnet-share-recovery/README.md).

## Evidence and interpretation

- [Issue #2963 and acceptance criteria](https://github.com/OriginTrail/dkg/issues/2963).
- [Original live partial commit and explicit manual recovery](https://github.com/OriginTrail/dkg/issues/2963#issuecomment-6217273362).
- [Related performance investigation #3252](https://github.com/OriginTrail/dkg/issues/3252).

The selected injection boundary is the promoted lifecycle insertion immediately after its deletion. Both failures retain eight SWM triples and the original seal and immutable operation intent, but no lifecycle `state`, `memoryLayer` or `assertionGraph`. This characterizes a relevant partial commit; it does not prove which call failed in the original benchmark. Neither arm's requests are manually replayed. The local characterization tests explicitly exercise manual replay and are reported separately from automatic recovery.

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

## Preserved invalid attempt

The first attempt used API/store ports 9296/9996 and graph suffix `2963-baseline-20261016`. It is **invalid for controlled performance comparison**: restarting the daemon lost the graph's runtime subscription, and a shell lacking fail-fast behavior continued after a readiness assertion failed. The harness was corrected to check readiness internally, and the graph selection is persisted before startup in the replacement arm.

All requests are retained: 48/48 publications admitted and finalized; 254/256 synchronous shares returned 200, and two injected shares returned 503. Independent receipt decoding verified 48 distinct successful publication transactions, one asset-creation event per transaction, and exact original asset IDs/authors/roots. All 436 original seals were unchanged. All ten signer pending/latest nonce counts matched at reconciliation. No manual repair occurred. Observation was explicitly stopped early; the final snapshot had 434 inventory rows and 393 catalog rows while projection was still draining. This is not a failed fixed-deadline comparison, nor a passing one.

The owned daemon and container were stopped and their matching claim released before acquiring the replacement arm. Store data and incomplete assets are retained locally. Secrets, API tokens, claim tokens and raw node logs are excluded from reviewer artifacts.

## Controlled baseline

Arm `baseline2`: API 9297, Blazegraph 9997; graph suffix `2963-baseline2-20261016`. Production source and runtime remain the optimized parent revision. Tests, plan and harness commits do not change production behavior. All 435 preparation requests plus the separately captured smoke succeeded.

Traffic started at `2026-10-16T16:21:34.107Z` and ended at `2026-10-16T16:28:44.869Z` (430.762 seconds). All 48 publication jobs finalized. Share responses: 254 HTTP 200 and two injected HTTP 503; no natural request failure. The fixed catalog deadline is `2026-10-16T16:48:44.869Z`. The deadline-bracketing polls at 16:48:38.982Z and 16:48:54.023Z both retained 434 rows; the full snapshot at 16:48:56.612Z (11.743 seconds after the deadline, within the fixed 15-second poll granularity) contained exactly 434 inventory and 434 catalog entries. Both missing entries were the injected assets. Automatic recovery: **0/2**; manual repairs: **0**. All 436 original seals remained unchanged. Descriptor audit: 434/436 HTTP 200, with exactly the two injected assets returning 404. No extra or duplicate catalog identities were observed.

Publication latency from admission to finalization: p50 173.152 seconds; p90 306.819 seconds. Full-cohort makespan 344.669 seconds, throughput 0.139264 publications/second. All 48 decoded asset-creation events matched the original asset ID, author and root; all 48 transaction hashes and publisher/nonce pairs were distinct. All ten signers had equal pending/latest nonces. The complete nonce interval accounts for 98 successful transactions: 48 publications, 49 token approvals and one graph registration, with no gaps. Read-only RPC evidence collection encountered rate and log-range limits; subsequent throttled 200-block queries completed. These were evidence-reader failures, not additional workload submissions.

The same unchanged baseline runtime was restarted without replay. At 16:56:24.597Z it still had 434 inventory and catalog entries. The owned daemon/store were stopped, listeners/processes checked, and the matching claim released. The two incomplete assets and store data remain preserved. A fresh claim owns the candidate home.

## Candidate, regressions and review

The candidate production revision is `7dfc334200bb2a716e7dc11cf25ec7a033cd9481` (implementation `082451177`, followed only by whitespace normalization). The startup smoke encountered a natural transient catalog-authority delay after content commit: HTTP 503 with a durable job handle at 17:09:29 UTC. No HTTP replay occurred. The real worker completed the same operation on attempt two at 17:10:27.827Z (57.915 seconds after the recorded failed attempt); a readback at 17:11:02.489Z verified its inventory and catalog entry. The original seal and lifecycle operation ID/intent were unchanged. This cold-start event is reported separately from the matched timed workload; it is not a third injected request.

Local validation so far: runtime build (including types/package checks), 184 publisher queue/replay regressions, 102 HTTP contract tests, 44 existing worker/queue/route tests, nine new durable synchronous recovery tests, seven characterization/inventory handoff tests and 129 broader agent/inventory regressions passed. Lint and file-size checks passed after excluding isolated credential/evidence homes through `.tmp/` in `.gitignore`. Initial failed test/build attempts are retained locally; passing results refer to the corrected implementations. The first matched candidate finished 48/48 publications, returned 254 HTTP 200 and two injected HTTP 503 responses, and reached a complete 436-row catalog at 17:32:48.626Z. Original-author descriptor probes first returned 200 at 17:25:24.562Z for catalog-140 and 17:25:08.936Z for catalog-141. The fixed catalog deadline was 17:47:59.508Z; the snapshot at 17:48:00.463Z contained exactly 436 inventory and catalog entries. Both injected operations recovered automatically (2/2), with no manual repair. The independent descriptor audit returned 436/436 HTTP 200. All 436 original seals, exact whole-graph payloads, 48 publication identities and carrier transactions matched; all 98 transactions were accounted for with no nonce gaps and all ten signers settled. Publication latency was higher than baseline: p50 243.122 seconds, p90 402.222 seconds, makespan 435.117 seconds, throughput 0.110315 publications/second. This single public-testnet pair supports recovery correctness, not a performance improvement. The daemon and store were stopped after proofs completed; their data remain preserved. After that convergence, focused source-only tests ran on the otherwise idle host; no build changed the running daemon. A further 12 real queue/agent recovery tests (including three completed-legacy compatibility cases), 161 HTTP/worker/queue regressions and 153 publisher regressions passed. A publisher no-emit type check passed; the first attempted invocation used an incompatible composite-project flag, which was corrected without touching runtime output.

Sanitized baseline artifacts are [indexed here](2963-evidence/README.md), including every measured request, every asset identity, decoded chain events, nonce accounting and the two fault captures.

The definition of done is not met yet. Remaining work: live validation of the review fixes, actual process-crash/restart recovery, final regression/build checks and current-head remote review convergence. The complete first-candidate artifacts are preserved separately; they do not establish validation of later source changes. No merge is authorized.

## Implementation and acceptance mapping

Synchronous HTTP requests now prepare the existing seal and original operation intent, then atomically persist a version-4 queue owner and inline lease before SWM mutation. The worker receives the original storage author, seal digest and complete immutable intent; it validates them again under the lifecycle lock and never reseals on replay. Existing authority/recipient checks run again, and the original curator-confirmation requirement cannot be weakened by a changed default. Queue writes require atomic replacement, expired started leases can reclaim only bound operations, and stale claim tokens remain fenced. Uncertain admission exposes an observation handle and never starts inline content mutation.

Bound post-commit failures move directly to `failed_retrying` and retain their diagnostic while reporting `retryable: true`. Recognized transient failures retain the obligation beyond the ordinary attempt cap. Permanent integrity failures remain visible for inspection. Unfinished bound jobs cannot be cleared or cancelled. Success requires the lifecycle tail and authorized durable inventory handoff; the existing projection supervisor owns catalog convergence from persisted inventory after restart. Blockchain publication and nonce allocation are unchanged.

The optimized parent already exposes `lastError.diagnosticCode`, makes swept retry rows consistent, and prevents clearing an unbound post-commit row still eligible for automatic recovery. This PR retains and regression-tests those contracts. The decision for issue item 4 is explicit: existing unbound async jobs retain their bounded startup/30-second sweep; new synchronous bound jobs enter retry immediately. Tests exercise the actual worker and queue. The lifecycle guide documents both contracts and additive HTTP 503 recovery fields.

Self-review found a compatibility edge: a complete pre-intent operation must remain a read-only no-op. The follow-up verifies its original seal, exact payload, empty WM, marker and durable tail under the lifecycle lock, then returns the original operation ID without creating a replay job. Incomplete or changed pre-intent content is rejected; no missing intent is fabricated. This follow-up is not part of the first candidate's compiled revision and will be identified separately in final validation.

The authored change exceeds the usual small-PR guideline because durable ownership crosses the HTTP admission, queue/worker, publisher replay and catalog handoff boundaries; splitting these would leave a partially enabled recovery contract. Responsibilities are extracted into small helpers rather than growing the large facade files. Reproduction scripts and generated reviewer evidence are accounted for separately from production code and tests.


## Review response and evidence correction

Remote review identified a content-audit gap: the first reducer selected the expected subject before comparison, which could hide unexpected subjects. The corrected validator compares complete WM/SWM/VM asset graphs and the complete materialized context graph, rejecting extra subjects, missing triples and unexpected graphs. Four validator regressions pass. Re-running the corrected reducer against both preserved fixed-deadline snapshots found no content errors. Both arms' generated artifacts now include the full-graph audit; this is a correction to evidence collection, not a rerun or removal of failures.

The review fixes retain automatic retries for typed curator non-confirmation while keeping explicit curator rejection terminal; derive inventory obligations from effective authority (including legacy/system/kill-switch paths); preserve completed pre-intent SWM and VM no-ops; separate the throwing inventory commit core from its best-effort observer; and share read-only completion/binding evidence. Two real SQLite inventory/queue/worker regressions cover failure before CAS and a committed write with lost acknowledgement, with one final row and the original binding on attempt two. Permanent HTTP failures retain their observation handle and inspection state without changing their error status. Fresh operation IDs retain the established public format.

CI also exposed route fixtures lacking the new recovery owner and an HTTP retry-metadata regression. Those were corrected with real queue fixtures; all 74 actual-daemon integration cases passed (knowledge-asset routes, source-worker clients/runner and OKF subgraph roundtrip), alongside 181 focused HTTP/recovery cases, 153 publisher queue/intent/replay cases and a publisher type check. The earlier full publisher lifecycle run passed 105 cases. Final lint and file-size checks passed. The initial full CI run is retained as failed evidence. Final-revision CI and real process restart remain required.
