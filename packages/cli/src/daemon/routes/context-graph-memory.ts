// SPDX-License-Identifier: Apache-2.0

import type { DKGAgent } from '@origintrail-official/dkg-agent';
import type { PublicMemoryLayersResponse } from '@origintrail-official/dkg-core/memory-layer-result';
import { canAdministerNode } from '../../auth.js';
import { readMemoryLayers, type ContextGraphReader } from '../context-graph-read-model.js';
import { admitContextGraphFollow } from '../context-graph-subscription-admission.js';
import { createStoreQueryRequestLifecycle } from '../store-query-lifecycle.js';
import { readBody, safeParseJson, jsonResponse, validateRequiredContextGraphId,
  respondIfContextGraphReadAuthorityUnavailable, SMALL_BODY_BYTES } from '../http-utils.js';
import { actorFromRequestContext, type RequestContext } from './context.js';

export function contextGraphReader(agent: DKGAgent, contextGraphId: string, callerAgentAddress?: string): ContextGraphReader {
  return {
    listGraphs: options => agent.listContextGraphQueryPartitions(contextGraphId, { ...options, callerAgentAddress }),
    query: async (sparql, options, policy) => {
      const result = await agent.query(sparql, { ...options, contextGraphId,
        includeContextGraphPartitions: true, exactContextGraphPartitions: true,
        includeSharedMemory: policy.includeSharedMemory, callerAgentAddress });
      return { type: 'bindings', bindings: result.bindings };
    },
  };
}

/** Serial, caller-admitted exact graph reads for dashboard memory layers. */
export async function handleContextGraphMemoryLayerRoute(ctx: RequestContext): Promise<void> {
  const { req, res, agent } = ctx;
  const actor = actorFromRequestContext(ctx);
  const body = await readBody(req, SMALL_BODY_BYTES);
  const parsed = safeParseJson(body, res);
  if (!parsed) return;
  const contextGraphId = parsed.contextGraphId;
  if (!validateRequiredContextGraphId(contextGraphId, res)) return;

  // Discover no graph names until the canonical admission boundary accepts
  // this caller. Each batch then uses agent.query again to preserve read,
  // shared-memory, and caller isolation if authority changes during the read.
  const admission = await admitContextGraphFollow(agent, contextGraphId, {
    isNodeAdmin: canAdministerNode(ctx.authentication), agentAddress: actor.authenticatedAgentAddress,
  });
  if (admission === 'unavailable') {
    res.setHeader('Retry-After', '2');
    return jsonResponse(res, 503, { code: 'CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE', retryable: true, error: 'Context graph read authority unavailable' });
  }
  if (admission === 'denied') {
    const empty = { bindings: [], ok: true, truncated: false };
    const response: PublicMemoryLayersResponse = { contextGraphId, layers: { wm: empty, swm: empty, vm: empty } };
    return jsonResponse(res, 200, response);
  }
  const lifecycle = createStoreQueryRequestLifecycle(req, res, 'node-ui.memory-layers');
  try {
    const snapshot = await readMemoryLayers(contextGraphReader(agent, contextGraphId, actor.authenticatedAgentAddress), contextGraphId, {
      signal: lifecycle.signal,
      priority: lifecycle.priority,
      includeQueryCatalog: parsed.includeQueryCatalog === true,
    });
    if (!res.writableEnded && !res.destroyed) {
      const response: PublicMemoryLayersResponse = { contextGraphId, ...snapshot };
      return jsonResponse(res, 200, response);
    }
    return;
  } catch (err: any) {
    if (lifecycle.signal.aborted || res.destroyed) return;
    if (respondIfContextGraphReadAuthorityUnavailable(res, err)) return;
    return jsonResponse(res, 500, {
      error: err?.message ?? 'Failed to read context-graph memory layers',
    });
  } finally {
    lifecycle.dispose();
  }
}
