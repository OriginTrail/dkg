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
  blazegraphMigrationVolumeName,
  type DockerRunner,
} from '../blazegraph-docker.js';

import { inspectBlazegraphContainerFacts } from '../blazegraph-container-inspection.js';

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

type PortBindingMap = Record<string, Array<{ HostPort?: string }> | null>;

export interface DockerInspectShape {
  State?: { Running?: boolean; StartedAt?: string; FinishedAt?: string };
  Mounts?: Array<{ Destination?: string; Name?: string }>;
  Config?: { Env?: string[]; Healthcheck?: { Test?: string[] } };
  HostConfig?: { PortBindings?: PortBindingMap };
  NetworkSettings?: { Ports?: PortBindingMap };
  /** Writable-layer bytes; only populated by `docker inspect --size`. */
  SizeRw?: number;
}

export function parseInspect(stdout: string): DockerInspectShape | null {
  try {
    const arr = JSON.parse(stdout);
    return Array.isArray(arr) && arr.length > 0 ? (arr[0] as DockerInspectShape) : null;
  } catch {
    return null;
  }
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
    const facts = inspectBlazegraphContainerFacts(info, {
      containerName, dataPath: BLAZEGRAPH_DATA_DIR, containerPort: BLAZEGRAPH_CONTAINER_PORT,
    });
    const hardened = facts.journalVolumeName !== undefined && facts.boundedJvm && facts.healthProbe;
    return { state: hardened ? 'hardened' : 'legacy', hostPort: facts.hostPort, running: facts.running,
      ...(!hardened && facts.journalVolumeName === blazegraphMigrationVolumeName(containerName)
        ? { usesMigrationVolume: true as const } : {}) };

  }
  const backup = await docker.run(['inspect', `${containerName}${HARDEN_BACKUP_SUFFIX}`]);
  if (backup.exitCode === 0) {
    const info = parseInspect(backup.stdout);
    const facts = inspectBlazegraphContainerFacts(info, {
      containerName, dataPath: BLAZEGRAPH_DATA_DIR, containerPort: BLAZEGRAPH_CONTAINER_PORT,
    });
    return { state: 'backup-only', hostPort: facts.hostPort, running: facts.running,
      ...(facts.journalVolumeName === blazegraphMigrationVolumeName(containerName)
        ? { usesMigrationVolume: true as const } : {}) };

  }
  return { state: 'absent' };
}
