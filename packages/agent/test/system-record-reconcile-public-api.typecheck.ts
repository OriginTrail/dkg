import type {
  NetworkIdV1,
  SignedSystemRecordRootDescriptorEnvelopeV1,
  SystemRecordInventoryRowV1,
  SystemRecordPeerPublicKeyV1,
} from '@origintrail-official/dkg-core/system-record-v1';
import type {
  AgentProfileArtifactInputV1,
  AgentProfileArtifactSourcesV1,
  AgentProfileCandidateContinuationReceiverV1,
  AgentProfileCandidateReceiverV1,
  AgentProfileContinuationReceiverV1,
  AgentProfilePreparationV1,
  AgentProfileReceiverV1,
  AgentProfileReceiverPreparedApplyV1,
  CreateAgentProfileReceiverOptionsV1,
} from '../src/system-records/receiver-v1.js';
import { createAgentProfileReceiverV1 } from '../src/system-records/receiver-v1.js';
import type { SystemRecordArtifactRepositoryV1 } from '../src/system-records/artifact-v1.js';
import {
  createAgentProfileReconcilerV1,
  type AgentProfileInventoryLoadRequestV1,
  type AgentProfileInventoryLoadResultV1,
  type AgentProfileReconcileAdmissionV1,
} from '../src/system-records/reconcile-v1.js';
import type { AgentProfileReconcileTransportV1 } from '../src/system-records/reconcile-transport-v1.js';

declare const networkId: NetworkIdV1;
declare const rootEnvelope: SignedSystemRecordRootDescriptorEnvelopeV1;
declare const providerPeerPublicKey: SystemRecordPeerPublicKeyV1;
declare const admission: AgentProfileReconcileAdmissionV1;
declare const receiver: AgentProfileReceiverV1;
declare const candidateReceiver: AgentProfileCandidateReceiverV1;
declare const candidateContinuationReceiver: AgentProfileCandidateContinuationReceiverV1;
declare const row: SystemRecordInventoryRowV1;
declare const signal: AbortSignal;
declare const closureArtifacts: SystemRecordArtifactRepositoryV1;
declare const securitySidecarArtifacts: SystemRecordArtifactRepositoryV1;
declare const receiverOptions: Omit<CreateAgentProfileReceiverOptionsV1, 'artifacts'>;
declare const preparation: AgentProfilePreparationV1;
declare const preparedApply: AgentProfileReceiverPreparedApplyV1;
declare const transport: AgentProfileReconcileTransportV1;
declare const loadInventoryObject: (
  request: AgentProfileInventoryLoadRequestV1,
  signal: AbortSignal,
) => Promise<AgentProfileInventoryLoadResultV1>;

const directReconciler = createAgentProfileReconcilerV1({
  networkId,
  rootEnvelope,
  providerPeerPublicKey,
  admission,
  loadInventoryObject,
  receiver,
});
const artifactSources: AgentProfileArtifactSourcesV1 = {
  closureArtifacts,
  securitySidecarArtifacts,
};
const legacyArtifactInput: AgentProfileArtifactInputV1 = closureArtifacts;
const splitArtifactInput: AgentProfileArtifactInputV1 = artifactSources;
const legacyReceiver = createAgentProfileReceiverV1({
  ...receiverOptions,
  artifacts: closureArtifacts,
});
const activeOnlyCallbackReceiver = createAgentProfileReceiverV1({
  ...receiverOptions,
  artifacts: closureArtifacts,
  prepareCandidateApply(candidate) {
    candidate.ownedSubjectTable;
    return preparedApply;
  },
});
const legacyPrepared = preparation.prepare(closureArtifacts, signal);
const prepared = receiver.prepareActive(row, signal);
const candidatePrepared = candidateReceiver.prepareCandidate(row, signal);
const customDirectReceiver: AgentProfileReceiverV1 = {
  prepareActive: receiver.prepareActive.bind(receiver),
  receiveActive: receiver.receiveActive.bind(receiver),
};
const customActiveContinuationReceiver: AgentProfileContinuationReceiverV1 = {
  openPreparation: () => preparation,
  prepareActive: receiver.prepareActive.bind(receiver),
  receiveActive: receiver.receiveActive.bind(receiver),
};
const customCandidateContinuationReceiver: AgentProfileCandidateContinuationReceiverV1 = {
  openPreparation: () => preparation,
  prepareActive: candidateContinuationReceiver.prepareActive.bind(candidateContinuationReceiver),
  receiveActive: candidateContinuationReceiver.receiveActive.bind(candidateContinuationReceiver),
  prepareCandidate: candidateContinuationReceiver.prepareCandidate.bind(
    candidateContinuationReceiver,
  ),
  receiveCandidate: candidateContinuationReceiver.receiveCandidate.bind(
    candidateContinuationReceiver,
  ),
};
const candidateContinuationPrepared = candidateContinuationReceiver.prepareCandidate(row, signal);
const customActiveContinuationReconciler = createAgentProfileReconcilerV1({
  networkId,
  rootEnvelope,
  providerPeerPublicKey,
  admission,
  transport,
  receiver: customActiveContinuationReceiver,
});
const customCandidateContinuationReconciler = createAgentProfileReconcilerV1({
  networkId,
  rootEnvelope,
  providerPeerPublicKey,
  admission,
  transport,
  receiver: customCandidateContinuationReceiver,
});
const customDirectReconciler = createAgentProfileReconcilerV1({
  networkId,
  rootEnvelope,
  providerPeerPublicKey,
  admission,
  loadInventoryObject,
  receiver: customDirectReceiver,
});

void directReconciler;
void prepared;
void candidatePrepared;
void artifactSources;
void legacyArtifactInput;
void splitArtifactInput;
void legacyReceiver;
void activeOnlyCallbackReceiver;
void legacyPrepared;
void customDirectReconciler;
void customActiveContinuationReceiver;
void customCandidateContinuationReceiver;
void candidateContinuationPrepared;
void customActiveContinuationReconciler;
void customCandidateContinuationReconciler;
