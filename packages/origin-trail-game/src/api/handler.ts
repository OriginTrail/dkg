import type { IncomingMessage, ServerResponse } from 'node:http';
import { OriginTrailGameCoordinator } from '../dkg/coordinator.js';
import { MIN_PLAYERS, signatureThreshold } from '../engine/wagon-train.js';
import { LOCATIONS } from '../world/world-data.js';

const PREFIX = '/api/apps/origin-trail-game';

function json(res: ServerResponse, status: number, data: unknown): true {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
  return true;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

export type AppRequestHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;

/**
 * Creates the OriginTrail Game app request handler.
 * When a DKG agent is provided, the handler uses the full DKG integration
 * (workspace + gossipsub + context graph). Without an agent, it falls back
 * to in-memory-only mode (useful for development/testing without a node).
 */
export default function createHandler(agent?: any, config?: any, _options?: unknown): AppRequestHandler {
  let coordinator: OriginTrailGameCoordinator | null = null;

  if (agent && typeof agent.peerId === 'string' && agent.gossip) {
    const paranetId = 'origin-trail-game';
    coordinator = new OriginTrailGameCoordinator(agent, { paranetId }, (msg: string) => {
      console.log(`[OriginTrailGame] ${msg}`);
    });
  }

  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const path = url.pathname;
    if (!path.startsWith(PREFIX)) return false;

    const subpath = path.slice(PREFIX.length) || '/';

    try {
      if (req.method === 'GET' && subpath === '/lobby') {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const lobby = coordinator.getLobby();
        return json(res, 200, {
          openSwarms: lobby.openSwarms.map(w => coordinator.formatSwarmState(w)),
          mySwarms: lobby.mySwarms.map(w => coordinator.formatSwarmState(w)),
        });
      }

      if (req.method === 'GET' && subpath === '/locations') {
        return json(res, 200, { locations: LOCATIONS });
      }

      if (req.method === 'GET' && subpath.startsWith('/swarm/')) {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const swarmId = subpath.slice('/swarm/'.length);
        const wagon = coordinator.getSwarm(swarmId);
        if (!wagon) return json(res, 404, { error: 'Swarm not found' });
        return json(res, 200, coordinator.formatSwarmState(wagon));
      }

      if (req.method === 'GET' && subpath === '/players') {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const players = await coordinator.getRegisteredPlayers();
        return json(res, 200, { players });
      }

      if (req.method === 'GET' && subpath === '/info') {
        return json(res, 200, {
          id: 'origin-trail-game',
          label: 'OriginTrail Game',
          minPlayers: MIN_PLAYERS,
          version: '0.2.0',
          dkgEnabled: !!coordinator,
          peerId: coordinator?.myPeerId ?? null,
          nodeName: config?.name ?? null,
        });
      }

      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
      if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });

      const body = JSON.parse(await readBody(req));

      if (subpath === '/create') {
        const { playerName, swarmName, maxPlayers } = body;
        if (!playerName || !swarmName) return json(res, 400, { error: 'Missing playerName or swarmName' });
        coordinator.publishPlayerProfile(playerName).catch(() => {});
        const wagon = await coordinator.createSwarm(playerName, swarmName, maxPlayers);
        return json(res, 200, coordinator.formatSwarmState(wagon));
      }

      if (subpath === '/join') {
        const { swarmId, playerName } = body;
        if (!swarmId || !playerName) return json(res, 400, { error: 'Missing swarmId or playerName' });
        coordinator.publishPlayerProfile(playerName).catch(() => {});
        const wagon = await coordinator.joinSwarm(swarmId, playerName);
        return json(res, 200, coordinator.formatSwarmState(wagon));
      }

      if (subpath === '/leave') {
        const { swarmId } = body;
        if (!swarmId) return json(res, 400, { error: 'Missing swarmId' });
        const wagon = await coordinator.leaveSwarm(swarmId);
        return json(res, 200, wagon ? coordinator.formatSwarmState(wagon) : { disbanded: true });
      }

      if (subpath === '/start') {
        const { swarmId } = body;
        if (!swarmId) return json(res, 400, { error: 'Missing swarmId' });
        const wagon = await coordinator.launchExpedition(swarmId);
        return json(res, 200, coordinator.formatSwarmState(wagon));
      }

      if (subpath === '/vote') {
        const { swarmId, voteAction, params } = body;
        if (!swarmId || !voteAction) return json(res, 400, { error: 'Missing swarmId or voteAction' });
        const wagon = await coordinator.castVote(swarmId, voteAction, params);
        return json(res, 200, coordinator.formatSwarmState(wagon));
      }

      if (subpath === '/force-resolve') {
        const { swarmId } = body;
        if (!swarmId) return json(res, 400, { error: 'Missing swarmId' });
        const wagon = await coordinator.forceResolveTurn(swarmId);
        return json(res, 200, coordinator.formatSwarmState(wagon));
      }

      return json(res, 404, { error: 'Not found' });
    } catch (err: any) {
      return json(res, 400, { error: err.message });
    }
  };
}
