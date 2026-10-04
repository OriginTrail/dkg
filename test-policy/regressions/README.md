# Regression register: first delivery

This register covers GH-2782 and GH-2741 only. A record binds a behavioral
invariant to an exact assertion, a repository-owned execution profile and the
required `tornado-agent` unit lane. Its proof receipt contains source commits
and trees, test/tool hashes, original lockfile identities, dependency manifests,
actual Node/pnpm versions, generated test config, commands, reports, observations
and cleanup results. `unproven` is explicit and never counts as proven evidence.

Base: `origin/testnet-canary` at
`00406e3d4a7230e84a34e046b6fc069ff8d51ff0`, fetched 4 October 2026.
Remote: `https://github.com/OriginTrail/dkg.git`.

## Commands

Use Node 22 (the evaluated releases' `.nvmrc`) and pnpm 10.28.1:

```sh
pnpm qa:check-regressions
pnpm qa:prove-regression --case GH-2782 --bad-ref v10.0.19
pnpm qa:prove-regression --case GH-2741 --bad-ref v10.0.18
node --test scripts/lib/__tests__/regression-proofs.test.mjs
```

Commit production/dependency and unit-config changes before proving. The runner
resolves refs to full commits and uses **two disposable detached worktrees**,
including for the corrected candidate. It overlays only the case's declared
minimal test. The historical side also receives a generated test-only config
from `profiles.mjs`; the corrected side uses its committed normal unit config.
No current production code, helper implementation, or replacement lockfile is
copied into historical source. Both original lockfiles are installed frozen;
only each checkout's agent workspace dependencies are built. No Hardhat, live
chain, existing node data, listening DKG node or external service is required.

Each side has 30-second package-manager, 180-second install/build, 60-second
discovery and 45-second execution bounds; git operations have 30-second bounds.
Phase output is capped at 8 MiB. Test/hook bounds are 15 seconds in historical
replay. A broad timeout is always inconclusive. SIGINT/SIGTERM stop the runner's
own process group and trigger worktree teardown. A failed teardown is retained
and reported, never silently deleted. Evidence defaults to the ignored
`.regression-proofs/<case>-<timestamp>/`; `--output` names a **new** directory
and refuses to overwrite existing evidence.

The tool requires exactly one discovered and executed assertion on each side,
a successful setup observation, a real `AssertionError` with the reviewed case
message and the case-specific bad state, followed by the same assertion passing
on the candidate. Compilation/import errors, skips, empty selection, unrelated
failures, wrong runtime and generic process deadlines cannot qualify. It records
inconclusive setup failures separately. Historical replay succeeded for these
profiles, so no defect-reintroduction patch or patch platform is included.

## Detectors and scope

- **GH-2782**: the existing unsaved-cursor assertion was extracted from
  `core-fills-gap.test.ts` to `regression-on-demand-cursor.test.ts`. The 19/25
  partial-fetch fixture leaves ordinals 6–11 missing. Production reconcile,
  cursor and persistence run; chain facts and ordinal transport are fixtures.
  The unchanged success checks require advances 0→3→6→25, exactly the missing
  ordinals fetched, no durable saves/rows, and convergence. The test also
  requires the same subscription object throughout. The original test detected
  the defect by throwing before its assertions; it now observes that error and
  executes the named invariant assertion, which makes the red reason verifiable.
  Always-on, host-only and restart companion tests remain in `core-fills-gap`;
  self-prime and durable late-binding coverage remain in their original files.
- **GH-2741**: the existing production repair assertion was extracted from
  `sync-protocol-peer-id.test.ts` to `regression-peer-store-repair.test.ts`.
  A started dial-only DKGNode owns the **real libp2p peer store**. Setup proves
  it advertises SYNC for a real PeerId and rejects the string wrapper. The
  production repair and readiness methods must call the deterministic
  authenticated-fetch fixture and return the challenged material. The expected
  bytes are a fixed protocol literal, independent of the production serializer.
  Other real-store/readiness and durable-failover tests remain in the original
  file. This proves repair orchestration through the dependency boundary; it
  does not certify distributed transport or challenge authentication.

GH-2741 is a defect **from repair's first shipment**, v10.0.15. Its production
repair already sent the invalid wrapper in that release. The introducing commit
`fa4b99f1093309a385912c8ee8dca674e3d8843f` is an ancestor of v10.0.15's commit
`244f6943fe7a909a23fe3671c9da088de942f8ed`. No previously working repair release
is claimed. GH-2782's first affected release remains explicitly unknown.

## Required execution and integration

The primary config discovers both files; `vitest.unit.config.ts` selects them.
The current weighted planner assigns each to exactly one required unit shard.
The register validator resolves files through **fresh test inventory**, checks
actual named Vitest discovery and disabled/focused-test analysis, and confirms
the planner's assignment. It rechecks the stored raw red/green reports and their
artifact/test/profile hashes. A test or proof-execution-tool edit requires fresh
proof. Registered assertions cannot use general disabled-test waivers, including
records explicitly marked unproven.
It does not replay historical versions during ordinary PR CI.

The only build-gate integration is the call from `scripts/ci/test-inventory.mjs`,
committed separately. The existing required build job already invokes this
command; the normal agent jobs continue to execute the behavior tests. No
workflow or pinned controller changes are needed for this hook. Existing
controller activation/freshness issues remain separate from this delivery.

PR #3035 (devnet observation/incomplete runs) and #3031 (staged Node 26) were
inspected for their interfaces and paths. No unmerged code was imported and
neither branch was modified. The Node 26 activation dependency does not apply
to these Node 22 agent proofs.

## Rejection demonstrations

`regression-proofs.test.mjs` produces actual Vitest reports in disposable
fixtures for intended red and corrected green, zero selection, skipped
assertion, wrong failing assertion, import failure and an unrelated failure in
the named test. It also rejects stale test/proof/receipt identities, missing or
ambiguous discovery, duplicate case IDs, absent owner/file, optional-only
routes and excluded/disabled assertions (also with a general waiver). Owned subprocess timeout/cancellation
are exercised and cleaned up. These are tool fixtures, not additional incident
proofs.

Actual case results, commands and limitations are recorded in `RESULTS.md` and
the per-case evidence directories. Generated full logs are kept with the proof
receipts; no historical proof is claimed until both sides validate.
