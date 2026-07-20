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
  blazegraphVolumeName,
  type DockerRunner,
} from '../blazegraph-docker.js';

/** Suffix for the renamed legacy container kept as the recovery path. */
export const HARDEN_BACKUP_SUFFIX = '-backup';

export type HardenState = 'absent' | 'legacy' | 'hardened' | 'backup-only';

export interface HardenStateInfo {
  state: HardenState;
  /** Host port bound to the container's HTTP port; undefined when unknowable. */
  hostPort?: number;
  running?: boolean;
}

type PortBindingMap = Record<string, Array<{ HostPort?: string }> | null>;

export interface DockerInspectShape {
  State?: { Running?: boolean; StartedAt?: string; FinishedAt?: string };
  Mounts?: Array<{ Destination?: string; Name?: string }>;
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
