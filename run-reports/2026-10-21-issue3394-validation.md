# Issue #3394 watchdog validation

## Executive Summary

In progress. The source-confirmed defect is loss of probe failure evidence: the incident release collapses different transport failures into `false`, then the supervisor logs only a count. PR #3395 records bounded, sanitized transport results and a generation-bound restart history. It also cancels stopped probes and prevents a late shutdown-detector result from terminating a retired generation. The historical worker stall's underlying cause remains unresolved; diagnostics alone do not fix that availability failure.

## Incident investigation

The private read-only bundle confirms a watchdog restart at 2026-10-21 01:10:36.727708 UTC and a replacement listener at 01:10:48.643 UTC: 11.915 seconds from kill to listener, not the full outage. Eight share and eight publication HTTP 502 responses aligned with the restart. Missing responses remain ambiguous and cannot establish non-admission. Lease expiry and partial-promotion risk were recorded; independent store corruption was not established.

There is no retained per-probe classification or causal event-loop stack. Replacement startup's sync/backpressure activity cannot establish the cause of the preceding stall. No OOM, false-positive watchdog, particular store deadlock or new release regression is established.

The probe and supervisor files at incident release `7563618d2` were identical to the chosen canary base `bec73c5ce`. A local comparison executed the exact incident probe function against deterministic native TCP servers: HTTP 503 returned true; deadline, premature close and malformed response all returned false. The candidate preserves these four distinct observations while keeping the same health policy.

## Environment and ownership

- Native macOS arm64, Node 22.23.3; DKG 10.0.25.
- Initial live runtime: `9855f8f7255017f3f2f45a550f19618eb8013c26`.
- Review revision: `a6d75342c7bf6eaee41465e3dbb6c1e75a85d5e2`; parser-classification ordering and removal of a redundant callback.
- Prepared pool batch-1 claimed as `issue3394-20261021`; fingerprint `31a756ba1143d53de1f13b02734089a68d65bf0306c5c5aac450fd729ce4a6ff`.
- Isolated home `.tmp/issue3394-live`; evidence `.scratch/3394/live`.
- Authenticated API: loopback 19394; owned Blazegraph: loopback 19395, container `dkg3394-blazegraph`.
- Image `islandora/blazegraph:6.4.3@sha256:015e308ae0a296cdb87c83c10da976ed970d2bfa971290aa1147593df8cf445d`.
- Base Sepolia (84532), Hub `0xC056e67Da4F51377Ad1B01f50F655fFdcCD809F6`; six funded publishers, no-attribution mode. No funding, profile or PCA provisioning.
- Public addresses and before/after balances/nonces retained in local evidence. Initial minimum across the operational/publisher cohort: 0.01 native gas and 1000 TRAC; no pending nonce divergence.

The reported incident used Gnosis. This isolated Base Sepolia campaign cannot establish exact historical reproduction. Only prepared claimed wallets were used; no deployment was modified. A local setup URL was corrected from `/blazegraph` to this image's `/bigdata` path before successful startup. The node also reported pruned historical RPC reads during background chain indexing; current graph registration succeeded. Those messages are retained as environment limitations, not silently counted as clean indexing.

## Local validation

- Runtime package build and CLI build/type/package-boundary checks passed.
- Initial focused run: 174 tests in six files; covers transport, watcher, supervisor log persistence, foreground supervision, durable synchronous sharing and async promotion bookkeeping.
- Additional shutdown budget/wait tests: 59 passed; admission-during-shutdown: three passed.
- Review round 1: 63 focused tests passed, including malformed headers after a valid status line. Unknown native parser codes still classify as malformed responses while serializing as `UNKNOWN`.
- Type checking, lint, file-size and whitespace checks passed. The first root-config baseline attempt was stopped during chain setup; it is not claimed as a passing baseline.
- Initial focused probe/watcher line coverage: 100% each; branch coverage 86.66% / 94.73%. Full supervisor line coverage in that run: 63.88%; unrelated process-exit paths were not exhaustively covered.

## Live campaign

Completed on initial runtime, 608.903 seconds. Workload: 30 rounds over at least ten minutes, first six sequential then three concurrent shares per round, 17 synthetic RDF triples per asset, publication every second round, one-shot create/share, canonical SWM/VM readback and a same-count negative payload comparison. Status/event-loop/backpressure sampled every five seconds; production watchdog interval remained 30 seconds. Results: 78 successful async shares plus one one-shot create/share, 15 verified publication receipts with matching on-chain roots and graph membership, and two canonical payload readbacks with same-count negative controls. All 122 status samples returned HTTP 200 with healthy backpressure; all 20 watchdog probes in the measured window received HTTP responses (maximum 29 ms). Maximum sampled event-loop p99 was 20 ms; maximum sampled delay was 121.5 ms. No spontaneous restart occurred.

The updated version was also published and verified: distinct prior/current share operations and roots, canonical readback, successful receipt. The update harness initially attempted to pull a draft already opened by its preceding readback and correctly received `WM_DRAFT_CONFLICT`; it resumed from that verified draft without changing product behavior.

An attempted interruption preflight stopped on a dirty build label (the untracked report file). No signal was injected; admitted jobs are reconciled without replay before the clean rebuild. Review round 2 separates raw monotonic shutdown-grace decisions from diagnostic rounding/capping; 56 focused tests passed.

Pending: restart the owned supervisor on the final reviewed runtime and deliberately stop its worker with SIGSTOP. Allow the unchanged five-probe watchdog to terminate/replace it. Inspect the retained summary and reconcile the original admitted share/publication jobs without replaying mutations. Report whether jobs were actually nonterminal at interruption separately from restart/readiness success.

## Cleanup and limits

Pending. Retain the wallet claim until jobs/transactions reconcile and owned processes/listeners stop. Preserve raw evidence outside the disposable worktree before retirement. No full sixteen-suite devnet gate, epoch transition, or exact Gnosis incident reproduction is claimed. No claim of zero regressions beyond the exercised cases.
