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

import { parseBlazegraphContainerInspection } from '../blazegraph-container-inspection.js';

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
    const facts = parseBlazegraphContainerInspection(result.stdout, {
      containerName, dataPath: BLAZEGRAPH_DATA_DIR, containerPort: BLAZEGRAPH_CONTAINER_PORT,
      logMaxSize: BLAZEGRAPH_LOG_MAX_SIZE, logMaxFile: BLAZEGRAPH_LOG_MAX_FILE,
    });
    if (facts === null) throw new Error('Docker inspect returned unparseable container facts');
    const hardened = facts.journalVolumeName !== undefined && facts.boundedJvm && facts.healthProbe && facts.boundedLogs;
    return { state: hardened ? 'hardened' : 'legacy', hostPort: facts.hostPort, running: facts.running,
      ...(!hardened && facts.journalVolumeName === blazegraphMigrationVolumeName(containerName)
        ? { usesMigrationVolume: true as const } : {}) };

  }
  requireConfirmedContainerAbsence(result.stderr, containerName, 'primary');
  const backupName = `${containerName}${HARDEN_BACKUP_SUFFIX}`;
  const backup = await docker.run(['inspect', backupName]);
  if (backup.exitCode === 0) {
    const facts = parseBlazegraphContainerInspection(backup.stdout, {
      containerName, dataPath: BLAZEGRAPH_DATA_DIR, containerPort: BLAZEGRAPH_CONTAINER_PORT,
      logMaxSize: BLAZEGRAPH_LOG_MAX_SIZE, logMaxFile: BLAZEGRAPH_LOG_MAX_FILE,
    });
    if (facts === null) throw new Error('Docker inspect returned unparseable backup facts');
    return { state: 'backup-only', hostPort: facts.hostPort, running: facts.running,
      ...(facts.journalVolumeName === blazegraphMigrationVolumeName(containerName)
        ? { usesMigrationVolume: true as const } : {}) };

  }
  requireConfirmedContainerAbsence(backup.stderr, backupName, 'backup');
  return { state: 'absent' };
}

/** A failed engine request is not permission to replace an authoritative journal. */
function requireConfirmedContainerAbsence(stderr: string, name: string, role: 'primary' | 'backup'): void {
  const missing = /^(?:Error:|Error response from daemon:)\s*No such (?:object|container):\s*(.+)$/iu.exec(stderr.trim());
  if (missing?.[1] === name) return;
  throw new Error(`Cannot determine whether ${role} container "${name}" exists: ${stderr.trim() || 'Docker inspect failed'}. `
    + 'Refusing migration while the authoritative journal is unknown.');
}
