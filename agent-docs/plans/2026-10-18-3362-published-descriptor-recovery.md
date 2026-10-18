# Published descriptor recovery — #3362

Status: Implementation and local regression checks complete; remote review and live campaign pending. Base: `testnet-canary` at `f3b33cffb`; branch: `codex/3362-descriptor-recovery`. Single implementation owner. High risk: confirmed blockchain publications and local identity metadata. Authorized: implementation, PR and review replies, isolated live testnet validation. No merge.

## Outcome and evidence

Restore descriptor availability without publishing again, inventing an assertion version, weakening GET validation, or overwriting a newer draft. Both original-name and graph-UAL reads must retain the exact author, KA number, UAL and confirmed root after cleanup/restart.

[Issue #3362](https://github.com/OriginTrail/dkg/issues/3362) reports one missing descriptor among 45 confirmed assets on v10.0.24/Gnosis, despite exact receipt-scoped VM content and chain ownership. The original evidence was recovered from our SCAN dev harness chat and deployment artifacts. Read-only diagnostics on the original Blazegraph node confirm the affected record retains all 14 other lifecycle fields but lacks `state`; the sibling descriptor resolves. At 12:45:09Z, the original job encountered `Store scheduler queue wait timeout (normal: blazegraph.insert)` during recovery. At 12:48:33Z, the same job skipped lifecycle stamping as a mismatch. The terminal job has since been cleared. The incident mechanism is confirmed; the SCAN node was not modified.

Code evidence: v10.0.24's `applyPublishedNamedKaVmLifecycle` deletes and inserts required fields separately. Failure after deleting `state` makes `assertion.history()` return null. `_canStampRecoveredKnowledgeAssetVmLifecycle` returns false on null; recovery then logs a mismatch, skips the lifecycle stamp, and can finalize the job. This can strand the descriptor permanently. Current canary batches the normal writer atomically, but its compatibility fallback and the direct publish tail still perform separate writes; already damaged records also remain unrepaired. Terminal queue cleanup only removes queue records; exact SWM cleanup does not intentionally remove named lifecycle state.

## Design and alternatives

Do not infer descriptor state from readable VM content on GET: that conflates user data with trusted publication identity. Do not retry publication: chain success is irreversible and already established. Reuse the existing canonical transaction recovery and bounded queue scheduling, repairing only metadata whose retained identity and immutable queued request agree with the confirmed transaction. Inspect raw lifecycle facts independently of the missing descriptor field; reject conflicting/multivalued identity and case-equivalent duplicate subjects. Preserve newer local roots/versions and existing supersession behavior. Keep incomplete required repair owned by the original transaction-bearing job.

Already-cleared jobs require a targeted operator repair endpoint. It defaults to verification only and completes the confirmed VM projection, after validating compatible surviving fields, exact content commitment, canonical/final receipt, chain author/version and graph binding through existing proof resolvers. It refuses newer drafts, duplicates, conflicts and missing proof. A shared lifecycle lock serializes validation and writing; one active repair per store and a 30-second deadline bound lock acquisition and reads. Entered writes are awaited; expired queued/read-only work cannot mutate and retains backpressure until settled. This is part of the same fix because automatic queue recovery cannot repair the reported asset after its job was cleared.

## Work and verification

1. Reproduce with the real ordered lifecycle writer failing its state insertion, real descriptor resolution, and queue recovery against controlled canonical chain evidence. Prove exact VM remains and the queue can incorrectly finalize. Compare against v10.0.24 behavior; distinguish mechanism from unverified incident trigger.
2. Implement strict recovery identity resolution, retaining read contracts and matching the actual stored author spelling. Cover missing state, conflicting identities, duplicate subjects, newer drafts/versions, repeated transient faults, restart, and terminal cleanup. Use existing bounded retry ownership rather than a new polling loop.
3. Provide a safe targeted recovery procedure for retained evidence; validate refusal when evidence is absent/ambiguous. Inspect direct-publish behavior and justify whether it is within this cohesive fix or a documented follow-up to #2962.
4. Run focused agent/publisher/CLI tests and runtime build. Review security, concurrency and recovery separately before submission. Remote reviewer provides independent implementation review; local plan review is self-review only. Target roughly 500 authored code/test lines; review scope if approaching 1,000.
5. Open PR into `testnet-canary`, attach it, collect all paginated review comments/threads/checks. Track up to 10 response rounds and a 30-minute observation window per substantive revision. No auto-merge.
6. Plan and execute an isolated funded testnet run under the dkg-testnet skill: claim batch, verify chain/Hub/token/balances, multiple named assets and updates, every descriptor by both identifiers, exact receipt-scoped VM content/root/chain proof, sibling controls, injected metadata failure, restart and terminal-job cleanup. Check all transaction/job outcomes, stop owned writers, release only after reconciliation. Record chain/backend limitations (prepared pool was previously Base Sepolia; reported incident was Gnosis).

## Risk review and recovery

- Identity is not established by name alone: exact reserved KA and attributed author must agree; casing aliases must not produce a second lifecycle.
- A missing row is not proof that a newer draft does not exist. Repair must use retained identity/version/pointer evidence and serialize with lifecycle writers, or explicitly refuse insufficient evidence.
- A failed/indeterminate write must retain durable recovery ownership. Never abandon a mutation while another retry starts.
- Downgrading binaries cannot undo confirmed transactions. Metadata repair must be idempotent and compatible; stop on any root/identity regression and preserve evidence rather than republishing.
- Keep keys, tokens and raw operational evidence out of the PR. Preserve previous task artifacts and unrelated running containers.

## Execution ledger

- Base verified: #3358 merged, latest canary `f3b33cffb`.
- New managed worktree created; prior task's uncommitted reports preserved.
- Dependency installation, runtime package build, updated agent and CLI builds passed.
- Failing-before regression: actual ordered writer removes state; original recovery finalizes the job while both descriptor lookups remain null. Candidate repairs it; a second store failure retains the same broadcast job.
- 138 agent tests (six suites) and 95 CLI tests (two suites) passed, including lifecycle, recovery, memory layers, operator proof/refusal and admin isolation. Chain evidence is controlled in the focused fault tests; live chain proof remains required.
- Prepared Base Sepolia batch-1 claimed; balances and all pending/latest nonce baselines verified. Live plan saved under ignored `.scratch/3362/live-plan.md`.
- Review rounds: 0/10; PR not yet opened.

### Live validation correction

PR #3365 opened at `71605cd6c`; otReviewAgent explicitly requested via REST (CLI reviewer editing required an unavailable organization-read scope). Initial checks have no failures; review pending.

The first live operator dry-run correctly refused to mutate, but exposed an overly strict snapshot-header lease: normal Base Sepolia block advancement invalidated it even when the KA was unchanged. Replace the lease check with a fresh coherent asset snapshot, comparing root count/root/author/publisher/storage binding and refusing older or reorged same-height views. A new test accepts block advancement and retains the version-change refusal. Focused checks now pass 24 tests; typecheck and lint pass. Live ordinary publications continue on the initial binary until their queue drains; rebuild/restart on the correction before operator acceptance testing.

Live fault evidence: a real confirmed publication's ordered state insertion failed twice; both descriptor reads became unavailable and the same transaction-bearing job remained included. First 20 ordinary heads passed name/UAL descriptor, exact-content and independent chain checks. Full campaign, restart and cleanup remain pending. Validation-response round 1; remote findings not yet received.

### Remote review response round 2 (in progress)

Five actionable findings on `0ac5a6d0e`: extend operator recovery to the trailing first-publication fields; distinguish single-value mismatches from duplicates in refusal tests; bound lock acquisition; factor canonical lifecycle reservation/subject interpretation; test timeout ownership and no late writes.

The publisher-owned lifecycle reader now exposes case-equivalent candidates and the existing strict reservation decoder. Descriptor history shares the same candidate ordering. Recovery-specific proof/cardinality rules remain strict. Operator repair accepts absent trailing published UAL and a matching prior layer graph, then uses the existing observed lifecycle writer to complete the projection. The same lock/read deadline now returns promptly on a stalled predecessor, with no expired callback mutation and backpressure retained until settlement; entered writes are never abandoned. Controlled-deadline tests cover stalled locks, cancellation-ignoring reads and entered writes. Refusal tests replace individual identity/version/WM/SWM values and assert their specific reason; multivalue rejection remains separate.

All 45 initial live publications completed on `71605cd6c`. The daemon was stopped after ordinary work drained, retaining the fault fixture's included job and original transaction. Restart, operator verification and the 15 updates will execute on the reviewed correction. No SCAN host writes or wallet release occurred.

Round 2 local verification: 145 agent tests across six suites and 80 publisher tests (pull-from plus provenance) passed. Agent/publisher builds and type fixtures, lint and file-size checks passed. Live acceptance remains pending on this revision; the existing daemon is stopped and its store retained.

### Remote review response round 3 (in progress)

Two actionable findings: a compatibility repair could delete its own required VM-root evidence, and successful UPDATE receipt repair needed explicit coverage. Incomplete-descriptor repair now passes a verified-proof mode to the shared mutation builder, preserving the already-proven lifecycle VM pointer and layer on both atomic and ordered paths. Automatic recovery selects that mode only after strict raw proof, including compatible layer/projection; ordinary publication behavior is unchanged. Fault tests arm an exception after deleting required proof and show neither repair path reaches that deletion; a separate transient state-insertion failure preserves proof and permits retry. Version-2 tests drive the real receipt resolver's `verifyKAUpdate` branch, retaining root/version and refusing a receipt for another version.

CI's SPARQL scanner could not infer the bounded subject VALUES list. Added its documented R4 acknowledgement explaining the at-most-three exact address-case lifecycle subjects. The scanner self-tests and targeted scan pass; this does not exempt any graph-wide query.

Live progress: 15/15 updates completed, and all 46 current heads plus all 61 publication receipts passed independent verification. Both cleared-job operator scenarios passed on `727a55b8a`. The daemon is stopped for the final proof-preserving revision; a fresh automatic fault fixture, version-2 operator repair and all-head cold-restart verification will run on it. Review response budget: 3/10 including the initial live-validation correction.

Round 3 validation: all 150 agent tests across six suites passed, including both writer modes and canonical UPDATE receipt proof/refusal. Typecheck, lint and file-size checks passed. Final live replay remains pending.

### Remote review response round 4 (in progress)

Preserve storage failures (including their cause/code) while translating only canonical lifecycle corruption. Add real-agent/publisher serialization coverage in both execution orders and authorized HTTP dry-run contract coverage. Final round-3 live replay passed all 47 heads and 62 publication versions after a daemon/database cold restart; all 125 wallet transactions have successful receipts. Owned services are stopped while this review batch is addressed.

Round 4 verification: 29 focused agent tests and 35 CLI authority/route tests pass. Real DKGAgent creation/write serialization passes in both orders with checksummed writer/lowercase repair identity; an additional real finalize/signature test installs version 2 and a newer WM root before the waiting repair refuses, preserving both roots and all resulting metadata. Agent build/type fixtures, lint, file-size and whitespace checks pass. Production delta from the accepted live runtime is limited to preserving storage-error diagnostics.
