import { join } from 'node:path';

import { assertSafeIri } from '@origintrail-official/dkg-core';
import type { TripleStoreConfig } from '@origintrail-official/dkg-storage';

export type RolloutStoreBackend = 'oxigraph' | 'blazegraph';

export const ROLLOUT_STORE_BACKEND_ENV = 'DKG_RFC64_GATE1_STORE_BACKEND';
export const ROLLOUT_BLAZEGRAPH_URL_ENV = 'DKG_RFC64_GATE1_BLAZEGRAPH_URL';
export const ROLLOUT_STORE_SENTINEL_GRAPH_ENV = 'DKG_RFC64_GATE1_STORE_SENTINEL_GRAPH';

const ROLLOUT_BLAZEGRAPH_TIMEOUT_MS = 30_000;

export type OxigraphRolloutStoreBinding = Readonly<{
  backend: 'oxigraph';
  sentinelGraph: string;
  storePath: string;
  tripleStore: TripleStoreConfig & Readonly<{
    backend: 'oxigraph-persistent';
    options: Readonly<{ path: string }>;
  }>;
}>;

export type BlazegraphRolloutStoreBinding = Readonly<{
  backend: 'blazegraph';
  endpoint: string;
  sentinelGraph: string;
  tripleStore: TripleStoreConfig & Readonly<{
    backend: 'blazegraph';
    options: Readonly<{ timeout: number; url: string }>;
  }>;
}>;

/** One complete, valid store selection. Optional environment values never
 * escape the parser into fixture or adapter code. */
export type RolloutStoreBinding =
  | OxigraphRolloutStoreBinding
  | BlazegraphRolloutStoreBinding;

export type RolloutStoreEnvironment = Readonly<Record<string, string | undefined>>;

export function parseRolloutStoreBackend(input: string | undefined): RolloutStoreBackend {
  if (input === undefined || input === '' || input === 'oxigraph') return 'oxigraph';
  if (input === 'blazegraph') return input;
  throw new Error(`${ROLLOUT_STORE_BACKEND_ENV} must be oxigraph or blazegraph`);
}

export function createOxigraphRolloutStoreBinding(input: Readonly<{
  dataDir: string;
  sentinelGraph: string;
}>): OxigraphRolloutStoreBinding {
  const storePath = join(input.dataDir, 'store.nq');
  return Object.freeze({
    backend: 'oxigraph',
    sentinelGraph: assertSafeIri(input.sentinelGraph),
    storePath,
    tripleStore: Object.freeze({
      backend: 'oxigraph-persistent',
      options: Object.freeze({ path: storePath }),
    }),
  });
}

export function createBlazegraphRolloutStoreBinding(input: Readonly<{
  endpoint: string;
  sentinelGraph: string;
}>): BlazegraphRolloutStoreBinding {
  if (input.endpoint.length === 0) {
    throw new Error(`Blazegraph rollout certification requires ${ROLLOUT_BLAZEGRAPH_URL_ENV}`);
  }
  return Object.freeze({
    backend: 'blazegraph',
    endpoint: input.endpoint,
    sentinelGraph: assertSafeIri(input.sentinelGraph),
    tripleStore: Object.freeze({
      backend: 'blazegraph',
      options: Object.freeze({
        timeout: ROLLOUT_BLAZEGRAPH_TIMEOUT_MS,
        url: input.endpoint,
      }),
    }),
  });
}

export function rolloutStoreBindingToEnv(
  binding: RolloutStoreBinding,
): Readonly<Record<string, string>> {
  if (binding.backend === 'oxigraph') {
    return Object.freeze({
      [ROLLOUT_STORE_BACKEND_ENV]: binding.backend,
      [ROLLOUT_STORE_SENTINEL_GRAPH_ENV]: binding.sentinelGraph,
    });
  }
  return Object.freeze({
    [ROLLOUT_STORE_BACKEND_ENV]: binding.backend,
    [ROLLOUT_BLAZEGRAPH_URL_ENV]: binding.endpoint,
    [ROLLOUT_STORE_SENTINEL_GRAPH_ENV]: binding.sentinelGraph,
  });
}

export function rolloutStoreBindingFromEnv(
  environment: RolloutStoreEnvironment,
  dataDir: string,
): RolloutStoreBinding {
  const backend = parseRolloutStoreBackend(environment[ROLLOUT_STORE_BACKEND_ENV]);
  const sentinelGraph = requiredEnvironmentValue(
    environment,
    ROLLOUT_STORE_SENTINEL_GRAPH_ENV,
  );
  if (backend === 'oxigraph') {
    return createOxigraphRolloutStoreBinding({ dataDir, sentinelGraph });
  }
  return createBlazegraphRolloutStoreBinding({
    endpoint: requiredEnvironmentValue(environment, ROLLOUT_BLAZEGRAPH_URL_ENV),
    sentinelGraph,
  });
}

function requiredEnvironmentValue(
  environment: RolloutStoreEnvironment,
  name: string,
): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}
