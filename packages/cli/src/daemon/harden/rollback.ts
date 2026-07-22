/**
 * Harden migration — automatic rollback to the backup container.
 *
 * Invoked by the executor for ANY failure after the swap (post-swap
 * docker setup or verification). See the facade
 * (../blazegraph-harden.ts) for the incident background.
 */
import {
  BLAZEGRAPH_DATA_DIR,
  blazegraphVolumeName,
  type DockerRunner,
} from '../blazegraph-docker.js';
import { parseInspect } from './state.js';

export interface RollbackResult {
  complete: boolean;
  /** Set when incomplete: the step that failed (later steps did not run). */
  failedStep?: string;
  detail?: string;
}

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
