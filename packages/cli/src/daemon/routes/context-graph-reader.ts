// SPDX-License-Identifier: Apache-2.0
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import type { ContextGraphReader } from '../context-graph-read-model.js';

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

