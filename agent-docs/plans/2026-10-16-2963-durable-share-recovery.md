# Durable synchronous share recovery — #2963

## Executive summary and status

The synchronous share path can commit sealed content and lose its lifecycle/catalog tail without a durable retry owner. Manual replay validates and resumes the immutable operation, but neither the HTTP error nor restart creates a worker obligation. Establish a live baseline on the optimized publisher before changing production code, then add durable ownership of this narrowly validated recovery path. The principal risk is replaying a different asset version, bypassing authority, or repeating uncertain side effects.

Status: discovery and baseline preparation; no recovery implementation yet. Single implementation owner: this chat. Independent remote review is required before completion; initial plan review uses separate self-review passes.

## Sources and branch

- [Issue and acceptance criteria](https://github.com/OriginTrail/dkg/issues/2963).
- [Live partial commit and manual recovery](https://github.com/OriginTrail/dkg/issues/2963#issuecomment-6217273362): original failing store call unknown. Missing lifecycle state is consistent with delete/insert interruption, not proof of that exact original call.
- [Related investigation](https://github.com/OriginTrail/dkg/issues/3252).
- [Performance PR](https://github.com/OriginTrail/dkg/pull/3253) remains open, head `9436b5c927f9fc8e5eb0cd5523da785dfa1cdd75`; target `codex/3252-async-publisher-performance`. Our branch is `codex/2963-durable-share-recovery`. Recheck before PR creation and retarget to `testnet-canary` after parent merge. Never merge either PR.
- Baseline includes diagnosticCode, requeued retryable flags, clear protection and post-commit 503 mapping already. Verify rather than duplicate them.

## Inspected architecture and causal chain

`knowledge-assets.ts` calls `agent.assertion.promote` directly for synchronous shares (including one-shot create). Agent sealing and authority/recipient checks precede `publisher.assertionPromote`; the publisher owns an immutable operation intent and exact graph replay validation. `assertion-promote-finalization.ts` performs separate lifecycle delete/insert, snapshot/head writes, WM cleanup and completion marking. Agent pointer/observer work follows. Async jobs have a persistent queue and recovery sweep; synchronous calls do not.

Root cause proven by source/evidence: no durable synchronous retry owner. Original exact store-call failure remains unknown. Deterministic injection must label its selected boundary and must not be presented as reconstructing the original call.

## Approach and decisions to resolve before implementation

1. Prefer reusing existing durable operation and queue ownership, with immutable coordinate/version/operation binding and real worker recovery. Record ownership before any share mutation; recording only in a catch misses process death and store outages.
2. Do not blindly enqueue arbitrary failed HTTP mutations. Recovery must validate the original seal, exact content and operation, retain original author/access/curator intent, recheck current authority, and refuse corrupt or superseded identities.
3. A durable dedicated recovery outbox is an alternative if the existing queue cannot represent inline ownership safely. Compare lease takeover, crash ambiguity, cleanup/cancel races, and compatibility before selecting the final design.
4. Atomic lifecycle metadata replacement alone reduces one boundary but does not recover pointer/catalog failures or process death; insufficient as the sole fix.
5. Keep the normal synchronous API success contract. Failure responses must state whether automatic recovery is durably owned, expose a safe observation handle, and explain temporary descriptor absence and zero newly promoted content on replay. Never promise recovery if admission failed.
6. Keep #3253's performance scope unchanged. No publisher transaction retry, nonce reset, authority relaxation or arbitrary write fallback.

## Execution chunks

| Chunk | Work and files | Dependency / completion evidence |
|---|---|---|
| C1 | Establish native macOS runtime, pinned Blazegraph, isolated home, owned wallet batch; preserve source evidence and environment manifest | Before production edits; SQLite actual open, CLI help, chain bindings, funds, nonce/ownership checks |
| C2 | Build reproducible live harness and deterministic partial-commit injection; baseline from exact parent head | C1; preserve all HTTP outcomes, jobs, RDF/intent snapshots and fixed deadlines before implementation |
| C3 | Finalize design around agent promote, publisher intent, queue and daemon worker; review authority and crash schedules | C2; update this plan with exact ownership/compatibility decision and concrete modules |
| C4 | Implement durable synchronous recovery and retain existing acceptance contracts; lifecycle docs | C3; focused source tests plus real queue/worker/restart checks |
| C5 | Candidate live runs in fresh home/namespace under identical resources/workload/deadlines and identical faults | C4; full denominator comparison, exact content and identity proof, nonce and transaction reconciliation |
| C6 | Sanitized report, coherent stacked PR, complete remote review sweeps and fixes | C5; current-head checks/review completion, all comments addressed, unresolved gaps explicit |

## Baseline/candidate protocol

Native macOS arm64, Node 22.23.3, pnpm 10.28.1. Pinned repository Blazegraph image (multi-architecture), Docker store limited to 4 CPUs / 4 GiB, actual JVM maximum heap 1 GiB (verified by `jcmd VM.flags`; image ignores `JAVA_OPTS`); native daemon heap limit 4 GiB. Host scheduling is not CPU-isolated: record this limitation identically for both arms. Six publishers from one exclusively claimed prepared batch, sequential arms, separate fresh homes/namespaces and context graphs. Immutable source bundles, authenticated API and checkout-pinned auto-update disabled. Never alter another owner's home or claim. Carry only the monotonic author-number allocator high-water mark between homes so unpublished sealed identities cannot be reused; do not copy content, catalog state or jobs.

Target workload: 180 initial catalog identities, 48 prepared publication assets, 256 concurrent synchronous catalog shares (8 triples each), private registered context graph, six funded publishers. Preserve setup failures separately. Use a readiness barrier before timing; freeze actual concurrency/pacing and publication observation deadline in the harness before baseline. Fixed catalog drain: 20 minutes after submission traffic ends, no extension to turn a failed run into a pass. Record all 256 requests including timeout/503/unknown outcomes and all 48 publication jobs including failures/incompletes. Do not silently repair setup or timed failures.

Run natural workload and separately labelled identical deterministic faults in both arms at lifecycle insertion after deletion, pointer maintenance and restart after content commit. At least one real process restart with persisted state is required. Neither a successful candidate without a matching fault nor unit tests establishes recovery.

Measure HTTP and durable-admission clocks separately, publication p50/p90 and full-cohort makespan (no full-cohort throughput if incomplete), recovery time from fault to verified completion, descriptors, lifecycle state/head/completion, exact expected inventory/catalog identity sets and convergence time. Compare canonical RDF/root, seal, operation envelope, version, WM cleanup, transaction carriers, receipts and all used signer pending/latest nonces. Manual repair is a separate result and never automatic success.

## Failure handling, compatibility and review

- Establish original operation identity before replay; ambiguous/corrupt/superseded state fails closed and remains observable.
- Persistent dependency failure retains a durable obligation with bounded backoff and explicit exhaustion policy; restart must not discard it.
- Queue ownership and lifecycle locks must serialize inline execution against recovery, manual replay and competing writes; stale claims cannot settle another owner's attempt.
- Preserve old queue records/API consumers with additive fields and version-gated recovery. Old binaries may not understand new recovery records: document downgrade limits and retain data.
- Catalog completion requires current accepted authority and exact coverage, not a success count or row count. Observer admission and convergence must be verified against real backend behavior.
- Stop owned submissions/writers, reconcile jobs/transactions, compare pending/latest nonces, stop owned daemon/store, then release matching wallet claim. Retain claim on ambiguous signing activity. Preserve failures before cleanup.
- Self-review lenses before implementation: design (durable owner precedes mutation), security (author/current authority), validation (both arms faulted), operations (crash/takeover), compatibility (old rows/downgrade). Remote review follows PR driver, up to 10 response rounds with bounded 30-minute observation windows; pending human approval remains a gap.

## Current ledger

- C1 complete: runtime build, CLI help and actual SQLite open passed. Acquired batch-1, six funded publishers, all ten signers initially pending=latest. Base Sepolia 84532; Hub/token bindings captured. API 9296 authenticated (200 with native token / 401 without). Pinned Blazegraph on 9996. Source bundles untouched. Ownership record `.tmp/2963/evidence/batch-claim.json` must remain private/local.
- C2: first attempt prepared 180 exact catalog/inventory identities and 256 sealed drafts without preparation failure. Readiness restart lost the benchmark graph from runtime subscription selection; a shell without `set -e` continued after the failed readiness assertion and started traffic. Marked **invalid for controlled performance comparison**, retaining full workload/fault evidence and no manual repairs. Harness now checks readiness internally before measured mutations. Repeat with fresh namespace/home and graph persisted in config after reconciling this attempt. No recovery production code changed.
- Baseline regression: 44 cases passed across real worker/queue and routes using CLI unit config. Initial default-config invocation unnecessarily started Hardhat setup and was stopped; its log retained. Recreated modern-allocator lifecycle deletion/insertion characterization passes 2 cases (typed not-started and untyped); explicit manual replay preserves identity/content and repairs descriptor. These are characterization, not automatic success.
- C3 design refinement: synchronous route retains inline execution. Prepare/seal through existing agent semantics, capture an exact seal fingerprint through a publisher helper, then atomically enqueue-and-claim a version-gated recovery request. Run the existing worker attempt runner inline with the original request options; ordinary supervisor owns subsequent attempts. Publisher checks the pinned seal under its lifecycle lock before any mutation; recovery skips resealing. The existing durable intent is authoritative for operation ID/timestamp/policy; absent intent is permitted only on the unchanged sealed first-attempt path that has never claimed an operation. Re-run current authority and curator checks. Crash reclaim is enabled only for this explicit bound request format; legacy ambiguous jobs remain fail-closed. Cover standalone share and one-shot create. Require durable inventory handoff before success for bound requests, leaving catalog projection itself asynchronous. Do not clear/cancel a bound obligation that may have committed content. Remaining design checks: exact failure budget behavior, source-file size extraction, callback API/export compatibility, and strict observer handling of inactive versus temporarily unresolved authority.
- C3–C6 implementation/validation/review remain pending. Next action: preserve first attempt outcomes, reconcile transactions, prepare fresh matched baseline with fail-closed readiness, then close baseline before production edits.
