/** Canonical prefix for full DKG agent DIDs. */
export const AGENT_DID_PREFIX = 'did:dkg:agent:';

/**
 * Canonicalize a full agent DID without changing case-sensitive peer identities.
 *
 * EVM addresses are case-insensitive on the wire (EIP-55 casing is advisory), while libp2p
 * peer IDs are case-sensitive. Only an exact 40-hex EVM suffix is therefore folded.
 */
export function normalizeAgentDid(did: string): string {
  const match = /^(did:dkg:agent:)(0x[0-9a-fA-F]{40})$/.exec(did);
  return match ? `${match[1]}${match[2]!.toLowerCase()}` : did;
}
