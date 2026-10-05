// SPDX-License-Identifier: Apache-2.0

import { multiaddr } from '@multiformats/multiaddr';
import type { ContextGraphMembershipRecord } from './dkg-agent-types.js';

export type ContextGraphMembershipSnapshot = ReadonlyArray<
  ContextGraphMembershipRecord & { firstSeenAt?: number; updatedAt: number }
>;

interface PersistedJoinApprovalProjection {
  readonly principalId: string;
  readonly updatedAt: number;
  readonly curatorPeerId?: string;
  readonly curatorDialAddress?: string;
}

export function verifiedCuratorDialAddress(value: unknown, peerId: string): string | undefined {
  if (typeof value !== 'string' || value.length > 512) return undefined;
  try {
    const address = multiaddr(value).toString();
    return address.endsWith(`/p2p/${peerId}`) ? address : undefined;
  } catch {
    return undefined;
  }
}

export function projectPersistedJoinApprovals(
  persistedMembershipRows: ContextGraphMembershipSnapshot,
  persistedContextGraphIds: ReadonlySet<string>,
  localAgentAddresses: ReadonlySet<string>,
): ReadonlyMap<string, PersistedJoinApprovalProjection> {
  const newestApprovalByContextGraph = new Map<string, PersistedJoinApprovalProjection>();
  for (const membership of persistedMembershipRows) {
    const principalId = membership.principalId.toLowerCase();
    if (
      membership.principalType !== 'agent' ||
      membership.status !== 'active' ||
      membership.source !== 'join-approved' ||
      !persistedContextGraphIds.has(membership.contextGraphId) ||
      !localAgentAddresses.has(principalId)
    ) {
      continue;
    }
    const existing = newestApprovalByContextGraph.get(membership.contextGraphId);
    if (!existing || membership.updatedAt > existing.updatedAt) {
      const curatorPeerId = typeof membership.metadata?.['curatorPeerId'] === 'string' &&
        membership.metadata['curatorPeerId'].trim()
        ? membership.metadata['curatorPeerId'].trim()
        : undefined;
      newestApprovalByContextGraph.set(membership.contextGraphId, {
        principalId,
        updatedAt: membership.updatedAt,
        curatorPeerId,
        curatorDialAddress: curatorPeerId
          ? verifiedCuratorDialAddress(membership.metadata?.['curatorDialAddress'], curatorPeerId)
          : undefined,
      });
    }
  }
  return newestApprovalByContextGraph;
}
