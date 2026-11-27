import { REPEATS_ON_ANY_AUTHORITY_ANSWER as repeatOn } from '../api-client-authority-retry.js';
import type { EntityIndexRequest, EntityReadinessRequest, EntitySearchRequest,
  EntityIndexStatus, EntityReadinessResponse, EntitySearchResponse } from './types.js';

type Post = <T>(path: string, body: unknown, deadline: { timeoutMs: number; repeatOn?: readonly string[] }) => Promise<T>;
export function createEntityClient(post: Post) {
  return {
    readiness: (body: EntityReadinessRequest) =>
      post<EntityReadinessResponse>('/api/entities/readiness', body, { timeoutMs: body.warmup ? 35_000 : 6_000, repeatOn }),
    index: (body: EntityIndexRequest) =>
      post<EntityIndexStatus>('/api/entities/index', body, { timeoutMs: 35_000 }),
    search: (body: EntitySearchRequest) =>
      post<EntitySearchResponse>('/api/entities/search', body, { timeoutMs: 6_000, repeatOn }),
  };
}
