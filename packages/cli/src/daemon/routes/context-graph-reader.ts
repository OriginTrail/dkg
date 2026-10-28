// SPDX-License-Identifier: Apache-2.0
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import type { ContextGraphReader } from '../context-graph-read-model.js';

export function contextGraphReader(agent: DKGAgent, contextGraphId: string, callerAgentAddress?: string): ContextGraphReader {
  return {
    listPartitions: options => agent.listContextGraphQueryPartitionReads(contextGraphId, { ...options, callerAgentAddress }),
    query: async (sparql, options, admission) => {
      const result = await agent.query(sparql, { ...options, contextGraphId,
        includeContextGraphPartitions: true, exactContextGraphPartitions: true,
        includeSharedMemory: admission === 'shared-memory', callerAgentAddress });
      return { type: 'bindings', bindings: result.bindings };
    },
  };
}

