/**
 * OriginTrail Game gossipsub message protocol.
 *
 * All game coordination messages are serialized as JSON and sent over
 * the paranet's app coordination topic (dkg/paranet/{paranetId}/app).
 * This ensures every node subscribed to the paranet — including relays
 * and nodes without the game installed — relays game messages through
 * the gossipsub mesh.
 */

export const APP_ID = 'origin-trail-game';

/**
 * Returns the paranet-scoped app topic. This is the same topic the DKG core
 * subscribes to in subscribeToParanet(), so all paranet nodes relay it.
 */
export function appTopic(paranetId: string): string {
  return `dkg/paranet/${paranetId}/app`;
}

export type MessageType =
  | 'swarm:created'
  | 'swarm:joined'
  | 'swarm:left'
  | 'expedition:launched'
  | 'vote:cast'
  | 'turn:proposal'
  | 'turn:approve'
  | 'turn:resolved';

export interface BaseMessage {
  app: typeof APP_ID;
  type: MessageType;
  swarmId: string;
  peerId: string;
  timestamp: number;
}

export interface SwarmCreatedMsg extends BaseMessage {
  type: 'swarm:created';
  swarmName: string;
  playerName: string;
  maxPlayers: number;
  identityId?: string;
}

export interface SwarmJoinedMsg extends BaseMessage {
  type: 'swarm:joined';
  playerName: string;
  identityId?: string;
}

export interface SwarmLeftMsg extends BaseMessage {
  type: 'swarm:left';
}

export interface ExpeditionLaunchedMsg extends BaseMessage {
  type: 'expedition:launched';
  gameStateJson: string;
  partyOrder?: string[];
  contextGraphId?: string;
}

export interface VoteCastMsg extends BaseMessage {
  type: 'vote:cast';
  turn: number;
  action: string;
  params?: Record<string, any>;
}

export interface TurnProposalMsg extends BaseMessage {
  type: 'turn:proposal';
  turn: number;
  proposalHash: string;
  winningAction: string;
  newStateJson: string;
  resultMessage: string;
  votes: Array<{ peerId: string; action: string }>;
  resolution: 'consensus' | 'leader-tiebreak' | 'force-resolved';
  deaths: Array<{ name: string; cause: string; partyIndex?: number }>;
  event?: { type: string; description: string };
  merkleRoot?: string;
  contextGraphId?: string;
}

export interface TurnApproveMsg extends BaseMessage {
  type: 'turn:approve';
  turn: number;
  proposalHash: string;
  identityId?: string;
  signatureR?: string;
  signatureVS?: string;
}

export interface TurnResolvedMsg extends BaseMessage {
  type: 'turn:resolved';
  turn: number;
  proposalHash: string;
}

export type OTMessage =
  | SwarmCreatedMsg
  | SwarmJoinedMsg
  | SwarmLeftMsg
  | ExpeditionLaunchedMsg
  | VoteCastMsg
  | TurnProposalMsg
  | TurnApproveMsg
  | TurnResolvedMsg;

export function encode(msg: OTMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(msg));
}

export function decode(data: Uint8Array): OTMessage | null {
  try {
    const obj = JSON.parse(new TextDecoder().decode(data));
    if (obj.app !== APP_ID) return null;
    return obj as OTMessage;
  } catch {
    return null;
  }
}
