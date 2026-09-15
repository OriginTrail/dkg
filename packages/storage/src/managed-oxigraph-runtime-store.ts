import type { TripleStoreConfig } from './triple-store.js';

const MANAGED_RUNTIME_CONTEXT = Symbol('dkg.managed-oxigraph-runtime-v1');
const managedRuntimeContexts = new WeakSet<object>();
const MANAGED_RUNTIME_DECORATOR_KEYS = [
  'largeLiteralStorage',
  'graphSetIndex',
  'changelog',
] as const;
type ManagedRuntimeDecoratorKey = typeof MANAGED_RUNTIME_DECORATOR_KEYS[number];
type ManagedRuntimeDecorators = Pick<TripleStoreConfig, ManagedRuntimeDecoratorKey>;

export interface ManagedOxigraphRuntimeStateV1 {
  readonly recovering: boolean;
  readonly generation: number;
}

/** Per-adapter activity lease used when more than one store shares a runtime. */
export interface ManagedOxigraphRuntimeActivityLeaseV1 {
  report(activeOperations: number): void;
  dispose(): void;
}

/** Runtime control plane supplied only by the daemon-owned construction path. */
export interface ManagedOxigraphRuntimeHooksV1 {
  readonly onClientTimeout?: (operation: string) => void;
  readonly getRecoveryState?: () => ManagedOxigraphRuntimeStateV1;
  readonly onActivityChange?: (activeOperations: number) => void;
  /** Prefer a per-store lease so a shared supervisor can aggregate activity. */
  readonly registerActivity?: () => ManagedOxigraphRuntimeActivityLeaseV1;
}

interface ManagedOxigraphRuntimeContextV1 {
  readonly hooks: Readonly<ManagedOxigraphRuntimeHooksV1>;
}

/**
 * Explicit runtime-only construction input for a DKG-supervised local
 * Oxigraph process. The non-enumerable private brand belongs to this dedicated
 * construction object, never to the generic adapter options bag. JSON and
 * ordinary object spreading therefore produce an untrusted TripleStoreConfig.
 */
export interface ManagedOxigraphRuntimeStoreConfigV1 extends TripleStoreConfig {
  readonly backend: 'sparql-http';
  readonly options: Record<string, unknown>;
  readonly [MANAGED_RUNTIME_CONTEXT]: ManagedOxigraphRuntimeContextV1;
}

/**
 * Capture an options bag without invoking caller code. Managed authority is
 * valid only for the values in this snapshot, never for a later read from the
 * caller-owned object.
 *
 * @internal Shared with the dedicated managed adapter constructor.
 */
export function snapshotManagedOxigraphRuntimeOptionsV1(
  input: unknown,
  managedByDkg = false,
  omitKeys: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (input === null || typeof input !== 'object') {
    throw new Error('managed Oxigraph options must be an object of data properties');
  }

  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(input);
  } catch {
    throw new Error('managed Oxigraph options could not be snapshotted');
  }

  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') {
      throw new Error('managed Oxigraph options must use string data properties');
    }
    const descriptor = descriptors[key]!;
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`managed Oxigraph option ${key} must be a data property`);
    }
    if ((managedByDkg && key === 'managedByDkg') || omitKeys.includes(key)) continue;
    Object.defineProperty(snapshot, key, {
      configurable: false,
      enumerable: true,
      value: descriptor.value,
      writable: false,
    });
  }
  if (managedByDkg) {
    Object.defineProperty(snapshot, 'managedByDkg', {
      configurable: false,
      enumerable: true,
      value: true,
      writable: false,
    });
  }
  return Object.freeze(snapshot);
}

export function createManagedOxigraphRuntimeStoreConfigV1(
  config: TripleStoreConfig,
  hooks: ManagedOxigraphRuntimeHooksV1 = {},
): ManagedOxigraphRuntimeStoreConfigV1 {
  if (config.backend !== 'sparql-http') {
    throw new Error('managed Oxigraph runtime config must use the sparql-http backend');
  }
  if (config.options === undefined) {
    throw new Error('managed Oxigraph runtime config requires endpoint options');
  }
  const options = snapshotManagedOxigraphRuntimeOptionsV1(config.options);
  assertLoopbackEndpoint(options.queryEndpoint, 'queryEndpoint');
  assertLoopbackEndpoint(
    options.updateEndpoint ?? options.queryEndpoint,
    'updateEndpoint',
  );
  if (options.managedByDkg !== true) {
    throw new Error('managed Oxigraph runtime config must be owned by the DKG daemon');
  }

  const context: ManagedOxigraphRuntimeContextV1 = Object.freeze({
    hooks: Object.freeze({ ...hooks }),
  });
  managedRuntimeContexts.add(context);
  const runtimeConfig = {
    backend: 'sparql-http' as const,
    options,
    ...copyManagedRuntimeDecorators(config),
  } as ManagedOxigraphRuntimeStoreConfigV1;
  Object.defineProperty(runtimeConfig, MANAGED_RUNTIME_CONTEXT, {
    configurable: false,
    enumerable: false,
    value: context,
    writable: false,
  });
  return Object.freeze(runtimeConfig);
}

