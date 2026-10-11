// SPDX-License-Identifier: Apache-2.0

import type { ContextGraphMembershipRecord } from './dkg-agent-types.js';
import { verifiedCuratorDialAddress } from './curator-dial-address.js';

export type ContextGraphMembershipSnapshot = ReadonlyArray<
  ContextGraphMembershipRecord & { firstSeenAt?: number; updatedAt: number }
>;

interface PersistedJoinApprovalProjection {
  readonly principalId: string;
  readonly updatedAt: number;
  readonly curatorPeerId?: string;
  readonly curatorDialAddress?: string;
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
