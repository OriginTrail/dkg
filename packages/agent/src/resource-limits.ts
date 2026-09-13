/** Operational ceilings, not protocol limits. See docs/agent-resource-limits.md. */
export const RESOURCE_MAX = Object.freeze({
  timerMs: 2_147_483_647,
  shutdownMs: 300_000,
  retryMs: 86_400_000,
  concurrency: 1_024,
  vmConcurrency: 32,
  queue: 65_536,
  cacheEntries: 100_000,
  batch: 1_000,
  rows: 10_000_000,
  bytes: 4 * 1024 ** 3,
  passes: 1_000,
  confirmationDepth: 1_000_000,
});

export type RejectedResourceSetting = (name: string) => void;
export interface IntegerBounds { min: 0 | 1; max: number }

/** Undefined is an absent setting. Invalid numbers fall through to the next source/default. */
export function resourceInteger(
  value: unknown,
  bounds: IntegerBounds,
  name: string,
  onRejected?: RejectedResourceSetting,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value)
    && value >= bounds.min && value <= bounds.max) return value;
  onRejected?.(name);
  return undefined;
}

/** Blank environment assignments are absent; only an explicit zero selects a zero mode. */
export function resourceIntegerEnv(
  raw: string | undefined,
  bounds: IntegerBounds,
  name: string,
  onRejected?: RejectedResourceSetting,
): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  return resourceInteger(Number(raw), bounds, name, onRejected);
}

/** Per-startup diagnostics: bounded cardinality/length, no raw values, no logging in parsers. */
export class ResourceConfigWarnings {
  private readonly names = new Set<string>();
  private readonly clamped = new Set<string>();
  private truncated = false;
  private retain(name: string, target: Set<string>): void {
    const label = name.replace(/[^a-zA-Z0-9_.]/g, '_').slice(0, 100);
    if (target.has(label)) return;
    if (this.names.size + this.clamped.size < 24) target.add(label);
    else this.truncated = true;
  }
  readonly reject: RejectedResourceSetting = (name) => this.retain(name, this.names);
  readonly clamp: RejectedResourceSetting = (name) => this.retain(name, this.clamped);
  get settings(): readonly string[] { return [...this.names]; }
  message(): string | undefined {
    if (this.names.size + this.clamped.size === 0) return undefined;
    const parts = [];
    if (this.names.size) parts.push(`Ignored invalid resource settings; using resolved fallback policy: ${[...this.names].join(', ')}`);
    if (this.clamped.size) parts.push(`Clamped resource settings to global limits: ${[...this.clamped].join(', ')}`);
    return `${parts.join('; ')}${this.truncated ? ', ...' : ''}`;
  }
  snapshot() {
    return Object.freeze({
      rejected: Object.freeze([...this.names]),
      clamped: Object.freeze([...this.clamped]),
      warning: this.message(),
    });
  }
}

interface EnvironmentIntegerSpec extends IntegerBounds { fallback: number }
export const AGENT_RESOURCE_ENV_SPECS = {
  DKG_VM_RECONCILE_INTERVAL_MS: { min: 1, max: RESOURCE_MAX.timerMs, fallback: 60_000 },
  DKG_VM_RECONCILE_BACKOFF_MAX_MS: { min: 1, max: RESOURCE_MAX.timerMs, fallback: 600_000 },
  DKG_VM_RECONCILE_CACHE_MAX_ENTRIES: { min: 1, max: RESOURCE_MAX.cacheEntries, fallback: 1_000 },
  DKG_VM_RECONCILE_CG_STATE_MAX_ENTRIES: { min: 1, max: RESOURCE_MAX.cacheEntries, fallback: 1_000 },
  DKG_VM_RECONCILE_SWM_GEN_FINGERPRINT_MAX_ROWS: { min: 1, max: RESOURCE_MAX.rows, fallback: 2_000 },
  DKG_VM_RECONCILE_QUEUE_MAX_PENDING: { min: 1, max: RESOURCE_MAX.queue, fallback: 256 },
  DKG_VM_RECONCILE_BATCH_SIZE: { min: 1, max: RESOURCE_MAX.batch, fallback: 10 },
  DKG_VM_RECONCILE_ORDINAL_CONCURRENCY: { min: 1, max: RESOURCE_MAX.vmConcurrency, fallback: 5 },
  DKG_VM_RECONCILE_CONCURRENCY: { min: 1, max: RESOURCE_MAX.vmConcurrency, fallback: 2 },
  DKG_VM_RECONCILE_MAX_FOREGROUND_BURST: { min: 1, max: RESOURCE_MAX.batch, fallback: 8 },
  DKG_VM_RECONCILE_SHUTDOWN_TIMEOUT_MS: { min: 1, max: RESOURCE_MAX.shutdownMs, fallback: 5_000 },
  DKG_RANDOM_SAMPLING_SHUTDOWN_TIMEOUT_MS: { min: 1, max: RESOURCE_MAX.shutdownMs, fallback: 5_000 },
  DKG_CORE_HOST_RECORDING_DRAIN_TIMEOUT_MS: { min: 1, max: RESOURCE_MAX.shutdownMs, fallback: 5_000 },
  DKG_VM_RECONCILE_CONFIRMATION_DEPTH: { min: 1, max: RESOURCE_MAX.confirmationDepth, fallback: 5 },
  DKG_CATCHUP_MAX_CONCURRENT_PEERS: { min: 1, max: RESOURCE_MAX.concurrency, fallback: 4 },
  DKG_CATCHUP_BACKPRESSURE_MAX_WAIT_MS: { min: 0, max: RESOURCE_MAX.retryMs, fallback: 180_000 },
} as const satisfies Record<string, EnvironmentIntegerSpec>;

