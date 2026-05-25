# Integration branch — Graphify-import fixes

This branch is the union of five PRs that came out of the PR #602
Graphify-import experience, integrated on top of `main` so any reviewer
can clone, build, and test the whole stack at once without checking out
five branches.

If you just want to merge things upstream, the PRs themselves are still
the canonical units of work — this branch is a *testing convenience*,
not the merge target.

## What's in the branch

| PR  | Branch                            | Headline                                                      |
|-----|-----------------------------------|---------------------------------------------------------------|
| #636 | `fix/graphify-import-issues`      | Repro harness + bug report for WM persistence regression       |
| #640 | `fix/graphify-wm-persistence`     | Storage + agent fix making WM persistence durable across restarts |
| #641 | `docs/importer-adrs`              | ADR 0002 (importer chunking contract) + ADR 0003 (code-graph ontology) |
| #642 | `feat/dkg-importer-helpers`       | `scripts/lib/manifest.mjs` resumable-import library + `dkg-importer/SKILL.md` |
| #643 | `docs/spec-async-promote-queue`   | RFC for an async WM→SWM promote queue                          |

PR #636 is stacked under #640, and PR #641 is stacked under #642, so
the merges below are just `#640` (carries #636), `#642` (carries #641),
and `#643` (independent).

## Build + smoke-check

```bash
git fetch ghorigin integration/graphify-import-fixes
git checkout integration/graphify-import-fixes
pnpm install
pnpm build:runtime              # builds storage + agent + cli + publisher in dep order
node --test scripts/lib/__tests__/manifest.test.mjs   # unit tests for the manifest lib
```

## Testing the WM persistence fix (PR #640 + #636)

The repro harness lives at `scripts/repro/wm-persistence-regression.mjs`
and is fully covered by the daemon-isolation contract in `REPRO.md`
(read that first — the harness refuses to run if it can't prove it's
talking to a throwaway daemon).

Quick smoke runs:

```bash
# small run, clean shutdown — should report lostTriples: 0
node scripts/repro/wm-persistence-regression.mjs \
  --num-assertions=5 --quads-per-assertion=1000 --restart-mode=clean

# small run, SIGKILL cycle — also lostTriples: 0 because the atomic
# write lands after every batch (worst case the kill races a single
# debounced flush window).
node scripts/repro/wm-persistence-regression.mjs \
  --num-assertions=5 --quads-per-assertion=1000 --restart-mode=kill

# full matrix (clean × kill) × (small/medium/large) × (pause=0 / pause=30s)
# — writes a JSON report under .dkg-repro-reports/
node scripts/repro/wm-persistence-regression.mjs --matrix
```

The pre-fix matrix evidence is checked in at
`.dkg-repro-reports/matrix-20260525-092823.json` (forensic per-graph
detail was trimmed to summary fields to keep the diff reviewable; re-run
the matrix to regenerate full detail locally). The post-fix verification
runs are at `.dkg-repro-reports/verify-{small,medium,kill}.json`.

The bug report at `docs/bugs/wm-persistence-regression.md` walks through
the four coordinated changes (`oxigraph.ts` atomic write + non-silent
hydrate + drained close; `dkg-agent.ts` `store.close()` on `stop()`).

## Testing the importer manifest library (PR #642 + #641)

Unit tests:

```bash
node --test scripts/lib/__tests__/manifest.test.mjs
```

End-to-end against a running daemon (uses the harness's isolation
contract — point it at a throwaway `DKG_HOME`, not `~/.dkg`):

```bash
DKG_HOME="$PWD/.dkg-test" DKG_API_PORT=54293 dkg start --foreground &

# In another shell:
node -e "
import('./scripts/lib/dkg-daemon.mjs').then(async ({ makeClient }) => {
  const client = makeClient({ apiBase: 'http://127.0.0.1:54293' });
  await client.ensureProject({ id: 'manifest-smoke', name: 'Manifest Smoke' });
  await client.ensureSubGraph(client.cgId, 'meta');
  const { createImportManifest, markPartitionStatus, loadImportManifest, pendingPartitions }
    = await import('./scripts/lib/manifest.mjs');
  const partitions = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
  await createImportManifest({ client, importId: 'smoke-1', partitions, subGraphName: 'meta' });
  await markPartitionStatus({ client, importId: 'smoke-1', partitionKey: 'src/a.ts', status: 'done', subGraphName: 'meta' });
  const { partitions: state } = await loadImportManifest({ client, importId: 'smoke-1', subGraphName: 'meta' });
  console.log(state);
  console.log('pending:', pendingPartitions(state).map((p) => p.key));
});
"
```

The expected output is `[{key: 'src/a.ts', status: 'done', ...}, {key: 'src/b.ts', status: 'pending', ...}, {key: 'src/c.ts', status: 'pending', ...}]` with `pending: ['src/b.ts', 'src/c.ts']`.

Per the SKILL.md at `packages/cli/skills/dkg-importer/SKILL.md`, both
`createImportManifest` and `markPartitionStatus` now promote their root
URIs to SWM so a peer node can read the manifest back and resume — feel
free to validate that by `dkg_query`-ing the `imp:partition` /
`imp:statusEvent` triples from a second daemon paired with the first.

## Reading the docs

- `docs/adr/0002-importer-chunking-contract.md` — when a client must
  chunk, what the limits are, what the server's response codes mean.
- `docs/adr/0003-code-graph-ontology-convergence.md` — canonical URI
  shape for the `urn:dkg:code:*` namespace, who owns which slice.
- `docs/specs/SPEC_ASYNC_PROMOTE_QUEUE.md` — RFC for the future async
  WM→SWM queue (no code yet; this is for sign-off).
- `packages/cli/skills/dkg-importer/SKILL.md` — agent-readable manual
  for bulk imports; the canonical reference for the chunking contract,
  manifest pattern, and look-before-mint URI rules.

## Reviewing as five separate PRs

The individual PRs are still the merge units. If you want to review
piece by piece:

- PR #636 → `gh pr view 636 --repo OriginTrail/dkg --web`
- PR #640 → `gh pr view 640 --repo OriginTrail/dkg --web`
- PR #641 → `gh pr view 641 --repo OriginTrail/dkg --web`
- PR #642 → `gh pr view 642 --repo OriginTrail/dkg --web`
- PR #643 → `gh pr view 643 --repo OriginTrail/dkg --web`

Each PR's first commit is the original work; subsequent commits address
Codex-review feedback. The current tips include **two rounds** of Codex
review fixes:

Round 1 (the original review):
- WM-persistence fix landed
- Manifest library bugs (binding parsing, root selection, SAMPLE+MAX
  decorrelation)
- ADR factual claims (URI encoding, scoped vs unscoped package names,
  `owl:` prefix)
- RFC state-machine + control-graph + lease-reclaim concerns
- Repro harness pid-reuse + supervisor-race + literal-string-`~/.dkg`
  safety holes

Round 2 (after the round-1 fixes were pushed):
- **PR #640**: `flushNow()` now THROWS instead of swallowing
  write/fsync/rename errors so `flush()` / `close()` callers
  (`DKGAgent.stop()`) fail loudly on ENOSPC / EACCES / EROFS instead
  of reporting a clean shutdown while losing WM. Plus a new
  `packages/storage/test/oxigraph-persistence.test.ts` covering the
  durability contract (close()-persists-across-reopen, corrupt-store
  quarantine, flush-error-propagation, debounce-race) — 5 tests, all
  passing.
- **PR #636/640**: harness now refuses to reuse a pre-existing daemon
  in `--spawn` mode (would let a `dkg start --foreground` supervisor
  respawn the worker mid-kill); also rejects `--no-spawn` +
  `--restart-mode=kill` / `--matrix` since the harness doesn't own
  the supervisor's pgid in that path.
- **PR #641**: ADR 0002 now shows `contextGraphId` (+ `subGraphName`)
  in the write/promote API examples — the daemon's request validator
  rejects calls that omit them. ADR 0003 uses the scoped, percent-
  encoded `<pkgName>` form in the `owl:sameAs` examples and wraps the
  reconciliation SPARQL in `GRAPH ?g { ... }`.
- **PR #642**: `markPartitionStatus` now promotes BOTH `partIri` and
  `evIri` so the new `partIri imp:statusEvent evIri` edge actually
  reaches SWM. `unquote()` is now robust to both Oxigraph flat-string
  bindings and SPARQL 1.1 results-JSON cells. New integration-style
  tests in `scripts/lib/__tests__/manifest.test.mjs` cover the full
  WM→SWM round-trip under both binding shapes and confirmed to FAIL
  when the promote-root list reverts to `[evIri]` only.
- **PR #643**: RFC's `PromoteJob` TypeScript interface now includes
  `failed_retrying` in the state enum; worker loop explicitly picks
  up `failed_retrying` jobs whose `nextRetryAt <= now`; added a
  per-`(contextGraphId, assertionName)` lock so two concurrent
  `promote-async` calls against the same assertion can't both run.
