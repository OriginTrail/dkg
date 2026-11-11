import { BlazegraphStore } from '../../src/adapters/blazegraph.js';
import { OxigraphStore } from '../../src/adapters/oxigraph.js';
import type { TripleStoreConfig } from '../../src/triple-store-composition.js';
import type { TripleStore } from '../../src/triple-store.js';

/**
 * The store a kill-lane writer process opens, from its environment: DKG_KILL_BACKEND is `blazegraph`
 * (with DKG_KILL_URL) or `oxigraph` (with DKG_KILL_PATH, a persistent store, which dumps itself
 * shortly after each write). The production adapter, and the config the read-graph layer takes.
 */
export function openKillWriterStore(env: NodeJS.ProcessEnv = process.env): { readonly adapter: TripleStore; readonly config: TripleStoreConfig } {
  if (env.DKG_KILL_BACKEND === 'blazegraph') {
    const url = env.DKG_KILL_URL;
    if (!url) throw new Error('DKG_KILL_URL is required');
    return { adapter: new BlazegraphStore(url, { timeout: 120_000 }), config: { backend: 'blazegraph', options: { url } } };
  }
  if (env.DKG_KILL_BACKEND === 'oxigraph') {
    const path = env.DKG_KILL_PATH;
    if (!path) throw new Error('DKG_KILL_PATH is required');
    return { adapter: new OxigraphStore(path), config: { backend: 'oxigraph-persistent', options: { path } } };
  }
  throw new Error(`Unknown DKG_KILL_BACKEND: ${env.DKG_KILL_BACKEND}`);
}
