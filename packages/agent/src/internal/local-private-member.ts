// SPDX-License-Identifier: Apache-2.0



/** A context graph member identity: a bare agent address or its `did:dkg:agent:` DID. */
function memberAgentAddress(value: string): string | undefined {
  const match = /^(?:did:dkg:agent:)?(0x[0-9a-fA-F]{40})$/.exec(value.trim());
  return match?.[1]?.toLowerCase();
}

/**
 * Whether `meta` declares an explicit private policy (#865) and lists one of
 * `localAgents` among its allowed agents, participants, curators or creators,
 * and not among its revoked agents.
 */
export function isLocalPrivateMember(
  meta: {
    readonly accessPolicy?: string;
    readonly allowedAgents: readonly string[];
    readonly participantAgents: readonly string[];
    readonly curators: readonly string[];
    readonly creators: readonly string[];
    readonly revokedAgents: readonly string[];
  },
  localAgents: readonly (string | undefined)[],
): boolean {
  if (meta.accessPolicy?.trim().toLowerCase() !== 'private') return false;
  const revoked = new Set(meta.revokedAgents.map(memberAgentAddress));
  const members = new Set(
    [...meta.allowedAgents, ...meta.participantAgents, ...meta.curators, ...meta.creators]
      .map(memberAgentAddress)
      .filter((member) => member !== undefined && !revoked.has(member)),
  );
  return localAgents.some((local) => (
    local !== undefined && members.has(memberAgentAddress(local))
  ));
}
