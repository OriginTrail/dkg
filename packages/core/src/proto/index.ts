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
  encodeGossipEnvelope,
  decodeGossipEnvelope,
  computeGossipSigningPayload,
} from './gossip-envelope.js';

export {
  type PublishIntentMsg,
  encodePublishIntent,
  decodePublishIntent,
} from './publish-intent.js';
