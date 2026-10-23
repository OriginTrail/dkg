# PR #3405 performance rereview and #3406 rebase

Status: in progress. Primary owner only; distinct durability and regression self-review before publication. This scoped continuation supplements the lifecycle plan on #3406 without copying its history into the foundation PR.

## Outcome and evidence

User requests validation/addressing of lupuszr's latest foundation feedback, then rebasing #3406. Review5625589390 on214cd54df confirms prior correctness fixes and no demonstrated new correctness failure. Fresh/mixed throughput remains below the proposed80% of base budget (171.56/744.92 and729.85/2502.07 writes/s); neither that objection nor human scope/design acceptance is resolved. Retain existing healthy managed-Oxigraph ACK compatibility, supported-backend barriers and no fork. No merge/deployment authorized. The user-requested dependent rebase requires an exact-old-head lease when publishing rewritten history.

Native Node22.23.3 local160-write fresh probe on214:211.12 writes/s. I/O instrumentation counts173 writer syncs (996.67ms summed concurrent),174 blob-directory syncs (825.18ms),176 realpath calls (170.76ms),355 opens (610.30ms). These are a short diagnostic, not comparable three-pair acceptance data. Latest base has advanced to f9b5f2524; inspect/reconcile its relevant changes while updating the stack.

## Selected bounded experiment

Keep each blob's own writable-handle write+sync and fresh-owner verification/retry. After its writer sync and close, admit its path to an owner-local directory-barrier batch. Snapshot admitted paths before dispatch; later arrivals form a subsequent batch and must never borrow an in-flight sync. Resolve each actual file target and traversed alias before deduplicating directory/ancestor syncs. All members wait for every directory in their batch; any failure rejects them all, caches no success, and ordinary retry rewrites bytes and performs the barriers again. One active batch bounds directory work, with no global mutation lock or ordinary read capacity held. Existing four physical blob-preparation slots and owner shutdown/drain stay intact.

Alternative: only document the measured cost and request owner budget acceptance. Remains available if batching is ineffective; do not ship extra durability protocol complexity without a demonstrated benefit. Dropping required syncs or certifying later arrivals using an earlier batch is rejected. A packed-blob format or changed default guarantee is outside this feedback batch.

## Work and validation

1. Add actual-I/O regressions for batching, no early RDF references, late arrivals requiring a new batch, shared directory failure/retry/reopen and existing aliases/same-writer error coverage. Demonstrate relevant checks fail without batching/with unsafe joining.
2. Implement narrow internal barrier batching; measure identical benchmark before/after in alternating runs. Keep only with material measured benefit; preserve any missed80% budget explicitly. Run full storage, affected native/backend/CLI contracts and builds/hygiene before push.
3. Incorporate current testnet-canary if necessary to keep foundation reviewable, resolve conflicts preserving upstream fixes. Rebase dependent #3406 onto final foundation, preserving its incremental changes. Verify range/tree differences; publish with exact old-head lease only after local readiness.
4. Reply with measurements and actual outcomes, refresh descriptions and review/CI for new heads. Preserve human acceptance blockers. Prior a6 live result remains historical after code changes; rerun relevant live proof before merge readiness if production behavior changes.

## Review lenses / stop conditions

Durability: group coverage starts only after each member's own file barrier; canonical and alias parent obligations survive failures; later members never share earlier coverage. Regression: small-write progress, cache eviction, bounded preparations, index/changelog ordering, close admission/drain and no new managed certificate. Keep the existing tested implementation if no useful measured improvement; do not turn a diagnostic into owner acceptance. Independent peer review is unavailable under current no-delegation instruction; use distinct self-review and current-head remote review.

## Experiment outcome and execution update

Three alternating unchanged/candidate pairs on the same native checkout,1,200 writes per fresh/mixed case,8writers/2readers,80KiB literals:12cases/14,400measuredwrites. Unchanged214 medians284.67fresh/1163.75mixed writes/s; candidate239.98/952.78 (15.7%/18.1% slower). All measured counts and read assertions passed. Directory-batch prototype is discarded completely; no production code or new barrier API from the experiment is retained. Its source/patch and logs are ignored local evidence. This compares214 to a rejected prototype, not214 against testnet-canary; host/control differences do not supersede lupuszr's results. The owner's reply asks for explanation and does not accept the performance cost. Explained that the cost belongs to our guarantee and that his request is valid; performance P1 remains open.

Foundation merged current target f9b5f2524 cleanly, retaining the stack's review history. Only review evidence and managed-backend scope wording are newly authored foundation changes. Next verify foundation, publish/reply; then perform the requested dependent rebase, inspect its exact tree/diff and test affected upstream integration. No additional durability protocol is shipping.

## Updated foundation validation

Runtime dependency closure, dependent type/package contracts and prepared CLI build pass. Full storage:1,653 passed/107files,45environment-gated skips. Selected managed/runtime CLI:54 passed/4files, including actual stock-server writes and supervised restart while commitment remains absent. Lint, disabled-test audit (zero additions), source-size ratchets and git diff checks pass. No production source from the batching experiment remains. New foundation source changes are solely inherited from target f9b5f2524; authored changes are this evidence, execution plan and corrected managed-compatibility documentation.
