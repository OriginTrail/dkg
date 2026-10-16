# Durable synchronous share recovery — #2963

## Executive summary and status

The synchronous share path can commit sealed content and lose its lifecycle/catalog tail without a durable retry owner. Manual replay validates and resumes the immutable operation, but neither the HTTP error nor restart creates a worker obligation. Establish a live baseline on the optimized publisher before changing production code, then add durable ownership of this narrowly validated recovery path. The principal risk is replaying a different asset version, bypassing authority, or repeating uncertain side effects.

Status: controlled baseline preserved; implementation and local regressions underway. Single implementation owner: this chat. Independent remote review is required before completion; initial plan review uses separate self-review passes.

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

## Design review before implementation

The chosen queue binding must include the canonical author-seal digest **and the full immutable operation intent** (operation ID, timestamp, publisher peer, confirmation requirement, access policy and allowed peers). Pinning only the seal would leave a gap if the intent write were interrupted or later absent: a retry could recreate the same operation ID with a different envelope. Admission reads any existing intent under the publisher lifecycle lock; otherwise it constructs the exact future intent. Publisher replay checks the binding under that same lock, rejects mismatched/corrupt intent or seal, and uses the pinned intent on the first write. It never replaces a conflicting claim. Author sealing occurs before admission and is not repeated by the bound worker. Known completed-VM no-ops retain their existing behavior after identity validation.

The queue will atomically admit and lease the inline attempt, so the supervisor cannot win between enqueue and the synchronous call. Version 4 bound records alone permit expired started attempts to re-enter the validated immutable operation; version 2/3 and unbound records retain current ambiguity rules. Storage-lane compatibility must remain pinned to its actual introduction in version 3, rather than comparing against a newly bumped current version. Unknown future formats and malformed bindings must fail closed. Retryable bound obligations remain durable beyond the ordinary attempt cap, with the existing capped backoff; permanent integrity/authority refusals remain visible and are not converted to transient successes. Cancellation/clear must not erase an unfinished bound obligation. Downgrading while these records remain is unsupported and must be documented.

Catalog ownership transfers only after a successful/existing inventory CAS under current authority. The existing projection supervisor seeds work for selected local-author scopes on startup and reads the durable inventory. A bound share therefore need not wait for an entire signed catalog, but cannot acknowledge completion while only a detached observer owns its inventory row. Inactive legacy lanes and already confirmed public VM rows need explicit treatment; authority transition/read failure and failed inventory writes retain the obligation. Policy mismatch must fail closed.

Implementation modules planned: a publisher binding helper, queue types/parser/admission/recovery policy, an extracted agent promotion helper, strict bound inventory handoff, an inline daemon attempt helper using the existing worker runner, the two synchronous route call sites, worker option propagation, and lifecycle documentation. Keep the existing publisher failure-disposition union intact; bound queue policy owns immediate post-commit requeue. Test with the actual queue and worker runner, including durable readback into new instances, stale claim rejection, current-authority denial, changed seal/intent refusal, repeated outage beyond budget, pointer failure and post-success bookkeeping ambiguity. A real daemon process-exit/restart scenario supplements those tests and the main live comparison.

## Baseline attempt ledger

- Attempt 0 (`baseline`) is invalid for controlled performance comparison because readiness was bypassed. Complete request denominator: 48/48 publication admissions and finalizations, 254/256 synchronous HTTP 200 and two injected 503s. Independent RPC reconciliation: 48 successful receipts, 48 distinct hashes and wallet/nonce pairs, all ten signer pending/latest counts equal. No manual repairs. Observation stopped early with its reason recorded; final snapshot had 434 inventory rows and 393 catalog rows while projection was still draining. These are retained failure/characterization results, not a fixed-deadline performance arm.
- Owned daemon and container for attempt 0 were stopped, listeners/processes checked, and its matching claim released. A fresh claim owns `baseline2-home`; only the monotonically increasing KA-number floor was carried forward. Fresh graph subscription is persisted before startup. Baseline 2 uses the same six wallets, pinned store image/resources and unchanged production build; preparation and a fail-closed readiness controller precede measured traffic. The frozen harness includes identical 15-second descriptor observations of both injected assets for both future arms.

