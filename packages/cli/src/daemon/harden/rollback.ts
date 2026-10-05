/**
 * Harden migration — automatic rollback to the backup container.
 *
 * Invoked by the executor for ANY failure after the swap (post-swap
 * docker setup or verification). See the facade
 * (../blazegraph-harden.ts) for the incident background.
 */
import {
  BLAZEGRAPH_DATA_DIR,
  BLAZEGRAPH_CONTAINER_PORT,
  blazegraphMigrationVolumeName as blazegraphVolumeName,
  type DockerRunner,
} from '../blazegraph-docker.js';
import { classifyBlazegraphContainerInspection } from '../blazegraph-container-inspection.js';

export type RollbackResult =
  | { complete: true; failedStep?: never; detail?: never }
  | {
    complete: false;
    /** The step that failed (later steps did not run). */
    failedStep: string;
    detail: string;
  };

/**
 * Automatic rollback after a failed post-swap step: remove the NEW
 * container (its volume holds only a copy of the journal — verified
 * via docker inspect before the rm; absent entirely when `docker run`
 * itself failed), restore the backup under its original name, and start
 * it with the original restart policy. The exported journal on disk is
 * deliberately left in place.
 *
 * Every step's exit code is checked. On the FIRST failure the rollback
 * STOPS — later steps must not run, because e.g. a `docker start
 * <containerName>` after a failed `rm -f` would start the
 * failed-verification container, not the restored legacy one. The log
 * then carries the exact remaining docker commands for the operator, and
 * the caller reports the rollback as INCOMPLETE (never "restored").
 */
export async function rollbackToBackup(opts: {
  docker: DockerRunner;
  containerName: string;
  backupName: string;
  log: (m: string) => void;
}): Promise<RollbackResult> {
  const { docker, containerName, backupName, log } = opts;
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
  const inspect = classifyBlazegraphContainerInspection(await docker.run(['inspect', containerName]), containerName, {
      containerName, dataPath: BLAZEGRAPH_DATA_DIR, containerPort: BLAZEGRAPH_CONTAINER_PORT,
      journalVolumeNames: [blazegraphVolumeName(containerName)], journalMountType: 'any',
    });
  if (inspect.kind === 'failed') return failStep('inspect-gate',
    `Cannot determine whether replacement "${containerName}" exists: ${inspect.detail}; rollback refused`,
    [`docker inspect ${containerName}`]);
  if (inspect.kind === 'found') {
    const hasVolume = inspect.facts.journalVolumeName !== undefined;
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
  }
  const commands = [
    ...(inspect.kind === 'found' ? [{ id: 'rm-failed-container', args: ['rm', '-f', containerName] }] : []),
    { id: 'rename-backup', args: ['rename', backupName, containerName] },
    { id: 'restore-restart-policy', args: ['update', '--restart=unless-stopped', containerName] },
    { id: 'start-legacy-container', args: ['start', containerName] },
  ];
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index]!;
    let result;
    try { result = await docker.run(command.args); }
    catch (error) {
      return failStep(command.id, `docker ${command.args[0]} invocation failed: ${String(error)}`,
        commands.slice(index).map(({ args }) => `docker ${args.join(' ')}`));
    }
    if (result.exitCode !== 0) return failStep(command.id,
      `docker ${command.args[0]} exited ${result.exitCode}: ${result.stderr.trim() || '(no stderr)'}`,
      commands.slice(index).map(({ args }) => `docker ${args.join(' ')}`));
  }
  log(`Rollback complete: ${containerName} restored and started.`);
  return { complete: true };
}
