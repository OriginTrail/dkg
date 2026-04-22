import type { IncomingMessage, ServerResponse } from 'node:http';
import { OriginTrailGameCoordinator } from '../dkg/coordinator.js';
import { MIN_PLAYERS, signatureThreshold } from '../engine/wagon-train.js';
import { MAX_EPOCHS } from '../engine/game-engine.js';
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
export default function createHandler(agent?: any, config?: any, _options?: unknown): AppRequestHandler & { destroy: () => void } {
  let coordinator: OriginTrailGameCoordinator | null = null;

  if (agent && typeof agent.peerId === 'string' && agent.gossip) {
    const contextGraphId = 'origin-trail-game';
    coordinator = new OriginTrailGameCoordinator(agent, { contextGraphId }, (msg: string) => {
      console.log(`[OriginTrailGame] ${msg}`);
    });
  }

  const handler = (async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
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
          recruitingSwarms: (lobby.recruitingSwarms ?? []).map(w => coordinator.formatSwarmState(w)),
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

      if (req.method === 'GET' && subpath === '/leaderboard') {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const entries = await coordinator.getLeaderboard();
        return json(res, 200, { entries });
      }

      if (req.method === 'GET' && subpath === '/notifications') {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        return json(res, 200, coordinator.getNotifications());
      }

      if (req.method === 'GET' && subpath === '/chat') {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const rawLimit = Number(url.searchParams.get('limit') ?? '50');
        const limit = Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.max(1, Math.min(Math.floor(rawLimit), 200))
          : 50;
        return json(res, 200, { messages: coordinator.getChatMessages(limit) });
      }

      if (req.method === 'GET' && subpath === '/info') {
        return json(res, 200, {
          id: 'origin-trail-game',
          label: 'OriginTrail Game',
          minPlayers: MIN_PLAYERS,
          maxEpochs: MAX_EPOCHS,
          version: '0.2.0',
          dkgEnabled: !!coordinator,
          peerId: coordinator?.myPeerId ?? null,
          nodeName: config?.name ?? null,
        });
      }

      if (req.method === 'POST' && subpath === '/notifications/read') {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const body = JSON.parse(await readBody(req));
        if (!body || typeof body !== 'object') return json(res, 400, { error: 'Invalid request body' });
        if (body.ids !== undefined && !Array.isArray(body.ids)) {
          return json(res, 400, { error: '"ids" must be an array of strings' });
        }
        const ids: string[] | undefined = body.ids;
        const count = coordinator.markNotificationsRead(ids);
        return json(res, 200, { markedRead: count });
      }

      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
      if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });

      const raw = JSON.parse(await readBody(req));
      if (!raw || typeof raw !== 'object') return json(res, 400, { error: 'Invalid request body' });
      const body = raw;

      if (subpath === '/chat') {
        const { message, displayName } = body;
        if (!message || typeof message !== 'string') return json(res, 400, { error: 'Missing or invalid message' });
        const trimmed = message.trim();
        if (trimmed.length === 0) return json(res, 400, { error: 'Message must not be empty' });
        if (trimmed.length > 200) return json(res, 400, { error: 'Message exceeds 200 character limit' });
        const name = typeof displayName === 'string' && displayName.trim()
          ? displayName.trim().slice(0, 50)
          : coordinator.myPeerId.slice(0, 8);
        const chatMsg = await coordinator.sendChatMessage(name, trimmed);
        return json(res, 200, chatMsg);
      }

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
        let { swarmId } = body;
        if (!swarmId) {
          const activeSwarms = coordinator.findMyActiveSwarms();
          if (activeSwarms.length === 0) return json(res, 400, { error: 'No active swarm to leave' });
          if (activeSwarms.length > 1) {
            return json(res, 400, {
              error: 'Multiple active swarms found. Please provide swarmId.',
              activeSwarmIds: activeSwarms.map((s) => s.id),
            });
          }
          swarmId = activeSwarms[0].id;
        }
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
        const { swarmId, expectedTurn } = body;
        if (!swarmId) return json(res, 400, { error: 'Missing swarmId' });
        // Bot review PR #229 (post-round-5): callers can pass
        // `expectedTurn` so idempotent retries of a specific turn
        // are detected semantically instead of by wall-clock proximity.
        const expected = typeof expectedTurn === 'number' && Number.isFinite(expectedTurn)
          ? expectedTurn
          : undefined;
        const wagon = await coordinator.forceResolveTurn(swarmId, { expectedTurn: expected });
        return json(res, 200, coordinator.formatSwarmState(wagon));
      }

      return json(res, 404, { error: 'Not found' });
    } catch (err: any) {
      return json(res, 400, { error: err.message });
    }
  }) as AppRequestHandler & { destroy: () => void };
  handler.destroy = () => coordinator?.destroy();
  return handler;
}
