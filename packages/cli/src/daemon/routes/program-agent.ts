import { getAddress, isAddress } from 'ethers';
import { isExplicitNodeOperator } from '../../auth.js';
import { SemanticProgramError } from '../../semantic-runtime.js';
import type { RequestContext } from './context.js';

/** An explicit local-agent selection delegates only Program actions, never arbitrary signing. */
export function programCaller(ctx: RequestContext): string | undefined {
  const selected = ctx.req.headers?.['x-dkg-program-agent'];
  if (selected === undefined) return ctx.actor.authenticatedAgentAddress;
  if (typeof selected !== 'string' || !isAddress(selected))
    throw new SemanticProgramError('INVALID_PROGRAM_AGENT', 'Select a valid local agent address', 400);
  const address = getAddress(selected);
  const self = ctx.actor.authenticatedAgentAddress?.toLowerCase() === address.toLowerCase();
  const auth = ctx.actor.authentication;
  // Agent-key HTTP proofs do not bind this optional header. It must never switch
  // their signed identity, even when that agent also has operator privileges.
  const operatorSession = isExplicitNodeOperator(auth) && auth.acceptedToken !== undefined;
  if (!operatorSession && !self)
    throw new SemanticProgramError('PROGRAM_AGENT_FORBIDDEN', 'Selecting a local agent requires its own credential or the node operator', 403);
  if (!ctx.agent.getCustodialAgentPrivateKey(address))
    throw new SemanticProgramError('PROGRAM_AGENT_UNAVAILABLE', 'This node does not hold the selected agent key', 409);
  return address;
}

export function availableProgramAgents(ctx: RequestContext) {
  const operator = isExplicitNodeOperator(ctx.actor.authentication);
  const own = ctx.actor.authenticatedAgentAddress;
  if (!operator && !own)
    throw new SemanticProgramError('PROGRAM_AGENT_FORBIDDEN', 'An authenticated node session is required', 403);
  // Whitelist public fields: local records also contain authentication material.
  const agents = ctx.agent.listLocalAgents()
    .filter(a => (operator || a.agentAddress.toLowerCase() === own!.toLowerCase())
      && !!ctx.agent.getCustodialAgentPrivateKey(a.agentAddress))
    .map(a => ({ address: a.agentAddress, name: a.name }));
  return { agents, defaultAddress: ctx.actor.effectiveAgentAddress };
}
