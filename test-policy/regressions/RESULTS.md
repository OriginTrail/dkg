# Observed regression proof results

Both records are **proven by historical source replay**, refreshed on 5 October 2026 after review. The exact candidate code commit is `3a34d991deaf118e6e951bbafa86dc2171c2138c` (full commit and tree in each receipt). Integration base: `00406e3d4a7230e84a34e046b6fc069ff8d51ff0`.

| Case | Historical source | Red | Corrected candidate |
| --- | --- | --- | --- |
| GH-2782 | `v10.0.19` → `42d7a9259ec2dd255e3257c95859c07e861d923d` | exactly 1 assertion failed, exit 1 | same assertion passed, exit 0 |
| GH-2741 | `v10.0.18` → `382258fa43b1a0dd8ef2091ba6048b90e6890581` | exactly 1 assertion failed, exit 1 | same assertion passed, exit 0 |

## Commands and evidence

```sh
pnpm qa:prove-regression --case GH-2782 --bad-ref v10.0.19 --output test-policy/regressions/evidence/GH-2782
pnpm qa:prove-regression --case GH-2741 --bad-ref v10.0.18 --output test-policy/regressions/evidence/GH-2741
pnpm qa:check-regressions
pnpm test:regression-proofs
pnpm test:scripts
pnpm lint
```

### GH-2782

- [Case record](GH-2782.json), [receipt](evidence/GH-2782/receipt.json), [red report](evidence/GH-2782/bad-report.json), [green report](evidence/GH-2782/candidate-report.json).
- Assertion: `VM reconcile cursor follows the subscription lifetime advances an on-demand subscription through its pending ordinals without a durable write`.
- Actual diagnostic: `AssertionError: GH-2782: unsaved subscription converges without durable membership: expected { …(10) } to deeply equal { error: null, …(9) }`.
- Red: successful partial-state setup, 19 local ordinals, fetched `[]`, cursor and subscription watermark `0`, and `Cannot acknowledge join approval for "on-demand-pending": durable subscription intent or host state is missing`. The named assertion executed after observing this production failure.
- Green: fetched `[6,7,8,9,10,11]`, 25 local ordinals, advances `[[0,3],[3,6],[6,25]]`, current=true, watermark=25, saves=0, rows=0, sameSubscription=true.
- Node `v22.23.2` on `darwin/arm64`; actual Vitest runtime matched. pnpm `10.28.1` on both sides.
- Historical original lock SHA-256: `88b380272fabd355f8dff04c160f333d867beb25d9cac4c7dd9ca1662bce6e08`; corrected original lock SHA-256: `11309f3bf44b0484d0d358555fab3a964114259e67d63cbcce4482704fe91c99`.
- Both detached worktrees were removed. Patch identity is explicitly null; no production overlay or replacement lockfile was used.

### GH-2741

- [Case record](GH-2741.json), [receipt](evidence/GH-2741/receipt.json), [red report](evidence/GH-2741/bad-report.json), [green report](evidence/GH-2741/candidate-report.json).
- Assertion: `Random Sampling proof-time exact repair on the real libp2p peer store fetches the challenged asset from a provider the peer store lists as sync-capable`.
- Actual diagnostic: `AssertionError: GH-2741: capable peer repair fetch completes: expected { fetchedFrom: [], outcome: { …(1) } } to deeply equal { …(2) }`.
- Red: the real store advertised SYNC for the canonical PeerId and rejected the wrapper. Production repair attempted no fetch (`fetchedFrom: []`) and returned `Random Sampling exact repair did not recover … from zAEZg3q6`; the named material/fetch assertion failed.
- Green: production repair fetched from `12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6` and completed with the fixed canonical challenged material and no private roots.
- Node `v22.23.2` on `darwin/arm64`; actual Vitest runtime matched. pnpm `10.28.1` on both sides.
- Historical original lock SHA-256: `f9a5b81b36191f695f3c867c6e4bf1de43e9b178277551ec1dcad26b0fa9b61a`; corrected original lock SHA-256: `11309f3bf44b0484d0d358555fab3a964114259e67d63cbcce4482704fe91c99`.
- Both detached worktrees were removed. Patch identity is explicitly null; no production overlay or replacement lockfile was used.

## Required lane and local checks

Fresh inventory resolves both files to `tornado-agent`, required cadence. Named Vitest discovery and `planAgentShards` assign GH-2741 to `agent-6.xml` and GH-2782 to `agent-10.xml`, exactly once each. The primary/normal unit configs both discover the files.

