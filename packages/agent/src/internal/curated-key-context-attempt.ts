// SPDX-License-Identifier: Apache-2.0

import type { DKGAgent } from '../dkg-agent.js';
import type { ResolveCuratedChainKeyContextOptions } from '../dkg-agent-publish.js';

export type CuratedKeyContextResolver = () => ReturnType<DKGAgent['_resolveCuratedChainKeyContext']>;

/** A publish attempt gives both inline emitters the same policy, roster and sender-key epoch. */
export function createCuratedKeyContextAttempt(
  agent: DKGAgent,
  contextGraphId: string,
  subGraphName?: string,
  authorAgentAddress?: string,
  explicitPolicyTargetContextGraphId?: string,
  options?: ResolveCuratedChainKeyContextOptions,
): CuratedKeyContextResolver {
  let resolution: ReturnType<CuratedKeyContextResolver> | undefined;
  return () => resolution ??= agent._resolveCuratedChainKeyContext(
    contextGraphId, subGraphName, authorAgentAddress, explicitPolicyTargetContextGraphId, 'LU-5', options,
  );
}
