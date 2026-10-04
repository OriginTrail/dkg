/**
 * Harden migration — step definitions and plan generation.
 *
 * `buildHardenMigration` owns each migration phase (id, operator-facing
 * description, Docker argv and action) and its state-dependent position.
 * Dry-run rendering and execution consume this same sequence, so the plan
 * cannot drift from what actually runs; a conformance test drives the
 * executor against a scripted docker and asserts every planned argv is
 * executed in plan order. See the facade (../blazegraph-harden.ts) for
 * the incident background.
 */
import { join, resolve } from 'node:path';
import {
  BLAZEGRAPH_DATA_DIR,
  BLAZEGRAPH_IMAGE,
  BLAZEGRAPH_JOURNAL_FILE,
  BLAZEGRAPH_TOMCAT_UID_GID,
  blazegraphMigrationVolumeName as blazegraphVolumeName,
  buildBlazegraphRunArgs,
} from '../blazegraph-docker.js';
import { HARDEN_BACKUP_SUFFIX, type HardenState } from './state.js';
import * as actions from './actions.js';

/** Where the journal export lands inside the migration dir. */
export const HARDEN_EXPORT_FILENAME = 'bigdata.jnl';

/**
 * Free-disk multiple required before the export starts. The export copy
 * AND the docker-volume seed copy typically live on the same root
 * filesystem (named volumes are under /var/lib/docker), so the migration
 * transiently needs ~2 journals of space plus slack.
 */
export const HARDEN_DISK_PREFLIGHT_FACTOR = 2.2;

export interface HardenStep {
  id: string;
  description: string;
  /** Present when the step is a docker invocation. */
  dockerArgs?: string[];
}

