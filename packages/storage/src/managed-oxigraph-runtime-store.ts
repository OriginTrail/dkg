import type { TripleStoreConfig } from './triple-store.js';

const managedRuntimeOptions = new WeakSet<object>();

/**
 * Construct the runtime-only store view for a DKG-supervised local Oxigraph
 * process. The authority is attached to the exact options object created here;
 * JSON, object literals, and copied persisted configuration cannot recreate it.
 *
 * This behavior-oriented factory is the only public managed-runtime boundary:
 * callers do not receive or mint a token, and the generic SPARQL adapter never
 * trusts a boolean or serialized marker.
 */
export function createManagedOxigraphRuntimeStoreConfigV1<
  TConfig extends TripleStoreConfig,
>(config: TConfig): TConfig {
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

  const runtimeOptions = Object.freeze({ ...options });
  managedRuntimeOptions.add(runtimeOptions);
  return Object.freeze({
    ...config,
    options: runtimeOptions,
  }) as TConfig;
}

/** @internal Used only by the SPARQL adapter capability boundary. */
export function isManagedOxigraphRuntimeStoreOptionsV1(
  candidate: unknown,
): candidate is Readonly<Record<string, unknown>> {
  return candidate !== null
    && typeof candidate === 'object'
    && managedRuntimeOptions.has(candidate);
}

/** @internal Preserve runtime provenance through storage-owned option cloning. */
export function copyManagedOxigraphRuntimeStoreOptionsV1(
  source: Record<string, unknown> | undefined,
  target: Record<string, unknown>,
): Record<string, unknown> {
  const copy = Object.freeze({ ...target });
  if (isManagedOxigraphRuntimeStoreOptionsV1(source)) {
    managedRuntimeOptions.add(copy);
  }
  return copy;
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