/**
 * Rebuild the decorator portion of a managed runtime config while carrying
 * its authenticated control-plane hooks forward. The endpoint and managed
 * ownership snapshot remain fixed; callers can only replace store decorators.
 */
export function withManagedOxigraphRuntimeStoreConfigV1(
  config: ManagedOxigraphRuntimeStoreConfigV1,
  updates: Readonly<Partial<Pick<
    TripleStoreConfig,
    'largeLiteralStorage' | 'graphSetIndex' | 'changelog'
  >>>,
): ManagedOxigraphRuntimeStoreConfigV1 {
  const hooks = getManagedOxigraphRuntimeHooksV1(config);
  if (hooks === undefined) {
    throw new Error('managed Oxigraph runtime config has no authenticated control plane');
  }
  return createManagedOxigraphRuntimeStoreConfigV1({
    backend: config.backend,
    options: config.options,
    ...copyManagedRuntimeDecorators(config, updates),
  }, hooks);
}

/** Copy and merge the complete decorator model in one descriptor-free pass. */
function copyManagedRuntimeDecorators(
  source: TripleStoreConfig,
  updates?: Readonly<Partial<ManagedRuntimeDecorators>>,
): Partial<ManagedRuntimeDecorators> {
  const decorators: Partial<ManagedRuntimeDecorators> = {};
  for (const key of MANAGED_RUNTIME_DECORATOR_KEYS) {
    const value = updates !== undefined
      && Object.prototype.hasOwnProperty.call(updates, key)
      ? updates[key]
      : source[key];
    if (value !== undefined) decorators[key] = value;
  }
  return decorators;
}

/** @internal Read only by the generic construction boundary before cloning. */
export function isManagedOxigraphRuntimeStoreConfigV1(
  candidate: unknown,
): candidate is ManagedOxigraphRuntimeStoreConfigV1 {
  return getManagedOxigraphRuntimeConstructionAuthorityV1(candidate) !== undefined;
}

/** @internal Pass the one opaque authority through the adapter construction boundary. */
export function getManagedOxigraphRuntimeConstructionAuthorityV1(
  candidate: unknown,
): object | undefined {
  if (candidate === null || typeof candidate !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(candidate, MANAGED_RUNTIME_CONTEXT);
  return descriptor !== undefined
    && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    && typeof descriptor.value === 'object'
    && descriptor.value !== null
    && managedRuntimeContexts.has(descriptor.value)
    ? descriptor.value
    : undefined;
}

/** @internal Recognize only the authority minted by the runtime config factory. */
export function isManagedOxigraphRuntimeConstructionAuthorityV1(
  candidate: unknown,
): boolean {
  return typeof candidate === 'object'
    && candidate !== null
    && managedRuntimeContexts.has(candidate);
}

/** @internal Recover the typed daemon hooks from an authenticated context. */
export function getManagedOxigraphRuntimeHooksV1(
  candidate: unknown,
): Readonly<ManagedOxigraphRuntimeHooksV1> | undefined {
  const context = isManagedOxigraphRuntimeConstructionAuthorityV1(candidate)
    ? candidate
    : getManagedOxigraphRuntimeConstructionAuthorityV1(candidate);
  return context !== undefined
    ? (context as ManagedOxigraphRuntimeContextV1).hooks
    : undefined;
}

function assertLoopbackEndpoint(input: unknown, label: string): void {
  if (typeof input !== 'string') {
    throw new Error(`managed Oxigraph ${label} must be a loopback HTTP URL`);
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`managed Oxigraph ${label} must be a loopback HTTP URL`);
  }
  if (
    url.protocol !== 'http:'
    || (
      url.hostname !== '127.0.0.1'
      && url.hostname !== 'localhost'
      && url.hostname !== '::1'
      && url.hostname !== '[::1]'
    )
  ) {
    throw new Error(`managed Oxigraph ${label} must be a loopback HTTP URL`);
  }
}
