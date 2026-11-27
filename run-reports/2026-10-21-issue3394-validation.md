# Issue #3394 watchdog validation

## Executive Summary

The diagnostics fix is validated; the interruption/recovery campaign is **partially successful, not all green**. Normal load, publication/update/readback and post-restart checks passed. The deliberate pause produced five classified failures and one retained restart summary. The interrupted publication recovered under its original job ID, but the interrupted async share failed conservatively after its 15-minute lease expired, requiring manual inspection. That recovery policy is unchanged from the incident release.

Across the isolated campaign, 83 share jobs succeeded and one intentionally interrupted share failed; all 19 publications finalized and all 39 transactions had successful receipts. No spontaneous worker restart occurred during sustained load. The historical stall's underlying cause remains unresolved: this PR fixes loss of diagnostic evidence, not that availability cause or the existing async-share recovery limitation.

## Incident investigation

The private read-only bundle confirms the watchdog restart at 2026-10-21 01:10:36.727708 UTC and replacement listener at 01:10:48.643 UTC: 11.915 seconds from kill to listener, not the full outage. Eight share and eight publication HTTP 502 responses aligned with the restart. Missing responses remain ambiguous and cannot establish non-admission. Lease expiry and partial-promotion risk were recorded; independent store corruption was not established.

No per-probe classification or causal event-loop stack was retained. Replacement startup's sync/backpressure activity cannot establish the preceding stall's cause. No OOM, false-positive watchdog, particular store deadlock or new release regression is established.

The probe and supervisor files at incident release `7563618d2` were identical to canary base `bec73c5ce`. Executing the exact incident probe function against native TCP fixtures confirmed that HTTP 503 returns true while deadlines, premature close and malformed response all collapse to false. The candidate preserves these distinct observations without changing the health policy.

## Environment and ownership

| Phase | Runtime / evidence |
|---|---|
| Initial sustained load and published update | `9855f8f7255017f3f2f45a550f19618eb8013c26` |
| Deliberate interruption and post-restart checks | `a2f740dedcb7b5239c3e9fad13b1e716a1d40630` |
| Final boundary-test revision | `e4fd43c7d`; runtime source identical to `a2f740ded` |
| Host/runtime | Native macOS arm64, Node 22.23.3, DKG 10.0.25 |
| Chain | Base Sepolia, chain ID 84532, prepared funded testnet pool |
| Store | Blazegraph; pinned `islandora/blazegraph:6.4.3@sha256:015e308ae0a296cdb87c83c10da976ed970d2bfa971290aa1147593df8cf445d` |
| Isolation | `.tmp/issue3394-live`; loopback API/store 19394/19395; owned container `dkg3394-blazegraph` |
| Wallet coordination | batch-1, run `issue3394-20261021`; fingerprint `31a756ba1143d53de1f13b02734089a68d65bf0306c5c5aac450fd729ce4a6ff`; six publishers, no-attribution mode |
| Evidence | `.scratch/3394/live/evidence`, preserved outside the disposable worktree; public signer addresses, Hub/token bindings and balances retained privately with the run |

Initial minimum across operational/publisher wallets: 0.01 native gas and 1000 TRAC. No funding, profile or PCA provisioning. Source bundles and unrelated services were unchanged. The reported incident used Gnosis; this is controlled Base Sepolia validation, **not an exact historical environment reproduction**.

## Local validation

- Runtime package build and CLI build/type/package-boundary checks passed.
- Initial focused regression run: **174 tests in six files**, including durable synchronous sharing and async promotion bookkeeping.
- Additional shutdown budget/wait tests: **59 passed**; admission-during-shutdown: **three passed**.
- Review round 1: **63 focused tests passed**, including malformed headers after a valid status line. Parser classification precedes code sanitization; unallowlisted codes serialize as `UNKNOWN`.
- Review round 2: **56 focused tests passed**, separating raw monotonic shutdown-grace policy from diagnostic rounding/capping.
- Review round 3: **57 focused tests passed**. At 29.6 ms, telemetry rounds to 30 but a 30 ms grace remains active; counting begins at exactly 30 ms. Restoring the old rounded-time policy made this regression fail; source was restored afterward.
- Type checks, repository lint, file-size and whitespace checks passed.
- Initial focused probe/watcher line coverage: 100% each; branch coverage 86.66% / 94.73%. Full supervisor line coverage in that run: 63.88%; unrelated exit paths were not exhaustively covered.

Native-server tests cover 200/401/404/503, refused connection, accepted/no headers, trickle timeout, incomplete/malformed response, setup failure and cancellation. Tests verify peer-side socket retirement, bounded/private diagnostics, success resets, grace suppression/expiry, stop races, one decision per generation, observer failure isolation and parent-log persistence across replacement.

