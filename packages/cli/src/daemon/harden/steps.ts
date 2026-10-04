/**
 * Harden migration — step definitions and plan generation.
 *
 * `hardenStepDefs` is the SINGLE source of truth for every migration
 * step (id, operator-facing description, and — for docker-backed steps —
 * the exact argv). Both the dry-run plan (`planHardenMigration`) and the
 * executor (executor.ts) consume these objects, so the rendered plan
 * cannot drift from what actually runs; a conformance test drives the
 * executor against a scripted docker and asserts every planned argv is
 * executed in plan order. See the facade (../blazegraph-harden.ts) for
 * the incident background.
 */
import { join } from 'node:path';
import * as actions from './actions.js';
import type { HardenWorkflowContext } from './actions.js';
import {
  BLAZEGRAPH_DATA_DIR,
  BLAZEGRAPH_IMAGE,
  BLAZEGRAPH_JOURNAL_FILE,
  BLAZEGRAPH_TOMCAT_UID_GID,
  blazegraphMigrationVolumeName as blazegraphVolumeName,
  buildBlazegraphRunArgs,
} from '../blazegraph-docker.js';
import { HARDEN_BACKUP_SUFFIX, type HardenState } from './state.js';

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

/** Plan-step inputs that do not depend on the migration state. */
export type HardenStepDefsInput = Omit<HardenPlanInput, 'state'> & { readonly sourceContainerName?: string };

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

/**
 * SINGLE source of truth for every migration step: id, operator-facing
 * description, and — for docker-backed steps — the exact argv. Both the
 * dry-run plan (`planHardenMigration`) and the executor
 * (`executeHardenMigration`) consume THESE objects, so the rendered plan
 * cannot drift from what actually runs: an argv change here changes both
 * sides at once, and the plan/executor conformance test (drives the
 * executor against a scripted docker and asserts every planned argv is
 * executed in plan order) fails if the executor stops sourcing a command
 * from its step definition or reorders/skips a step.
 */
export function hardenStepDefs(input: HardenStepDefsInput) {
  const backupName = `${input.containerName}${HARDEN_BACKUP_SUFFIX}`;
  const sourceName = input.sourceContainerName ?? input.containerName;
  const exportPath = join(input.migrationDir, HARDEN_EXPORT_FILENAME);

  return {
    journalSize: {
      id: 'journal-size',
      description: `read in-container journal size (docker exec stat ${BLAZEGRAPH_JOURNAL_FILE})`,
      dockerArgs: ['exec', sourceName, 'stat', '-c', '%s', BLAZEGRAPH_JOURNAL_FILE],
    },
    diskPreflight: {
      id: 'disk-preflight',
      description:
        `require free disk at ${input.migrationDir} >= ${HARDEN_DISK_PREFLIGHT_FACTOR}x journal size ` +
        `(export copy + docker-volume seed copy usually share the root filesystem)`,
    },
    stop: {
      id: 'stop',
      description: `docker stop -t 120 ${sourceName} (graceful s6 -> Tomcat shutdown flushes RWStore)`,
      dockerArgs: ['stop', '-t', '120', sourceName],
    },
    exportJournal: {
      id: 'export-journal',
      description:
        `docker cp the current journal from ${sourceName} to ${exportPath} (always re-exported; saved exports may be stale)`,
      dockerArgs: ['cp', `${sourceName}:${BLAZEGRAPH_JOURNAL_FILE}`, exportPath],
    },
    exportIntegrity: {
      id: 'export-integrity',
      description:
        `re-inspect ${sourceName} after the export: it must NOT have run during the ` +
        `copy (Running false, StartedAt/FinishedAt unchanged since the post-stop baseline) and ` +
        `the writable-layer size (SizeRw) must be unchanged`,
      dockerArgs: ['inspect', '--size', sourceName],
    },
    volumeCreate: {
      id: 'volume-create',
      description: `create named journal volume ${blazegraphVolumeName(input.containerName)} (idempotent)`,
      dockerArgs: ['volume', 'create', blazegraphVolumeName(input.containerName)],
    },
    seedVolume: {
      id: 'seed-volume',
      description:
        `seed the volume from ${exportPath} via a helper container (same pinned image; ` +
        `the volume journal is ALWAYS overwritten from the current export — equal size ` +
        `does not imply equal content; chown ${BLAZEGRAPH_TOMCAT_UID_GID})`,
      dockerArgs: seedRunArgs(input),
    },
    renameBackup: {
      id: 'rename-backup',
      description: `docker rename ${input.containerName} ${backupName} (backup is NEVER removed by this tool)`,
      dockerArgs: ['rename', input.containerName, backupName],
    },
    disableBackupRestart: {
      id: 'disable-backup-restart',
      description: `docker update --restart=no ${backupName} (backup can never auto-start on host reboot)`,
      dockerArgs: ['update', '--restart=no', backupName],
    },
    runHardened: {
      id: 'run-hardened',
      description:
        `create hardened container ${input.containerName} (heap ${input.heapMb} MB, ` +
        `journal volume, healthcheck, log caps)`,
      dockerArgs: buildBlazegraphRunArgs({
        containerName: input.containerName,
        hostPort: input.hostPort,
        namespace: input.namespace,
        heapMb: input.heapMb,
        volumeName: blazegraphVolumeName(input.containerName),
      }),
    },
    verify: {
      id: 'verify',
      dockerArgs: ['exec', input.containerName, 'stat', '-c', '%s', BLAZEGRAPH_JOURNAL_FILE],
      description:
        `verify: /bigdata/status ready + ASK {} HTTP 200 + identity-tag SELECT returns a ` +
        `binding + in-container journal size >= exported size (on failure: automatic ` +
        `rollback to ${backupName}; exported journal kept at ${exportPath})`,
    },
  } satisfies Record<string, HardenStep>;
}

