# Issue 3350: exact WM draft recovery

Date: 2026-10-23. Status: in progress. Owner: Codex.
Branch: `codex/3350-exact-wm-draft-recovery`; base: `testnet-canary`, explicitly requested by the user and required by CONTRIBUTING.md. Initial base/head: `9031533da8981d7d934b58f2440bbe42a424c224`. Initial working tree clean, detached HEAD; no applicable AGENTS.md found.

## Outcome and evidence

[Issue #3350](https://github.com/OriginTrail/dkg/issues/3350) describes an ambiguous successful pull when its HTTP response disappears. Public WM reads cannot distinguish complete recovery from incomplete or dirty private WM. Add an explicit, source-pinned exact recovery option to the existing authenticated named pull endpoint. It verifies both partitions under the existing lifecycle lock and returns scope, identity, counts and commitments without writing or exposing payload. Ordinary reject and explicit replace retain their behavior. The primary risk is accepting a different/stale source or an incomplete private partition.

Inspected `dkg-publisher.ts:assertionPullFrom`, `assertion-pull-source.ts`, `assertion-seal-recovery.ts`, agent assertion adapters, named KA route, CLI client/command, and existing pull/recovery tests. The existing implementation validates the source, checks public/private draft presence, archives its seal, clears the active seal, then writes public and private WM separately. Conflict rejection is correct; authenticated recovery evidence is missing. Existing tests cover source integrity and interrupted seal clearing, but do not expose a supported exact draft verification operation. Regression introduction date is not established.

## Selected design

- Request: `POST /api/knowledge-assets/:name/wm/pull-from` with existing graph/subgraph/layer and `recoverExact: {kaUal, assertionVersion, merkleRoot}`. This opt-in verifies an existing draft only, requires reject semantics, and never seeds, clears, finalizes or replaces anything.
- Pin the caller's accepted source using the UAL and assertion version retained from finalize/share/history. Reject mismatched or superseded seals, absent/invalid sources, and absent/nonexact drafts. Verify complete source commitments first, then both current draft partitions against the same seal.
- Return `recovered: true` and `draftEvidence` binding effective actor, graph/subgraph, name, source layer, UAL, assertion version, public/private counts and Merkle commitments. No private payload, storage query, or exception cause is returned.
- Snapshot nested options before waiting for the lifecycle lock. Verify source identity and both partitions while holding that same lock. This is an observation at completion of verification, not a reusable capability: subsequent writes can invalidate it. Later mutations must use their existing locked validation; clients must not use this response to justify `replace`.
- Keep recovery logic/types in a small publisher module and reduce the existing oversized publisher/agent/route files rather than increasing their size budgets.

Alternatives considered: a GET commitment proof would require a separate conditional mutation contract and creates a misuse-prone read/write race; silently treating equal drafts as success weakens default rejection; replace destroys unproven data. Explicit verification fits the existing lock and source validator without a new persisted schema or token lifecycle.

```mermaid
sequenceDiagram
  participant Client
  participant NamedAPI
  participant Publisher
  participant Store
  Client->>NamedAPI: pull-from + recoverExact source identity
  NamedAPI->>NamedAPI: authenticate and resolve actor/graph/subgraph
  NamedAPI->>Publisher: exact recovery request
  Publisher->>Publisher: acquire lifecycle lock
  Publisher->>Store: current seal and complete immutable source
  Publisher->>Store: both current draft partitions
  Publisher->>Publisher: verify pinned identity, counts and roots
  Publisher-->>Client: exact evidence or bounded conflict; no writes
```

## Execution chunks

1. **C1, contract and publisher:** implement source-pinned opt-in, consistent reads, safe failures and typed evidence. Preserve ordinary pull, replacement and partial-clear recovery. Add real Oxigraph regressions for success, partial seeding, wrong equal-count public/private, stray private, missing private source, scope/identity/version errors, superseding source, restart and lock ordering. Baseline the existing pull tests before edits; prove new regression fails without implementation.
2. **C2, supported HTTP/CLI:** propagate the typed option through the agent/client, validate request combinations, expose source-pinning CLI flags and document snapshot limits. Exercise real authenticated daemon requests, response loss and persistent store restart. Cover unauthorized/wrong actor and malformed options. Keep tests connected to production components.
3. **C3, local validation and PR:** build runtime packages, run targeted publisher/agent/CLI tests, file-size and diff hygiene checks. Review privacy/concurrency and integrated behavior against this plan. Open one cohesive PR into `testnet-canary`; expected implementation/test size roughly 500–900 changed lines, reassess if larger. No merge or auto-merge is authorized.
4. **C4, live testnet:** after native dependency/SQLite readiness, claim a funded batch from configured `DKG_TESTNET_POOL`, copy only its four files to an isolated home, disable updates, use authenticated API and managed Oxigraph. Record resolved network/Hub/token and actual ports before transactions. Create actor-owned public/private and public-only KAs, finalize/share, drop one successful pull response through a proxy, restart daemon/store, recover exact and retain safe evidence. Inject a partial public/private boundary through test infrastructure if supported without a production fault hook. Check dirty equal-count partitions, wrong source and default reject, unchanged conflicting storage, edit/finalize/share regression, and VM publish/readback when infrastructure permits. Record real outcomes, never infer chain finality from SWM success. Report any unavailable boundary distinctly.
5. **C5, remote review and cleanup:** establish the actual reviewer trigger/completion signal, collect all reviews/comments/threads/checks with pagination. Address coherent feedback batches (up to 10 rounds), verify each revision, and observe each substantive head for up to 30 minutes at two-minute intervals. Current round: 0; review window not started. Do useful validation during review. Reconcile jobs/transactions and signer nonces, stop owned workers/listeners and release the matching wallet claim only after quiescence. Preserve source, compact evidence/report and required continuation state.

## Acceptance and verification

| Criterion | Evidence planned |
|---|---|
| Complete pull + lost response distinguished after restart | Real persistent store tests and authenticated black-box fault/restart campaign |
| Partial/missing private, dirty public/private, stray private refused | Equal-count negative tests plus before/after storage equality |
| Wrong actor/graph/subgraph/KA/version and superseding source refused | Publisher scope tests and named API auth tests |
| Concurrent changes and caller mutation cannot make stale proof succeed | Lock ordering and nested-option snapshot tests; documented snapshot limit |
| No private response/log/error data | Bounded error assertions and live sentinel scan |
| Default reject, replace and partial seal recovery preserved | Existing pull suite and named lifecycle regression |
| Candidate builds and passes relevant CI/review | Observed local results and current-head remote review/check sweep |

## Risk review and recovery

Pre-implementation self-review (not independent): privacy, source fallback, concurrency and operational lenses identified two material requirements: recovery must never fallback to an older seal when a newer complete seal supersedes the pinned one; nested source options must be copied before lock acquisition. Both are in C1. Rejected operations must preserve storage, checked explicitly. Remote reviewer provides independent implementation review. No migration is needed; rollback removes the additive option. If store/chain/peer prerequisites fail, retain the failure evidence and report the exact validation boundary while continuing independent checks.

## Resources and status

| Resource | Owner/purpose | Retention/cleanup condition |
|---|---|---|
| Existing checkout `934e/dkg` | Current chat; implementation | Preserve for PR and continuation |
| `.tmp/issue-3350/` | Current task; install/build/test and live evidence | Keep compact evidence; stop owned activity before disposing isolated runtime |
| Configured external wallet pool | Shared immutable source | Never delete/modify bundles; claim only after readiness |

Dependency installation started with frozen lockfile. Native Node 22.23.3, pnpm 10.28.1; pool configured. Next: baseline publisher pull tests, then C1 implementation. No testnet batch claimed or remote PR created yet.

### 2026-10-23 implementation checkpoint

C1/C2 implemented. The pin additionally requires `merkleRoot`: unpublished assertion versions can be reused, so tuple-only pinning would not identify the accepted content. Normal pull responses add this source commitment. Relevant builds passed; 105 publisher/lifecycle tests passed, 15 CLI smoke tests passed (root-flag focused retest passed), and the real authenticated HTTP fault test passed. Rootless/source/partial-seal baseline had 73 passing tests; the first new regression run had 9 expected failures. Lint and source-size checks passed. Full named-route regression is running.

Live batch `batch-2` claimed in `.tmp/issue-3350/evidence/batch-claim.json`; only this task's home `.tmp/issue-3350/home` uses it. Node/SQLite and Base Sepolia chain 84532, configured Hub/token, balances/nonces and API auth qualified. Actual API/store ports: 64728/64729. An initial unregistered public graph hit existing `Catalog policy no longer matches the admitted share` before SWM commit; retain that terminal failed share in evidence. A registered graph is being prepared to satisfy live authority prerequisites. No recovery assertion is inferred from that failed setup. No wallet funding or PCA changes performed.

### Review round 1 and live checkpoint

PR: https://github.com/OriginTrail/dkg/pull/3429. Reviewer `otReviewAgent` completed review of `e458e6fe8fc888999d0c5163788ed9957b1a6a2c` with four actionable threads. Round 1 is in progress: (1) await the extracted handler so outer error mapping remains active; (2) preserve bounded retryable storage timeout/pressure/transport failures; (3) share one untrusted-input pin parser across publisher, HTTP and CLI; (4) separate exact draft tests and shared fixtures. All four changes implemented and verified: 109 publisher/lifecycle tests, 69 real daemon/Hardhat named-route tests, 5 focused pull error-mapping tests, and the CLI recovery flag test passed. Builds/type/package checks, lint and size checks passed. The new suite remains in both publisher test configurations.

Live evidence now demonstrates: complete mixed public/private pull with dropped HTTP response; ordinary conflict rejection; complete exact recovery after daemon/store restart; partial private refusal; actual process exit immediately before private INSERT (test-only fetch preloader, after public WM commit), supervisor/store restart, and exact recovery refusal without changes; equal-count wrong private content, public-only source with stray private content, and wrong assertion version refused unchanged. The direct local-store writes only prepare private fixtures/corruption; all finalize/share/pull/recovery operations use the authenticated named HTTP API. No production fault hook was added. A separate later share reached retryable `chain-access-policy-timeout` before SWM commit; follow its existing owner, do not replay the POST. Edit/finalize/share regression and final transaction/job cleanup are still in progress.

### Round 2, completed live campaign and current handoff

Round 1 addressed all four original comments and resolved them after factual replies. Round 2 incorporates the second current-head review: (1) a gated real storage read proves overlapping writers wait for verification; deliberately bypassing recovery's lifecycle lock makes this test fail; (2) bounded read-error handling now wraps lifecycle inspection and both draft partitions, preserving explicit lifecycle/conflict errors and retryable transport classifications, while unexpected backend excerpts remain bounded 500s; (3) result types are a discriminated union with compile-time narrowing and invalid-state rejection. The CI-unused-import findings are also fixed. Local validation: 116 publisher/lifecycle tests, 69 real daemon/Hardhat HTTP tests, seven focused HTTP error tests, relevant builds/type/package tests, tracked-file lint and source-size guard pass. The new source-size budget is ratcheted down.

Live campaign complete: see `run-reports/2026-10-23-issue-3350-wm-draft-recovery.md`. In addition to the prior fault/restart matrix, explicit replacement/edit/finalize/share passed, async VM publish finalized with three ACKs, receipt/root/graph membership independently matched at the receipt block, and VM public payload plus complete private/public commitment readback passed. The delayed admitted share succeeded on attempt five without POST replay. Final candidate retest also refused same-count public corruption and missing private source unchanged, then reverified the restored source. Executable source hashes are retained for post-commit comparison.

All jobs terminal; all signer pending/latest nonces equal after shutdown; owned processes/listeners stopped; batch-2 released with its original token. Private home/store/evidence retained for review; source wallet bundles unchanged. No live node or automation remains running.

Next action: submit round 2, verify executable source blobs against the captured live manifest, reply to/resolve the three findings, and finish current-head remote review/CI. Rounds used: 2 (round 2 currently in progress). Preserve the active 30-minute observation deadline in `.tmp/issue-3350/evidence/review-ledger.json`; metadata-only changes do not extend it. No merge authorized.

### Round 3 — CI documentation budget

The remote reviewer completed review of executable-code head `f8ead9b3b6b2486d9603edeffc2637e18afd8910` with “found no issues”; no unresolved review threads remain. The full CI run completed with all unrelated jobs passing, but CLI shard 4 failed the existing node-skill size guard (1004 split lines versus a limit below 1000). Coverage merge and CI gate then failed because that shard failed. Keep a concise, complete recovery entry in the skill and move the detailed API/error/CLI/snapshot contract into `docs/use-dkg/wm-draft-recovery.md`. The skill is back to 998 lines; 21 endpoint tests and three route-parity tests pass. This revision changes documentation only, so the nine executed source blobs remain identical and the stopped/released testnet environment need not be restarted.

Round 3 is in progress for this substantive documentation/CI fix. Submit it, recheck source blob equality, request current-head review, and observe required CI to completion within its bounded window. Code-owner approval remains required by branch rules; no merge is authorized.
