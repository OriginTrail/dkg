import type { EntityIndexSpec, EntityIndexStatus, EntityReadinessResponse, EntitySearchResponse } from './types.js';

type Post = <T>(path: string, body: unknown, deadline: { timeoutMs: number }) => Promise<T>;
export function createEntityClient(post: Post) {
  return {
    readiness: (body: { contextGraphId: string; indexId: string; warmup?: boolean }) =>
      post<EntityReadinessResponse>('/api/entities/readiness', body, { timeoutMs: body.warmup ? 35_000 : 6_000 }),
    index: (body: EntityIndexSpec & { restart?: boolean }) =>
      post<EntityIndexStatus>('/api/entities/index', body, { timeoutMs: 35_000 }),
    search: (body: { contextGraphId: string; indexId: string; query: string; limit?: number }) =>
      post<EntitySearchResponse>('/api/entities/search', body, { timeoutMs: 6_000 }),
  };
}
