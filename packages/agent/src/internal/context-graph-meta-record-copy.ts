// SPDX-License-Identifier: Apache-2.0
import type { ContextGraphMetaRecord } from '../context-graph-meta-projection.js';

export function cloneMetaRecord(record: ContextGraphMetaRecord): ContextGraphMetaRecord {
  return {
    ...record,
    creators: [...record.creators],
    curators: [...record.curators],
    allowedPeers: [...record.allowedPeers],
    allowedAgents: [...record.allowedAgents],
    participantAgents: [...record.participantAgents],
    participantIdentityIds: [...record.participantIdentityIds],
    revokedAgents: [...record.revokedAgents],
    delegations: record.delegations.map((delegation) => ({
      ...delegation,
      agents: [...delegation.agents],
      allowedPeers: [...delegation.allowedPeers],
      allowedKeys: [...delegation.allowedKeys],
      expiresAtValues: [...delegation.expiresAtValues],
    })),
    subGraphs: record.subGraphs.map((subGraph) => ({ ...subGraph })),
  };
}
