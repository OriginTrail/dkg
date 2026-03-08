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

export const SPARQL_PREFIXES = {
  OT,
  RDF,
  SCHEMA,
  DKG,
  PROV,
};
