import type { EntityIndexSpec } from './types.js';

type Post = (path: string, body: unknown, deadline: { timeoutMs: number }) => Promise<unknown>;
export function createEntityClient(post: Post) {
  return {
    readiness: (body: { contextGraphId: string; indexId: string; warmup?: boolean }) =>
      post('/api/entities/readiness', body, { timeoutMs: body.warmup ? 35_000 : 6_000 }),
    index: (body: EntityIndexSpec & { restart?: boolean }) => post('/api/entities/index', body, { timeoutMs: 35_000 }) as
      Promise<{ indexId: string; scanComplete: boolean; indexedEntities: number }>,
    search: (body: { contextGraphId: string; indexId: string; query: string; limit?: number }) =>
      post('/api/entities/search', body, { timeoutMs: 6_000 }),
  };
}
