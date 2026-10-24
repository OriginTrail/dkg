import type { DkgClient } from '../client.js';

const AGENT_DID_PREFIX = 'did:dkg:agent:';

export function unwrapAgentAddress(value: string): string {
  return value.startsWith(AGENT_DID_PREFIX)
    ? value.slice(AGENT_DID_PREFIX.length)
    : value;
}

/** Resolve the raw daemon identity required by strict Working Memory reads. */
export async function resolveWorkingMemoryAgentAddress(client: DkgClient): Promise<string> {
  const identity = await client.getAgentIdentity();
  const resolved = identity.agentAddress
    ? unwrapAgentAddress(identity.agentAddress)
    : identity.peerId;
  if (!resolved) {
    throw new Error(
      'Working Memory reads require a resolvable daemon agent identity. '
      + 'Check daemon health and API-token configuration.',
    );
  }
  return resolved;
}
