// SPDX-License-Identifier: Apache-2.0
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import type { ContextGraphReader } from '../context-graph-read-model.js';

export function contextGraphReader(agent: DKGAgent, contextGraphId: string, callerAgentAddress?: string): ContextGraphReader {
  return { statistics: options => agent.readContextGraphNamedGraphStats(contextGraphId, { ...options, callerAgentAddress }) };
}
