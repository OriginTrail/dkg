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

export function createManagedOxigraphRuntimeStoreConfigV1(
  config: TripleStoreConfig,
): ManagedOxigraphRuntimeStoreConfigV1 {
  if (config.backend !== 'sparql-http') {
    throw new Error('managed Oxigraph runtime config must use the sparql-http backend');
  }
  const options = config.options;
  if (options === undefined) {
    throw new Error('managed Oxigraph runtime config requires endpoint options');
  }
  assertLoopbackEndpoint(options.queryEndpoint, 'queryEndpoint');
  assertLoopbackEndpoint(
    options.updateEndpoint ?? options.queryEndpoint,
    'updateEndpoint',
  );
  if (options.managedByDkg !== true) {
    throw new Error('managed Oxigraph runtime config must be owned by the DKG daemon');
  }

  const runtimeConfig = {
    ...config,
    backend: 'sparql-http' as const,
    options: Object.freeze({ ...options }),
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
  if (candidate === null || typeof candidate !== 'object') return false;
  const descriptor = Object.getOwnPropertyDescriptor(candidate, MANAGED_RUNTIME_CONTEXT);
  return descriptor !== undefined
    && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    && descriptor.value === MANAGED_RUNTIME_AUTHORITY;
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
