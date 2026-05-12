export {
  type PublishRequestMsg,
  type PublishAckMsg,
  type KAManifestEntryMsg,
  encodePublishRequest,
  decodePublishRequest,
  encodePublishAck,
  decodePublishAck,
} from './publish.js';

export {
  type AccessRequestMsg,
  type AccessResponseMsg,
  encodeAccessRequest,
  decodeAccessRequest,
  encodeAccessResponse,
  decodeAccessResponse,
} from './access.js';

export {
  type QueryRequestMsg,
  type QueryResponseMsg,
  encodeQueryRequest,
  decodeQueryRequest,
  encodeQueryResponse,
  decodeQueryResponse,
} from './query.js';

export {
  type DiscoverRequestMsg,
  type DiscoverResponseMsg,
  encodeDiscoverRequest,
  decodeDiscoverRequest,
  encodeDiscoverResponse,
  decodeDiscoverResponse,
} from './discover.js';

export {
  type AgentMessageMsg,
  encodeAgentMessage,
  decodeAgentMessage,
} from './message.js';

export {
  type WorkspacePublishRequestMsg,
  type WorkspaceManifestEntryMsg,
  type WorkspaceCASConditionMsg,
  encodeWorkspacePublishRequest,
  decodeWorkspacePublishRequest,
  type SharePublishRequestMsg,
  type ShareManifestEntryMsg,
  type ShareCASConditionMsg,
  encodeSharePublishRequest,
  decodeSharePublishRequest,
} from './workspace.js';

export {
  type KAUpdateRequestMsg,
  type KAUpdateManifestEntryMsg,
  encodeKAUpdateRequest,
  decodeKAUpdateRequest,
} from './ka-update.js';

export {
  type FinalizationMessageMsg,
  encodeFinalizationMessage,
  decodeFinalizationMessage,
} from './finalization.js';

// ── V10 messages ────────────────────────────────────────────────────────

export {
  type VerifyProposalMsg,
  type VerifyApprovalMsg,
  encodeVerifyProposal,
  decodeVerifyProposal,
  encodeVerifyApproval,
  decodeVerifyApproval,
} from './verify.js';

export {
  type StorageACKMsg,
  encodeStorageACK,
  decodeStorageACK,
} from './storage-ack.js';

export {
  type GossipEnvelopeMsg,
  GOSSIP_ENVELOPE_VERSION,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
  GOSSIP_ENVELOPE_FRESHNESS_MS,
  encodeGossipEnvelope,
  decodeGossipEnvelope,
  computeGossipSigningPayload,
} from './gossip-envelope.js';

export {
  type EncryptedWorkspacePayloadMsg,
  type EncryptedWorkspaceRecipientKeySlotMsg,
  type EncryptedWorkspaceAADFields,
  ENCRYPTED_WORKSPACE_ENVELOPE_VERSION,
  ENCRYPTED_WORKSPACE_ENVELOPE_TYPE,
  ENCRYPTED_WORKSPACE_CIPHER_ALGORITHM,
  ENCRYPTED_WORKSPACE_KEY_AGREEMENT_ALGORITHM,
  ENCRYPTED_WORKSPACE_KEY_WRAP_ALGORITHM,
  ENCRYPTED_WORKSPACE_AAD_DOMAIN,
  encodeEncryptedWorkspacePayload,
  decodeEncryptedWorkspacePayload,
  computeEncryptedWorkspaceAAD,
  timestampForAAD,
} from './encrypted-workspace.js';

export {
  type SwmSenderKeyPackageMsg,
  type SwmSenderKeyPackageAckMsg,
  type SwmSenderKeyMessageMsg,
  type SwmSenderKeySecretMsg,
  type SwmSenderKeyMessageAADFields,
  type SwmSenderKeyPackageAADFields,
  SWM_SENDER_KEY_PACKAGE_VERSION,
  SWM_SENDER_KEY_PACKAGE_TYPE,
  SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
  SWM_SENDER_KEY_MESSAGE_TYPE,
  SWM_SENDER_KEY_CIPHER_ALGORITHM,
  SWM_SENDER_KEY_SETUP_KEY_AGREEMENT_ALGORITHM,
  SWM_SENDER_KEY_AAD_DOMAIN,
  SWM_SENDER_KEY_SETUP_AAD_DOMAIN,
  SWM_SENDER_KEY_SIGNATURE_DOMAIN,
  encodeSwmSenderKeyPackage,
  decodeSwmSenderKeyPackage,
  encodeSwmSenderKeyPackageAck,
  decodeSwmSenderKeyPackageAck,
  encodeSwmSenderKeyMessage,
  decodeSwmSenderKeyMessage,
  encodeSwmSenderKeySecret,
  decodeSwmSenderKeySecret,
  computeSwmSenderKeyMessageAAD,
  computeSwmSenderKeyPackageAAD,
  computeSwmSenderKeyPackageEncryptionAAD,
  computeSwmSenderKeySignaturePayload,
  uint64ForAAD,
  uint64ForProto,
} from './swm-sender-key.js';

export {
  type PublishIntentMsg,
  encodePublishIntent,
  decodePublishIntent,
} from './publish-intent.js';
