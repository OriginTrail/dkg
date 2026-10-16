import type { DKGAgent, AssertionPromoteOptions } from '@origintrail-official/dkg-agent';
import type { PromoteRequest } from '@origintrail-official/dkg-publisher';

/** The admitted request is the sole source of durable execution fields. */
export async function executePromoteRequest(agent: Pick<DKGAgent, 'assertion'>, request: PromoteRequest,
  markStarted: () => Promise<void>, attempt?: Pick<AssertionPromoteOptions, 'curatorAckTimeoutMs'>,
): ReturnType<DKGAgent['assertion']['promote']> {
  await markStarted();
  return agent.assertion.promote(request.contextGraphId, request.assertionName, {
    entities: request.entities === undefined || request.entities === 'all' ? request.entities : [...request.entities],
    recoveryBinding: request.recoveryBinding,
    subGraphName: request.subGraphName,
    ...(request.agentAddress ? { agentAddress: request.agentAddress } : {}),
    ...(request.authorAgentAddress ? { authorAgentAddress: request.authorAgentAddress } : {}),
    ...(attempt?.curatorAckTimeoutMs !== undefined ? { curatorAckTimeoutMs: attempt.curatorAckTimeoutMs } : {}),
  });
}
