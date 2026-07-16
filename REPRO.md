# Graphify import fixes — worktree README

This worktree (`fix/graphify-import-issues` branched off `main`) addresses fallout
from [issue #596](https://github.com/OriginTrail/dkg/issues/596) and
[PR #602](https://github.com/OriginTrail/dkg/pull/602) — the Graphify codebase-import
experiment that exposed WM persistence, daemon API perf, importer ecosystem, and
ontology-convergence issues.

## Isolation contract

Another agent is concurrently working on OT-RFC-38 Phase A (`feat/cg-memory-model`).
To keep our daemon lifecycle work (Phase 1 does `kill -9` cycles) from touching their
daemon and store, every command in this worktree that talks to a daemon MUST use:

```sh
# Run from the worktree root.
export WORKTREE_ROOT="$(git rev-parse --show-toplevel)"
export DKG_HOME="$WORKTREE_ROOT/.dkg-repro"
export DKG_API_PORT=54293
```

- `DKG_HOME` — separate Oxigraph store, separate auth token, separate config from
  the default `~/.dkg` (and from any other agent's daemon-state dir).
- `DKG_API_PORT=54293` — picked from the IANA ephemeral range (49152–65535) to
  avoid colliding with the default 9200, devnet ports `19101+`, or anything common.

The repro script (`scripts/repro/wm-persistence-regression.mjs`) has a hard guard
refusing to run if `DKG_API_PORT` is 9200.

## Quick reference

All commands assume `WORKTREE_ROOT`, `DKG_HOME`, `DKG_API_PORT` are exported as above.

- **One-time setup** — initialise the repro `DKG_HOME` (uses the globally
  installed `dkg` binary; not the monorepo source, which isn't built in this
  worktree). The wizard prompts pick `apiPort=54293` and disable auth:

  ```sh
  dkg init
  ```

- **Start the repro daemon manually** (the repro script does this on its own when
  `--spawn` is set, which is the default):

  ```sh
  dkg start --foreground
  ```

- **Run the repro script** (writes a JSON report under `.dkg-repro-reports/`):

  ```sh
  node scripts/repro/wm-persistence-regression.mjs \
    --num-assertions=5 --quads-per-assertion=500 --restart-mode=clean
  ```

  Or the full matrix (clean × kill × small/medium/large × pause0/pause30):

  ```sh
  node scripts/repro/wm-persistence-regression.mjs --matrix
  ```

- **Read the auth token** (auth is disabled in the repro init, but some importers
  still send a bearer):

  ```sh
  cat "$DKG_HOME/auth.token"
  ```

- **Tear down** (drop the store but keep the daemon config + wallet):

  ```sh
  pkill -f "$DKG_HOME"
  rm -rf "$DKG_HOME/store.nq" \
         "$DKG_HOME/node-ui.db"* \
         "$DKG_HOME/vector-store.db"* \
         "$DKG_HOME/daemon.pid" \
         "$DKG_HOME/daemon.log" \
         "$DKG_HOME/api.port"
  ```

  Or full reset (re-runs of `dkg init` are then required):

  ```sh
  pkill -f "$DKG_HOME"
  rm -rf "$DKG_HOME"/*
  ```

## What this worktree will NOT touch

To minimise merge-time pain when both branches eventually land on `main`:

- `packages/agent/src/swm/**`
- `packages/publisher/src/**`
- `packages/chain/src/**`
- Non-trivial edits to `packages/agent/src/dkg-agent.ts` (~13k-line file, heavily
  co-edited by the other agent). The single-line addition in `stop()` to call
  `await this.tripleStore.close()` is a deliberate exception — see
  `docs/bugs/wm-persistence-regression.md`.

## Phase status

- **Phase 1 (DONE)** — Reproduce the WM persistence regression and document it.
  Artefacts: this README, `scripts/repro/wm-persistence-regression.mjs`,
  `docs/bugs/wm-persistence-regression.md`, and the matrix evidence under
  `.dkg-repro-reports/matrix-20260525-092823.json`.
- **Phase 2** — Fix the WM persistence regression itself. Tracked in a follow-up
  PR; see `docs/bugs/wm-persistence-regression.md` "Suggested fix shape".
- **Phases 3–6** — Importer-helpers library, agent-readable SKILL, two ADRs
  (chunking contract + code-graph ontology), upstream PR #602 review comment,
  async-promote RFC. Each lands as its own PR.
