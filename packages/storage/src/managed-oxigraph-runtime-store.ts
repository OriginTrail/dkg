import type { TripleStoreConfig } from './triple-store.js';

const MANAGED_RUNTIME_CONTEXT = Symbol('dkg.managed-oxigraph-runtime-v1');
const MANAGED_RUNTIME_AUTHORITY = Object.freeze({
  kind: 'dkg-managed-oxigraph-runtime-v1',
} as const);

/**
 * Explicit runtime-only construction input for a DKG-supervised local
 * Oxigraph process. The non-enumerable private brand belongs to this dedicated
 * construction object, never to the generic adapter options bag. JSON and
 * ordinary object spreading therefore produce an untrusted TripleStoreConfig.
 */
export interface ManagedOxigraphRuntimeStoreConfigV1 extends TripleStoreConfig {
  readonly backend: 'sparql-http';
  readonly options: Record<string, unknown>;
  readonly [MANAGED_RUNTIME_CONTEXT]: typeof MANAGED_RUNTIME_AUTHORITY;
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
    if (managedByDkg && key === 'managedByDkg') continue;
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

  const runtimeConfig = {
    backend: 'sparql-http' as const,
    options,
    ...(config.largeLiteralStorage === undefined
      ? {}
      : { largeLiteralStorage: config.largeLiteralStorage }),
    ...(config.graphSetIndex === undefined
      ? {}
      : { graphSetIndex: config.graphSetIndex }),
    ...(config.changelog === undefined
      ? {}
      : { changelog: config.changelog }),
  } as ManagedOxigraphRuntimeStoreConfigV1;
  Object.defineProperty(runtimeConfig, MANAGED_RUNTIME_CONTEXT, {
    configurable: false,
    enumerable: false,
    value: MANAGED_RUNTIME_AUTHORITY,
    writable: false,
  });
  return Object.freeze(runtimeConfig);
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
    && descriptor.value === MANAGED_RUNTIME_AUTHORITY
    ? MANAGED_RUNTIME_AUTHORITY
    : undefined;
}

/** @internal Recognize only the authority minted by the runtime config factory. */
export function isManagedOxigraphRuntimeConstructionAuthorityV1(
  candidate: unknown,
): boolean {
  return candidate === MANAGED_RUNTIME_AUTHORITY;
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
