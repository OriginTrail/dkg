// SPDX-License-Identifier: Apache-2.0

import { deriveCuratorDidFromCgId } from '@origintrail-official/dkg-core';

export type PrivateRecoveryAuthority = 'structural' | 'legacy';

export type PrivateRecoverySourceDecision = Readonly<
  | {
    kind: 'recover';
    source: 'rfc64-complete-provider' | 'structural-curator' | 'legacy-curator';
    curatorPeerId: string;
  }
  | {
    kind: 'skip';
    reason: 'local-curator' | 'curator-unresolved' | 'peer-not-curator';
    authority: PrivateRecoveryAuthority;
    structuralAgent?: string;
    curatorPeerIds?: readonly string[];
    curatorPeerId?: string;
  }
>;

export interface PrivateRecoverySourcePlanInput {
  contextGraphId: string;
  remotePeerId: string;
  completeProviderSelected: boolean;
  localAgentAddresses: Iterable<string>;
  localPeerId?: string;
  isLegacyLocalCurator: () => Promise<boolean>;
  resolveStructuralCuratorPeers: (structuralAgent: string) => Promise<readonly string[]>;
  resolveLegacyCuratorPeer: () => Promise<string | null | undefined>;
}

/**
 * Selects the one authoritative source for a private recovery attempt.
 *
 * Local-curator prohibition is evaluated first. An RFC-64 complete-provider
 * pin then authorizes cold bootstrap without depending on registry discovery.
 * Ordinary structural or legacy curator discovery is only used as fallback.
 */
export async function planPrivateRecoverySource(
  input: PrivateRecoverySourcePlanInput,
): Promise<PrivateRecoverySourceDecision> {
  const structuralCuratorDid = deriveCuratorDidFromCgId(input.contextGraphId);
  const authority: PrivateRecoveryAuthority = structuralCuratorDid ? 'structural' : 'legacy';
  const structuralAgent = structuralCuratorDid
    ?.slice('did:dkg:agent:'.length)
    .toLowerCase();

  const localCurator = structuralAgent !== undefined
    ? [...input.localAgentAddresses].some(
      (address) => address.toLowerCase() === structuralAgent,
    )
    : await input.isLegacyLocalCurator();
  if (localCurator) {
    return { kind: 'skip', reason: 'local-curator', authority, structuralAgent };
  }

  if (input.completeProviderSelected) {
    return {
      kind: 'recover',
      source: 'rfc64-complete-provider',
      curatorPeerId: input.remotePeerId,
    };
  }

  if (structuralAgent !== undefined) {
    const curatorPeerIds = [...await input.resolveStructuralCuratorPeers(structuralAgent)];
    if (curatorPeerIds.length === 0) {
      return {
        kind: 'skip',
        reason: 'curator-unresolved',
        authority,
        structuralAgent,
      };
    }
    if (!curatorPeerIds.includes(input.remotePeerId)) {
      return {
        kind: 'skip',
        reason: 'peer-not-curator',
        authority,
        structuralAgent,
        curatorPeerIds,
      };
    }
    return {
      kind: 'recover',
      source: 'structural-curator',
      curatorPeerId: input.remotePeerId,
    };
  }

  const curatorPeerId = await input.resolveLegacyCuratorPeer();
  if (!curatorPeerId) {
    return { kind: 'skip', reason: 'curator-unresolved', authority };
  }
  if (input.localPeerId && curatorPeerId === input.localPeerId) {
    return { kind: 'skip', reason: 'local-curator', authority, curatorPeerId };
  }
  if (curatorPeerId !== input.remotePeerId) {
    return { kind: 'skip', reason: 'peer-not-curator', authority, curatorPeerId };
  }
  return { kind: 'recover', source: 'legacy-curator', curatorPeerId };
}