## Live results

| Check | Observed result |
|---|---|
| Sustained workload | 30 rounds over 608.903 seconds; six sequential rounds then three concurrent shares per round; 17 synthetic RDF triples per asset; publication every second round |
| Initial load | 78 async shares plus one one-shot create/share; 15 verified publication receipts with matching on-chain roots and graph membership |
| Responsiveness during measured load | 122/122 status samples HTTP 200 with healthy backpressure; 20/20 production watchdog probes received HTTP responses, maximum 29 ms; one worker generation |
| Event-loop sampling | Maximum sampled p99: 20 ms; maximum sampled delay: 121.5 ms; this does not exclude unsampled pauses |
| Payload/version checks | Canonical SWM/VM readbacks passed, including same-count negative payload controls; a published update retained distinct prior/current share operations and roots |
| Controlled interruption | SIGSTOP while share was running and publication claimed; unchanged 5-second deadline / 30-second interval / five-failure threshold |
| Restart evidence | Five deadlines of 5001–5003 ms, each connected with no headers; one generation-bound restart summary containing three earlier healthy probes and all five failures |
| Replacement | Kill at 08:14:05.290 UTC, listener at 08:14:12.130 UTC: **6.840 seconds kill-to-listener**; publisher-ready observation 175.119 seconds after pause |
| Interrupted publication | Recovered and finalized under the original job ID; receipt/root/membership verified; no mutation replay |
| Interrupted share | **Failed** at lease expiry, requiring manual inspection; no mutation replay or lease manipulation |
| Fresh work after restart | One-shot create/share, async publication and canonical VM readback passed on the replacement |
| Final queue inventory | 84 share jobs: **83 succeeded, one failed**; 19 publication jobs: **19 finalized**; all terminal |
| Transactions | **39/39 receipts successful**; every used signer nonce reconciled; final pending/latest nonces equal and unchanged after shutdown |

The restart summary remained in the parent-owned log, and the replacement's probes used a new generation. The controlled SIGSTOP validates the connected-but-unresponsive transport mechanism; it does not identify what blocked the historical worker.

### Interrupted-share limitation

The retained async request has no durable recovery binding. Its `promoteStarted` marker was set while `swmInserted` remained false. The 15-minute lease expired at 08:26:44.899 UTC; the queue failed the job at 08:26:44.921 with “Worker lease expired during promote; recovery aborted to prevent duplicate SWM/gossip.” It requires operator inspection instead of unsafe automatic replay.

The async admission body, lease default and expired-running recovery policy were compared with incident release `7563618d2` and are unchanged. This is a reproduced downstream limitation, not a new recovery behavior introduced by this PR. A read-only payload-location check found the fixture's 17 triples in working memory only; that narrow observation does not prove global store integrity or authorize a blind retry. The job and store journal are preserved for follow-up.

## Non-passing setup attempts and environment limits

- The first root-config baseline attempt was stopped during unnecessary chain setup; it is not a passing baseline claim.
- A local store URL was corrected from `/blazegraph` to the image's `/bigdata` endpoint before successful startup.
- Background chain indexing reported pruned historical RPC reads. Current graph registration and all campaign transactions succeeded; historical indexing is not claimed clean.
- The update harness tried to pull a draft its earlier readback had already opened, correctly receiving `WM_DRAFT_CONFLICT`. It resumed from the verified existing draft.
- One interruption preflight caught a dirty build label caused by the untracked report file. No pause was injected; already admitted jobs were reconciled before a clean rebuild.
- Another publication preflight selected an asset already reopened by SWM readback and correctly received `PUBLISH_INTENT_STALE`, `jobCreated:false`. A sealed independent fixture was used; the rejected mutation was not ambiguously replayed.
- The first post-restart share poll budget was two minutes, shorter than the production 15-minute lease. Read-only observation continued under the original job ID through its terminal failure; the original timeout is preserved.

## Cleanup and follow-up

Owned supervisor/worker processes and both listeners are gone; the owned container and isolated credential home were removed. All admitted jobs reached terminal states, all transactions/nonces reconciled, and batch-1 was released. The stopped Blazegraph journal was compressed and verified by comparing its SHA-256 before compression and after decompression. Raw results, logs, failure evidence and journal are preserved outside the disposable worktree.

No full sixteen-suite devnet gate, epoch transition or exact Gnosis incident reproduction is claimed. This is not evidence of zero regressions outside the exercised cases. Keep #3394 open for historical stall attribution and the separate async-share recovery limitation; do not turn a missing response or this conservative failure into permission to replay a write.

Remote review and CI readiness are tracked on PR #3395; maintainer approval remains a separate repository requirement.
