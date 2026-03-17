export * from './embedding-provider.js';
export * from './job-queue.js';
export * from './sqlite-vec-store.js';
export * from './streaming-scan-store.js';
export * from './triple-text.js';
export * from './vector-sidecar.js';
export * from './vector-store.js';

import type { VectorStore, VectorStoreConfig } from './vector-store.js';
import { SqliteVecStore } from './sqlite-vec-store.js';
import { StreamingScanStore } from './streaming-scan-store.js';

export function createVectorStore(config: VectorStoreConfig): VectorStore {
  try {
    return new SqliteVecStore(config);
  } catch (error) {
    console.warn(
      `[dkg-vector] sqlite-vec unavailable, falling back to streaming scan: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return new StreamingScanStore(config);
  }
}
