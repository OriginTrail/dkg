/** Normalize curator identities for the UI and agent-facing graph selectors. */
export function canonicalContextGraphAgentDid(did: string): string {
  let value = did.trim().replace(/^["']|["']$/g, '');
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1);
  const prefix = 'did:dkg:agent:';
  if (value.slice(0, prefix.length).toLowerCase() === prefix) {
    const subject = value.slice(prefix.length);
    return prefix + (/^0x[a-fA-F0-9]{40}$/i.test(subject) ? subject.toLowerCase() : subject);
  }
  return /^0x[a-fA-F0-9]{40}$/.test(value) ? prefix + value.toLowerCase() : value.toLowerCase();
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
