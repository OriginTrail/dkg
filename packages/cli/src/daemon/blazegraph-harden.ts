/**
 * Legacy Blazegraph container migration — `dkg store harden`.
 *
 * # Why this exists (2026-07-18 mainnet wedge incident)
 *
 * The 15 mainnet-core Blazegraph containers were provisioned before the
 * survivability flags existed. They run with:
 *   - the journal (`/data/bigdata.jnl`) in the container WRITABLE LAYER
 *     (no volume mount) — `docker rm` would destroy the only copy;
 *   - no `-Xmx` — the JVM defaults to ~25% of host RAM and dies in a G1
 *     full-GC spiral under heavy sync-responder SPARQL, ending in an
 *     OutOfMemoryError storm that kills Tomcat's HTTP poller thread while
 *     the JVM stays alive (alive-but-deaf; `--restart unless-stopped`
 *     never fires);
 *   - no HEALTHCHECK — `docker ps` shows the wedged container as healthy;
 *   - unrotated json-file logs (>4 GB observed on fleet).
 *
 * This migrates such a container to the hardened shape produced by
 * `buildBlazegraphRunArgs` (blazegraph-docker.ts) WITHOUT ever putting the
 * journal at risk:
 *
 *   write harden lock (suspends the daemon's runtime store monitor so it
 *   can never `docker restart` the stopped container mid-export) →
 *   stop → export journal to disk → export integrity re-inspect →
 *   create volume → seed volume →
 *   rename old container to `<name>-backup` (restart policy disabled,
 *   NEVER removed by any code path here) → run hardened container →
 *   verify (readiness + ASK + identity-tag probe + journal byte size) →
 *   on ANY post-rename failure (setup OR verification), automatic
 *   rollback to the untouched backup → remove harden lock (finally).
 *
 * Every step is idempotent and the whole migration is resumable: state is
 * derived from `docker inspect` (no state file), and a crashed run picks
 * up where the world says it stopped. There is NO code path that deletes
 * the only copy of the journal — the exported file and the backup
 * container both survive until the operator removes them manually.
 *
 * Exposed via `dkg store harden` (commands/store.ts); deliberately NOT
 * auto-run at daemon boot.
 *
 * # Module layout
 *
 * This file is the public facade; the implementation lives in harden/
 * with one module per responsibility:
 *   - harden/state.ts    — docker-inspect state classification
 *   - harden/steps.ts    — step definitions + dry-run plan (the single
 *                          source of truth for every docker argv)
 *   - harden/executor.ts — execution/resume with predicate checks
 *   - harden/verify.ts   — post-swap SPARQL verification probes
 *   - harden/rollback.ts — automatic rollback to the backup container
 */
export {
  HARDEN_BACKUP_SUFFIX,
  inspectHardenState,
  type HardenState,
  type HardenStateInfo,
} from './harden/state.js';
export {
  HARDEN_DISK_PREFLIGHT_FACTOR,
  HARDEN_EXPORT_FILENAME,
  hardenStepDefs,
  planHardenMigration,
  type HardenPlanInput,
  type HardenStep,
  type HardenStepDefsInput,
} from './harden/steps.js';
export {
  executeHardenMigration,
  type ExecuteHardenMigrationOptions,
  type HardenMigrationResult,
} from './harden/executor.js';
export { type RollbackResult } from './harden/rollback.js';
