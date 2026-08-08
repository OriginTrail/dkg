import type {
  CatalogSealDeploymentProfileV1,
} from '@origintrail-official/dkg-core';
import type {
  NetworkIdV1,
  SystemRecordPeerPublicKeyV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import type { EvmPersonalMessageSignerV1 } from '../evm-message-signer-v1.js';
import type {
  AgentProfileProducerPublicationStoreV1,
  CreateAgentProfileProducerOptionsV1,
  SystemRecordPeerSignerV1,
} from './agent-profile-producer-contract-v1.js';

export interface AgentProfileProducerPreparationDependenciesV1 {
  readonly networkId: NetworkIdV1;
  readonly publicationDeployment: Readonly<CatalogSealDeploymentProfileV1>;
  readonly peerId: string;
  readonly peerPublicKey: SystemRecordPeerPublicKeyV1;
  readonly evmIssuer: string;
  readonly nowMs?: () => number;
  readonly snapshot: AgentProfileProducerPublicationStoreV1['snapshot'];
}

export interface AgentProfileProducerSigningDependenciesV1 {
  readonly peerSigner: SystemRecordPeerSignerV1;
  readonly evmSigner: EvmPersonalMessageSignerV1;
}

export interface AgentProfileProducerInventoryDependenciesV1 {
  readonly networkId: NetworkIdV1;
  readonly peerSigner: SystemRecordPeerSignerV1;
  readonly resolveArtifact: AgentProfileProducerPublicationStoreV1['resolveArtifact'];
}

export interface AgentProfileProducerCommitDependenciesV1 {
  readonly prepareCommit: AgentProfileProducerPublicationStoreV1['prepareCommit'];
  readonly install: CreateAgentProfileProducerOptionsV1['install'];
}
