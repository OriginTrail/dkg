import type {
  NetworkIdV1,
  SignedSystemRecordRootDescriptorEnvelopeV1,
  SystemRecordInventoryRowV1,
  SystemRecordPeerPublicKeyV1,
} from '@origintrail-official/dkg-core/system-record-v1';
import type {
  AgentProfileReceiverV1,
} from '../src/system-records/receiver-v1.js';
import {
  createAgentProfileReconcilerV1,
  type AgentProfileInventoryLoadRequestV1,
  type AgentProfileInventoryLoadResultV1,
  type AgentProfileReconcileAdmissionV1,
} from '../src/system-records/reconcile-v1.js';

declare const networkId: NetworkIdV1;
declare const rootEnvelope: SignedSystemRecordRootDescriptorEnvelopeV1;
declare const providerPeerPublicKey: SystemRecordPeerPublicKeyV1;
declare const admission: AgentProfileReconcileAdmissionV1;
declare const receiver: AgentProfileReceiverV1;
declare const row: SystemRecordInventoryRowV1;
declare const signal: AbortSignal;
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
const prepared = receiver.prepareActive(row, signal);
const customDirectReceiver: AgentProfileReceiverV1 = {
  prepareActive: receiver.prepareActive.bind(receiver),
  receiveActive: receiver.receiveActive.bind(receiver),
};
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
void customDirectReconciler;
