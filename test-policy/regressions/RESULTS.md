# Observed regression proof results

Both records are **proven by historical source replay**, observed on 4 October 2026. The exact candidate code commit is `6218e803d` (full commit and tree in each receipt). Integration base: `00406e3d4a7230e84a34e046b6fc069ff8d51ff0`.

| Case | Historical source | Red | Corrected candidate |
| --- | --- | --- | --- |
| GH-2782 | `v10.0.19` → `42d7a9259ec2dd255e3257c95859c07e861d923d` | exactly 1 assertion failed, exit 1 | same assertion passed, exit 0 |
| GH-2741 | `v10.0.18` → `382258fa43b1a0dd8ef2091ba6048b90e6890581` | exactly 1 assertion failed, exit 1 | same assertion passed, exit 0 |

## Commands and evidence

```sh
pnpm qa:prove-regression --case GH-2782 --bad-ref v10.0.19 --output test-policy/regressions/evidence/GH-2782
pnpm qa:prove-regression --case GH-2741 --bad-ref v10.0.18 --output test-policy/regressions/evidence/GH-2741
pnpm qa:check-regressions
node --test scripts/lib/__tests__/regression-proofs.test.mjs
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

The [local shared-runner JUnit](evidence/required-agent-unit.xml) and [metadata](evidence/required-agent-unit.json) show both assertions executed and passed, with zero skipped. This command is a **filtered local run through the required profile**, not a full GitHub shard receipt:

```sh
node scripts/ci/run-vitest-junit.mjs --lane agent -- --config vitest.unit.config.ts test/regression-on-demand-cursor.test.ts test/regression-peer-store-repair.test.ts
```

| Check | Observed result |
| --- | --- |
| Six affected agent files under normal unit config | 240 passed, 0 failed, 0 skipped |
| Proof-tool negatives, including actual Vitest fixture reports | 14 passed, 0 failed, 0 skipped |
| Existing repository-script lane after the explicit-input fix | 449 passed, 0 failed, 0 skipped |
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

The [focused TAP evidence](evidence/proof-tool-negatives.tap) covers zero selection, a skipped assertion, the wrong failing assertion, import failure, an unrelated failure in the named test, stale test/proof/receipt identity, missing/ambiguous discovery, duplicate case ID, absent owner/file, optional-only routing and disabled/excluded assertions. It runs actual Vitest for execution negatives and actually changes copied fixture bytes for stale-evidence rejection. Owned process deadlines and cancellation are also exercised.

The original GH-2782 detector failed before reaching its expected-result assertions. The extracted detector observes the production exception and stalled state, then executes a named invariant assertion; success checks remain intact. GH-2741 already detected its original defect; extraction keeps the real store and strengthens setup and the independent fixed-byte expectation.

An initial proof-tool discovery attempt was inconclusive because macOS returned `/private/var` paths for a `/var` temporary checkout. Canonicalizing the owned scratch path fixed that tool issue. Both historical source builds/imports succeeded. A CI routing audit also rejected computed proof-input paths; those paths are now explicit. Neither failure was counted as red proof.

GH-2741 is classified as defective from repair’s first shipment (v10.0.15); that introducing commit is absent from v10.0.14 and the repair method is absent there. GH-2782’s first affected release remains unknown.

Transport/chain facts remain the documented fixture boundaries. These proofs certify cursor/persistence and repair/real-store orchestration, not a distributed release campaign. Required PR CI receipts will be linked when available. The inventory hook uses the existing required build job; it needs no controller pin rotation. PR #3031’s staged Node 26 activation is independent.