The actual required GitHub CI jobs passed: [GH-2741, shard 6/10](https://github.com/OriginTrail/dkg/actions/runs/37229741344/job/111517782120) and [GH-2782, shard 10/10](https://github.com/OriginTrail/dkg/actions/runs/37229741344/job/111517782149). Downloading and parsing each uploaded JUnit report found exactly one matching assertion, passed with no failure/error/skipped element. Both actual runtimes were Node `v22.23.3`. The [compact CI evidence](evidence/required-ci-assertions.json) records artifact links, raw XML hashes, exact testcase identities and matching test-source hashes.

These jobs evaluated PR head `155b9cba50f4cb651114e593a0c06b24289a77ff` in merge commit `810f8e00da64f4980c139ac3c46fb72bc5257fd5`. The [required build job](https://github.com/OriginTrail/dkg/actions/runs/37229741344/job/111516808494) also validated both proven records and passed all 449 tooling tests then present. The behavioral tests are still byte-identical. The review follow-up changes shared proof execution and case identity handling, so both historical receipts were regenerated; fresh Windows launcher CI verification is pending that push.

The [local shared-runner JUnit](evidence/required-agent-unit.xml) and [metadata](evidence/required-agent-unit.json) show both assertions executed and passed, with zero skipped. This command is a **filtered local run through the required profile**, not a full GitHub shard receipt:

```sh
node scripts/ci/run-vitest-junit.mjs --lane agent -- --config vitest.unit.config.ts test/regression-on-demand-cursor.test.ts test/regression-peer-store-repair.test.ts
```

| Check | Observed result |
| --- | --- |
| Six affected agent files under normal unit config | 240 passed, 0 failed, 0 skipped |
| Proof-tool checks, including actual Vitest fixture reports | 18 passed, 0 failed, 0 skipped |
| Existing repository-script lane after review fixes | 454 passed, 0 failed, 0 skipped |
| Lint | exit 0; zero disabled-test additions; no baseline changes |
| Fresh inventory and registry | 2,249 files, 23 Vitest packages; two proven records |
| Agent and CLI/dependency builds | passed |

Focused behavioral command:

```sh
pnpm --dir packages/agent exec vitest run --config vitest.unit.config.ts test/core-fills-gap.test.ts test/vm-reconcile-self-prime.test.ts test/durable-sync-lifecycle-binding.test.ts test/sync-protocol-peer-id.test.ts test/regression-on-demand-cursor.test.ts test/regression-peer-store-repair.test.ts
```

Build command:

```sh
pnpm -r --filter '@origintrail-official/dkg...' --filter '!@origintrail-official/dkg-evm-module' run build
```

## Rejection evidence and limitations

The [focused TAP evidence](evidence/proof-tool-negatives.tap) covers zero selection, a skipped assertion, the wrong failing assertion, import failure, an unrelated failure in the named test, stale test/proof/receipt identity, missing/ambiguous discovery, duplicate case ID, absent owner/file, optional-only routing and disabled/excluded assertions. A registered skipped assertion is rejected even with a valid general disabled-test waiver and an explicitly unproven record. It runs actual Vitest for execution negatives and actually changes copied fixture bytes for stale-evidence rejection. Owned descendant termination on deadlines and cancellation, the actual pinned pnpm launcher, and selected-case versus shared-runner identity changes are also exercised.

The original GH-2782 detector failed before reaching its expected-result assertions. The extracted detector observes the production exception and stalled state, then executes a named invariant assertion; success checks remain intact. GH-2741 already detected its original defect; extraction keeps the real store and strengthens setup and the independent fixed-byte expectation.

An initial proof-tool discovery attempt was inconclusive because macOS returned `/private/var` paths for a `/var` temporary checkout. Canonicalizing the owned scratch path fixed that tool issue. Both historical source builds/imports succeeded. A CI routing audit also rejected computed proof-input paths; those paths are now explicit. Neither failure was counted as red proof.

GH-2741 is classified as defective from repair’s first shipment (v10.0.15); that introducing commit is absent from v10.0.14 and the repair method is absent there. GH-2782’s first affected release remains unknown.

Transport/chain facts remain the documented fixture boundaries. These proofs certify cursor/persistence and repair/real-store orchestration, not a distributed release campaign. The inventory hook uses the existing required build job; it needs no controller pin rotation. PR #3031's staged Node 26 activation is independent.

## Review follow-up (5 October 2026)

All three inline findings were actionable:

- [Windows pnpm launch](https://github.com/OriginTrail/dkg/pull/3037#discussion_r4179487765): the runner uses the pnpm lifecycle's actual CLI entry, launched through Node or directly for standalone pnpm.exe. Argument arrays bypass command-interpreter expansion. Both the advertised proof command and launcher check must be invoked through pnpm on Windows. Actual launch identity is included in each phase.
- [Case identity coupling](https://github.com/OriginTrail/dkg/pull/3037#discussion_r4179487769): selected definitions now live in independently fingerprinted case modules. Changing one definition invalidates that case only; changing the shared execution inputs invalidates both. Actual copied files are edited in the rejection test.
- [Scanner source rewrite](https://github.com/OriginTrail/dkg/pull/3037#discussion_r4179487770): the scanner exposes `applyWaivers: false`; regression policy analyzes the original source. Normal waiver handling and rejection of lowercase/uppercase waived skipped assertions remain covered, with original line locations preserved.

The Windows smoke hook is isolated in commit `3a34d991d`. Its `pnpm qa:check-regression-launcher` exercises the actual pinned pnpm launch and owned descendant termination on timeout/cancellation. The same check passed locally on Node v22.23.2/darwin; the Windows result will be recorded after the PR run. No trusted-controller mapping or pin changed.
