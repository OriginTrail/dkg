import { AGENT_DID_PREFIX, isEvmAgentDidSubject, toAgentDid } from './agent-identity.js';

/** Normalize curator identities for the UI and agent-facing graph selectors. */
export function canonicalContextGraphAgentDid(did: string): string {
  let value = did.trim().replace(/^["']|["']$/g, '');
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1);
  if (value.slice(0, AGENT_DID_PREFIX.length).toLowerCase() === AGENT_DID_PREFIX) {
    return toAgentDid(value.slice(AGENT_DID_PREFIX.length));
  }
  return isEvmAgentDidSubject(value) ? toAgentDid(value) : value.toLowerCase();
}

/** Membership comes from the caller-scoped daemon result, or an exact legacy curator match. */
export function contextGraphBelongsToAgent(
  graph: { callerInvolved?: unknown; curator?: unknown },
  agentDid: string | null | undefined,
): boolean {
  if (graph.callerInvolved === true) return true;
  if (graph.callerInvolved === false) return false;
  if (!agentDid?.trim() || typeof graph.curator !== 'string' || !graph.curator.trim()) return false;
  return canonicalContextGraphAgentDid(graph.curator) === canonicalContextGraphAgentDid(agentDid);
}
