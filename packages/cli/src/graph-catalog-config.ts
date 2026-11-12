import {
  DEFAULT_STORE_GRAPH_CATALOG_MAX_BYTES,
  STORE_GRAPH_CATALOG_MAX_BYTES_ENV,
  configureStoreGraphCatalogMaxBytes,
  graphCatalogMaxBytesProblem,
  type GraphCatalogStoreConfig,
} from '@origintrail-official/dkg-storage';

/**
 * `store.graphCatalog` in config.json: the node's bound on its graph catalog, the list of the
 * store's named graphs that the node keeps and reads whole. `maxBytes` defaults to 256 MiB, and
 * DKG_STORE_GRAPH_CATALOG_MAX_BYTES in the process environment wins over it. A `store` section
 * may hold it without a `backend`; the node then keeps its default store.
 */
export interface GraphCatalogConfig {
  maxBytes?: number;
}

/**
 * Check `store.graphCatalog` and the environment variable that overrides it, set the configured
 * value as this process's ceiling, and return it for the store configs the process builds.
 * A bad value throws an error that names the setting, so the process refuses to start with it.
 */
export function applyGraphCatalogConfig(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): GraphCatalogStoreConfig | undefined {
  const raw = env[STORE_GRAPH_CATALOG_MAX_BYTES_ENV]?.trim();
  if (raw && graphCatalogMaxBytesProblem(Number(raw)) !== undefined) {
    throw new Error(`${STORE_GRAPH_CATALOG_MAX_BYTES_ENV} must be a positive whole number of bytes, not ${JSON.stringify(raw)}. `
      + `Unset it to use store.graphCatalog.maxBytes, or the default of ${DEFAULT_STORE_GRAPH_CATALOG_MAX_BYTES} bytes.`);
  }
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('store.graphCatalog must be an object, for example { "maxBytes": 536870912 }.');
  }
  const { maxBytes } = value as { readonly maxBytes?: unknown };
  if (maxBytes === undefined) return undefined;
  const problem = graphCatalogMaxBytesProblem(maxBytes);
  if (problem) {
    throw new Error(`store.graphCatalog.maxBytes ${problem}. Remove it to keep the default of ${DEFAULT_STORE_GRAPH_CATALOG_MAX_BYTES} bytes.`);
  }
  configureStoreGraphCatalogMaxBytes(maxBytes);
  return { maxBytes: maxBytes as number };
}
