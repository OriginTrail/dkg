import { join } from 'node:path';

import { assertSafeIri } from '@origintrail-official/dkg-core';
import type { TripleStoreConfig } from '@origintrail-official/dkg-storage';

export type RolloutStoreBackend = 'oxigraph' | 'blazegraph';

export const ROLLOUT_STORE_BACKEND_ENV = 'DKG_RFC64_GATE1_STORE_BACKEND';
export const ROLLOUT_BLAZEGRAPH_URL_ENV = 'DKG_RFC64_GATE1_BLAZEGRAPH_URL';
export const ROLLOUT_STORE_SENTINEL_GRAPH_ENV = 'DKG_RFC64_GATE1_STORE_SENTINEL_GRAPH';

const ROLLOUT_BLAZEGRAPH_TIMEOUT_MS = 30_000;

export type OxigraphRolloutStoreConfig = TripleStoreConfig & Readonly<{
  backend: 'oxigraph-persistent';
  options: Readonly<{ path: string }>;
}>;

export type BlazegraphRolloutStoreConfig = TripleStoreConfig & Readonly<{
  backend: 'blazegraph';
  options: Readonly<{ timeout: number; url: string }>;
}>;

/** One complete, valid store selection. The discriminated TripleStoreConfig is
 * the only store identity; adapter paths and endpoints are never duplicated. */
export type RolloutStoreBinding = Readonly<{
  sentinelGraph: string;
  tripleStore: OxigraphRolloutStoreConfig | BlazegraphRolloutStoreConfig;
}>;

export type RolloutStoreEnvironment = Readonly<Record<string, string | undefined>>;

export function parseRolloutStoreBackend(input: string | undefined): RolloutStoreBackend {
  if (input === undefined || input === '' || input === 'oxigraph') return 'oxigraph';
  if (input === 'blazegraph') return input;
  throw new Error(`${ROLLOUT_STORE_BACKEND_ENV} must be oxigraph or blazegraph`);
}

export function createOxigraphRolloutStoreBinding(input: Readonly<{
  dataDir: string;
  sentinelGraph: string;
}>): RolloutStoreBinding {
  const storePath = join(input.dataDir, 'store.nq');
  return Object.freeze({
    sentinelGraph: assertSafeIri(input.sentinelGraph),
    tripleStore: Object.freeze({
      backend: 'oxigraph-persistent',
      options: Object.freeze({ path: storePath }),
    }),
  });
}

export function createBlazegraphRolloutStoreBinding(input: Readonly<{
  endpoint: string;
  sentinelGraph: string;
}>): RolloutStoreBinding {
  if (input.endpoint.length === 0) {
    throw new Error(`Blazegraph rollout certification requires ${ROLLOUT_BLAZEGRAPH_URL_ENV}`);
  }
  return Object.freeze({
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
  if (binding.tripleStore.backend === 'oxigraph-persistent') {
    return Object.freeze({
      [ROLLOUT_STORE_BACKEND_ENV]: 'oxigraph',
      [ROLLOUT_STORE_SENTINEL_GRAPH_ENV]: binding.sentinelGraph,
    });
  }
  return Object.freeze({
    [ROLLOUT_STORE_BACKEND_ENV]: 'blazegraph',
    [ROLLOUT_BLAZEGRAPH_URL_ENV]: binding.tripleStore.options.url,
    [ROLLOUT_STORE_SENTINEL_GRAPH_ENV]: binding.sentinelGraph,
  });
}

export function rolloutStoreBackendForBinding(
  binding: RolloutStoreBinding,
): RolloutStoreBackend {
  return binding.tripleStore.backend === 'oxigraph-persistent'
    ? 'oxigraph'
    : 'blazegraph';
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
