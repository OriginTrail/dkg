// SPDX-License-Identifier: Apache-2.0

/** Browser-safe wire contract returned by POST /api/context-graph/memory-layers. */
export type PublicMemoryLayerKey = 'wm' | 'swm' | 'vm';

export interface PublicMemoryLayerBinding {
  s: string;
  p: string;
  o: string;
  g: string;
}

export interface PublicMemoryLayerResult {
  bindings: PublicMemoryLayerBinding[];
  ok: boolean;
  truncated: boolean;
}

export interface PublicMemoryLayersResponse {
  contextGraphId: string;
  layers: Record<PublicMemoryLayerKey, PublicMemoryLayerResult>;
}