export interface HardenMigrationPhase extends HardenStep {
  readonly recovery: 'before-swap' | 'after-swap' | 'existing';
  readonly execute: (context: HardenWorkflowContext) => Promise<void>;
}

/** Both rendering and execution select this exact ordered workflow. */
export function hardenMigrationWorkflow(input: HardenPlanInput): HardenMigrationPhase[] {
  const defs = hardenStepDefs({ ...input, sourceContainerName: input.state === 'backup-only'
    ? `${input.containerName}${HARDEN_BACKUP_SUFFIX}` : input.containerName });
  const phase = (step: HardenStep, execute: (context: HardenWorkflowContext, step: HardenStep) => Promise<void>,
    recovery: HardenMigrationPhase['recovery'] = 'before-swap'): HardenMigrationPhase => ({
    ...step, recovery, execute: context => execute(context, step),
  });
  if (input.state === 'absent') return [];
  if (input.state === 'hardened') return [phase({ id: 'verify',
    description: 'verify the existing hardened store answers ASK {} at its configured namespace endpoint',
  }, actions.verifyExisting, 'existing')];
  const readableJournal = input.running ?? (input.state !== 'backup-only');
  return [
    ...(readableJournal ? [phase(defs.journalSize, actions.readJournalSize),
      phase(defs.diskPreflight, actions.checkFreeDisk)] : []),
    phase(defs.stop, actions.stopSource),
    phase(defs.exportJournal, actions.exportJournal),
    phase(defs.exportIntegrity, actions.verifyExport),
    phase(defs.volumeCreate, actions.createVolume),
    phase(defs.seedVolume, actions.seedVolume),
    ...(input.state === 'legacy' ? [phase(defs.renameBackup, actions.renameBackup)] : []),
    phase(defs.disableBackupRestart, actions.disableBackupRestart, 'after-swap'),
    phase(defs.runHardened, actions.runHardened, 'after-swap'),
    phase(defs.verify, actions.verifyReplacement, 'after-swap'),
  ];
}

export function planHardenMigration(input: HardenPlanInput): HardenStep[] {
  return hardenMigrationWorkflow(input).map(({ execute: _execute, recovery: _recovery, ...step }) => step);
}
