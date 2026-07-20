/**
 * Harden migration — executor.
 *
 * Executes (or resumes) the legacy-container migration whose plan lives
 * in steps.ts and whose safety invariants are documented in the facade
 * (../blazegraph-harden.ts). Every docker command is sourced from the
 * SAME step definitions the dry-run plan renders — never hand-written —
 * so the printed plan and the executed migration cannot drift apart.
 */
import { mkdir, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as os from 'node:os';
import {
  BLAZEGRAPH_CONTAINER_PORT,
  BLAZEGRAPH_JOURNAL_FILE,
  blazegraphVolumeName,
  computeBlazegraphHeapMb,
  defaultDockerRunner,
  waitForBlazegraphReady,
  type DockerRunner,
} from '../blazegraph-docker.js';
import { storeHardenLockPath } from '../store-runtime-monitor.js';
import {
  HARDEN_BACKUP_SUFFIX,
  inspectHardenState,
  parseInspect,
} from './state.js';
import {
  HARDEN_DISK_PREFLIGHT_FACTOR,
  HARDEN_EXPORT_FILENAME,
  hardenStepDefs,
  planHardenMigration,
  type HardenStep,
} from './steps.js';
import { askOk, identityTagPresent } from './verify.js';
import { rollbackToBackup, type RollbackResult } from './rollback.js';

export interface ExecuteHardenMigrationOptions {
  containerName: string;
  namespace: string;
  migrationDir: string;
  /**
   * DKG config home (`dkgDir()`), resolved by the caller exactly the way
   * the `dkg store harden` command resolves its config. The harden lock
   * marker (`<dkgHome>/.store-harden.lock`, see
   * store-runtime-monitor.ts `storeHardenLockPath`) lives here so the
   * daemon's runtime store monitor — which reads the same path — can
   * suspend its docker restarts while the migration holds the container
   * stopped.
   */
  dkgHome: string;
  log: (m: string) => void;
  dryRun?: boolean;
  /** Host port override; default = the port read off the legacy container. */
  hostPort?: number;
  // Injectables (tests provide these; production callers omit them):
  docker?: DockerRunner;
  fetch?: typeof globalThis.fetch;
  env?: NodeJS.ProcessEnv;
  totalMemoryBytes?: () => number;
  /** Free-bytes probe for the disk preflight. Default: statfs(migrationDir). */
  freeDiskBytes?: (dir: string) => Promise<number>;
  /** Readiness-poll bounds for the verify step (tests shrink these). */
  readyTimeoutMs?: number;
  readyIntervalMs?: number;
}

export interface HardenMigrationResult {
  outcome: 'already-hardened' | 'hardened' | 'dry-run';
  containerName: string;
  /** Set when a backup container exists that the operator must remove manually. */
  backupContainerName: string | null;
  hostPort: number;
  /** On-disk journal export (retained after success as a second recovery copy). */
  exportPath: string | null;
  journalBytes: number | null;
  heapMb: number;
  /** Dry-run only: the step list that would execute. */
  steps?: HardenStep[];
}

async function defaultFreeDiskBytes(dir: string): Promise<number> {
  const fs = await statfs(dir);
  return fs.bsize * fs.bavail;
}

async function fileSize(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

async function mustRun(
  docker: DockerRunner,
  args: string[],
  what: string,
  opts?: { timeoutMs?: number; hint?: string },
): Promise<string> {
  const result = await docker.run(
    args,
    opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : undefined,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `${what} failed — docker ${args[0]} exited ${result.exitCode}. ` +
      `stderr: ${result.stderr.trim() || '(empty)'}` +
      (opts?.hint ? ` ${opts.hint}` : ''),
    );
  }
  return result.stdout;
}

/**
 * Post-`docker stop` state snapshot used by the export integrity checks.
 * `--size` makes docker compute `SizeRw` (writable-layer bytes) — the
 * journal lives in that layer on legacy containers, so an unchanged
 * SizeRw across the export proves the copied bytes never moved
 * underneath `docker cp`. (`docker exec stat` is NOT available here: the
 * container is stopped, and exec requires a running container.)
 */
interface StoppedContainerSnapshot {
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  sizeRw?: number;
}

async function inspectStoppedSnapshot(
  docker: DockerRunner,
  /** The export-integrity step's argv (`docker inspect --size <name>`). */
  args: string[],
  what: string,
  hint: string,
): Promise<StoppedContainerSnapshot> {
  const out = await mustRun(docker, args, what, { hint });
  const info = parseInspect(out);
  if (info == null) {
    throw new Error(`${what} returned unparseable docker inspect output. ${hint}`);
  }
  return {
    running: info.State?.Running === true,
    startedAt: info.State?.StartedAt,
    finishedAt: info.State?.FinishedAt,
    sizeRw: typeof info.SizeRw === 'number' ? info.SizeRw : undefined,
  };
}

/**
 * Execute (or resume) the harden migration. See the facade module header
 * for the algorithm and the safety invariants. Throws on any predicate
 * failure; any failure after the swap (post-swap docker setup or
 * verification) additionally rolls back to the backup container before
 * throwing.
 */
export async function executeHardenMigration(
  opts: ExecuteHardenMigrationOptions,
): Promise<HardenMigrationResult> {
  const docker = opts.docker ?? defaultDockerRunner();
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const log = opts.log;
  const env = opts.env ?? process.env;
  const freeDiskBytes = opts.freeDiskBytes ?? defaultFreeDiskBytes;
  const { containerName, namespace, migrationDir } = opts;
  const backupName = `${containerName}${HARDEN_BACKUP_SUFFIX}`;
  const exportPath = join(migrationDir, HARDEN_EXPORT_FILENAME);
  const heapMb = computeBlazegraphHeapMb(
    (opts.totalMemoryBytes ?? os.totalmem)(),
    env.DKG_BLAZEGRAPH_HEAP_MB,
  );

  const info = await inspectHardenState(docker, containerName);

  if (info.state === 'absent') {
    throw new Error(
      `Container "${containerName}" not found (and no "${backupName}") — nothing to harden. ` +
      `Check \`docker ps -a\` and pass --container if the name differs.`,
    );
  }

  // The host port comes from HostConfig.PortBindings (durable, survives a
  // stop) with NetworkSettings.Ports as a runtime fallback. When neither
  // yields one AND the operator gave no --port, ABORT rather than guess
  // 9999 — recreating the store on a wrong port would strand the daemon
  // config pointing at nothing.
  const hostPort = opts.hostPort ?? info.hostPort;
  if (hostPort === undefined) {
    throw new Error(
      `Could not determine the host port for container "${containerName}": neither ` +
      `HostConfig.PortBindings nor NetworkSettings.Ports carries a binding for ` +
      `${BLAZEGRAPH_CONTAINER_PORT}/tcp (or 8080/tcp). Refusing to guess. ` +
      `Pass --port <port> (the port in your store URL, typically 9999).`,
    );
  }
  const baseUrl = `http://127.0.0.1:${hostPort}`;
  const sparqlUrl = `${baseUrl}/bigdata/namespace/${encodeURIComponent(namespace)}/sparql`;

  // Every docker command below comes from the SAME step definitions the
  // dry-run plan renders (hardenStepDefs) — never a hand-written argv, so
  // the printed plan and the executed migration cannot drift apart.
  const steps = hardenStepDefs({ containerName, namespace, hostPort, heapMb, migrationDir });

  if (opts.dryRun) {
    return {
      outcome: 'dry-run',
      containerName,
      backupContainerName: info.state === 'backup-only' ? backupName : null,
      hostPort,
      exportPath: null,
      journalBytes: null,
      heapMb,
      steps: planHardenMigration({
        containerName, namespace, hostPort, heapMb, migrationDir, state: info.state,
      }),
    };
  }

  // Already-hardened path: verify and report; nothing to migrate.
  if (info.state === 'hardened') {
    log(`Container "${containerName}" already has the journal volume mounted — verifying.`);
    if (!(await askOk(fetchImpl, sparqlUrl))) {
      throw new Error(
        `Hardened container "${containerName}" exists but ASK probe failed at ${sparqlUrl}. ` +
        `Check \`docker ps\` / \`docker logs ${containerName}\`.`,
      );
    }
    log(`ASK probe OK at ${sparqlUrl} — nothing to do.`);
    const backupExists = (await docker.run(['inspect', backupName])).exitCode === 0;
    return {
      outcome: 'already-hardened',
      containerName,
      backupContainerName: backupExists ? backupName : null,
      hostPort,
      exportPath: (await fileSize(exportPath)) != null ? exportPath : null,
      journalBytes: null,
      heapMb,
    };
  }

  await mkdir(migrationDir, { recursive: true });

  // BLOCKER-1(a): write the harden lock BEFORE the first mutating step.
  // The daemon's runtime store monitor (store-runtime-monitor.ts) reads
  // this exact path and suspends its docker restarts while it exists —
  // otherwise its 6x30s failure ladder would `docker restart` the
  // deliberately-stopped legacy container while a multi-minute
  // `docker cp` is still reading the journal out of it (torn export).
  const lockPath = storeHardenLockPath(opts.dkgHome);
  await mkdir(opts.dkgHome, { recursive: true });
  await writeFile(
    lockPath,
    `${JSON.stringify({ pid: process.pid, containerName, startedAt: new Date().toISOString() })}\n`,
    'utf-8',
  );
  log(`Wrote harden lock ${lockPath} — the daemon's store monitor suspends restarts while it exists.`);
  try {
    let exportedSize: number;
    // MINOR-10: every abort between `docker stop` and the rename leaves the
    // legacy container stopped; each such error must say so and name the
    // restore command.
    const stoppedHint =
      `NOTE: the legacy store container "${containerName}" is currently STOPPED — ` +
      `restore service with: docker start ${containerName} (then re-run harden when ready).`;

    if (info.state === 'legacy') {
      // (2) In-container journal size — only readable while running.
      let preSize: number | null = null;
      if (info.running) {
        const out = await mustRun(
          docker,
          steps.journalSize.dockerArgs,
          'reading in-container journal size',
        );
        preSize = Number.parseInt(out.trim(), 10);
        if (!Number.isFinite(preSize) || preSize <= 0) {
          throw new Error(
            `Unexpected journal size "${out.trim()}" from ${containerName}:${BLAZEGRAPH_JOURNAL_FILE} — refusing to migrate.`,
          );
        }
        log(`Journal size in container: ${preSize} bytes.`);
      } else {
        log(
          `WARNING: container is stopped — in-container journal size unknown; ` +
          `export validation falls back to size > 0.`,
        );
      }

      // (3) Disk preflight — a partial `docker cp` onto a full disk is the
      // classic corrupted-copy path. The size predicates would catch it, but
      // aborting up-front is cheaper than a 5 GB copy that must be redone.
      // 2.2x: the export copy AND the docker-volume seed copy typically
      // share the root filesystem, so both journals coexist transiently.
      if (preSize != null) {
        const free = await freeDiskBytes(migrationDir);
        const needed = Math.ceil(preSize * HARDEN_DISK_PREFLIGHT_FACTOR);
        if (free < needed) {
          throw new Error(
            `Not enough free disk at ${migrationDir}: need ~${needed} bytes ` +
            `(${HARDEN_DISK_PREFLIGHT_FACTOR}x journal — the export copy plus the docker-volume ` +
            `seed copy typically share the root filesystem), have ${free}. ` +
            `Pass --migration-dir <dir> on a larger mount.`,
          );
        }
      }

      // (4) Graceful stop lets s6 → Tomcat → Blazegraph quiesce and flush the
      // RWStore before the journal is copied. Idempotent on a stopped container.
      log(`Stopping ${containerName} (up to 120s for a clean RWStore flush)…`);
      await mustRun(docker, steps.stop.dockerArgs, 'stopping the legacy container', {
        timeoutMs: 180_000,
      });

      // (4b) Post-stop baseline for the export integrity checks below.
      // (`docker exec stat` is unavailable now — the container is stopped —
      // so integrity rides on State timestamps + writable-layer SizeRw.)
      const postStop = await inspectStoppedSnapshot(
        docker, steps.exportIntegrity.dockerArgs, 'inspecting the stopped legacy container', stoppedHint,
      );
      if (postStop.running) {
        throw new Error(
          `Container "${containerName}" reports Running=true immediately after docker stop — ` +
          `something restarted it (the daemon's store monitor? systemd? another operator?). ` +
          `Stop the daemon (dkg stop) or find the interfering process, then re-run harden. ` +
          `Nothing was migrated; the legacy container remains authoritative.`,
        );
      }

      // (5) Export — ALWAYS re-exported in the legacy path, never reused.
      // A pre-existing export here is stale by construction: reaching this
      // branch with preSize != null means the container was RUNNING at
      // entry, i.e. it has run (and possibly written) since any earlier
      // export was taken. Size predicates cannot catch a same-size content
      // change, and an RWStore journal that grew makes the old copy short.
      // The only resume state where an on-disk export is the source of
      // record is 'backup-only' (rename already happened → the container
      // never ran again), handled in the other branch below. docker cp
      // overwrites the destination, so a torn previous export is replaced.
      log(`Exporting journal to ${exportPath}…`);
      await mustRun(
        docker,
        steps.exportJournal.dockerArgs,
        'exporting the journal (docker cp)',
        { hint: stoppedHint },
      );

      // (5b) BLOCKER-1(b): the container MUST NOT have run while the export
      // was copying — a restart mid-`docker cp` yields a torn journal that
      // no size predicate can reliably catch. Any change to Running /
      // StartedAt / FinishedAt since the post-stop baseline is proof of
      // interference; abort BEFORE any rename so the legacy container
      // stays authoritative.
      const postExport = await inspectStoppedSnapshot(
        docker, steps.exportIntegrity.dockerArgs, 're-inspecting the legacy container after the export', stoppedHint,
      );
      if (
        postExport.running ||
        postExport.startedAt !== postStop.startedAt ||
        postExport.finishedAt !== postStop.finishedAt
      ) {
        throw new Error(
          `Journal export integrity check failed: container "${containerName}" ran during the export ` +
          `(Running=${postExport.running}, StartedAt ${postStop.startedAt ?? '<unknown>'} → ` +
          `${postExport.startedAt ?? '<unknown>'}). Something restarted it mid-copy — most likely the ` +
          `daemon's runtime store monitor (is another daemon running without the harden lock?), ` +
          `systemd, or another operator. The exported copy may be torn and will NOT be used; ` +
          `no rename happened and the legacy container remains authoritative. ` +
          `${postExport.running
            ? `The legacy container is currently RUNNING again — service is up; re-run harden once the interference is resolved.`
            : stoppedHint}`,
        );
      }
      // (5c) BLOCKER-1(c): writable-layer size must be byte-identical to the
      // post-stop baseline — the journal lives in that layer on a legacy
      // container, so any change means the docker cp source moved under us.
      if (postStop.sizeRw != null && postExport.sizeRw != null) {
        if (postExport.sizeRw !== postStop.sizeRw) {
          throw new Error(
            `Journal export integrity check failed: the container's writable layer changed during ` +
            `the export (SizeRw ${postStop.sizeRw} → ${postExport.sizeRw} bytes) — the journal was ` +
            `written while docker cp read it. The exported copy may be torn and will NOT be used; ` +
            `no rename happened. ${stoppedHint}`,
          );
        }
      } else {
        log(
          `WARNING: docker inspect --size returned no SizeRw — skipping the byte-level export ` +
          `integrity check (the Running/StartedAt checks above still passed).`,
        );
      }

      const measured = await fileSize(exportPath);
      // Predicate — checked BEFORE any rename, so on failure the legacy
      // container is fully intact and a re-run simply retries the export.
      if (measured == null || measured <= 0 || (preSize != null && measured < preSize)) {
        throw new Error(
          `Journal export validation failed: exported ${measured ?? 'nothing'} bytes, ` +
          `expected ${preSize ?? '> 0'}. Legacy container "${containerName}" is untouched; ` +
          `re-run to retry. ${stoppedHint}`,
        );
      }
      exportedSize = measured;
      log(`Export verified: ${exportedSize} bytes.`);
    } else {
      // 'backup-only' resume: the rename already happened, so the export on
      // disk is the seed source of record. Refuse to guess if it's missing —
      // the backup container still holds the data and a human should look.
      const measured = await fileSize(exportPath);
      if (measured == null || measured <= 0) {
        throw new Error(
          `Resume state "backup-only" but no journal export at ${exportPath}. ` +
          `The data is safe in container "${backupName}" — restore it manually ` +
          `(docker rename ${backupName} ${containerName}; docker update --restart=unless-stopped ` +
          `${containerName}; docker start ${containerName}) and re-run harden.`,
        );
      }
      exportedSize = measured;
      log(`Resuming from backup-only state with export ${exportPath} (${exportedSize} bytes).`);
    }

    const legacyStoppedHint = info.state === 'legacy' ? stoppedHint : undefined;

    // (6) Volume create — idempotent.
    await mustRun(
      docker,
      steps.volumeCreate.dockerArgs,
      'creating the journal volume',
      { hint: legacyStoppedHint },
    );

    // (7) Seed the volume via a helper container from the SAME pinned image
    // (nothing new pulled). The script ALWAYS overwrites the volume journal
    // from the current export — a size-match skip would silently reuse a
    // rollback-stale copy whose size happens to equal the fresh export's
    // (RWStore rewrites pages in place) — and echoes the in-volume size for
    // validation against the CURRENT export.
    log(`Seeding volume ${blazegraphVolumeName(containerName)} from the export…`);
    const seedOut = await mustRun(
      docker,
      steps.seedVolume.dockerArgs,
      'seeding the journal volume',
      { hint: legacyStoppedHint },
    );
    const seededSize = Number.parseInt(seedOut.trim(), 10);
    if (seededSize !== exportedSize) {
      throw new Error(
        `Volume seed validation failed: volume journal is ${seedOut.trim()} bytes, ` +
        `export is ${exportedSize}. ` +
        (info.state === 'legacy'
          ? `Legacy container "${containerName}" is untouched; re-run to retry. ${stoppedHint}`
          : `Backup container "${backupName}" is untouched; inspect the volume, then re-run.`),
      );
    }

    // (8) Swap. After the rename the world state is 'backup-only', which is
    // exactly the resume entry point — a crash anywhere past here re-enters
    // at step (6) with all destructive work already behind it. The backup
    // can never auto-start on host reboot (it would fight the new container
    // for the port and the stale journal) and is NEVER rm'd by this tool.
    if (info.state === 'legacy') {
      log(`Renaming ${containerName} → ${backupName} (kept until you remove it).`);
      await mustRun(docker, steps.renameBackup.dockerArgs, 'renaming the legacy container', {
        hint: stoppedHint,
      });
    }

    // From here the world is post-swap: the authoritative data sits under
    // the backup name and nothing serves the daemon. ANY failure below —
    // disabling the backup's restart policy, creating the hardened
    // container, or the verification probes — must attempt the automatic
    // rollback. Scoping the rollback to verification only (as an earlier
    // revision did) strands the node with no store at all when e.g.
    // another process grabs the host port and `docker run` exits non-zero:
    // the untouched backup would sit one rename away while the operator
    // reads a raw docker error. `phase` only labels the failure for the
    // operator-facing message; the recovery path is identical.
    let phase: 'post-swap setup' | 'verification' = 'post-swap setup';
    try {
      await mustRun(
        docker,
        steps.disableBackupRestart.dockerArgs,
        'disabling the backup restart policy',
      );

      // (9) Create the hardened container on the SAME host port.
      log(`Creating hardened container ${containerName} (heap ${heapMb} MB)…`);
      await mustRun(
        docker,
        steps.runHardened.dockerArgs,
        'creating the hardened container',
      );

      // (10) Verify, (11) roll back on failure.
      phase = 'verification';
      await waitForBlazegraphReady({
        url: baseUrl,
        fetch: fetchImpl,
        intervalMs: opts.readyIntervalMs ?? 2_000,
        // Cold start of s6 + Tomcat + a multi-GB RWStore takes minutes (the
        // container's own health-start-period is 120s) — a short window here
        // would roll back a perfectly healthy migration mid-boot.
        timeoutMs: opts.readyTimeoutMs ?? 180_000,
        log,
      });
      if (!(await askOk(fetchImpl, sparqlUrl))) {
        throw new Error(`ASK probe failed at ${sparqlUrl}`);
      }
      if (!(await identityTagPresent(fetchImpl, sparqlUrl))) {
        throw new Error(
          `identity-tag probe returned no binding at ${sparqlUrl} — the migrated data did not follow`,
        );
      }
      // Same command as the journal-size step: the verify phase re-reads
      // the in-container size to prove the data followed the migration.
      const sizeOut = await mustRun(
        docker,
        steps.journalSize.dockerArgs,
        'reading the migrated journal size',
      );
      const migratedSize = Number.parseInt(sizeOut.trim(), 10);
      // >= because Blazegraph may extend the journal on open.
      if (!Number.isFinite(migratedSize) || migratedSize < exportedSize) {
        throw new Error(
          `migrated journal is ${sizeOut.trim()} bytes, expected >= ${exportedSize}`,
        );
      }
    } catch (err) {
      log(
        `${phase === 'verification' ? 'Verification' : 'Post-swap setup'} FAILED ` +
        `(${(err as Error).message}) — rolling back to ${backupName}.`,
      );
      let rollback: RollbackResult;
      try {
        rollback = await rollbackToBackup({ docker, containerName, backupName, log });
      } catch (rollbackErr) {
        // Spawn-level docker failure mid-rollback: report INCOMPLETE, never
        // pretend the legacy container came back.
        rollback = {
          complete: false,
          failedStep: 'docker-invocation',
          detail: (rollbackErr as Error).message ?? String(rollbackErr),
        };
        log(`ROLLBACK INCOMPLETE: docker invocation failed (${rollback.detail}).`);
      }
      if (rollback.complete) {
        throw new Error(
          `Harden ${phase} failed and the legacy container was restored. ` +
          `Cause: ${(err as Error).message}. The journal export is retained at ${exportPath}.`,
        );
      }
      throw new Error(
        `Harden ${phase} failed and the automatic rollback is INCOMPLETE ` +
        `(stopped at step "${rollback.failedStep}": ${rollback.detail ?? 'see log'}). ` +
        `The legacy container was NOT restored to service. Your data is still safe in ` +
        `container "${backupName}" and in the export at ${exportPath} — see the log above ` +
        `for the exact docker commands to finish the restore by hand. ` +
        `Cause of the failed ${phase}: ${(err as Error).message}.`,
      );
    }

    log(`Verification passed — ${containerName} is hardened.`);
    return {
      outcome: 'hardened',
      containerName,
      backupContainerName: backupName,
      hostPort,
      exportPath,
      journalBytes: exportedSize,
      heapMb,
    };
  } finally {
    // Always release the harden lock — the runtime monitor must regain its
    // restart authority whether the migration succeeded or threw.
    await rm(lockPath, { force: true }).catch(() => {});
  }
}