export interface HardenPlanInput {
  containerName: string;
  namespace: string;
  hostPort: number;
  heapMb: number;
  migrationDir: string;
  state: HardenState;
  /** Docker exec size preflight is available only while the source is running. */
  running?: boolean;
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

/** Each selected phase owns its description, command, action and rollback boundary. */
export interface HardenExecutablePhase extends HardenStep {
  readonly rollbackPhase?: 'post-swap setup' | 'verification';
  execute(context: actions.HardenWorkflowInputs): Promise<void>;
}

function dockerPhase(id: string, description: string, dockerArgs: string[],
  execute: (context: actions.HardenWorkflowInputs, command: readonly string[]) => Promise<void>,
  rollbackPhase?: HardenExecutablePhase['rollbackPhase']): HardenExecutablePhase {
  return { id, description, dockerArgs,
    ...(rollbackPhase === undefined ? {} : { rollbackPhase }),
    execute: context => execute(context, dockerArgs) };
}

/** One state-selected sequence serves both dry-run rendering and execution. */
export function buildHardenMigration(input: HardenPlanInput & { sourceContainerName?: string }) {
  const migrationDir = resolve(input.migrationDir);
  const backupName = `${input.containerName}${HARDEN_BACKUP_SUFFIX}`;
  const sourceName = input.sourceContainerName ?? (input.state === 'backup-only' ? backupName : input.containerName);
  const exportPath = join(migrationDir, HARDEN_EXPORT_FILENAME);
  const integrityCommand = ['inspect', '--size', sourceName];
  let preSize: number | null = null;
  let stopped: actions.StoppedContainerSnapshot | null = null;
  let exported: actions.VerifiedJournalExport | null = null;
  let backupExists = input.state !== 'hardened';
  const requireExport = () => {
    if (exported === null) throw new Error('Migration phase requires a verified journal export');
    return exported;
  };
  const verifyCommand = ['exec', input.containerName, 'stat', '-c', '%s', BLAZEGRAPH_JOURNAL_FILE];
  const phases: HardenExecutablePhase[] = input.state === 'absent' ? [] : input.state === 'hardened' ? [
    dockerPhase('verify', 'verify ASK; repeat identity and journal verification when migration backup/export remains',
      verifyCommand, async (ctx, command) => {
        const result = await actions.verifyAlreadyHardened(ctx, command);
        exported = result.exported; backupExists = result.backupExists;
      }),
  ] : [
    ...((input.running ?? input.state !== 'backup-only') ? [
      dockerPhase('journal-size', `read in-container journal size (docker exec stat ${BLAZEGRAPH_JOURNAL_FILE})`,
        ['exec', sourceName, 'stat', '-c', '%s', BLAZEGRAPH_JOURNAL_FILE],
        async (ctx, command) => { preSize = await actions.readJournalSize(ctx, command); }),
      { id: 'disk-preflight', description:
        `require free disk at ${migrationDir} >= ${HARDEN_DISK_PREFLIGHT_FACTOR}x journal size `
        + `(export copy + docker-volume seed copy usually share the root filesystem)`,
        execute: (ctx: actions.HardenWorkflowInputs) => actions.checkFreeDisk(ctx, preSize) },
    ] : []),
    dockerPhase('stop', `docker stop -t 120 ${sourceName} (graceful s6 -> Tomcat shutdown flushes RWStore)`,
      ['stop', '-t', '120', sourceName], async (ctx, command) => {
        stopped = await actions.stopSource(ctx, command, integrityCommand);
      }),
    dockerPhase('export-journal', `docker cp the current journal from ${sourceName} to ${exportPath} (always re-exported; saved exports may be stale)`,
      ['cp', `${sourceName}:${BLAZEGRAPH_JOURNAL_FILE}`, exportPath], actions.exportJournal),
    dockerPhase('export-integrity',
      `re-inspect ${sourceName} after the export: it must NOT have run during the `
      + `copy (Running false, StartedAt/FinishedAt unchanged since the post-stop baseline) and `
      + `the writable-layer size (SizeRw) must be unchanged`, integrityCommand, async (ctx, command) => {
        if (stopped === null) throw new Error('Migration export requires a stopped-container baseline');
        exported = await actions.verifyExport(ctx, stopped, preSize, command);
      }),
    dockerPhase('volume-create', `create named journal volume ${blazegraphVolumeName(input.containerName)} (idempotent)`,
      ['volume', 'create', blazegraphVolumeName(input.containerName)], actions.createVolume),
    dockerPhase('seed-volume',
      `seed the volume from ${exportPath} via a helper container (same pinned image; `
      + `the volume journal is ALWAYS overwritten from the current export — equal size `
      + `does not imply equal content; chown ${BLAZEGRAPH_TOMCAT_UID_GID})`, seedRunArgs({ ...input, migrationDir }),
      (ctx, command) => actions.seedVolume(ctx, command, requireExport())),
    ...(input.state === 'legacy' ? [dockerPhase('rename-backup',
      `docker rename ${input.containerName} ${backupName} (backup is NEVER removed by this tool)`,
      ['rename', input.containerName, backupName], actions.renameBackup)] : []),
    dockerPhase('disable-backup-restart', `docker update --restart=no ${backupName} (backup can never auto-start on host reboot)`,
      ['update', '--restart=no', backupName], actions.disableBackupRestart, 'post-swap setup'),
    dockerPhase('run-hardened', `create hardened container ${input.containerName} (heap ${input.heapMb} MB, journal volume, healthcheck, log caps)`,
      buildBlazegraphRunArgs({ containerName: input.containerName, hostPort: input.hostPort,
        namespace: input.namespace, heapMb: input.heapMb, volumeName: blazegraphVolumeName(input.containerName) }),
      actions.runHardened, 'post-swap setup'),
    dockerPhase('verify', `verify: /bigdata/status ready + ASK {} HTTP 200 + identity-tag SELECT returns a `
      + `binding + in-container journal size >= exported size (on failure: automatic `
      + `rollback to ${backupName}; exported journal kept at ${exportPath})`, verifyCommand,
      (ctx, command) => actions.verifyReplacement(ctx, command, requireExport()), 'verification'),
  ];
  return { phases, get exported() { return exported; }, get backupExists() { return backupExists; } };
}

function description(phase: HardenExecutablePhase): HardenStep {
  return { id: phase.id, description: phase.description,
    ...(phase.dockerArgs === undefined ? {} : { dockerArgs: [...phase.dockerArgs] }) };
}

export function planHardenMigration(input: HardenPlanInput): HardenStep[] {
  return buildHardenMigration(input).phases.map(description);
}
