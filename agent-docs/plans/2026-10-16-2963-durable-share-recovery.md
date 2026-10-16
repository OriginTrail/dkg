# Durable synchronous share recovery — #2963

## Executive summary and status

The synchronous share path can commit sealed content and lose its lifecycle/catalog tail without a durable retry owner. Manual replay validates and resumes the immutable operation, but neither the HTTP error nor restart creates a worker obligation. Establish a live baseline on the optimized publisher before changing production code, then add durable ownership of this narrowly validated recovery path. The principal risk is replaying a different asset version, bypassing authority, or repeating uncertain side effects.

Status: original baseline/candidate pair preserved (0/2 versus 2/2 automatic recoveries), and clean merged-base baseline completed (0/2). PR #3300 is in review response round 8. Candidate2 through candidate6 are explicitly preparation-only. Final matched candidate and actual process-exit/ordinary-lease recovery remain required. Single implementation owner: this chat. Independent remote review and required human approval remain outstanding.

## Sources and branch

- [Issue and acceptance criteria](https://github.com/OriginTrail/dkg/issues/2963).
- [Live partial commit and manual recovery](https://github.com/OriginTrail/dkg/issues/2963#issuecomment-6217273362): original failing store call unknown. Missing lifecycle state is consistent with delete/insert interruption, not proof of that exact original call.
- [Related investigation](https://github.com/OriginTrail/dkg/issues/3252).
- [Performance PR](https://github.com/OriginTrail/dkg/pull/3253) merged at 2026-10-16T18:08:57Z, original tested head `9436b5c927f9fc8e5eb0cd5523da785dfa1cdd75`. Our separate [PR #3300](https://github.com/OriginTrail/dkg/pull/3300), branch `codex/2963-durable-share-recovery`, was retargeted from the parent branch to `testnet-canary` and merged base `2aba84de35754e5663b52018f9781a6e6c8b948d`. Never merge either PR ourselves.
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

Run the natural workload with separately labelled identical deterministic lifecycle-insertion faults in both arms. Cover pointer maintenance through real queue/worker regressions, and supplement the matched workload with a separately reported process-crash/restart scenario after content commit. At least one real process restart with persisted state is required. Neither a successful candidate without a matching fault nor unit tests establishes recovery.

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

After (implemented):

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

### Compatibility review during the fixed candidate observation

Self-review identified a completed pre-intent SWM case that the new admission binding rejected although the existing publisher supports a non-mutating no-op. Add a read-only verification under the existing lifecycle lock, return the original operation ID without a queue job, and continue rejecting incomplete or changed pre-intent content. This is not permission to reconstruct a missing immutable intent. Verify complete/no-op, incomplete and changed-content cases through the real agent/queue entry point. The running measured candidate remains compiled at `7dfc334200bb2a716e7dc11cf25ec7a033cd9481`; source edits are not rebuilt into that live daemon. Any later runtime revision is identified separately and needs live validation before the final claim.


## Base integration adjustment — 2026-10-16 18:09 UTC

#3253 merged as 8aa7b3ab82ff8ebac3771d7898bafb69e570ea26 while review response was underway. Retarget #3300 to testnet-canary and merge its current head 2aba84de3 (do not rebase). The base also includes substantial v14 sync/storage work, so the prior 9436b5c baseline / 7dfc334 candidate comparison remains preserved but cannot isolate the recovery fix on that new runtime. Run an additional clean baseline from 2aba84de3 in a separate managed worktree before running the integrated candidate. Use the frozen 48-publication/256-share workload and identical two faults, resources, six wallets, fresh home/namespace, exact starting set and fixed deadlines. Carry only allocator floors; release/reclaim batch ownership after complete quiescence. No prior failures are removed from the report.

After the new baseline, run the integrated candidate and normal-lease actual process-exit/restart regression. Report both matched pairs separately and all exact revisions. Re-run runtime builds and affected integration regressions for the merged base. Keep the unresolved original incident call-site gap and CI/review status explicit.


## Round 3 review changes (unvalidated source, baseline 3 remains isolated)

- Serialize strict inventory preparation and CAS with the existing per-asset inventory boundary and author-lane accounting, so concurrent public VM confirmation cannot remove first and then be resurrected. A real inventory/confirmation race regression pauses after preparation.
- Reject `awaitCuratorAck: true` with `KA_PROMOTE_ACK_REQUIREMENT_CONFLICT` when an existing immutable intent did not require acknowledgement; do not rewrite the intent or silently downgrade the caller. Test the real agent/queue admission and HTTP 409 contract.
- Use one typed seal/lifecycle/operation evidence reader for ordinary and bound promotion. Operation decoding remains deferred until after stale-marker cleanup, preserving legacy no-op and typed corruption behavior. Update the two-process claim race barrier to intercept the shared evidence read.
- Classify HTTP failures into status/body/headers once, then add observation metadata at the synchronous share boundary. Preserve permanent statuses, store uncertainty, curator fields, sanitized transport errors and one-shot partial results.
- Register the Python full-graph evidence regressions in the repository test inventory; the remote build gate failed on this missing route, not on compilation.
- Strengthen the separate process-exit evidence reducer to compare exact RDF terms and cardinality, complete lifecycle/pointer and WM cleanup, and the identical daemon revision/peer across restart. No crash test has run yet.

Validation is deliberately deferred until baseline 3's fixed observation deadline (2026-10-16T18:50:43.016Z) and preserved readback. No heavy build or test may compete with that measured arm.


## Baseline 3 closure and round 3 local verification

Baseline 3's deadline readback retained exactly the two injected incomplete assets: 434/436 catalog, inventory and descriptors; zero share jobs; 0/2 automatic and zero manual recoveries. All 436 seals/full payloads, all 48 publication identities/carriers and the complete 98-transaction nonce interval passed. Daemon and container stopped; matching claim released after reconciliation. A fresh candidate2 claim owns a new home/namespace and the same six wallets; only the monotonic author allocator floor was carried forward.

The third-round source fixes passed full runtime build, 257 HTTP/worker tests, nine agent tests, 105 publisher lifecycle tests, 153 queue/intent/replay tests, 74 actual-daemon tests, four Python evidence tests, test inventory, lint and file-size checks. One stale parser reference failed the initial build and was corrected to use the shared literal decoder. Next: push this substantive review round, freeze a clean build, complete the matched candidate and the normal-lease process-exit/restart proof, then drive current-head remote review. Restart findings remain open until real evidence exists.


## Round 4 execution plan

Fresh review on `6fc212c92` found a real temporary-authority retry gap, terminal-owner conflicts misreported as pending, and incomplete restart catalog/inventory identity verification. It also requested explicit bound-request and recovery-observation contracts. No candidate2 measured traffic has begun. Preserve its preparation-only attempt and natural startup recovery, then use a fresh final candidate after these fixes; never discard or repair its failures to manufacture a result.

1. Add a typed catalog-authority readiness error at the exact missing service/accepted-policy decisions. The durable inventory adapter may wrap those known temporary causes as retryable, while missing deployment configuration, policy mismatch and integrity failures remain permanent. Exercise real queue/worker completion when accepted policy arrives.
2. Model ordinary and bound promote requests as distinct union members. A bound request requires `entities: all`, storage lane and immutable binding; narrow inline admission and returned job. Centralize boundary validation and policy narrowing, retaining wire format 4, unknown-format refusal and legacy queue behavior.
3. Replace exception mutation with a typed recovery failure envelope containing original cause and an explicit observation state. Derive existing-owner state from the actual persisted job; terminal owners require inspection, unknown reads must not promise scheduled recovery. Construct status URLs only at the HTTP boundary; classify the cause once and preserve permanent statuses, transient headers, uncertain admission and one-shot partial responses.
4. Extract a pure restart identity verifier. Derive expected catalog/inventory tuples from the immutable crash seal plus the 436 preserved main-run seals; reject wrong IDs, versions, digests, duplicates, missing or unexpected entries. Add negative verifier tests and retain real process-exit/restart execution as required evidence.
5. Run build/type/export checks, targeted real inventory/worker and HTTP regressions, publisher queue/intent/lifecycle suites and actual-daemon integration. Preserve failed attempts, rerun current-head CI/review, then run the fresh six-wallet matched candidate and normal 15-minute-lease crash recovery. Final review convergence remains required; no merge.

Round-4 CI diagnosis: current-head CLI and browser tests exposed an effective-acknowledgement regression: self-curator requests explicitly ask for acknowledgement but correctly produce no remote confirmation callback. Compare the admitted immutable requirement against the effective current callback requirement, not the raw API boolean. Preserve rejection when a remote callback would strengthen a previously unconfirmed operation; preserve required=true on replay. A route fixture also needs to assert the newly added inspection metadata without losing its original 409 fields. CI agent shard cancellation and consequential coverage/gate failure remain recorded separately.

Round-4 implementation and targeted verification completed: explicit request variants and typed admission/observation envelope; terminal conflict readback; typed catalog service/policy readiness; exact all-row restart identity tuple verifier plus 15 negative/positive checks; effective acknowledgement self-curator regression fixed. 75 real-daemon tests passed. Candidate2 preparation is preserved, stopped and reconciled (0 measured jobs, 2 setup transactions, 180 successful share owners); claim handed to isolated candidate3 after ownership-safe release. Next: clean committed runtime, candidate3 six-wallet comparison with fixed deadlines, actual process exit and ordinary-lease recovery, sanitized proof export and remaining remote review. No merge authorization.

### Round 5: final ownership gaps (execution plan)

New review on 9180f2222 found that a bound VM no-op can acknowledge success without durable private placement ownership, and legacy message-based classification can turn permanent curator rejection into unlimited retry based on a graph name. The final candidate3 preparation is therefore preserved without measured traffic; finish its in-flight preparation, read back all owners, reconcile its two setup transactions, stop owned writers and retain/release the claim only when quiescent. Do not build while its daemon is active.

1. Make terminal typed curator rejection precede text classification. Bound recovery must not gain unlimited retry from arbitrary diagnostic prose; retain legacy unbound compatibility and typed store/producer retry dispositions. Verify keyword-bearing graph IDs over real HTTP and real queue execution, and curator non-confirmation remains retryable.
2. Keep SWM pointer stamping conditional on promotedAllRoots. For an inventory-required binding whose verified publisher replay is already VM, independently verify the exact original seal and confirmed version, then establish the appropriate durable catalog handoff: private finalized placement repair ownership or public inventory removal. Temporary missing authority/persistence retains the bound owner; permanent policy/seal conflicts fail closed. Never issue a chain transaction or stamp an SWM pointer for this VM no-op. Reuse existing authority and placement APIs but do not accept their best-effort/inactive-lane success as proof of a durable obligation.
3. Add the failure sequence regression: original SWM share/inventory failure, VM confirmation whose repair admission fails, fresh agent/queue state from persisted storage, automatic bound recovery, one correct placement owner/catalog tuple and unchanged VM/chain effect. Also retain public VM no-op and policy/integrity refusal cases.
4. Change admission-failure tests to call durableSynchronousShare with a live recovery worker flag, observing typed admission uncertainty, no inline promote invocation, unchanged WM and absent SWM. Retain refusal/lost-ack queue persistence checks and eventual lease recovery.
5. Make the shared attempt runner return a typed generic promotion result or original cause alongside its bookkeeping outcome; inline HTTP consumes that result directly. Test success, retryable/terminal failure, failure-bookkeeping uncertainty and success-bookkeeping uncertainty without weakening fencing.
6. Expose the canonical intent object validation boundary; parse JSON only at persisted-text boundaries. Separate non-allocating validity checks from immutable snapshot construction, preserving canonical peer validation and copied frozen collections. Run malformed intent, bound queue, replay and type regressions.
7. Build and validate relevant agent/publisher/CLI suites, actual daemon cases, lint and source budgets. Push one cohesive round-5 batch, answer findings with evidence, and use a new isolated candidate for the fixed six-wallet comparison. Then execute the actual process-exit/ordinary-lease restart proof and publish reviewer-safe full-denominator evidence. No merges.

### Review response round 6

- Preserve candidate4 as preparation-only before measured submissions; retain its natural startup failure/readback/recovery and finish or reconcile preparation before wallet handoff.
- Emit a typed transport-failure disposition only from syntactically read-only store queries. Recognize actual fetch/socket failure identities, keep malformed responses/integrity and arbitrary mutation errors terminal, and test an original bound partial commit recovering after a one-time replay read reset.
- Preserve typed inventory input/history/signature/corruption failures before the replay-safe CAS recovery wrapper. Exercise a real invalid predecessor signature, alongside failed and unacknowledged CAS regressions.
- Replace confirmation's strict-mode branches with one throwing ownership-transfer core and explicit outcomes. Legacy observation logs/translates errors; durable completion consumes phase-specific errors. Public removal must use a throwing boundary, preserving authority checks and asset/scope ordering. Durable private marker precedes best-effort notification.
- Validate these boundaries and the existing legacy observer contracts, build/lint, push one coherent revision, then start a fresh comparable candidate and actual crash/restart test. Do not count preparation-only runs toward the measured acceptance evidence.

### Round 7 refinement

Preserve the legacy public-only authoring exclusion using accepted policy, never request-supplied policy; reject ambiguous fallback admission before SWM mutation. Bind strict handoff parameters to the original recovery binding alone. Keep the throwing confirmed-removal result separate from observer accounting and preserve upstream typed SPARQL HTTP contracts. Candidate5 remains preparation-only with exact starting-state and nonce reconciliation evidence. The next clean candidate must still complete the frozen six-wallet comparison and process-exit regression. The existing foreground supervisor automatically respawns an exited worker; observe its actual PID replacement and normal 15-minute lease recovery without manually restarting or replaying HTTP.

### Round 8 refinement

Use a typed queue cancellation conflict and preserve ordinary cancellation. Consolidate deliberate catalog exclusions into one applicability decision, leaving runtime readiness in lane resolution. Classify each one-shot share failure once into response, recovery observation and continuation disposition; preserve terminal 207 accumulation and VM continuation. Proven typed read transport failures must retain bound retry ownership even when upstream diagnostic prose resembles a payload limit. Validate real queue HTTP cancellation, all partial-response states, mixed-policy/native catalog behavior and actual daemon routes. Preserve candidate6 preparation evidence, then use a fresh isolated clean revision for the unchanged measured workload and automatic supervisor restart proof.

### Round 9 execution plan

1. Preserve candidate7 preparation before traffic, reconcile it and hand off only after quiescence. Treat draft reopening while inventory recovery is pending as a correctness defect, not an operator-repair case. Extend the existing publisher lifecycle mutation guard to inspect durable bound owners, including terminal inspection holds. Serialize validated bound admission with that same lifecycle lock so reopening cannot race between preparation and owner persistence. Retain strict original seal/intent checks, ordinary async behavior, author-lane isolation and reopening after successful ownership transfer. Test real queue/agent inventory failure, attempted reopen, worker completion and subsequent reopen, plus admission/reopen ordering.
2. Represent inventory persistence provenance at the canonical read/CAS boundary. Keep signature/history/input verification outside the persistence error wrapper, preserve uncertain CAS recovery and conflict retry bounds, and let promotion consume the domain distinction rather than producer/database error-code lists. Preserve legacy observer cause/accounting behavior and run real invalid-signature and lost-ack persistence regressions.
3. Make restart observations carry request-start and response-completion timestamps. Only completed observations within the fixed cutoff may establish deadline success. Test delayed successful responses across the cutoff deterministically.
4. Use the existing identity-tuple normalizer/verifier for starting-set and final comparisons; export precomputed results rather than reimplementing comparison in Python. Preserve exact baseline missing identities, artifact fields and full denominators. Regenerate completed-arm artifacts and compare them.
5. Validate targeted and actual-daemon regressions, runtime build/types, lint/size and coverage, then push this coherent response. Complete the fresh six-wallet candidate and actual supervisor process-exit proof before replying to the remaining restart evidence findings. Record unresolved gaps and never merge.
