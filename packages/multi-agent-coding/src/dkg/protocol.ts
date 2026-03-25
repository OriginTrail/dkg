/**
 * GossipSub message types for the GitHub Collaboration app.
 *
 * All messages are JSON-serialized and published on the paranet's app topic:
 *   dkg/paranet/github-collab:{owner}/{repo}/app
 */

export const APP_ID = 'github-collab';

export type MessageType =
  | 'node:joined'
  | 'node:left'
  | 'review:requested'
  | 'review:submitted'
  | 'review:consensus'
  | 'sync:announce'
  | 'ping'
  | 'invite:sent'
  | 'invite:accepted'
  | 'invite:declined'
  | 'session:started'
  | 'session:ended'
  | 'session:heartbeat'
  | 'claim:created'
  | 'claim:released'
  | 'claim:conflict'
  | 'decision:recorded'
  | 'annotation:added';

export interface BaseMessage {
  app: typeof APP_ID;
  type: MessageType;
  peerId: string;
  timestamp: number;
}

export interface NodeJoinedMessage extends BaseMessage {
  type: 'node:joined';
  repo: string;
  nodeName?: string;
}

export interface NodeLeftMessage extends BaseMessage {
  type: 'node:left';
  repo: string;
}

export interface ReviewRequestedMessage extends BaseMessage {
  type: 'review:requested';
  repo: string;
  prNumber: number;
  sessionId: string;
  reviewers: string[];
  requiredApprovals: number;
}

export interface ReviewSubmittedMessage extends BaseMessage {
  type: 'review:submitted';
  repo: string;
  prNumber: number;
  sessionId: string;
  decision: 'approve' | 'request_changes' | 'comment';
}

export interface ReviewConsensusMessage extends BaseMessage {
  type: 'review:consensus';
  repo: string;
  prNumber: number;
  sessionId: string;
  outcome: 'approved' | 'changes_requested';
  signaturesCollected: number;
  ual?: string;
}

export interface SyncAnnounceMessage extends BaseMessage {
  type: 'sync:announce';
  repo: string;
  scope: string[];
  quadsWritten: number;
}

export interface PingMessage extends BaseMessage {
  type: 'ping';
  repos: string[];
}

export interface InviteSentMessage extends BaseMessage {
  type: 'invite:sent';
  invitationId: string;
  repo: string;
  paranetId: string;
  targetPeerId: string;
  nodeName?: string;
}

export interface InviteAcceptedMessage extends BaseMessage {
  type: 'invite:accepted';
  invitationId: string;
  repo: string;
  paranetId: string;
  nodeName?: string;
}

export interface InviteDeclinedMessage extends BaseMessage {
  type: 'invite:declined';
  invitationId: string;
  repo: string;
}

export interface SessionStartedMessage extends BaseMessage {
  type: 'session:started';
  repo: string;
  sessionId: string;
  agent: string;
  agentType?: string;
  goal?: string;
}

export interface SessionEndedMessage extends BaseMessage {
  type: 'session:ended';
  repo: string;
  sessionId: string;
  agent: string;
  summary?: string;
  duration: number;
  filesModified: number;
}

export interface SessionHeartbeatMessage extends BaseMessage {
  type: 'session:heartbeat';
  repo: string;
  sessionId: string;
}

export interface ClaimCreatedMessage extends BaseMessage {
  type: 'claim:created';
  repo: string;
  claimId: string;
  file: string;
  agent: string;
  sessionId?: string;
}

export interface ClaimReleasedMessage extends BaseMessage {
  type: 'claim:released';
  repo: string;
  claimId: string;
  file: string;
}

export interface ClaimConflictMessage extends BaseMessage {
  type: 'claim:conflict';
  repo: string;
  file: string;
  claimingAgent: string;
  existingAgent: string;
}

export interface DecisionRecordedMessage extends BaseMessage {
  type: 'decision:recorded';
  repo: string;
  decisionId: string;
  summary: string;
  agent: string;
}

export interface AnnotationAddedMessage extends BaseMessage {
  type: 'annotation:added';
  repo: string;
  annotationId: string;
  targetUri: string;
  kind: 'finding' | 'suggestion' | 'warning' | 'note';
  content: string;
  agent: string;
}

export type AppMessage =
  | NodeJoinedMessage
  | NodeLeftMessage
  | ReviewRequestedMessage
  | ReviewSubmittedMessage
  | ReviewConsensusMessage
  | SyncAnnounceMessage
  | PingMessage
  | InviteSentMessage
  | InviteAcceptedMessage
  | InviteDeclinedMessage
  | SessionStartedMessage
  | SessionEndedMessage
  | SessionHeartbeatMessage
  | ClaimCreatedMessage
  | ClaimReleasedMessage
  | ClaimConflictMessage
  | DecisionRecordedMessage
  | AnnotationAddedMessage;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeMessage(msg: AppMessage): Uint8Array {
  return encoder.encode(JSON.stringify(msg));
}

export function decodeMessage(data: Uint8Array): AppMessage | null {
  try {
    const parsed = JSON.parse(decoder.decode(data));
    if (parsed?.app !== APP_ID) return null;
    return parsed as AppMessage;
  } catch {
    return null;
  }
}
