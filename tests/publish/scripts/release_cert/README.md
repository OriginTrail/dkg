# Release certification — additive harness (M1–M5)

Additive module next to the existing publish tests. Nothing here modifies the
existing jobs, tables, or dashboards.

## Pieces

| File | Milestone | What it does |
|---|---|---|
| `schema.sql` | M1 | Creates `queue_snapshots`, `releases`, `publish_layer_ops`, `scorecards`, `incidents` (idempotent, `IF NOT EXISTS`) |
| `db.mjs` | M1 | pg client using the existing `DB_*_PUBLISH` env contract (testnet DB) |
| `queue_state_recorder.mjs` | M1 | Polls each node's `/api/status` (+ `/api/diagnostics/backpressure` when a token is configured) on a 30s loop → `queue_snapshots` |
| `release_watcher.mjs` | M1 | Polls npm dist-tags for `@origintrail-official/dkg` → `releases` (dashboard annotation lines + scorecard/campaign trigger) |
| `blackbox_nightly.sh` | M2 | Conductor + 2 locally spawned participants inside the job container: fresh CG + fresh SWM content on a local curator, participants prove subscription parity |
| `layered_suite.mjs` | M3 | Staged WM → SWM → VM ops with receiver-side verification + payload-size matrix → `publish_layer_ops` (public CG by default; private via `RC_CG_PRIVATE`) |
| `cg_rotate.mjs` | M3 | Ensures weekly public CG + permanent aging CG (+ optional private pair) exist, registered, and subscribed — idempotent daily cron |
| `scorecard.mjs` | M4 | T+1h/6h/24h release verdicts (PASS/DEGRADED/FAIL/INCONCLUSIVE) vs 24h pre-release baseline → `scorecards` + digest (Slack when `SLACK_WEBHOOK_SCORECARD` is set) |
| `canary_gate.mjs` | M4 | Canary smoke gate — armed, needs the fleet canary edge + `next`-tag release flow |
| `cold_start_sync.mjs` | M5 | Fresh throwaway edge in-container → subscribe → time-to-parity with exact triple-count parity → `publish_layer_ops` (`cold_start`) |
| `capture_incident.mjs` | Q3 | On non-healthy backpressure states: captures node evidence bundles → `incidents` + prints a ready ListenerBoi prompt |
| `rollback_drill.mjs` | M5 | update → verify → rollback → verify drill — armed, needs a fleet edge (`RC_FLEET_SSH`/`RC_FLEET_API`), never the shared beacons |
| `../../dashboards/release-certification-dashboard.json` | M1–Q2 | "DKG Release Certification" dashboard (uid `dkg-release-cert`): queue state/age/depth, layer success + latency, scorecards, top store occupants, release lines |

## Running

```bash
# no DB needed — prints what would be inserted
RC_DRY=1 RC_DURATION_S=1 node scripts/release_cert/queue_state_recorder.mjs
RC_DRY=1 node scripts/release_cert/release_watcher.mjs

# real runs (Jenkins provides the DB env + node tokens)
npm run rc:recorder   # RC_DURATION_S=840 RC_INTERVAL_S=30 by default
npm run rc:watcher
```

Env: `RC_NODES` (JSON `[{name,url,tokenEnv?,network?}]`, defaults to the 4 testnet
beacons), `RC_DURATION_S`, `RC_INTERVAL_S`, `RC_TRACK_TAGS`, `RC_DRY`.
Per-node tokens (`V10_TOKEN_TESTNET1..4`) unlock the lane-level diagnostics rows;
without them the recorder still records status + admission (npm-release nodes
report `backpressure: null` — recorded as `no-backpressure-field`, which is data,
not an error).

## Jenkins jobs (new, additive)

- `V10_Release_Cert_QueueRecorder` — cron `*/15 * * * *`, runs the recorder for
  14 min per build (continuous coverage from a scheduled job).
- `V10_Release_Cert_ReleaseWatcher` — cron `*/5 * * * *`, runs the watcher once.

Both check out this branch, `npm install` in `tests/publish/`, and rely on the
global DB env vars already configured on the controller. DB note: the Jenkins DB
user is INSERT-only — if `schema.sql` fails with a permissions error on first
run, the DB owner applies `schema.sql` once and everything proceeds.
