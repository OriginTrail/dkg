import { join } from 'node:path';

import type { TripleStoreConfig } from '@origintrail-official/dkg-storage';

export type RolloutStoreBackend = 'oxigraph' | 'blazegraph';

export const ROLLOUT_STORE_BACKEND_ENV = 'DKG_RFC64_GATE1_STORE_BACKEND';
export const ROLLOUT_BLAZEGRAPH_URL_ENV = 'DKG_RFC64_GATE1_BLAZEGRAPH_URL';
export const ROLLOUT_STORE_SENTINEL_GRAPH_ENV = 'DKG_RFC64_GATE1_STORE_SENTINEL_GRAPH';

export interface Gate1RolloutStoreConfig {
  readonly backend: RolloutStoreBackend;
  readonly tripleStore: TripleStoreConfig;
}

export function parseRolloutStoreBackend(input: string | undefined): RolloutStoreBackend {
  if (input === undefined || input === '' || input === 'oxigraph') return 'oxigraph';
  if (input === 'blazegraph') return input;
  throw new Error(`${ROLLOUT_STORE_BACKEND_ENV} must be oxigraph or blazegraph`);
}

export function buildGate1RolloutStoreConfig(input: Readonly<{
  backendInput: string | undefined;
  blazegraphUrl: string | undefined;
  dataDir: string;
}>): Gate1RolloutStoreConfig {
  const backend = parseRolloutStoreBackend(input.backendInput);
  if (backend === 'oxigraph') {
    return Object.freeze({
      backend,
      tripleStore: {
        backend: 'oxigraph-persistent',
        options: { path: join(input.dataDir, 'store.nq') },
      },
    });
  }
  if (input.blazegraphUrl === undefined || input.blazegraphUrl.length === 0) {
    throw new Error(`Blazegraph rollout certification requires ${ROLLOUT_BLAZEGRAPH_URL_ENV}`);
  }
  return Object.freeze({
    backend,
    tripleStore: {
      backend: 'blazegraph',
      options: { url: input.blazegraphUrl, timeout: 30_000 },
    },
  });
}
