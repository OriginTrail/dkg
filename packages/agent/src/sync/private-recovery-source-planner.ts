// SPDX-License-Identifier: Apache-2.0

import { deriveCuratorDidFromCgId } from '@origintrail-official/dkg-core';

export type PrivateRecoverySkipDecision = Readonly<
  | {
    kind: 'skip';
    reason: 'local-curator';
    authority: 'structural';
    structuralAgent: string;
  }
  | {
    kind: 'skip';
    reason: 'local-curator';
    authority: 'legacy';
  }
  | {
    kind: 'skip';
    reason: 'curator-unresolved';
    authority: 'structural';
    structuralAgent: string;
  }
  | {
    kind: 'skip';
    reason: 'curator-unresolved';
    authority: 'legacy';
  }
  | {
    kind: 'skip';
    reason: 'peer-not-curator';
    authority: 'structural';
    structuralAgent: string;
    curatorPeerIds: readonly string[];
  }
  | {
    kind: 'skip';
    reason: 'peer-not-curator';
    authority: 'legacy';
    curatorPeerId: string;
  }
>;

export type PrivateRecoverySourceDecision = Readonly<
  | {
    kind: 'recover';
    source: 'rfc64-complete-provider' | 'structural-curator' | 'legacy-curator';
    curatorPeerId: string;
  }
  | PrivateRecoverySkipDecision
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

export interface PrivateRecoverySkipLog {
  readonly level: 'debug' | 'info';
  readonly message: string;
}

/** Format every rejection variant without leaking payload invariants to callers. */
export function formatPrivateRecoverySkip(
  decision: PrivateRecoverySkipDecision,
  contextGraphId: string,
  remotePeerId: string,
): PrivateRecoverySkipLog {
  switch (decision.reason) {
    case 'local-curator':
      return {
        level: 'debug',
        message: `SWM sync: skipping "${contextGraphId}" — local node is the curator (never reverse-syncs a CG it owns)`,
      };
    case 'curator-unresolved':
      return {
        level: 'info',
        message: decision.authority === 'structural'
          ? `SWM recovery skipped for private CG "${contextGraphId.slice(0, 28)}": curator (${decision.structuralAgent.slice(0, 10)}) peer not resolved yet`
          : `SWM recovery skipped for private CG "${contextGraphId.slice(0, 28)}": curator peerId not resolved`,
      };
    case 'peer-not-curator':
      return {
        level: 'info',
        message: decision.authority === 'structural'
          ? `SWM recovery deferred for private CG "${contextGraphId.slice(0, 28)}": connecting peer ${remotePeerId.slice(0, 12)} is not among the curator's ${decision.curatorPeerIds.length} registered peer(s)`
          : `SWM recovery deferred for private CG "${contextGraphId.slice(0, 28)}": connecting peer is not the curator`,
      };
    default:
      return unreachableDecision(decision);
  }
}

function unreachableDecision(value: never): never {
  throw new TypeError(`Unexpected private recovery decision: ${JSON.stringify(value)}`);
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
  const structuralAgent = structuralCuratorDid
    ?.slice('did:dkg:agent:'.length)
    .toLowerCase();

  const localCurator = structuralAgent !== undefined
    ? [...input.localAgentAddresses].some(
      (address) => address.toLowerCase() === structuralAgent,
    )
    : await input.isLegacyLocalCurator();
  if (localCurator) {
    return structuralAgent === undefined
      ? { kind: 'skip', reason: 'local-curator', authority: 'legacy' }
      : {
        kind: 'skip',
        reason: 'local-curator',
        authority: 'structural',
        structuralAgent,
      };
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
        authority: 'structural',
        structuralAgent,
      };
    }
    if (!curatorPeerIds.includes(input.remotePeerId)) {
      return {
        kind: 'skip',
        reason: 'peer-not-curator',
        authority: 'structural',
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
    return { kind: 'skip', reason: 'curator-unresolved', authority: 'legacy' };
  }
  if (input.localPeerId && curatorPeerId === input.localPeerId) {
    return { kind: 'skip', reason: 'local-curator', authority: 'legacy' };
  }
  if (curatorPeerId !== input.remotePeerId) {
    return {
      kind: 'skip',
      reason: 'peer-not-curator',
      authority: 'legacy',
      curatorPeerId,
    };
  }
  return { kind: 'recover', source: 'legacy-curator', curatorPeerId };
}
