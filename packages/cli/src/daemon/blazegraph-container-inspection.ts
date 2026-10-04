import { blazegraphVolumeName, blazegraphMigrationVolumeName } from './blazegraph-container-policy.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export interface BlazegraphContainerFacts {
  readonly journalVolumeName?: string;
  readonly journalMountIsVolume: boolean;
  readonly boundedJvm: boolean;
  readonly healthProbe: boolean;
  readonly boundedLogs: boolean;
  readonly hostPort?: number;
  readonly running: boolean;
}

/** Normalize Docker's untyped inspection once; consumers retain their policy decisions. */
export function inspectBlazegraphContainerFacts(info: unknown, policy: {
  readonly containerName: string;
  readonly dataPath: string;
  readonly containerPort: number;
  readonly logMaxSize?: string;
  readonly logMaxFile?: string;
  /** Provisioning follows published ports; migration also needs stopped-container bindings. */
  readonly portSource?: 'published' | 'configured-first';
}): BlazegraphContainerFacts {
  const root = record(info);
  const mounts = Array.isArray(root?.Mounts) ? root.Mounts : [];
  const journal = mounts.map(record).find(mount => mount?.Destination === policy.dataPath
    && (mount.Name === blazegraphVolumeName(policy.containerName)
      || mount.Name === blazegraphMigrationVolumeName(policy.containerName))
    && (mount.Type === undefined || mount.Type === 'volume'));
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
  return Object.freeze({ journalVolumeName: typeof journal?.Name === 'string' ? journal.Name : undefined,
    journalMountIsVolume: journal?.Type === 'volume', boundedJvm, healthProbe, boundedLogs,
    hostPort: policy.portSource === 'published'
      ? portFrom(record(root?.NetworkSettings)?.Ports)
      : portFrom(hostConfig?.PortBindings) ?? portFrom(record(root?.NetworkSettings)?.Ports),
    running: record(root?.State)?.Running === true });
}
