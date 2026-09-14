import { MAX_NODE_TIMER_DELAY_MS } from '@origintrail-official/dkg-core';

/** Operational ceilings, not protocol limits. See docs/agent-resource-limits.md. */
export const RESOURCE_MAX = Object.freeze({
  timerMs: MAX_NODE_TIMER_DELAY_MS,
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

/** The subsystem whose process-scoped snapshot captures a setting. */
export type ResourceOwner = 'vm' | 'catchup';

interface EnvironmentIntegerSpec extends IntegerBounds {
  /**
   * The value used when the environment supplies none or an invalid one.
   * `{ from }` derives it from another setting's RESOLVED value, which is how
   * a dependent setting stays in this registry instead of needing its own
   * parser. The referenced setting must belong to the same owner and be
   * declared earlier, so it is already resolved; both are checked below.
   */
  fallback: number | { readonly from: string };
  owner: ResourceOwner;
  /** Whether startup diagnostics publish the resolved value. */
  diagnostic: boolean;
}

/**
 * The one descriptor of every process-scoped setting. Owner slices, their
 * resolvers and the startup diagnostics projection all derive from it, so a
 * new setting is declared here once, with its owner and visibility.
 */
export const AGENT_RESOURCE_ENV_SPECS = {
  DKG_VM_RECONCILE_INTERVAL_MS: { owner: 'vm', diagnostic: true, min: 1, max: RESOURCE_MAX.timerMs, fallback: 60_000 },
  // Startup jitter defaults to one reconcile interval. Zero is a valid
  // configured value (no jitter), so the bound starts at 0; startup
  // diagnostics do not publish it.
  DKG_VM_RECONCILE_STARTUP_MAX_DELAY_MS: {
    owner: 'vm', diagnostic: false, min: 0, max: RESOURCE_MAX.timerMs,
    fallback: { from: 'DKG_VM_RECONCILE_INTERVAL_MS' },
  },
  DKG_VM_RECONCILE_BACKOFF_MAX_MS: { owner: 'vm', diagnostic: true, min: 1, max: RESOURCE_MAX.timerMs, fallback: 600_000 },
  DKG_VM_RECONCILE_CACHE_MAX_ENTRIES: { owner: 'vm', diagnostic: true, min: 1, max: RESOURCE_MAX.cacheEntries, fallback: 1_000 },
  DKG_VM_RECONCILE_CG_STATE_MAX_ENTRIES: { owner: 'vm', diagnostic: true, min: 1, max: RESOURCE_MAX.cacheEntries, fallback: 1_000 },
  DKG_VM_RECONCILE_SWM_GEN_FINGERPRINT_MAX_ROWS: { owner: 'vm', diagnostic: true, min: 1, max: RESOURCE_MAX.rows, fallback: 2_000 },
  DKG_VM_RECONCILE_QUEUE_MAX_PENDING: { owner: 'vm', diagnostic: true, min: 1, max: RESOURCE_MAX.queue, fallback: 256 },
  DKG_VM_RECONCILE_BATCH_SIZE: { owner: 'vm', diagnostic: true, min: 1, max: RESOURCE_MAX.batch, fallback: 10 },
  DKG_VM_RECONCILE_ORDINAL_CONCURRENCY: { owner: 'vm', diagnostic: true, min: 1, max: RESOURCE_MAX.vmConcurrency, fallback: 5 },
  DKG_VM_RECONCILE_CONCURRENCY: { owner: 'vm', diagnostic: true, min: 1, max: RESOURCE_MAX.vmConcurrency, fallback: 2 },
  DKG_VM_RECONCILE_MAX_FOREGROUND_BURST: { owner: 'vm', diagnostic: true, min: 1, max: RESOURCE_MAX.batch, fallback: 8 },
  DKG_VM_RECONCILE_SHUTDOWN_TIMEOUT_MS: { owner: 'vm', diagnostic: true, min: 1, max: RESOURCE_MAX.shutdownMs, fallback: 5_000 },
  DKG_RANDOM_SAMPLING_SHUTDOWN_TIMEOUT_MS: { owner: 'vm', diagnostic: true, min: 1, max: RESOURCE_MAX.shutdownMs, fallback: 5_000 },
  DKG_CORE_HOST_RECORDING_DRAIN_TIMEOUT_MS: { owner: 'vm', diagnostic: true, min: 1, max: RESOURCE_MAX.shutdownMs, fallback: 5_000 },
  DKG_VM_RECONCILE_CONFIRMATION_DEPTH: { owner: 'vm', diagnostic: true, min: 1, max: RESOURCE_MAX.confirmationDepth, fallback: 5 },
  DKG_CATCHUP_MAX_CONCURRENT_PEERS: { owner: 'catchup', diagnostic: true, min: 1, max: RESOURCE_MAX.concurrency, fallback: 4 },
  DKG_CATCHUP_BACKPRESSURE_MAX_WAIT_MS: { owner: 'catchup', diagnostic: true, min: 0, max: RESOURCE_MAX.retryMs, fallback: 180_000 },
} as const satisfies Record<string, EnvironmentIntegerSpec>;

type AgentResourceEnvSpecs = typeof AGENT_RESOURCE_ENV_SPECS;
export type AgentResourceEnvName = keyof AgentResourceEnvSpecs;

/** Every dependent fallback names a real setting; a typo is a compile error. */
type DependentFallbacksResolve = {
  [Name in AgentResourceEnvName]:
    AgentResourceEnvSpecs[Name]['fallback'] extends { readonly from: infer From }
      ? From extends AgentResourceEnvName ? true : never
      : true;
}[AgentResourceEnvName];
const _dependentFallbacksResolve: DependentFallbacksResolve = true;
void _dependentFallbacksResolve;

/** The settings the descriptor assigns to `Owner`; `Diagnostic` narrows to published ones. */
export type OwnedResourceEnvName<Owner extends ResourceOwner, Diagnostic extends boolean = boolean> = {
  [Name in AgentResourceEnvName]:
    AgentResourceEnvSpecs[Name] extends { owner: Owner; diagnostic: Diagnostic } ? Name : never;
}[AgentResourceEnvName];

/** Runtime projection of {@link OwnedResourceEnvName}, in descriptor order. */
export function ownedResourceEnvNames<Owner extends ResourceOwner, Diagnostic extends boolean = boolean>(
  owner: Owner,
  diagnostic?: Diagnostic,
): readonly OwnedResourceEnvName<Owner, Diagnostic>[] {
  return (Object.keys(AGENT_RESOURCE_ENV_SPECS) as AgentResourceEnvName[]).filter(
    (name): name is OwnedResourceEnvName<Owner, Diagnostic> => {
      const spec = AGENT_RESOURCE_ENV_SPECS[name];
      return spec.owner === owner && (diagnostic === undefined || spec.diagnostic === diagnostic);
    },
  );
}

type OwnedResourceValues<Owner extends ResourceOwner> = Readonly<Record<OwnedResourceEnvName<Owner>, number>>;

/**
 * The VM owner's process-scoped slice. The `owner` tag is what keeps one
 * owner's slice — or a merge of several — from standing in for another's.
 */
export interface VmResourceSnapshot {
  readonly owner: 'vm';
  readonly values: OwnedResourceValues<'vm'>;
  readonly startupMaxDelayMs: number;
  readonly rejected: readonly string[];
}

/** The sync catch-up owner's process-scoped slice. */
export interface CatchupResourceSnapshot {
  readonly owner: 'catchup';
  readonly values: OwnedResourceValues<'catchup'>;
  readonly rejected: readonly string[];
}

/** Every owner's slice, composed explicitly at the composition root and never merged. */
export interface AgentResourceSnapshots {
  readonly vm: VmResourceSnapshot;
  readonly catchup: CatchupResourceSnapshot;
}

function resolveOwnedResourceEnvironment<Owner extends ResourceOwner>(
  owner: Owner,
  env: Readonly<Record<string, string | undefined>>,
) {
  const warnings = new ResourceConfigWarnings();
  const values = {} as Record<OwnedResourceEnvName<Owner>, number>;
  for (const name of ownedResourceEnvNames(owner)) {
    const spec = AGENT_RESOURCE_ENV_SPECS[name];
    const fallback = typeof spec.fallback === 'number'
      ? spec.fallback
      : resolvedDependency(spec.fallback.from, name, values);
    values[name] = resourceIntegerEnv(env[name], spec, name, warnings.reject) ?? fallback;
  }
  return { values, rejected: [...warnings.settings] };
}

/**
 * The resolved value a dependent fallback derives from. Declaration order is
 * resolution order, so a dependency declared later — or owned by another
 * slice, which this loop never resolves — is a declaration error, not a
 * silent zero.
 */
function resolvedDependency(
  from: string,
  dependent: string,
  values: Record<string, number>,
): number {
  const resolved = values[from];
  if (resolved === undefined) {
    throw new Error(
      `${dependent} derives its fallback from ${from}, which is not resolved first `
      + 'in AGENT_RESOURCE_ENV_SPECS under the same owner',
    );
  }
  return resolved;
}

/** VM-owned process settings. Importing a catch-up helper never initializes this slice. */
export function resolveVmResourceEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): VmResourceSnapshot {
  const resolved = resolveOwnedResourceEnvironment('vm', env);
  return Object.freeze({
    owner: 'vm',
    values: Object.freeze(resolved.values),
    // Named projection of a descriptor setting, kept for the static consumers.
    startupMaxDelayMs: resolved.values.DKG_VM_RECONCILE_STARTUP_MAX_DELAY_MS,
    rejected: Object.freeze(resolved.rejected),
  });
}

/** Sync catch-up-owned process settings, resolved independently from VM settings. */
export function resolveCatchupResourceEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): CatchupResourceSnapshot {
  const resolved = resolveOwnedResourceEnvironment('catchup', env);
  return Object.freeze({
    owner: 'catchup',
    values: Object.freeze(resolved.values),
    rejected: Object.freeze(resolved.rejected),
  });
}

/** Both owner slices from one environment, for callers outside the process-scoped runtime modules. */
export function resolveAgentResourceSnapshots(
  env: Readonly<Record<string, string | undefined>>,
): AgentResourceSnapshots {
  return Object.freeze({
    vm: resolveVmResourceEnvironment(env),
    catchup: resolveCatchupResourceEnvironment(env),
  });
}
