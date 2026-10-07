// SPDX-License-Identifier: Apache-2.0

export interface ContextGraphSubGraphMeta {
  uri: string;
  name: string;
  createdBy: string;
  createdAt?: string;
  description?: string;
}

export interface ContextGraphDelegationMeta {
  uri: string;
  agents: string[];
  allowedPeers: string[];
  allowedKeys: string[];
  expiresAtValues: string[];
}

export interface ContextGraphMetaRecord {
  id: string;
  uri: string;
  declared: boolean;
  isSystem: boolean;
  name?: string;
  description?: string;
  creator?: string;
  creators: string[];
  curator?: string;
  curators: string[];
  accessPolicy?: string;
  createdAt?: string;
  allowedPeers: string[];
  allowedAgents: string[];
  participantAgents: string[];
  participantIdentityIds: string[];
  revokedAgents: string[];
  delegations: ContextGraphDelegationMeta[];
  onChainId?: string;
  subGraphs: ContextGraphSubGraphMeta[];
  hasAgentGate: boolean;
  hasPeerGate: boolean;
  hasLegacyParticipantGate: boolean;
}

