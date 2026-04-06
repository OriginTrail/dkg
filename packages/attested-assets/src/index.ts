export type {
  SessionStatus,
  MemberRole,
  SessionMember,
  QuorumPolicy,
  ReducerConfig,
  SessionConfig,
  AKAEventType,
  AKAEvent,
  RoundStartPayload,
  InputPayload,
  RoundProposalPayload,
  RoundAckPayload,
  RoundFinalizedPayload,
  SessionAcceptedPayload,
  SessionFinalizedPayload,
  ReducerFn,
  ReducerModule,
  RoundState,
  SessionState,
  AKAEventEnvelope,
} from './types.js';

export {
  canonicalJsonEncode,
  sha256Hex,
  sha256String,
  computeConfigHash,
  computeMembershipRoot,
  computeSessionId,
  computeInputSetHash,
  computeStateHash,
  computeTurnCommitment,
  signAKAPayload,
  verifyAKASignature,
  type SigningContext,
} from './canonical.js';

export {
  quorumThreshold,
  isQuorumMet,
  getActiveMemberCount,
} from './quorum.js';

export { ReducerRegistry } from './reducer.js';

export {
  SessionValidator,
  detectEquivocation,
  type ValidationResult,
} from './session-validator.js';

export {
  SessionManager,
  AKASessionEvent,
  type SessionManagerConfig,
} from './session-manager.js';

export {
  AKAGossipHandler,
  contextGraphSessionsTopic,
  sessionTopic,
  type AKAEventHandler,
} from './gossip-handler.js';

export {
  encodeAKAEvent,
  decodeAKAEvent,
  encodeSessionConfig,
  decodeSessionConfig,
  encodeRoundStartPayload,
  decodeRoundStartPayload,
  encodeInputPayload,
  decodeInputPayload,
  encodeRoundProposalPayload,
  decodeRoundProposalPayload,
  encodeRoundAckPayload,
  decodeRoundAckPayload,
  encodeRoundFinalizedPayload,
  decodeRoundFinalizedPayload,
  encodeSessionAcceptedPayload,
  decodeSessionAcceptedPayload,
  encodeSessionFinalizedPayload,
  decodeSessionFinalizedPayload,
} from './proto/aka-events.js';

export {
  createSessionRoutes,
  type SessionRouteHandler,
  type RouteRequest,
  type RouteResponse,
} from './api/session-routes.js';
