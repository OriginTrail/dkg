/**
 * Harden migration — state inspection.
 *
 * Classifies the world into the migration state machine using nothing
 * but `docker inspect` (no state file), so a crashed `dkg store harden`
 * run resumes from whatever the world actually looks like. See the
 * facade (../blazegraph-harden.ts) for the incident background and the
 * full algorithm.
 */
import {
  BLAZEGRAPH_CONTAINER_PORT,
  BLAZEGRAPH_DATA_DIR,
  BLAZEGRAPH_LOG_MAX_SIZE,
  BLAZEGRAPH_LOG_MAX_FILE,
  blazegraphMigrationVolumeName,
  type DockerRunner,
} from '../blazegraph-docker.js';

import { classifyBlazegraphContainerInspection, type BlazegraphContainerInspectionOutcome } from '../blazegraph-container-inspection.js';

/** Suffix for the renamed legacy container kept as the recovery path. */
export const HARDEN_BACKUP_SUFFIX = '-backup';

export type HardenState = 'absent' | 'legacy' | 'hardened' | 'backup-only';

export interface HardenStateInfo {
  state: HardenState;
  /** Host port bound to the container's HTTP port; undefined when unknowable. */
  hostPort?: number;
  running?: boolean;
  usesMigrationVolume?: true;
}

/**
 * Classify the container into the migration state machine. State is
 * derived exclusively from docker — no state file — so a crashed
 * migration resumes correctly from whatever the world actually looks
 * like:
 *   - 'hardened': container exists with the named journal volume mounted
 *     at /data, bounded JVM/logs and ASK health policy (the migration's end
 *     state, also the fresh-provision shape).
 *   - 'legacy': container exists without that mount (fleet-verified
 *     shape: `Mounts: []`, `Config.Volumes: null`).
 *   - 'backup-only': container missing but `<name>-backup` exists. A retained
 *     replacement volume may still hold newer writes; seeding separately
 *     requires exact volume absence and ownership of a fresh creation.
 *   - 'absent': neither exists.
 */
export async function inspectHardenState(
  docker: DockerRunner,
  containerName: string,
): Promise<HardenStateInfo> {
  const policy = { containerName, dataPath: BLAZEGRAPH_DATA_DIR, containerPort: BLAZEGRAPH_CONTAINER_PORT,
    logMaxSize: BLAZEGRAPH_LOG_MAX_SIZE, logMaxFile: BLAZEGRAPH_LOG_MAX_FILE };
  const result = classifyBlazegraphContainerInspection(await docker.run(['inspect', containerName]), containerName, policy);
  if (result.kind === 'found') {
    const { facts } = result;
    const hardened = facts.journalVolumeName !== undefined && facts.boundedJvm && facts.healthProbe && facts.boundedLogs;
    return { state: hardened ? 'hardened' : 'legacy', hostPort: facts.hostPort, running: facts.running,
      ...(!hardened && facts.journalVolumeName === blazegraphMigrationVolumeName(containerName)
        ? { usesMigrationVolume: true as const } : {}) };

  }
  requireConfirmedContainerAbsence(result, containerName, 'primary');
  const backupName = `${containerName}${HARDEN_BACKUP_SUFFIX}`;
  const backup = classifyBlazegraphContainerInspection(await docker.run(['inspect', backupName]), backupName, policy);
  if (backup.kind === 'found') {
    const { facts } = backup;
    return { state: 'backup-only', hostPort: facts.hostPort, running: facts.running,
      ...(facts.journalVolumeName === blazegraphMigrationVolumeName(containerName)
        ? { usesMigrationVolume: true as const } : {}) };

  }
  requireConfirmedContainerAbsence(backup, backupName, 'backup');
  return { state: 'absent' };
}

/** A failed engine request is not permission to replace an authoritative journal. */
function requireConfirmedContainerAbsence(outcome: Exclude<BlazegraphContainerInspectionOutcome, { kind: 'found' }>, name: string, role: 'primary' | 'backup'): void {
  if (outcome.kind === 'missing') return;
  if (outcome.reason === 'output') throw new Error(`Docker inspect returned unparseable ${role === 'backup' ? 'backup' : 'container'} facts`);
  throw new Error(`Cannot determine whether ${role} container "${name}" exists: ${outcome.detail}. `
    + 'Refusing migration while the authoritative journal is unknown.');
}
