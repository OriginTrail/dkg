import { blazegraphVolumeName, blazegraphMigrationVolumeName } from './blazegraph-container-policy.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export interface DockerJournalMount {
  readonly destination?: string;
  readonly name?: string;
  readonly type?: string;
}

export interface BlazegraphInspectionPolicy {
  readonly containerName: string;
  readonly dataPath: string;
  readonly containerPort: number;
  readonly logMaxSize?: string;
  readonly logMaxFile?: string;
  /** Provisioning follows published ports; migration needs stopped-container bindings. */
  readonly portSource?: 'published' | 'configured-first';
  /** Rollback accepts only its replacement volume; other readers accept either owned volume. */
  readonly journalVolumeNames?: readonly string[];
  readonly journalMountType?: 'any' | 'volume-or-unspecified';
}

export interface BlazegraphContainerFacts {
  readonly mounts: readonly DockerJournalMount[];
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly writableLayerSize?: number;
  readonly journalVolumeName?: string;
  readonly journalMountIsVolume: boolean;
  readonly boundedJvm: boolean;
  readonly healthProbe: boolean;
  readonly boundedLogs: boolean;
  readonly hostPort?: number;
  readonly running: boolean;
}

/** Normalize Docker's untyped inspection once; consumers retain their policy decisions. */
export function inspectBlazegraphContainerFacts(info: unknown, policy: BlazegraphInspectionPolicy): BlazegraphContainerFacts {
  const root = record(info);
  const string = (value: unknown) => typeof value === 'string' ? value : undefined;
  const mounts = (Array.isArray(root?.Mounts) ? root.Mounts : []).map(record)
    .filter((mount): mount is Record<string, unknown> => mount !== undefined)
    .map(mount => Object.freeze({
      ...(string(mount.Destination) === undefined ? {} : { destination: string(mount.Destination) }),
      ...(string(mount.Name) === undefined ? {} : { name: string(mount.Name) }),
      ...(string(mount.Type) === undefined ? {} : { type: string(mount.Type) }),
    }));
  const ownedNames = policy.journalVolumeNames ?? [blazegraphVolumeName(policy.containerName),
    blazegraphMigrationVolumeName(policy.containerName)];
  const journal = mounts.find(mount => mount.destination === policy.dataPath
    && mount.name !== undefined && ownedNames.includes(mount.name)
    && (policy.journalMountType === 'any' || mount.type === undefined || mount.type === 'volume'));
  const config = record(root?.Config);
  const env = Array.isArray(config?.Env) ? config.Env : [];
  const boundedJvm = env.some(value => typeof value === 'string'
    && value.startsWith('TOMCAT_JAVA_OPTS=')
    && /-Xmx[1-9]\d*[mMgG](?:\s|$)/u.test(value)
    && /-XX:\+ExitOnOutOfMemoryError(?:\s|$)/u.test(value));
  const health = record(config?.Healthcheck);
  const healthProbe = Array.isArray(health?.Test)
    && health.Test.some(value => typeof value === 'string' && value.includes('ASK%7B%7D'));
  const hostConfig = record(root?.HostConfig);
  const logging = record(hostConfig?.LogConfig);
  const logOptions = record(logging?.Config);
  const boundedLogs = logging?.Type === 'local'
    && policy.logMaxSize !== undefined && policy.logMaxFile !== undefined
    && logOptions?.['max-size'] === policy.logMaxSize && logOptions?.['max-file'] === policy.logMaxFile;
  const portFrom = (input: unknown): number | undefined => {
    const map = record(input);
    const binding = map?.[`${policy.containerPort}/tcp`]
      ?? (policy.containerPort === 8080 ? undefined : map?.['8080/tcp']);
    const value = Array.isArray(binding) ? record(binding[0])?.HostPort : undefined;
    const port = typeof value === 'string' ? Number(value) : undefined;
    return port !== undefined && Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
  };
  const state = record(root?.State);
  const size = root?.SizeRw;
  return Object.freeze({ mounts: Object.freeze(mounts), startedAt: string(state?.StartedAt),
    finishedAt: string(state?.FinishedAt),
    writableLayerSize: typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? size : undefined,
    journalVolumeName: journal?.name, journalMountIsVolume: journal?.type === 'volume', boundedJvm, healthProbe, boundedLogs,
    hostPort: policy.portSource === 'published'
      ? portFrom(record(root?.NetworkSettings)?.Ports)
      : portFrom(hostConfig?.PortBindings) ?? portFrom(record(root?.NetworkSettings)?.Ports),
    running: record(root?.State)?.Running === true });
}

/** Decode one Docker inspect response. Invalid top-level data is never a stopped-container proof. */
export function parseBlazegraphContainerInspection(stdout: string, policy: BlazegraphInspectionPolicy): BlazegraphContainerFacts | null {
  try {
    const values: unknown = JSON.parse(stdout);
    return Array.isArray(values) && record(values[0]) !== undefined
      ? inspectBlazegraphContainerFacts(values[0], policy) : null;
  } catch { return null; }
}
