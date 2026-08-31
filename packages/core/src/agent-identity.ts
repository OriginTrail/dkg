/** Canonical prefix shared by every DKG agent-DID producer and consumer. */
export const AGENT_DID_PREFIX = 'did:dkg:agent:';

const EVM_AGENT_SUBJECT = /^0x[0-9a-fA-F]{40}$/;

export function isEvmAgentDidSubject(subject: string): boolean {
  return EVM_AGENT_SUBJECT.test(subject);
}

/** Lowercase an EVM-address subject while preserving case-sensitive peer identities. */
export function canonicalAgentDidSubject(subject: string): string {
  return isEvmAgentDidSubject(subject) ? subject.toLowerCase() : subject;
}

/** Normalize an already-formed full agent DID. Non-agent DIDs pass through unchanged. */
export function normalizeAgentDid(did: string): string {
  if (!did.startsWith(AGENT_DID_PREFIX)) return did;
  const subject = did.slice(AGENT_DID_PREFIX.length);
  return `${AGENT_DID_PREFIX}${canonicalAgentDidSubject(subject)}`;
}

/** Construct a canonical full agent DID from a bare subject or normalize an existing one. */
export function toAgentDid(subjectOrDid: string): string {
  return subjectOrDid.startsWith(AGENT_DID_PREFIX)
    ? normalizeAgentDid(subjectOrDid)
    : `${AGENT_DID_PREFIX}${canonicalAgentDidSubject(subjectOrDid)}`;
}