type AgentResourceEnvName = keyof typeof AGENT_RESOURCE_ENV_SPECS;

export const VM_RESOURCE_ENV_NAMES = [
  'DKG_VM_RECONCILE_INTERVAL_MS',
  'DKG_VM_RECONCILE_BACKOFF_MAX_MS',
  'DKG_VM_RECONCILE_CACHE_MAX_ENTRIES',
  'DKG_VM_RECONCILE_CG_STATE_MAX_ENTRIES',
  'DKG_VM_RECONCILE_SWM_GEN_FINGERPRINT_MAX_ROWS',
  'DKG_VM_RECONCILE_QUEUE_MAX_PENDING',
  'DKG_VM_RECONCILE_BATCH_SIZE',
  'DKG_VM_RECONCILE_ORDINAL_CONCURRENCY',
  'DKG_VM_RECONCILE_CONCURRENCY',
  'DKG_VM_RECONCILE_MAX_FOREGROUND_BURST',
  'DKG_VM_RECONCILE_SHUTDOWN_TIMEOUT_MS',
  'DKG_RANDOM_SAMPLING_SHUTDOWN_TIMEOUT_MS',
  'DKG_CORE_HOST_RECORDING_DRAIN_TIMEOUT_MS',
  'DKG_VM_RECONCILE_CONFIRMATION_DEPTH',
] as const satisfies readonly AgentResourceEnvName[];

export const CATCHUP_RESOURCE_ENV_NAMES = [
  'DKG_CATCHUP_MAX_CONCURRENT_PEERS',
  'DKG_CATCHUP_BACKPRESSURE_MAX_WAIT_MS',
] as const satisfies readonly AgentResourceEnvName[];

type ResourceEnvironmentName =
  | (typeof VM_RESOURCE_ENV_NAMES)[number]
  | (typeof CATCHUP_RESOURCE_ENV_NAMES)[number];

function resolveResourceEnvironment<Name extends ResourceEnvironmentName>(
  names: readonly Name[],
  env: Readonly<Record<string, string | undefined>>,
) {
  const warnings = new ResourceConfigWarnings();
  const values = {} as Record<Name, number>;
  for (const name of names) {
    const spec = AGENT_RESOURCE_ENV_SPECS[name];
    values[name] = resourceIntegerEnv(env[name], spec, name, warnings.reject) ?? spec.fallback;
  }
  return { values, rejected: [...warnings.settings] };
}

/** VM-owned process settings. Importing a catch-up helper never initializes this slice. */
export function resolveVmResourceEnvironment(env: Readonly<Record<string, string | undefined>>) {
  const resolved = resolveResourceEnvironment(VM_RESOURCE_ENV_NAMES, env);
  const startupMaxDelayMs = resourceIntegerEnv(env.DKG_VM_RECONCILE_STARTUP_MAX_DELAY_MS,
    { min: 0, max: RESOURCE_MAX.timerMs }, 'DKG_VM_RECONCILE_STARTUP_MAX_DELAY_MS',
    (name) => resolved.rejected.push(name))
    ?? resolved.values.DKG_VM_RECONCILE_INTERVAL_MS;
  return Object.freeze({
    values: Object.freeze(resolved.values),
    startupMaxDelayMs,
    rejected: Object.freeze(resolved.rejected),
  });
}

/** Sync catch-up-owned process settings, resolved independently from VM settings. */
export function resolveCatchupResourceEnvironment(env: Readonly<Record<string, string | undefined>>) {
  const resolved = resolveResourceEnvironment(CATCHUP_RESOURCE_ENV_NAMES, env);
  return Object.freeze({
    values: Object.freeze(resolved.values),
    rejected: Object.freeze(resolved.rejected),
  });
}

/** Compatibility composition for callers that still want every process setting at once. */
export function resolveAgentResourceEnvironment(env: Readonly<Record<string, string | undefined>>) {
  const vm = resolveVmResourceEnvironment(env);
  const catchup = resolveCatchupResourceEnvironment(env);
  return Object.freeze({
    values: Object.freeze({ ...vm.values, ...catchup.values }),
    startupMaxDelayMs: vm.startupMaxDelayMs,
    rejected: Object.freeze([...vm.rejected, ...catchup.rejected]),
  });
}