### Proposed ownership flow

Before:

```mermaid
sequenceDiagram
  participant HTTP
  participant Agent
  participant Publisher
  participant Store
  HTTP->>Agent: synchronous share
  Agent->>Publisher: promote sealed asset
  Publisher->>Store: commit content and operation intent
  Publisher->>Store: lifecycle / head / cleanup
  Store--xPublisher: interruption
  Agent-->>HTTP: 503; no retry owner
```

After (planned, not yet implemented):

```mermaid
sequenceDiagram
  participant HTTP
  participant Agent
  participant Queue
  participant Publisher
  participant Inventory
  participant Worker
  HTTP->>Agent: prepare unchanged sealed asset and intent binding
  HTTP->>Queue: durable admission + inline lease
  HTTP->>Agent: inline bound promote
  Agent->>Publisher: validate seal and intent under lifecycle lock
  Publisher-->>Agent: same operation committed or repaired
  Agent->>Inventory: durable authorized inventory handoff
  HTTP->>Queue: settle success
  Note over Queue,Worker: Failure or expired lease retains the bound obligation
  Worker->>Queue: claim with fresh token after backoff / expiry
  Worker->>Agent: replay original bound operation; no reseal
```

The main live protocol is frozen at baseline-2 traffic start. Preparation completed without failure; exact starting catalog/inventory both contain 180 entries. Read-only evidence reducers additionally compare every original seal predicate, exact payload graph sets, catalog identity/version/seal digests, all 48 transaction carriers, and decoded `KnowledgeAssetCreated` events. Attempt 0's 48/48 canonical chain identities and 436/436 original seals are independently verified; its readiness invalidity remains unchanged.

A further queue audit found a durability prerequisite: the legacy queue writer permits subject-scoped delete/insert fallback. Bound synchronous obligations must require atomic subject replacement for **every** state transition, otherwise a crash between that fallback's delete and insert could erase the only repair owner. Blazegraph and Oxigraph expose the required capability. Unsupported/refusing stores must fail before sharing, retaining any existing row; no fallback is allowed for bound records. Add a capability-refusal and uncertain-ack persistence regression. Ordinary unbound queue behavior is unchanged.

Security/compatibility review refinement: capture whether the accepted request owes catalog inventory alongside its recovery binding. A later authority transition, unsubscribe or kill switch must not silently discharge an already-owned catalog obligation. Deliberate legacy and named-subgraph lanes keep their existing behavior. Persist the resolved curator-confirmation requirement so a changed daemon default after restart cannot weaken it. Bound recovery skips re-signing; original storage-lane casing, author attestation and nonce allocation stay pinned. The additional inline admission API should be an optional queue capability so custom legacy queue implementations remain type-compatible; unsupported capability fails before SWM mutation.

## Baseline closure and implementation progress

Controlled baseline2 completed on unchanged production revision 9436b5c927f9fc8e5eb0cd5523da785dfa1cdd75 before production edits. At the fixed deadline, 48/48 publications finalized and 254/256 synchronous requests succeeded; both injected partial commits remained incomplete (0/2 automatic recovery, zero manual repairs). Exact catalog/inventory count 434/436, descriptor count 434/436. All 436 seals and 48 chain identities preserved; all 98 signer transactions reconciled without nonce gaps. Same-runtime restart retained the incomplete state. Owned daemon and store stopped and matching claim released before candidate acquisition.

Implemented the version-4 bound queue design, atomic inline admission, pinned seal/intent validation, started-lease reclaim, continued transient/post-commit retry beyond the normal cap, protected unfinished obligations, original-author worker propagation and synchronous/one-shot route integration. The catalog handoff now awaits the validated inventory CAS for bound obligations; detached observation remains the legacy path. Worker-disabled synchronous admission fails before sharing with an explicit 503 rather than promising an absent recovery owner. Permanent integrity failures remain visible; they cannot be cleared or cancelled as completed obligations. Candidate live run and remote review are still required. No merge authorized.
