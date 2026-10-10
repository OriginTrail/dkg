import { EntityIndexStore } from './store.js';
import { EntitySearchService } from './service.js';
import { LocalEntityEmbedder } from './embedding.js';
import type { EntityEmbeddingConfig } from './types.js';
export function createEntitySearch(dir: string, config?: { embedding: EntityEmbeddingConfig }): EntitySearchService | undefined {
  if (!config) return undefined;
  const embedder = new LocalEntityEmbedder(config.embedding);
  return new EntitySearchService(new EntityIndexStore(dir), embedder);
}
