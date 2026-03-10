/**
 * RDF helpers for OriginTrail Game state stored in the DKG.
 *
 * Uses @dkg/storage Quad format: { subject, predicate, object, graph }.
 */

export const OT = 'https://origintrail-game.dkg.io/';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const SCHEMA = 'https://schema.org/';
const DKG = 'https://dkg.network/ontology#';
const PROV = 'http://www.w3.org/ns/prov#';

export function otUri(path: string): string {
  return `${OT}${path}`;
}

export function swarmUri(swarmId: string): string {
  return otUri(`swarm/${swarmId}`);
}

export function turnUri(swarmId: string, turn: number): string {
  return otUri(`swarm/${swarmId}/turn/${turn}`);
}

export function playerUri(peerId: string): string {
  return otUri(`player/${peerId}`);
}

export function voteUri(swarmId: string, turn: number, peerId: string): string {
  return otUri(`swarm/${swarmId}/turn/${turn}/vote/${peerId}`);
}

interface Quad {
  subject: string;
  predicate: string;
  object: string;
  graph: string;
}

export function quad(s: string, p: string, o: string, g: string): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

function escapeNQuads(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

export function literal(value: string | number | boolean): string {
  if (typeof value === 'string') return `"${escapeNQuads(value)}"`;
  if (typeof value === 'number') return `"${value}"^^<http://www.w3.org/2001/XMLSchema#decimal>`;
  return `"${value}"^^<http://www.w3.org/2001/XMLSchema#boolean>`;
}

export function workspaceGraph(paranetId: string): string {
  return `did:dkg:paranet:${paranetId}`;
}

export function contextGraph(paranetId: string, swarmId: string): string {
  return `did:dkg:paranet:${paranetId}/context/${swarmId}`;
}

export function swarmCreatedQuads(paranetId: string, swarmId: string, swarmName: string, leaderPeerId: string, createdAt: number, maxPlayers: number): Quad[] {
  const g = workspaceGraph(paranetId);
  const s = swarmUri(swarmId);
  return [
    quad(s, `${RDF}type`, otUri('AgentSwarm'), g),
    quad(s, otUri('name'), literal(swarmName), g),
    quad(s, otUri('orchestrator'), playerUri(leaderPeerId), g),
    quad(s, otUri('createdAt'), literal(createdAt), g),
    quad(s, otUri('status'), literal('recruiting'), g),
    quad(s, otUri('maxPlayers'), literal(maxPlayers), g),
  ];
}

export function playerJoinedQuads(paranetId: string, swarmId: string, peerId: string, displayName: string): Quad[] {
  const g = workspaceGraph(paranetId);
  const membership = `${OT}swarm/${swarmId}/member/${peerId}`;
  return [
    quad(membership, `${RDF}type`, otUri('SwarmMembership'), g),
    quad(membership, otUri('agent'), playerUri(peerId), g),
    quad(membership, otUri('displayName'), literal(displayName), g),
    quad(membership, otUri('swarm'), swarmUri(swarmId), g),
  ];
}

export function voteCastQuads(paranetId: string, swarmId: string, turn: number, peerId: string, action: string, params?: Record<string, any>): Quad[] {
  const g = workspaceGraph(paranetId);
  const v = voteUri(swarmId, turn, peerId);
  const quads = [
    quad(v, `${RDF}type`, otUri('Vote'), g),
    quad(v, otUri('turn'), literal(turn), g),
    quad(v, otUri('action'), literal(action), g),
    quad(v, otUri('agent'), playerUri(peerId), g),
  ];
  if (params) {
    quads.push(quad(v, otUri('params'), literal(JSON.stringify(params)), g));
  }
  return quads;
}

export function expeditionLaunchedQuads(paranetId: string, swarmId: string, gameStateJson: string, launchedAt: number): Quad[] {
  const g = workspaceGraph(paranetId);
  const s = `urn:dkg:expedition:${swarmId}:launched`;
  return [
    quad(s, `${RDF}type`, otUri('ExpeditionLaunch'), g),
    quad(s, otUri('swarm'), swarmUri(swarmId), g),
    quad(s, otUri('status'), literal('traveling'), g),
    quad(s, otUri('gameState'), literal(gameStateJson), g),
    quad(s, otUri('launchedAt'), literal(launchedAt), g),
  ];
}

export interface ChainProvenance {
  txHash: string;
  blockNumber?: number;
  ual: string;
}

export function turnResolvedQuads(paranetId: string, swarmId: string, turn: number, winningAction: string, gameStateJson: string, approvers: string[]): Quad[] {
  const g = contextGraph(paranetId, swarmId);
  const t = turnUri(swarmId, turn);
  const quads = [
    quad(t, `${RDF}type`, otUri('TurnResult'), g),
    quad(t, otUri('turn'), literal(turn), g),
    quad(t, otUri('winningAction'), literal(winningAction), g),
    quad(t, otUri('gameState'), literal(gameStateJson), g),
    quad(t, otUri('swarm'), swarmUri(swarmId), g),
  ];
  for (const peerId of approvers) {
    quads.push(quad(t, otUri('approvedBy'), playerUri(peerId), g));
  }
  return quads;
}


export function turnProvenanceQuads(paranetId: string, swarmId: string, turn: number, provenance: ChainProvenance): Quad[] {
  const g = workspaceGraph(paranetId);
  const s = `${turnUri(swarmId, turn)}/provenance`;
  const quads: Quad[] = [
    quad(s, `${RDF}type`, otUri('TurnProvenance'), g),
    quad(s, otUri('turn'), literal(turn), g),
    quad(s, otUri('swarm'), swarmUri(swarmId), g),
    quad(s, otUri('transactionHash'), literal(provenance.txHash), g),
    quad(s, otUri('ual'), literal(provenance.ual), g),
  ];
  if (typeof provenance.blockNumber === 'number') {
    quads.push(quad(s, otUri('blockNumber'), literal(provenance.blockNumber), g));
  }
  return quads;
}

export interface ConsensusAttestation {
  peerId: string;
  proposalHash: string;
  approved: boolean;
  timestamp: number;
}

export function consensusAttestationQuads(
  paranetId: string,
  swarmId: string,
  turn: number,
  attestations: ConsensusAttestation[],
  resolution: string,
  proposalHash: string,
): Quad[] {
  const g = contextGraph(paranetId, swarmId);
  const t = turnUri(swarmId, turn);
  const root = `urn:dkg:attestation:${swarmId}:turn${turn}:${proposalHash}`;
  const quads: Quad[] = [
    quad(root, `${RDF}type`, otUri('ConsensusAttestationBatch'), g),
    quad(root, otUri('forTurn'), t, g),
    quad(root, otUri('resolution'), literal(resolution), g),
  ];
  for (const att of attestations) {
    const attUri = otUri(`swarm/${swarmId}/turn/${turn}/attestation/${att.proposalHash}/${att.peerId}`);
    quads.push(
      quad(attUri, `${RDF}type`, otUri('ConsensusAttestation'), g),
      quad(attUri, otUri('turn'), literal(turn), g),
      quad(attUri, otUri('signer'), playerUri(att.peerId), g),
      quad(attUri, otUri('proposalHash'), literal(att.proposalHash), g),
      quad(attUri, otUri('approved'), literal(att.approved), g),
      quad(attUri, otUri('attestedAt'), literal(att.timestamp), g),
      quad(root, otUri('hasAttestation'), attUri, g),
    );
  }
  return quads;
}

export interface PublishProvenance {
  rootEntity: string;
  ual: string;
  txHash: string;
  blockNumber?: number;
  publisherPeerId: string;
  publishedAt: number;
}

export function publishProvenanceChainQuads(paranetId: string, provenance: PublishProvenance): Quad[] {
  const g = workspaceGraph(paranetId);
  const s = `${provenance.rootEntity}/provenance/${provenance.txHash}`;
  const quads: Quad[] = [
    quad(s, `${RDF}type`, otUri('PublishedEntity'), g),
    quad(s, otUri('sourceEntity'), provenance.rootEntity, g),
    quad(s, otUri('ual'), literal(provenance.ual), g),
    quad(s, otUri('transactionHash'), literal(provenance.txHash), g),
    quad(s, otUri('publisherDID'), literal(provenance.publisherPeerId), g),
    quad(s, otUri('publishedAt'), literal(provenance.publishedAt), g),
  ];
  if (provenance.blockNumber) {
    quads.push(quad(s, otUri('blockNumber'), literal(provenance.blockNumber), g));
  }
  return quads;
}


export function playerProfileQuads(paranetId: string, peerId: string, displayName: string): Quad[] {
  const g = `did:dkg:paranet:${paranetId}`;
  const entity = `did:dkg:game:player:${peerId}`;
  return [
    quad(entity, `${RDF}type`, otUri('Player'), g),
    quad(entity, `${SCHEMA}name`, literal(displayName), g),
    quad(entity, `${DKG}peerId`, literal(peerId), g),
    quad(entity, `${PROV}atTime`, literal(new Date().toISOString()), g),
  ];
}

export interface TopologyPeer {
  peerId: string;
  connectionType: 'relay' | 'direct';
  messageAgeMs: number;
  lastSeen: number;
}

export function networkTopologyQuads(paranetId: string, writerPeerId: string, peers: TopologyPeer[]): Quad[] {
  const g = workspaceGraph(paranetId);
  const s = otUri(`topology/snapshot-${writerPeerId}`);
  const quads: Quad[] = [
    quad(s, `${RDF}type`, otUri('NetworkSnapshot'), g),
    quad(s, otUri('capturedAt'), literal(Date.now()), g),
    quad(s, otUri('writer'), literal(writerPeerId), g),
  ];
  for (const peer of peers) {
    const peerNode = `${s}/.well-known/genid/${peer.peerId}`;
    quads.push(
      quad(peerNode, `${RDF}type`, otUri('TopologyPeer'), g),
      quad(peerNode, otUri('peerId'), literal(peer.peerId), g),
      quad(peerNode, otUri('connectionType'), literal(peer.connectionType), g),
      quad(peerNode, otUri('messageAgeMs'), literal(peer.messageAgeMs), g),
      quad(peerNode, otUri('lastSeen'), literal(peer.lastSeen), g),
      quad(s, otUri('hasPeer'), peerNode, g),
    );
  }
  return quads;
}

export function workspaceLineageQuads(paranetId: string, entries: Array<{ workspaceOperationId: string; rootEntity: string; status?: string; publishedUal?: string; publishedTxHash?: string; publishedAt?: number; confirmed?: boolean }>): Quad[] {
  const g = workspaceGraph(paranetId);
  const quads: Quad[] = [];
  for (const entry of entries) {
    const s = otUri(`lineage/${entry.workspaceOperationId}`);
    quads.push(quad(s, `${RDF}type`, otUri('WorkspaceLineage'), g));
    quads.push(quad(s, otUri('workspaceOperationId'), literal(entry.workspaceOperationId), g));
    quads.push(quad(s, otUri('rootEntity'), entry.rootEntity, g));
    if (entry.publishedUal) {
      quads.push(quad(s, otUri('publishedUal'), literal(entry.publishedUal), g));
    }
    if (entry.publishedTxHash) {
      quads.push(quad(s, otUri('publishedTxHash'), literal(entry.publishedTxHash), g));
    }
    if (entry.publishedAt != null) {
      quads.push(quad(s, otUri('publishedAt'), literal(entry.publishedAt), g));
    }
    quads.push(quad(s, otUri('confirmed'), literal(entry.confirmed ?? false), g));
    const status = entry.status ?? (entry.confirmed ? 'published' : 'workspace');
    quads.push(quad(s, otUri('status'), literal(status), g));
  }
  return quads;
}

export function strategyPatternQuads(
  paranetId: string,
  swarmId: string,
  peerId: string,
  stats: { totalVotes: number; actionCounts: Record<string, number>; favoriteAction: string; turnsSurvived: number },
): Quad[] {
  const g = contextGraph(paranetId, swarmId);
  const s = otUri(`strategy/${swarmId}/${peerId}`);
  const quads: Quad[] = [
    quad(s, `${RDF}type`, otUri('StrategyPattern'), g),
    quad(s, otUri('player'), playerUri(peerId), g),
    quad(s, otUri('swarm'), swarmUri(swarmId), g),
    quad(s, otUri('totalVotes'), literal(stats.totalVotes), g),
    quad(s, otUri('favoriteAction'), literal(stats.favoriteAction), g),
    quad(s, otUri('turnsSurvived'), literal(stats.turnsSurvived), g),
  ];
  for (const [action, count] of Object.entries(stats.actionCounts)) {
    const safeKey = action.replace(/[^a-zA-Z0-9_-]/g, '_');
    const acUri = otUri(`strategy/${swarmId}/${peerId}/action/${safeKey}`);
    quads.push(quad(s, otUri('hasActionCount'), acUri, g));
    quads.push(quad(acUri, otUri('action'), literal(action), g));
    quads.push(quad(acUri, otUri('count'), literal(count), g));
  }
  return quads;
}

export function leaderboardEntryQuads(
  paranetId: string,
  swarmId: string,
  peerId: string,
  displayName: string,
  score: number,
  outcome: 'won' | 'lost',
  epochs: number,
  survivorsCount: number,
  partySize: number,
  finishedAt: number,
): Quad[] {
  const g = contextGraph(paranetId, swarmId);
  const entry = otUri(`swarm/${swarmId}/leaderboard/${peerId}`);
  return [
    quad(entry, `${RDF}type`, otUri('LeaderboardEntry'), g),
    quad(entry, otUri('player'), playerUri(peerId), g),
    quad(entry, otUri('displayName'), literal(displayName), g),
    quad(entry, otUri('swarm'), swarmUri(swarmId), g),
    quad(entry, otUri('score'), literal(score), g),
    quad(entry, otUri('outcome'), literal(outcome), g),
    quad(entry, otUri('epochs'), literal(epochs), g),
    quad(entry, otUri('survivors'), literal(survivorsCount), g),
    quad(entry, otUri('partySize'), literal(partySize), g),
    quad(entry, otUri('finishedAt'), literal(finishedAt), g),
  ];
}

export function syncMemoryDkgQuads(
  paranetId: string,
  swarmId: string,
  turn: number,
  peerId: string,
  tracSpent: number,
): Quad[] {
  const g = contextGraph(paranetId, swarmId);
  const s = otUri(`swarm/${swarmId}/turn/${turn}/sync/${peerId}`);
  return [
    quad(s, `${RDF}type`, otUri('SyncMemoryViaDKG'), g),
    quad(s, otUri('swarm'), swarmUri(swarmId), g),
    quad(s, otUri('turn'), literal(turn), g),
    quad(s, otUri('agent'), playerUri(peerId), g),
    quad(s, otUri('tracSpent'), literal(tracSpent), g),
    quad(s, otUri('timestamp'), literal(new Date().toISOString()), g),
  ];
}

export const SPARQL_PREFIXES = {
  OT,
  RDF,
  SCHEMA,
  DKG,
  PROV,
};
