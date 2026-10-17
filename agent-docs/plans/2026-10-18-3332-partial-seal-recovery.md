# Issue 3332: recover interrupted WM pull-from

Status: In progress. Owner: Codex. Base: `testnet-canary` (user requested), initial SHA `2361a863d`. Branch: `codex/3332-partial-seal-recovery`.

## Executive summary

An interrupted active-seal clear leaves a completed SWM asset unable to reopen: the unfinished-promote guard reads only the active seal before the existing archive loader runs. Add a narrowly scoped recovery check for pull-from, proving the archived commitment against the exact completed operation and current SWM head before any mutation. Preserve ordinary mutation guards and draft conflict handling. The main risk is admitting a stale or unrelated archive as authorization.

## Evidence and analysis

- [Issue 3332](https://github.com/OriginTrail/dkg/issues/3332) reports v10.0.24 missing the first four seal predicates while retaining the complete private archive. Its store-timeout attribution is correlation, not proof. No issue comments at investigation time.
- `packages/publisher/src/dkg-publisher.ts`: pull-from calls `assertNoUnfinishedAssertionPromote` before `loadAssertionSeals`; clear/archive use sequential predicate deletions. The loader already tolerates torn candidates, but is unreachable in this failure.
- `packages/core/src/assertion-seal.ts`: missing root yields no seal; other incomplete shapes may throw.
- `workspace-resolution.ts` provides strict, snapshot-consistent head/operation decoding, including equivalent operation aliases and corruption detection. Reuse it rather than add a permissive metadata query.
- `BlazegraphStore.replaceSubject` uses a single transactional update. An atomic clear alone cannot repair historical partial clears and cannot atomically cover subsequent lifecycle/WM/private writes through the existing interface. Prefer safe resumption without a storage API redesign. Verify real Blazegraph behavior, rather than relying on the adapter comment alone.
- Existing pull-from tests cover dirty drafts, source integrity and archive reuse after completed pull/discard, but do not inject interruption during clear. Regression window beyond the reported release remains unproven.

## Design

Only pull-from may request archive-based completion proof when its active seal is missing/torn. Require a complete v2 archive, selector/lifecycle identity, surviving active seal fields consistent with the archive, a completion marker, a strict current head matching KA/version and operation (or a clean consumed lifecycle pointer), matching public digest/count and private commitment/count, and validated exact public/private SWM source. Never accept missing metadata as generic authorization. No archive fallback for create/write/discard.

After proof, existing source selection and conflict checks still run before archive/clear/draft replacement. A normal retry is the recovery action; SWM-share cannot repair a removed active seal by itself. Genuine unfinished shares continue to use the existing share recovery response.

```mermaid
flowchart LR
  A[Pull-from] --> B[Unfinished-promote guard]
  B --> C{Active seal proves completion?}
  C -->|yes| E[Verify selected source and draft conflict]
  C -->|missing or torn, pull only| D[Verify archive + lifecycle + current head + exact SWM payload]
  D -->|valid| E
  D -->|invalid| F[Reject without mutation]
  E --> G[Archive, clear, create and seed draft]
```

## Work and acceptance

1. **C1: deterministic reproduction and implementation.** Owner Codex. Add failure injection at every active predicate deletion boundary, including fully cleared before create; recreate publisher to remove in-memory state. Assert the original failure before the fix, then successful exact public/private recovery. Add negative tests for tampered archive, operation/digest mismatch, newer head, missing marker and dirty draft. Keep authored code/tests cohesive, target approximately 500 changed lines.
2. **C2: real store validation.** Owner Codex, after C1. Run the same behavioral matrix against an isolated real Blazegraph namespace; include actual container restart and archive-write failures. Preserve stage-attributed evidence without payloads/signatures. Build runtime and run affected publisher tests, type checks and repository lint checks.
3. **C3: PR/review.** Owner Codex, after local checks. Open one PR into `testnet-canary`, attach it, identify/request the remote reviewer, collect all comments/reviews/threads/checks with pagination. Address up to ten response rounds; observe each substantive revision for up to 30 minutes at two-minute intervals. Do not merge. Track head, deadline and rounds here.
4. **C4: live testnet.** Owner Codex, after review changes stabilize. Follow dkg-testnet macOS runbook, claim a prepared batch, isolate home and ports, disable auto-update, check native SQLite and signer balances. Use real Blazegraph for this issue-specific scenario. Create/finalize/share a synthetic named KA, verify source/head, inject clear interruption and restart, retry and compare exact public/private content. Exercise normal next-version lifecycle and relevant async VM publication/readback if network prerequisites allow. Reconcile jobs/transactions, stop owned writers and release only when quiescent. Save sanitized report in `run-reports/` and raw evidence outside tracked files.

## Review and operational limits

Pre-implementation self-review: narrow the exception to pull-from; compare remaining fields to prevent a newer draft being mistaken for an interrupted clear; strict head decoding prevents superseded/ambiguous operations. Validate source before mutation, and assert negative tests preserve storage. Remote reviewer supplies independent implementation review. No subagents assigned.

No schema migration or new wire contract. Rollback retains existing data formats but reintroduces inability to retry old partial clears. Do not reset operator state or remove genuine promote intents. User authorized PR/review and live testnet transactions, not funding or merge. If a store/network prerequisite fails, preserve evidence and resolve setup where possible; report the exact boundary rather than claiming a pass.

## Execution ledger

- Dependencies installed with pinned pnpm; runtime build in progress.
- Wallet pool configured; Docker available; no batch claimed yet.
- C1 next: write regression and demonstrate pre-fix rejection.
- Review rounds: 0. PR/head/deadline: not yet submitted.
