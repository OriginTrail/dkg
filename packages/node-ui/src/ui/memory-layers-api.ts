// SPDX-License-Identifier: Apache-2.0

import { BASE, authHeaders, fetchWithTimeout, HttpError } from './http.js';
import type {
  PublicMemoryLayerBinding,
  PublicMemoryLayerKey,
  PublicMemoryLayerResult,
  PublicMemoryLayersResponse,
} from '@origintrail-official/dkg-core/memory-layer-result';

const CONTEXT_GRAPH_LOAD_TIMEOUT_MS = 60000;

export type MemoryLayerApiKey = PublicMemoryLayerKey;
export type MemoryLayerApiBinding = PublicMemoryLayerBinding;
export type MemoryLayerApiResult = PublicMemoryLayerResult;
export type MemoryLayersApiResponse = PublicMemoryLayersResponse;

// Every mounted view of the same CG consumes the same read model. Keep one
// browser request in flight per CG so DashboardView, ProjectView, strict-mode
// mounts, and SSE refreshes cannot multiply storage work.
const inflightMemoryLayers = new Map<string, Promise<MemoryLayersApiResponse>>();

export function fetchMemoryLayersDeduped(contextGraphId: string, includeQueryCatalog = false): Promise<MemoryLayersApiResponse> {
  const headers = authHeaders();
  const cacheKey = JSON.stringify([contextGraphId, includeQueryCatalog, headers.Authorization ?? null]);
  const existing = inflightMemoryLayers.get(cacheKey);
  if (existing) return existing;
  const promise = (async () => {
    const res = await fetchWithTimeout(`${BASE}/api/context-graph/memory-layers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ contextGraphId, includeQueryCatalog }),
    }, CONTEXT_GRAPH_LOAD_TIMEOUT_MS);
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const msg = (errBody as { error?: string })?.error ?? `HTTP ${res.status}`;
      throw new HttpError(res.status, msg, errBody);
    }
    return res.json() as Promise<MemoryLayersApiResponse>;
  })().finally(() => {
    inflightMemoryLayers.delete(cacheKey);
  });
  inflightMemoryLayers.set(cacheKey, promise);
  return promise;
}
