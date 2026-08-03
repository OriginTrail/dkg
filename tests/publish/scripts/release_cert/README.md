# Release certification — M1: queue visibility + release markers

Additive module next to the existing publish tests. Nothing here modifies the
existing jobs, tables, or dashboards.

## Pieces

| File | What it does |
|---|---|
| `schema.sql` | Creates `queue_snapshots`, `releases`, `publish_layer_ops` (idempotent, `IF NOT EXISTS`) |
| `db.mjs` | pg client using the existing `DB_*_PUBLISH` env contract (testnet DB) |
| `queue_state_recorder.mjs` | Polls each node's `/api/status` (+ `/api/diagnostics/backpressure` when a token is configured) on a 30s loop and inserts `queue_snapshots` rows |
| `release_watcher.mjs` | Polls npm dist-tags for `@origintrail-official/dkg`, records every (tag, version) change into `releases` |
| `../../dashboards/release-certification-dashboard.json` | "DKG Release Certification" Grafana dashboard (uid `dkg-release-cert`): backpressure state timeline, admission in-flight/rejected, lane age/depth panels, release annotation lines from the `releases` table |

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
