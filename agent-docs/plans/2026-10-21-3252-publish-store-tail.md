# Issue 3252 — preserve authority caches during publication

Status: implemented; bounded live validation completed; PR review in progress. Owner: Codex. Base: `testnet-canary` at `abb89dff7`; branch `codex/3252-publish-store-tail`. User authorized investigation, implementation, PR/review and live testnet validation; no merge.

## Executive summary

The original issue is a multi-stage latency report, already partially addressed by merged PR #3253. Current cleanup still issues the known, graph-scoped StorageACK-copy deletion through the agent's opaque UPDATE wrapper. That wrapper invalidates every context-graph projection and recipient-key proof, even when the deletion only touches one SWM metadata graph. Compose this closed operation with an explicit graph removal descriptor, preserving the actual deletion query, mutation decorators and uncertain-write fencing. The expected improvement is fewer unrelated authority reloads and fewer cache fences during publication; end-to-end throughput improvement must be measured, not inferred.

## Evidence and boundaries

- [Issue and latest measurements](https://github.com/OriginTrail/dkg/issues/3252): cleanup, lifecycle stamping and terminal persistence remain material. They overlap; do not add their distributions.
- [Prior PR #3253](https://github.com/OriginTrail/dkg/pull/3253) merged; its all-workload acceptance failed. Existing claim and completion changes must be preserved.
- `published-snapshot-retirement.ts` invokes `clearDischargedStorageAckCopies` after SWM graph removal and before deleting the original operation rows. Its UPDATE is bounded to `input.metaGraph`, retaining newer versions and unrelated assets.
- `context-graph-cache-invalidating-store.ts` treats all raw UPDATEs as `everything`; `ContextGraphMetaProjection.dirtyAll` invalidates every projection; `RecipientKeyRouteFence.begin` rejects otherwise reusable recipient proofs during opaque writes and forces rediscovery afterward.
- Existing `createPublishedNamedKaVmLifecycleWriter` and ledger timestamp writer establish explicit composition without inspecting/unwrapping arbitrary store objects.
- Current scheduler already exports queue-wait/execution histograms by operation and active-operation snapshots. This patch does not duplicate those metrics or increase concurrency.
- [#2962](https://github.com/OriginTrail/dkg/issues/2962) separately tracks incomplete inline finalization. This performance fix must not relax local completion requirements or claim to resolve that defect.

## Approach

Choose a publisher-owned closed cleanup plan (SPARQL, target graph, stable label) and writer type. Direct publisher users retain the existing store behavior. Agent construction composes a writer over its configured decorated storage plus the shared mutation observer, describing removal of any subject in exactly that graph. Pass the same writer into every daemon wallet publisher. Do not trust a caller-provided arbitrary SPARQL string or mutation descriptor. Generic UPDATEs remain opaque.

Alternatives rejected: broadly trusting `touchedGraphs` would let arbitrary callers weaken authority fences; skipping cleanup loses snapshot retirement; increasing scheduler capacity changes host pressure without fixing unnecessary work. Batching more cleanup writes is deferred because it is a separate change and can itself introduce opaque invalidation.

```mermaid
flowchart LR
  A[Confirmed publication] --> B[Closed StorageACK cleanup plan]
  B --> C[Observe target graph removal]
  C --> D[Configured decorated store UPDATE]
  D --> E[Settle changed or uncertain outcome]
  E --> F[Retain unrelated projections and proofs]
```

## Work and acceptance

1. **C1 — reproduction/design (lead):** deterministic real-store test proves current cleanup advances unrelated projection/recipient revisions and blocks their reuse. Use actual operation rows and compare complete resulting RDF. Save failing-before output. No production change until this distinguishes old/new behavior.
2. **C2 — implementation (lead):** publisher closed plan/type, default retirement writer, agent composed writer and construction, daemon runtime propagation. Preserve cleanup ordering/deadline, one execution, original errors, graph-index/changelog wrappers, empty input no-op and standalone compatibility. Target one PR below roughly 600 authored code/test lines.
3. **C3 — regression checks (lead):** successful/no-match cleanup; empty input; malformed IRIs; absent capability; before/after-commit errors; graph containing real recipient facts; concurrent key introduction into a pending removal; generic opaque UPDATE; decorated store behavior; actual per-wallet wiring. Run existing cleanup/version/retirement and lifecycle/fence suites, package builds/types and repository static gates. A valid fix leaves unrelated cache identities stable but invalidates affected proofs, including ambiguous writes.
4. **C4 — live validation (lead):** claim an available prepared batch only after native build/SQLite readiness. Isolated macOS home and oxigraph-server, no wallet funding. Verify testnet bindings, balances, auth and peers. Run bounded private graph async VM publications and readback, capture all jobs including failures, exact payload/root/receipt and cleanup metadata. Use matched repeated baseline/candidate cleanup observation experiments under the real daemon to attribute avoided reloads, plus all-job wall-clock results; report small-sample/provider limits. If funds/quorum prevent publication, preserve the boundary and do not call it passed. Additional Blazegraph characterization is desirable because the reported incident used that backend.
5. **C5 — PR and convergence (lead/remote reviewer):** create PR into `testnet-canary`, use non-closing issue link unless full acceptance actually passes. Full paginated comments/reviews/threads/check sweeps, at most ten response rounds, 30-minute observation window per substantive revision. Explicitly request `otReviewAgent` if automation does not. Revalidate affected checks after fixes; do not merge.

## Risks and review

Medium risk: the optimization changes cache/authority fencing. Self-review (not independent) requires that the graph descriptor comes from the exact query plan, real key writes remain fenced, indeterminate outcomes retain graph-scoped uncertainty, and no underlying wrapper is bypassed. Remote reviewer provides independent implementation review. No schema migration. Rollback restores conservative invalidation and reads existing data unchanged. Never suppress persistence or replay an uncertain update.

## Resource ledger and progress

| Resource | Owner/purpose | Cleanup condition |
| --- | --- | --- |
| Existing managed checkout | This chat, implementation/PR | Retain for review |
| `.tmp/3252/` | This chat, isolated home and raw evidence | Stop owned processes, reconcile jobs/transactions, release matching claim; preserve compact evidence |
| `/tmp/dkg-4582-*.log` | This chat, build/test logs | Retain relevant evidence through review |

Initial checkpoint (before implementation): native Node 22.23.3 arm64, pinned pnpm install, runtime build and SQLite construction passed on the unchanged base. No wallets were claimed at that point.

## Implementation and validation update

C1–C3 complete. Failing-before evidence: unchanged cleanup advances the unrelated recipient revision from 0 to 1. The composed writer now retains unrelated proofs and keeps real key/uncertain-write fences. The real two-wallet runtime test invokes each publisher's retirement path with the identical configured writer.

Executed: 78 publisher cleanup/retirement cases; 188 agent cases across cleanup, recipient-fence and queued-finalization suites (187 before adding the repeated-arm case); 36 existing lifecycle/timestamp writer cases; 11 CLI runtime/recovery cases. Twelve new cleanup cases pass on embedded Oxigraph and an isolated real Blazegraph server. Repeated control/candidate/candidate/control arms, each with eight warm unrelated projections and four cleanup calls, yield **192 / 0 / 0 / 192** projection reads on both backends. These are controlled cache-read counts, not chain throughput or client latency measurements.

Native runtime build/types, lint, source-size guard and test inventory pass. Source budgets are lowered only for the two changed files whose nearby comments were condensed; unrelated baseline changes from the generator were discarded.

Initial C4 checkpoint (superseded below): the attempted claim acquired nothing. Both prepared batches are held by other active tasks. No wallet files were copied, no live daemon launched and no testnet transactions sent. User was asked whether another pool exists; otherwise retry ownership after other work. This is a live-validation prerequisite, not a product failure.

Owned `dkg-3252-blazegraph` container (`127.0.0.1:19452`, pinned image digest recorded in report) supplies disposable isolated test namespaces. Tests dispose their namespaces; stop/remove this container after validation/review. An accidentally selected CLI default test config started a local Hardhat fixture; its owned process tree was stopped and the intended unit config rerun successfully. No real keys or network transactions were involved.

## Scope refinement — default publication path

Further configuration inspection found `gc.finalizedCleanupEnabled` defaults to false. The first change therefore applies only when snapshot retirement is enabled; the issue does not establish that setting on the reported host. Do not present it as the established incident cause.

The default path also unnecessarily discards the active CG projection: the existing composed lifecycle writer reports exact subject/predicate removals, but `invalidateGraph` invalidates its whole CG for every removal. Required VM stamps and `swmShareComplete` removal have non-projection predicates. Extend the same cache-preservation PR to retain a projection only when a removal names a safe non-CG subject and a safe predicate outside both projection-record and recipient-authority predicate sets. Keep whole-graph/whole-subject removal, unsafe terms, exact CG subject (any predicate, because absence proofs read any fact), policy/roster/delegation/subgraph predicates, and generic UPDATE conservative. No mutation is skipped.

Pre-implementation self-review caught why subject-only filtering is unsafe: delegation reads can select any subject, and absence proofs inspect any predicate on the exact CG subject. The proposed predicate-and-subject proof preserves both. Add failing-before actual lifecycle writer/marker-clear checks, real authority change negatives, unknown-term negatives, uncertain outcome and both backend coverage. Reassess PR size as one cohesive cache-invalidation fix. Live validation was still required and batch-blocked at this design checkpoint.

## Final validation and plan reconciliation

Both cache-preservation paths are implemented. The default-path extension passes 15 new cases on Oxigraph and Blazegraph, including real marker removal, CG-subject absence proofs, delegation/roster changes and uncertain writes. The combined focused agent run passes 257 cases. Both unchanged-base regressions failed before their fixes.

Batch 1 subsequently became available and was claimed before credential use. C4 completed as a bounded live Base Sepolia campaign at runtime commit `63a3342fcb99323a31262ee61429d7a2acbf94b7`: six publications with finalized cleanup enabled, then six with it disabled after a restart. Each finalized without retries, with successful receipts, required lifecycle stamps and exact RDF readback. See the report for receipt links, scope and cleanup status.

Measurement refinement: repeated matched control/candidate experiments were executed against both real store backends in the targeted harness, rather than alternating implementations inside the live daemon. The live daemon used observational wrappers to confirm actual optimized-path execution, with all outcomes recorded; no live speedup is inferred. This isolates invalidation cost without confounding it with public RPC timing. It is narrower than the original full workload acceptance and leaves #3252 open. The observed catalog status has current authority, no missing rows and matching inventory digests, but differing head digests/row counts; broad catalog convergence remains unproven.

The final change remains one cohesive cache-invalidation fix. Approximately 500 authored code/test lines plus plan/report evidence cover two related publication paths, shared construction and real-store correctness tests. C5: PR #3397 targets testnet-canary; first revision received a completed no-issues remote review. The substantive default-path extension receives a fresh request and bounded observation window. No merge is authorized.
