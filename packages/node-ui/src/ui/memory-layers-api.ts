// SPDX-License-Identifier: Apache-2.0

import { BASE, authHeaders, fetchWithTimeout, HttpError } from './http.js';

const CONTEXT_GRAPH_LOAD_TIMEOUT_MS = 60000;

export type MemoryLayerApiKey = 'wm' | 'swm' | 'vm';

export interface MemoryLayerApiBinding {
  s: string;
  p: string;
  o: string;
  g: string;
}

export interface MemoryLayerApiResult {
  bindings: MemoryLayerApiBinding[];
  ok: boolean;
  truncated: boolean;
}

export interface MemoryLayersApiResponse {
  contextGraphId: string;
  layers: Record<MemoryLayerApiKey, MemoryLayerApiResult>;
}

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
