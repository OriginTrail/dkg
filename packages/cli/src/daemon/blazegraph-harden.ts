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
 * This module migrates such a container to the hardened shape produced by
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
 */
import { mkdir, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as os from 'node:os';
import {
  BLAZEGRAPH_CONTAINER_PORT,
  BLAZEGRAPH_DATA_DIR,
  BLAZEGRAPH_IMAGE,
  BLAZEGRAPH_JOURNAL_FILE,
  BLAZEGRAPH_TOMCAT_UID_GID,
  blazegraphVolumeName,
  buildBlazegraphRunArgs,
  computeBlazegraphHeapMb,
  defaultDockerRunner,
  waitForBlazegraphReady,
  type DockerRunner,
} from './blazegraph-docker.js';
import {
  STORE_META_GRAPH,
  STORE_META_PREDICATE,
  STORE_META_SUBJECT,
  storeHardenLockPath,
} from './store-health-check.js';

/** Suffix for the renamed legacy container kept as the recovery path. */
export const HARDEN_BACKUP_SUFFIX = '-backup';

/** Where the journal export lands inside the migration dir. */
export const HARDEN_EXPORT_FILENAME = 'bigdata.jnl';

/**
 * Free-disk multiple required before the export starts. The export copy
 * AND the docker-volume seed copy typically live on the same root
 * filesystem (named volumes are under /var/lib/docker), so the migration
 * transiently needs ~2 journals of space plus slack.
 */
export const HARDEN_DISK_PREFLIGHT_FACTOR = 2.2;

// --------------------------------------------------------------------
// State inspection
// --------------------------------------------------------------------

export type HardenState = 'absent' | 'legacy' | 'hardened' | 'backup-only';

export interface HardenStateInfo {
  state: HardenState;
  /** Host port bound to the container's HTTP port; undefined when unknowable. */
  hostPort?: number;
  running?: boolean;
}

type PortBindingMap = Record<string, Array<{ HostPort?: string }> | null>;

interface DockerInspectShape {
  State?: { Running?: boolean; StartedAt?: string; FinishedAt?: string };
  Mounts?: Array<{ Destination?: string; Name?: string }>;
  HostConfig?: { PortBindings?: PortBindingMap };
  NetworkSettings?: { Ports?: PortBindingMap };
  /** Writable-layer bytes; only populated by `docker inspect --size`. */
  SizeRw?: number;
}

function parseInspect(stdout: string): DockerInspectShape | null {
  try {
    const arr = JSON.parse(stdout);
    return Array.isArray(arr) && arr.length > 0 ? (arr[0] as DockerInspectShape) : null;
  } catch {
    return null;
  }
}

function portFromBindingMap(map: PortBindingMap | undefined): number | undefined {
  // Fleet-verified binding shape: '8080/tcp' → [{HostIp: '127.0.0.1',
  // HostPort: '9999'}]. Prefer the current image contract, fall back to
  // the literal 8080 the deployed islandora image exposes.
  const binding = map?.[`${BLAZEGRAPH_CONTAINER_PORT}/tcp`]
    ?? (BLAZEGRAPH_CONTAINER_PORT === 8080 ? undefined : map?.['8080/tcp']);
  if (!Array.isArray(binding) || binding.length === 0) return undefined;
  const port = Number(binding[0].HostPort);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

function inspectHostPort(info: DockerInspectShape | null): number | undefined {
  // HostConfig.PortBindings is the DURABLE configuration and stays
  // populated for stopped containers; NetworkSettings.Ports is runtime
  // state and is EMPTY once the container stops (which is exactly the
  // state a backup-only resume or a stopped-legacy run inspects).
  return portFromBindingMap(info?.HostConfig?.PortBindings)
    ?? portFromBindingMap(info?.NetworkSettings?.Ports);
}

/**
 * Classify the container into the migration state machine. State is
 * derived exclusively from docker — no state file — so a crashed
 * migration resumes correctly from whatever the world actually looks
 * like:
 *   - 'hardened': container exists with the named journal volume mounted
 *     at /data (the migration's end state, also the fresh-provision shape).
 *   - 'legacy': container exists without that mount (fleet-verified
 *     shape: `Mounts: []`, `Config.Volumes: null`).
 *   - 'backup-only': container missing but `<name>-backup` exists — a
 *     migration crashed between the rename and the hardened `docker run`.
 *   - 'absent': neither exists.
 */
export async function inspectHardenState(
  docker: DockerRunner,
  containerName: string,
): Promise<HardenStateInfo> {
  const result = await docker.run(['inspect', containerName]);
  if (result.exitCode === 0) {
    const info = parseInspect(result.stdout);
    const volume = blazegraphVolumeName(containerName);
    const hardened = info?.Mounts?.some(
      (m) => m.Destination === BLAZEGRAPH_DATA_DIR && m.Name === volume,
    ) === true;
    return {
      state: hardened ? 'hardened' : 'legacy',
      hostPort: inspectHostPort(info),
      running: info?.State?.Running === true,
    };
  }
  const backup = await docker.run(['inspect', `${containerName}${HARDEN_BACKUP_SUFFIX}`]);
  if (backup.exitCode === 0) {
    const info = parseInspect(backup.stdout);
    return { state: 'backup-only', hostPort: inspectHostPort(info) };
  }
  return { state: 'absent' };
}

// --------------------------------------------------------------------
// Pure plan generation (the dry-run / unit-test seam)
// --------------------------------------------------------------------

export interface HardenStep {
  id: string;
  description: string;
  /** Present when the step is a docker invocation. */
  dockerArgs?: string[];
  /** Postcondition that must hold before the next step runs. */
  predicate: string;
}

export interface HardenPlanInput {
  containerName: string;
  namespace: string;
  hostPort: number;
  heapMb: number;
  migrationDir: string;
  state: HardenState;
}

/** Shell script run inside the seed helper container (same pinned image —
 *  nothing new is pulled). Temp-file + `mv` makes the seed itself
 *  resumable: a crashed copy leaves `.seed.tmp`, never a torn journal.
 *
 *  The volume journal is ALWAYS overwritten from the current export —
 *  there is deliberately NO skip-if-present / skip-if-same-size fast
 *  path. Equal byte size does not imply equal content: Blazegraph's
 *  RWStore recycles pages in place, so after a verify-failure rollback
 *  (which leaves the seeded volume behind) the legacy container can keep
 *  writing WITHOUT the journal size ever changing. A size-match skip
 *  would then carry the stale attempt-1 copy into the hardened container
 *  on the next run, and verification cannot catch it — the identity tag
 *  and the size predicate hold for the stale copy too. Silent data loss.
 *
 *  Overwriting unconditionally is safe here: the volume copy is never
 *  the only copy (the export file and the backup/legacy container both
 *  still exist at this point) and only goes live after verify passes.
 *  The whole chain is `&&`-linked so a failed cp/mv/chown fails the
 *  step's exit code instead of falling through to echoing a (possibly
 *  stale) journal size. */
function seedScript(): string {
  return (
    `cp /seed/${HARDEN_EXPORT_FILENAME} ${BLAZEGRAPH_DATA_DIR}/.seed.tmp && ` +
    `mv ${BLAZEGRAPH_DATA_DIR}/.seed.tmp ${BLAZEGRAPH_JOURNAL_FILE} && ` +
    `chown ${BLAZEGRAPH_TOMCAT_UID_GID} ${BLAZEGRAPH_JOURNAL_FILE} && ` +
    `stat -c %s ${BLAZEGRAPH_JOURNAL_FILE}`
  );
}

function seedRunArgs(input: { containerName: string; migrationDir: string }): string[] {
  return [
    'run', '--rm',
    '--entrypoint', '/bin/sh',
    '-v', `${blazegraphVolumeName(input.containerName)}:${BLAZEGRAPH_DATA_DIR}`,
    '-v', `${input.migrationDir}:/seed:ro`,
    BLAZEGRAPH_IMAGE,
    '-c', seedScript(),
  ];
}

export function planHardenMigration(input: HardenPlanInput): HardenStep[] {
  const backupName = `${input.containerName}${HARDEN_BACKUP_SUFFIX}`;
  const exportPath = join(input.migrationDir, HARDEN_EXPORT_FILENAME);

  const verify: HardenStep = {
    id: 'verify',
    description:
      `verify: /bigdata/status ready + ASK {} HTTP 200 + identity-tag SELECT returns a ` +
      `binding + in-container journal size >= exported size (on failure: automatic ` +
      `rollback to ${backupName}; exported journal kept at ${exportPath})`,
    predicate: 'store answers queries and provably carries the migrated data',
  };
  const volumeCreate: HardenStep = {
    id: 'volume-create',
    description: `create named journal volume ${blazegraphVolumeName(input.containerName)} (idempotent)`,
    dockerArgs: ['volume', 'create', blazegraphVolumeName(input.containerName)],
    predicate: 'volume exists',
  };
  const seed: HardenStep = {
    id: 'seed-volume',
    description:
      `seed the volume from ${exportPath} via a helper container (same pinned image; ` +
      `the volume journal is ALWAYS overwritten from the current export — equal size ` +
      `does not imply equal content; chown ${BLAZEGRAPH_TOMCAT_UID_GID})`,
    dockerArgs: seedRunArgs(input),
    predicate: 'seed helper stdout (journal size in volume) equals the CURRENT exported size',
  };
  const runHardened: HardenStep = {
    id: 'run-hardened',
    description:
      `create hardened container ${input.containerName} (heap ${input.heapMb} MB, ` +
      `journal volume, healthcheck, log caps)`,
    dockerArgs: buildBlazegraphRunArgs({
      containerName: input.containerName,
      hostPort: input.hostPort,
      namespace: input.namespace,
      heapMb: input.heapMb,
    }),
    predicate: 'container created and starts',
  };

  switch (input.state) {
    case 'hardened':
      return [verify];
    case 'backup-only':
      // Resume after a crash between rename and hardened run. The export
      // must already exist on disk; the executor refuses to proceed
      // otherwise (the backup container still holds the data either way).
      return [volumeCreate, seed, runHardened, verify];
    case 'legacy':
      return [
        {
          id: 'journal-size',
          description: `read in-container journal size (docker exec stat ${BLAZEGRAPH_JOURNAL_FILE})`,
          dockerArgs: ['exec', input.containerName, 'stat', '-c', '%s', BLAZEGRAPH_JOURNAL_FILE],
          predicate: 'journal size known (skipped when the container is stopped)',
        },
        {
          id: 'disk-preflight',
          description:
            `require free disk at ${input.migrationDir} >= ${HARDEN_DISK_PREFLIGHT_FACTOR}x journal size ` +
            `(export copy + docker-volume seed copy usually share the root filesystem)`,
          predicate: 'enough free space for the journal export AND the volume seed copy',
        },
        {
          id: 'stop',
          description: `docker stop -t 120 ${input.containerName} (graceful s6 -> Tomcat shutdown flushes RWStore)`,
          dockerArgs: ['stop', '-t', '120', input.containerName],
          predicate: 'container stopped',
        },
        {
          id: 'export-journal',
          description: `docker cp the journal out to ${exportPath} (skipped if a complete export already exists)`,
          dockerArgs: ['cp', `${input.containerName}:${BLAZEGRAPH_JOURNAL_FILE}`, exportPath],
          predicate: 'exported size > 0 and >= in-container size; abort BEFORE any rename on mismatch',
        },
        {
          id: 'export-integrity',
          description:
            `re-inspect ${input.containerName} after the export: it must NOT have run during the ` +
            `copy (Running false, StartedAt/FinishedAt unchanged since the post-stop baseline) and ` +
            `the writable-layer size (SizeRw) must be unchanged`,
          dockerArgs: ['inspect', '--size', input.containerName],
          predicate: 'container stayed stopped for the whole export and the journal bytes never moved; abort BEFORE any rename otherwise',
        },
        volumeCreate,
        seed,
        {
          id: 'rename-backup',
          description: `docker rename ${input.containerName} ${backupName} (backup is NEVER removed by this tool)`,
          dockerArgs: ['rename', input.containerName, backupName],
          predicate: 'legacy container preserved under the backup name',
        },
        {
          id: 'disable-backup-restart',
          description: `docker update --restart=no ${backupName} (backup can never auto-start on host reboot)`,
          dockerArgs: ['update', '--restart=no', backupName],
          predicate: 'backup restart policy disabled',
        },
        runHardened,
        verify,
      ];
    case 'absent':
      return [];
  }
}

// --------------------------------------------------------------------
// Executor
// --------------------------------------------------------------------

export interface ExecuteHardenMigrationOptions {
  containerName: string;
  namespace: string;
  migrationDir: string;
  /**
   * DKG config home (`dkgDir()`), resolved by the caller exactly the way
   * the `dkg store harden` command resolves its config. The harden lock
   * marker (`<dkgHome>/.store-harden.lock`, see
   * store-health-check.ts `storeHardenLockPath`) lives here so the
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

/** Bounded ASK {} against the namespace SPARQL endpoint; true on HTTP 200. */
async function askOk(
  fetchImpl: typeof globalThis.fetch,
  sparqlUrl: string,
): Promise<boolean> {
  try {
    const res = await fetchImpl(sparqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/sparql-results+json',
      },
      body: `query=${encodeURIComponent('ASK {}')}`,
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Cheap named-graph presence probe: every daemon-booted namespace carries
 * the store identity tag (store-health-check.ts `checkOrSetStoreIdentity`),
 * so a binding here proves the DATA followed the migration, not just that
 * an empty namespace answers ASK. Vocabulary imported from
 * store-health-check.ts — the writer of the tag — so the probe can never
 * drift from what the daemon actually writes.
 */
async function identityTagPresent(
  fetchImpl: typeof globalThis.fetch,
  sparqlUrl: string,
): Promise<boolean> {
  const query =
    `SELECT ?name WHERE { GRAPH <${STORE_META_GRAPH}> { ` +
    `<${STORE_META_SUBJECT}> <${STORE_META_PREDICATE}> ?name } }`;
  try {
    const res = await fetchImpl(sparqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/sparql-results+json',
      },
      body: `query=${encodeURIComponent(query)}`,
    });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null) as
      | { results?: { bindings?: unknown[] } }
      | null;
    return (body?.results?.bindings?.length ?? 0) > 0;
  } catch {
    return false;
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
  containerName: string,
  what: string,
  hint: string,
): Promise<StoppedContainerSnapshot> {
  const out = await mustRun(docker, ['inspect', '--size', containerName], what, { hint });
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
 * Execute (or resume) the harden migration. See the module header for the
 * algorithm and the safety invariants. Throws on any predicate failure;
 * any failure after the swap (post-swap docker setup or verification)
 * additionally rolls back to the backup container before throwing.
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
  // The daemon's runtime store monitor (store-health-check.ts) reads this
  // exact path and suspends its docker restarts while the file exists —
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
          ['exec', containerName, 'stat', '-c', '%s', BLAZEGRAPH_JOURNAL_FILE],
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
      await mustRun(docker, ['stop', '-t', '120', containerName], 'stopping the legacy container', {
        timeoutMs: 180_000,
      });

      // (4b) Post-stop baseline for the export integrity checks below.
      // (`docker exec stat` is unavailable now — the container is stopped —
      // so integrity rides on State timestamps + writable-layer SizeRw.)
      const postStop = await inspectStoppedSnapshot(
        docker, containerName, 'inspecting the stopped legacy container', stoppedHint,
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
        ['cp', `${containerName}:${BLAZEGRAPH_JOURNAL_FILE}`, exportPath],
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
        docker, containerName, 're-inspecting the legacy container after the export', stoppedHint,
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
      ['volume', 'create', blazegraphVolumeName(containerName)],
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
      seedRunArgs({ containerName, migrationDir }),
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
      await mustRun(docker, ['rename', containerName, backupName], 'renaming the legacy container', {
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
        ['update', '--restart=no', backupName],
        'disabling the backup restart policy',
      );

      // (9) Create the hardened container on the SAME host port.
      log(`Creating hardened container ${containerName} (heap ${heapMb} MB)…`);
      await mustRun(
        docker,
        buildBlazegraphRunArgs({ containerName, hostPort, namespace, heapMb }),
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
      const sizeOut = await mustRun(
        docker,
        ['exec', containerName, 'stat', '-c', '%s', BLAZEGRAPH_JOURNAL_FILE],
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

export interface RollbackResult {
  complete: boolean;
  /** Set when incomplete: the step that failed (later steps did not run). */
  failedStep?: string;
  detail?: string;
}

/**
 * Automatic rollback after a failed post-swap verification: remove the
 * NEW container (its volume holds only a copy of the journal — verified
 * via docker inspect before the rm), restore the backup under its
 * original name, and start it with the original restart policy. The
 * exported journal on disk is deliberately left in place.
 *
 * Every step's exit code is checked. On the FIRST failure the rollback
 * STOPS — later steps must not run, because e.g. a `docker start
 * <containerName>` after a failed `rm -f` would start the
 * failed-verification container, not the restored legacy one. The log
 * then carries the exact remaining docker commands for the operator, and
 * the caller reports the rollback as INCOMPLETE (never "restored").
 */
async function rollbackToBackup(opts: {
  docker: DockerRunner;
  containerName: string;
  backupName: string;
  log: (m: string) => void;
}): Promise<RollbackResult> {
  const { docker, containerName, backupName, log } = opts;
  const cmdRm = `docker rm -f ${containerName}`;
  const cmdRename = `docker rename ${backupName} ${containerName}`;
  const cmdPolicy = `docker update --restart=unless-stopped ${containerName}`;
  const cmdStart = `docker start ${containerName}`;
  const failStep = (
    step: string,
    detail: string,
    remaining: string[],
  ): RollbackResult => {
    log(
      `ROLLBACK INCOMPLETE at step "${step}": ${detail}\n` +
      `The legacy container has NOT been restored to service. Finish the restore manually:\n` +
      remaining.map((c) => `  ${c}`).join('\n'),
    );
    return { complete: false, failedStep: step, detail };
  };

  // Paranoia gate: only rm a container that provably mounts the named
  // volume (i.e. is the hardened container we just created, holding a
  // COPY). A name collision with anything else must abort the rm.
  const inspect = await docker.run(['inspect', containerName]);
  if (inspect.exitCode === 0) {
    const parsed = parseInspect(inspect.stdout);
    const hasVolume = parsed?.Mounts?.some(
      (m) => m.Destination === BLAZEGRAPH_DATA_DIR
        && m.Name === blazegraphVolumeName(containerName),
    ) === true;
    if (!hasVolume) {
      log(
        `ROLLBACK HALTED: "${containerName}" does not mount the expected volume — ` +
        `refusing to remove it. Manual intervention required (backup: ${backupName}).`,
      );
      return {
        complete: false,
        failedStep: 'volume-gate',
        detail: `"${containerName}" does not mount ${blazegraphVolumeName(containerName)}; rm refused`,
      };
    }
    const rmResult = await docker.run(['rm', '-f', containerName]);
    if (rmResult.exitCode !== 0) {
      return failStep(
        'rm-failed-container',
        `docker rm -f exited ${rmResult.exitCode}: ${rmResult.stderr.trim() || '(no stderr)'}`,
        [cmdRm, cmdRename, cmdPolicy, cmdStart],
      );
    }
  }
  const renameResult = await docker.run(['rename', backupName, containerName]);
  if (renameResult.exitCode !== 0) {
    return failStep(
      'rename-backup',
      `docker rename exited ${renameResult.exitCode}: ${renameResult.stderr.trim() || '(no stderr)'}`,
      [cmdRename, cmdPolicy, cmdStart],
    );
  }
  const policyResult = await docker.run(['update', '--restart=unless-stopped', containerName]);
  if (policyResult.exitCode !== 0) {
    return failStep(
      'restore-restart-policy',
      `docker update exited ${policyResult.exitCode}: ${policyResult.stderr.trim() || '(no stderr)'}`,
      [cmdPolicy, cmdStart],
    );
  }
  const startResult = await docker.run(['start', containerName]);
  if (startResult.exitCode !== 0) {
    return failStep(
      'start-legacy-container',
      `docker start exited ${startResult.exitCode}: ${startResult.stderr.trim() || '(no stderr)'}`,
      [cmdStart],
    );
  }
  log(`Rollback complete: ${containerName} restored and started.`);
  return { complete: true };
}
