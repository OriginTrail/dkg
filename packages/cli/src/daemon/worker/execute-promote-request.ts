import type { DKGAgent, AssertionPromoteOptions } from '@origintrail-official/dkg-agent';
import type { PromoteRequest, PromoteExecutionAuthority } from '@origintrail-official/dkg-publisher';

/** The admitted request is the sole source of durable execution fields. */
export async function executePromoteRequest(agent: Pick<DKGAgent, 'assertion'>, request: PromoteRequest,
  attempt?: Pick<AssertionPromoteOptions, 'curatorAckTimeoutMs'> & { executionAuthority?: PromoteExecutionAuthority },
): ReturnType<DKGAgent['assertion']['promote']> {
  const attemptOptions = {
    subGraphName: request.subGraphName,
    ...(request.agentAddress ? { agentAddress: request.agentAddress } : {}),
    ...(request.authorAgentAddress ? { authorAgentAddress: request.authorAgentAddress } : {}),
    ...(attempt?.curatorAckTimeoutMs !== undefined ? { curatorAckTimeoutMs: attempt.curatorAckTimeoutMs } : {}),
  };
  const options: AssertionPromoteOptions = request.recoveryBinding
    ? { ...attemptOptions, entities: request.entities, recoveryBinding: request.recoveryBinding, executionAuthority: attempt?.executionAuthority }
    : { ...attemptOptions, entities: request.entities === undefined || request.entities === 'all' ? request.entities : [...request.entities] };
  return agent.assertion.promote(request.contextGraphId, request.assertionName, options);
}
