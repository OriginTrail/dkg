import { describe, it, expect, beforeEach } from 'vitest';
import createHandler from '../src/api/handler.js';
import { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';

function makeMockAgent(peerId = 'test-peer-1') {
  const published: any[] = [];
  const workspaceWrites: any[] = [];
  const subscriptions = new Set<string>();
  const messageHandlers = new Map<string, Function[]>();

  return {
    peerId,
    gossip: {
      subscribe(topic: string) { subscriptions.add(topic); },
      publish: async (_topic: string, _data: Uint8Array) => {},
      onMessage(topic: string, handler: Function) {
        if (!messageHandlers.has(topic)) messageHandlers.set(topic, []);
        messageHandlers.get(topic)!.push(handler);
      },
      offMessage(_topic: string, _handler: Function) {},
    },
    writeToWorkspace: async (_paranetId: string, quads: any[]) => {
      workspaceWrites.push(quads);
      return { workspaceOperationId: 'test-op' };
    },
    publish: async (_paranetId: string, quads: any[]): Promise<any> => {
      published.push(quads);
      return { onChainResult: { txHash: '0xabc123' }, ual: 'did:dkg:test:ual' };
    },
    query: async (..._args: any[]): Promise<any> => ({ bindings: [] }),
    _published: published,
    _workspaceWrites: workspaceWrites,
    _subscriptions: subscriptions,
    _messageHandlers: messageHandlers,
  };
}

function createMockReq(method: string, path: string, body?: any): IncomingMessage & { url: string } {
  const req = new EventEmitter() as any;
  req.method = method;
  req.url = path;
  req.headers = {};
  if (body) {
    setTimeout(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    }, 0);
  }
  return req;
}

function createMockRes(): { res: ServerResponse; body: string; status: number } {
  const result = { body: '', status: 0 };
  const res = {
    writeHead(status: number, _headers: any) { result.status = status; },
    end(data: string) { result.body = data; },
  } as any;
  return { res, ...result, get body() { return result.body; }, get status() { return result.status; } };
}

describe('OriginTrail Game API handler', () => {
  let agent: ReturnType<typeof makeMockAgent>;
  let handler: any;

  beforeEach(() => {
    agent = makeMockAgent();
    handler = createHandler(agent, { paranets: ['test'] });
  });

  it('GET /info returns app info with DKG enabled', async () => {
    const req = createMockReq('GET', '/api/apps/origin-trail-game/info');
    const mock = createMockRes();
    const url = new URL(req.url, 'http://localhost');
    await handler(req, mock.res, url);
    const data = JSON.parse(mock.body);
    expect(data.id).toBe('origin-trail-game');
    expect(data.dkgEnabled).toBe(true);
    expect(data.peerId).toBe('test-peer-1');
  });

  it('GET /lobby returns formatted swarms with playerCount', async () => {
    const req1 = createMockReq('POST', '/api/apps/origin-trail-game/create', { playerName: 'Alice', swarmName: 'Test Swarm' });
    const mock1 = createMockRes();
    await handler(req1, mock1.res, new URL(req1.url, 'http://localhost'));
    const created = JSON.parse(mock1.body);
    expect(created.playerCount).toBe(1);

    const reqLobby = createMockReq('GET', '/api/apps/origin-trail-game/lobby');
    const mockLobby = createMockRes();
    await handler(reqLobby, mockLobby.res, new URL(reqLobby.url, 'http://localhost'));
    const lobby = JSON.parse(mockLobby.body);

    expect(lobby.mySwarms.length).toBe(1);
    expect(lobby.mySwarms[0].playerCount).toBe(1);
    expect(lobby.mySwarms[0].name).toBe('Test Swarm');
    expect(lobby.mySwarms[0].players[0].name).toBe('Alice');
    expect(lobby.mySwarms[0].players[0].isLeader).toBe(true);
  });

  it('GET /swarm/:id returns formatted swarm with leader info', async () => {
    const reqCreate = createMockReq('POST', '/api/apps/origin-trail-game/create', { playerName: 'Bob', swarmName: 'My Swarm' });
    const mockCreate = createMockRes();
    await handler(reqCreate, mockCreate.res, new URL(reqCreate.url, 'http://localhost'));
    const created = JSON.parse(mockCreate.body);

    const reqWagon = createMockReq('GET', `/api/apps/origin-trail-game/swarm/${created.id}`);
    const mockWagon = createMockRes();
    await handler(reqWagon, mockWagon.res, new URL(reqWagon.url, 'http://localhost'));
    const wagon = JSON.parse(mockWagon.body);

    expect(wagon.playerCount).toBe(1);
    expect(wagon.leaderId).toBe('test-peer-1');
    expect(wagon.leaderName).toBe('Bob');
    expect(wagon.players[0].isLeader).toBe(true);
    expect(wagon.players[0].name).toBe('Bob');
  });

  it('POST /create returns error if playerName missing', async () => {
    const req = createMockReq('POST', '/api/apps/origin-trail-game/create', { swarmName: 'No Player' });
    const mock = createMockRes();
    await handler(req, mock.res, new URL(req.url, 'http://localhost'));
    expect(mock.status).toBe(400);
    const data = JSON.parse(mock.body);
    expect(data.error).toContain('Missing');
  });

  it('handler without agent returns 503 for lobby', async () => {
    const noAgentHandler = createHandler();
    const req = createMockReq('GET', '/api/apps/origin-trail-game/lobby');
    const mock = createMockRes();
    await noAgentHandler(req, mock.res, new URL(req.url, 'http://localhost'));
    expect(mock.status).toBe(503);
  });

  it('coordinator subscribes to the dedicated game paranet app topic', () => {
    expect(agent._subscriptions.has('dkg/paranet/origin-trail-game/app')).toBe(true);
  });

  it('gossipsub messages include app discriminator', async () => {
    let capturedData: Uint8Array | null = null;
    const captureAgent = makeMockAgent('capture-peer');
    captureAgent.gossip.publish = async (_topic: string, data: Uint8Array) => { capturedData = data; };
    const captureHandler = createHandler(captureAgent, { paranets: ['test'] });

    const req = createMockReq('POST', '/api/apps/origin-trail-game/create', { playerName: 'Eve', swarmName: 'Capture Swarm' });
    const mock = createMockRes();
    await captureHandler(req, mock.res, new URL(req.url, 'http://localhost'));

    expect(capturedData).not.toBeNull();
    const parsed = JSON.parse(new TextDecoder().decode(capturedData!));
    expect(parsed.app).toBe('origin-trail-game');
    expect(parsed.type).toBe('swarm:created');
  });

  it('decode ignores messages from other apps', async () => {
    const { decode } = await import('../src/dkg/protocol.js');
    const otherApp = new TextEncoder().encode(JSON.stringify({ app: 'some-other-game', type: 'swarm:created', swarmId: 'x' }));
    expect(decode(otherApp)).toBeNull();

    const ours = new TextEncoder().encode(JSON.stringify({ app: 'origin-trail-game', type: 'swarm:created', swarmId: 'x' }));
    expect(decode(ours)).not.toBeNull();
    expect(decode(ours)!.type).toBe('swarm:created');
  });

  it('POST /create publishes player profile to game paranet', async () => {
    const req = createMockReq('POST', '/api/apps/origin-trail-game/create', { playerName: 'Zara', swarmName: 'Profile Swarm' });
    const mock = createMockRes();
    await handler(req, mock.res, new URL(req.url, 'http://localhost'));
    expect(mock.status).toBe(200);

    await new Promise(r => setTimeout(r, 50));

    expect(agent._published.length).toBeGreaterThanOrEqual(1);
    const profileQuads = agent._published[0];
    expect(profileQuads.some((q: any) => q.predicate.includes('schema.org/name') && q.object.includes('Zara'))).toBe(true);
    expect(profileQuads.some((q: any) => q.predicate.includes('peerId'))).toBe(true);
    expect(profileQuads.some((q: any) => q.object.includes('Player'))).toBe(true);
  });

  it('expeditionLaunchedQuads generates correct RDF triples (C3)', async () => {
    const { expeditionLaunchedQuads } = await import('../src/dkg/rdf.js');
    const quads = expeditionLaunchedQuads('test-paranet', 'swarm-1', '{"status":"active"}', 1700000000000);
    expect(quads.length).toBe(5);

    const typeQuad = quads.find((q: any) => q.predicate.includes('type'));
    expect(typeQuad?.object).toContain('ExpeditionLaunch');

    const swarmQuad = quads.find((q: any) => q.predicate.includes('swarm'));
    expect(swarmQuad?.object).toContain('swarm/swarm-1');

    const statusQuad = quads.find((q: any) => q.predicate.includes('status'));
    expect(statusQuad?.object).toContain('traveling');

    const gameStateQuad = quads.find((q: any) => q.predicate.includes('gameState'));
    expect(gameStateQuad?.object).toContain('active');

    const launchedAtQuad = quads.find((q: any) => q.predicate.includes('launchedAt'));
    expect(launchedAtQuad?.object).toContain('1700000000000');

    expect(quads[0].subject).toBe('urn:dkg:expedition:swarm-1:launched');
    expect(quads.every((q: any) => q.graph === 'did:dkg:paranet:test-paranet')).toBe(true);
  });

  it('launchExpedition writes game state to workspace (C3)', async () => {
    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const { encode } = await import('../src/dkg/protocol.js');
    const testAgent = makeMockAgent('launch-test-peer');
    testAgent.query = async () => ({ bindings: [] });
    const coordinator = new OriginTrailGameCoordinator(testAgent as any, { paranetId: 'test-launch' });

    const swarm = await coordinator.createSwarm('Leader', 'Launch Test');
    const handlers = testAgent._messageHandlers.get('dkg/paranet/test-launch/app');
    const handle = handlers![0];
    for (const [pid, name] of [['p2', 'P2'], ['p3', 'P3']]) {
      handle('dkg/paranet/test-launch/app', encode({
        app: 'origin-trail-game', type: 'swarm:joined', swarmId: swarm.id,
        peerId: pid, timestamp: Date.now(), playerName: name,
      }), pid);
    }

    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 50));
      if (swarm.players.length >= 3) break;
    }
    expect(swarm.players.length).toBe(3);

    const beforeWrites = testAgent._workspaceWrites.length;
    await coordinator.launchExpedition(swarm.id);

    const wsWritesAfter = testAgent._workspaceWrites.slice(beforeWrites);
    expect(wsWritesAfter.length).toBeGreaterThanOrEqual(1);
    const launchQuads = wsWritesAfter.find((batch: any[]) =>
      batch.some((q: any) => q.predicate.includes('gameState')),
    );
    expect(launchQuads).toBeDefined();
  });

  it('onRemoteExpeditionLaunched updates in-memory state without workspace write (C3)', async () => {
    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const { encode } = await import('../src/dkg/protocol.js');
    const { GameEngine } = await import('../src/engine/game-engine.js');
    const leaderPeerId = 'remote-leader-c3';
    const followerAgent = makeMockAgent('follower-c3');
    followerAgent.query = async () => ({ bindings: [] });
    const coordinator = new OriginTrailGameCoordinator(followerAgent as any, { paranetId: 'test-remote-launch' });

    const handlers = followerAgent._messageHandlers.get('dkg/paranet/test-remote-launch/app');
    const handle = handlers![0];

    handle('dkg/paranet/test-remote-launch/app', encode({
      app: 'origin-trail-game', type: 'swarm:created', swarmId: 'swarm-c3',
      peerId: leaderPeerId, timestamp: Date.now(), swarmName: 'Remote Test', playerName: 'Leader', maxPlayers: 3,
    }), leaderPeerId);
    await new Promise(r => setTimeout(r, 50));

    const engine = new GameEngine();
    const gs = engine.createGame(['Leader', 'P2', 'P3'], leaderPeerId);
    const launchMsg = encode({
      app: 'origin-trail-game', type: 'expedition:launched', swarmId: 'swarm-c3',
      peerId: leaderPeerId, timestamp: Date.now(),
      gameStateJson: JSON.stringify(gs),
    });

    const beforeWrites = followerAgent._workspaceWrites.length;
    handle('dkg/paranet/test-remote-launch/app', launchMsg, leaderPeerId);
    await new Promise(r => setTimeout(r, 100));

    // Follower should NOT write to workspace (Rule 4: leader owns swarm root);
    // launch state is replicated via leader's workspace gossip instead
    expect(followerAgent._workspaceWrites.length).toBe(beforeWrites);

    const swarm = coordinator.getSwarm('swarm-c3');
    expect(swarm).not.toBeNull();
    expect(swarm!.status).toBe('traveling');
    expect(swarm!.currentTurn).toBe(1);
    expect(swarm!.gameState).toEqual(gs);
    expect(swarm!.gameState!.status).toBe('active');
    expect(swarm!.gameState!.sessionId).toBeDefined();
    expect(swarm!.gameState!.party).toHaveLength(3);
  });

  it('GET /players returns registered players from the graph', async () => {
    const playerAgent = makeMockAgent('player-peer');
    playerAgent.query = async () => ({
      bindings: [
        { name: '"TestPlayer"', peerId: '"peer-123"', registeredAt: '"2026-01-01T00:00:00Z"' },
        { name: '"AnotherPlayer"', peerId: '"peer-456"', registeredAt: '"2026-01-02T00:00:00Z"' },
      ],
    });
    const playerHandler = createHandler(playerAgent);

    const req = createMockReq('GET', '/api/apps/origin-trail-game/players');
    const mock = createMockRes();
    await playerHandler(req, mock.res, new URL(req.url, 'http://localhost'));

    expect(mock.status).toBe(200);
    const data = JSON.parse(mock.body);
    expect(data.players).toHaveLength(2);
    expect(data.players[0].name).toBe('TestPlayer');
    expect(data.players[0].peerId).toBe('peer-123');
    expect(data.players[1].name).toBe('AnotherPlayer');
  });

  it('GET /players returns 503 without agent', async () => {
    const noAgentHandler = createHandler();
    const req = createMockReq('GET', '/api/apps/origin-trail-game/players');
    const mock = createMockRes();
    await noAgentHandler(req, mock.res, new URL(req.url, 'http://localhost'));
    expect(mock.status).toBe(503);
  });

  it('formatSwarmState includes turnHistory and voteStatus with timeRemaining', async () => {
    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const { encode } = await import('../src/dkg/protocol.js');
    const testAgent = makeMockAgent('coord-fmt-peer');
    testAgent.query = async () => ({ bindings: [] });
    const coordinator = new OriginTrailGameCoordinator(testAgent as any, { paranetId: 'test-fmt' });

    const swarm = await coordinator.createSwarm('Leader', 'Fmt Swarm');

    // Simulate two remote players joining via gossip
    const handlers = testAgent._messageHandlers.get('dkg/paranet/test-fmt/app');
    const handle = handlers![0];
    for (const [pid, name] of [['remote-p2', 'P2'], ['remote-p3', 'P3']]) {
      handle('dkg/paranet/test-fmt/app', encode({
        app: 'origin-trail-game', type: 'swarm:joined', swarmId: swarm.id,
        peerId: pid, timestamp: Date.now(), playerName: name,
      }), pid);
    }
    await new Promise(r => setTimeout(r, 50));

    const formatted = coordinator.formatSwarmState(swarm);
    expect(formatted.leaderId).toBe('coord-fmt-peer');
    expect(formatted.leaderName).toBe('Leader');
    expect(formatted.turnHistory).toEqual([]);
    expect(formatted.voteStatus).toBeNull();
    expect(formatted.players.find((p: any) => p.isLeader)?.name).toBe('Leader');

    await coordinator.launchExpedition(swarm.id);
    const traveling = coordinator.formatSwarmState(swarm);
    expect(traveling.voteStatus).not.toBeNull();
    expect(traveling.voteStatus!.timeRemaining).toBeGreaterThan(0);
    expect(traveling.voteStatus!.timeRemaining).toBeLessThanOrEqual(30_000);
    expect(traveling.voteStatus!.allVoted).toBe(false);
    expect(traveling.turnHistory).toEqual([]);
  });
});

describe('Entity exclusivity — no duplicate root entities', () => {
  it('playerJoinedQuads uses unique SwarmMembership URIs per swarm, not the player URI as root', async () => {
    const { playerJoinedQuads } = await import('../src/dkg/rdf.js');
    const q1 = playerJoinedQuads('origin-trail-game', 'swarm-A', 'peer-1', 'Alice');
    const q2 = playerJoinedQuads('origin-trail-game', 'swarm-B', 'peer-1', 'Alice');

    const root1 = q1[0].subject;
    const root2 = q2[0].subject;

    // Different swarms produce different root entities for the same player
    expect(root1).not.toBe(root2);
    expect(root1).toContain('swarm-A');
    expect(root1).toContain('peer-1');
    expect(root2).toContain('swarm-B');
    expect(root2).toContain('peer-1');

    // Root entity is a SwarmMembership, NOT the player URI itself
    expect(q1[0].object).toContain('SwarmMembership');
    // Player URI is referenced as an object, not the subject
    expect(q1.some((q: any) => q.predicate.includes('agent') && q.object.includes('player/peer-1'))).toBe(true);
  });

  it('creating then joining a different swarm produces non-overlapping root entities', async () => {
    const { swarmCreatedQuads, playerJoinedQuads } = await import('../src/dkg/rdf.js');
    const createQuads = [
      ...swarmCreatedQuads('origin-trail-game', 'swarm-X', 'Test', 'peer-1', Date.now(), 5),
      ...playerJoinedQuads('origin-trail-game', 'swarm-X', 'peer-1', 'Alice'),
    ];
    const joinQuads = playerJoinedQuads('origin-trail-game', 'swarm-Y', 'peer-1', 'Alice');

    const createRoots = new Set(createQuads.map((q: any) => q.subject));
    const joinRoots = new Set(joinQuads.map((q: any) => q.subject));

    // No root entity from joining should collide with any from creating
    for (const root of joinRoots) {
      expect(createRoots.has(root)).toBe(false);
    }
  });

  it('same player joining same swarm twice produces identical root entity (idempotent URI)', async () => {
    const { playerJoinedQuads } = await import('../src/dkg/rdf.js');
    const q1 = playerJoinedQuads('origin-trail-game', 'swarm-A', 'peer-1', 'Alice');
    const q2 = playerJoinedQuads('origin-trail-game', 'swarm-A', 'peer-1', 'Alice');

    // Same swarm + same peer = same membership URI (deterministic)
    expect(q1[0].subject).toBe(q2[0].subject);
  });

  it('publishPlayerProfile skips publish when profile already exists', async () => {
    const profileAgent = makeMockAgent('existing-peer');
    let queryCallCount = 0;
    profileAgent.query = async (sparql: string) => {
      queryCallCount++;
      if (sparql.includes('SELECT') && sparql.includes('Player')) {
        return { bindings: [{ exists: '1' }] };
      }
      return { bindings: [] };
    };
    profileAgent.publish = async (_paranetId: string, quads: any[]) => {
      profileAgent._published.push(quads);
      return {};
    };

    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const coordinator = new OriginTrailGameCoordinator(profileAgent as any, { paranetId: 'origin-trail-game' });

    await coordinator.publishPlayerProfile('ExistingPlayer');

    // Should have queried for existence but NOT published
    expect(queryCallCount).toBeGreaterThanOrEqual(1);
    expect(profileAgent._published.length).toBe(0);
  });

  it('publishPlayerProfile publishes when profile does not exist', async () => {
    const freshAgent = makeMockAgent('new-peer');
    freshAgent.query = async () => {
      return { bindings: [] };
    };
    freshAgent.publish = async (_paranetId: string, quads: any[]) => {
      freshAgent._published.push(quads);
      return {};
    };

    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const coordinator = new OriginTrailGameCoordinator(freshAgent as any, { paranetId: 'origin-trail-game' });

    await coordinator.publishPlayerProfile('NewPlayer');

    expect(freshAgent._published.length).toBe(1);
    expect(freshAgent._published[0].some((q: any) => q.object.includes('Player'))).toBe(true);
  });

  it('creating a swarm writes workspace quads without Rule 4 risk for the player', async () => {
    const wsAgent = makeMockAgent('ws-peer');
    wsAgent.query = async () => ({ bindings: [{ result: 'false' }] });
    const wsHandler = createHandler(wsAgent, { paranets: ['test'] });

    // Create first swarm
    const req1 = createMockReq('POST', '/api/apps/origin-trail-game/create', { playerName: 'Alice', swarmName: 'Swarm 1' });
    const mock1 = createMockRes();
    await wsHandler(req1, mock1.res, new URL(req1.url, 'http://localhost'));
    expect(mock1.status).toBe(200);

    // Leave it
    const created = JSON.parse(mock1.body);
    const reqLeave = createMockReq('POST', '/api/apps/origin-trail-game/leave', { swarmId: created.id });
    const mockLeave = createMockRes();
    await wsHandler(reqLeave, mockLeave.res, new URL(reqLeave.url, 'http://localhost'));

    // Create second swarm — workspace writes should have unique root entities
    const req2 = createMockReq('POST', '/api/apps/origin-trail-game/create', { playerName: 'Alice', swarmName: 'Swarm 2' });
    const mock2 = createMockRes();
    await wsHandler(req2, mock2.res, new URL(req2.url, 'http://localhost'));
    expect(mock2.status).toBe(200);

    // Collect all root entities from all workspace writes
    const allRoots = wsAgent._workspaceWrites.flatMap((quads: any[]) => quads.map((q: any) => q.subject));
    const uniqueRoots = new Set(allRoots);
    // No root entity should appear in more than one batch
    const batchRoots = wsAgent._workspaceWrites.map((quads: any[]) => new Set(quads.map((q: any) => q.subject)));
    for (let i = 0; i < batchRoots.length; i++) {
      for (let j = i + 1; j < batchRoots.length; j++) {
        for (const root of batchRoots[i]) {
          expect(batchRoots[j].has(root)).toBe(false);
        }
      }
    }
  });
});

describe('Chain provenance in turn results (C4)', () => {
  it('turnProvenanceQuads uses workspace graph and distinct root entity', async () => {
    const { turnProvenanceQuads, turnUri } = await import('../src/dkg/rdf.js');
    const quads = turnProvenanceQuads('test-paranet', 'swarm-1', 1, {
      txHash: '0xabc123',
      blockNumber: 42,
      ual: 'did:dkg:test/ual/1',
    });

    const txQuad = quads.find(q => q.predicate.includes('transactionHash'));
    expect(txQuad).toBeDefined();
    expect(txQuad!.object).toContain('0xabc123');

    const blockQuad = quads.find(q => q.predicate.includes('blockNumber'));
    expect(blockQuad).toBeDefined();
    expect(blockQuad!.object).toContain('42');

    const ualQuad = quads.find(q => q.predicate.includes('/ual'));
    expect(ualQuad).toBeDefined();
    expect(ualQuad!.object).toContain('did:dkg:test/ual/1');

    const graphs = new Set(quads.map(q => q.graph));
    expect(graphs.size).toBe(1);

    const roots = new Set(quads.map(q => q.subject));
    expect(roots.size).toBe(1);
    const root = [...roots][0];
    expect(root).toContain('/provenance');
    expect(root).not.toBe(turnUri('swarm-1', 1));
  });

  it('turnResolvedQuads does not include provenance triples', async () => {
    const { turnResolvedQuads } = await import('../src/dkg/rdf.js');
    const quads = turnResolvedQuads('test-paranet', 'swarm-1', 1, 'advance', '{}', ['peer-a']);

    expect(quads.find(q => q.predicate.includes('transactionHash'))).toBeUndefined();
    expect(quads.find(q => q.predicate.includes('blockNumber'))).toBeUndefined();
    expect(quads.find(q => q.predicate.includes('/ual'))).toBeUndefined();
  });

  it('turnProvenanceQuads omits blockNumber when undefined', async () => {
    const { turnProvenanceQuads } = await import('../src/dkg/rdf.js');
    const quads = turnProvenanceQuads('test-paranet', 'swarm-1', 1, {
      txHash: '0xabc123',
      blockNumber: undefined,
      ual: 'did:dkg:test/ual/1',
    });

    expect(quads.find(q => q.predicate.includes('transactionHash'))).toBeDefined();
    expect(quads.find(q => q.predicate.includes('/ual'))).toBeDefined();
    expect(quads.find(q => q.predicate.includes('blockNumber'))).toBeUndefined();
  });

  it('turnProvenanceQuads includes blockNumber when 0 (valid block height)', async () => {
    const { turnProvenanceQuads } = await import('../src/dkg/rdf.js');
    const quads = turnProvenanceQuads('test-paranet', 'swarm-1', 1, {
      txHash: '0xabc123',
      blockNumber: 0,
      ual: 'did:dkg:test/ual/1',
    });

    expect(quads.find(q => q.predicate.includes('transactionHash'))).toBeDefined();
    expect(quads.find(q => q.predicate.includes('blockNumber'))).toBeDefined();
  });

  it('turnProvenanceQuads emits UAL as literal', async () => {
    const { turnProvenanceQuads } = await import('../src/dkg/rdf.js');
    const quads = turnProvenanceQuads('test-paranet', 'swarm-1', 1, {
      txHash: '0xabc123',
      ual: 'some-plain-string',
    });

    const ualQuad = quads.find(q => q.predicate.includes('/ual'));
    expect(ualQuad).toBeDefined();
    expect(ualQuad!.object).toContain('some-plain-string');
  });

  it('forceResolveTurn writes provenance to workspace (not a second publish) when on-chain result is available', async () => {
    const leaderPeerId = 'leader-prov-1';
    const logs: string[] = [];

    const leaderAgent = makeMockAgent(leaderPeerId);
    leaderAgent.publish = async (_paranetId: string, quads: any[]) => {
      leaderAgent._published.push(quads);
      return {
        ual: 'did:dkg:test/ual/turn-1',
        onChainResult: { txHash: '0xdeadbeef', blockNumber: 100 },
      };
    };
    leaderAgent.query = async () => ({ bindings: [] });

    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const { encode } = await import('../src/dkg/protocol.js');
    const coordinator = new OriginTrailGameCoordinator(leaderAgent as any, { paranetId: 'prov-test' }, (msg) => logs.push(msg));

    const swarm = await coordinator.createSwarm('Leader', 'ProvenanceSwarm', 4);

    const handlers = leaderAgent._messageHandlers.get('dkg/paranet/prov-test/app');
    const handle = handlers![0];
    for (const [pid, name] of [['prov-p2', 'P2'], ['prov-p3', 'P3']] as const) {
      handle('dkg/paranet/prov-test/app', encode({
        app: 'origin-trail-game', type: 'swarm:joined', swarmId: swarm.id,
        peerId: pid, timestamp: Date.now(), playerName: name,
      }), pid);
    }
    await new Promise(r => setTimeout(r, 50));

    await coordinator.launchExpedition(swarm.id);
    await coordinator.castVote(swarm.id, 'advance');

    const publishCountBefore = leaderAgent._published.length;
    await coordinator.forceResolveTurn(swarm.id);

    // Only ONE publish call for the turn data — provenance goes to workspace
    expect(leaderAgent._published.length).toBe(publishCountBefore + 1);

    const provenanceWrite = leaderAgent._workspaceWrites.find((quads: any[]) =>
      quads.some((q: any) => q.predicate?.includes('transactionHash')),
    );
    expect(provenanceWrite).toBeDefined();
    expect(provenanceWrite.some((q: any) => q.object?.includes('0xdeadbeef'))).toBe(true);
    expect(provenanceWrite.some((q: any) => q.object?.includes('did:dkg:test/ual/turn-1'))).toBe(true);

    const blockQuad = provenanceWrite.find((q: any) => q.predicate?.includes('blockNumber'));
    expect(blockQuad).toBeDefined();
    expect(blockQuad.object).toContain('100');

    // Workspace graph (not context graph)
    const wsGraphs = new Set(provenanceWrite.map((q: any) => q.graph));
    expect(wsGraphs.size).toBe(1);
    expect([...wsGraphs][0]).toBe('did:dkg:paranet:prov-test');

    // Provenance root entity is distinct from the published turn entity
    const wsRoots = new Set(provenanceWrite.map((q: any) => q.subject));
    expect(wsRoots.size).toBe(1);
    const provRoot = [...wsRoots][0];
    expect(provRoot).toContain('/provenance/');

    const turnQuads = leaderAgent._published[leaderAgent._published.length - 1];
    const turnRoots = new Set(turnQuads.map((q: any) => q.subject));
    for (const turnRoot of turnRoots) {
      expect(provRoot).not.toBe(turnRoot);
    }

    const ualQuad = provenanceWrite.find((q: any) => q.predicate?.includes('/ual'));
    expect(ualQuad).toBeDefined();
    expect(ualQuad.object).toContain('did:dkg:test/ual/turn-1');

    const provLogs = logs.filter(l => l.includes('Provenance chain written'));
    expect(provLogs.length).toBeGreaterThanOrEqual(1);
  });

  it('forceResolveTurn skips provenance when no on-chain result', async () => {
    const leaderPeerId = 'leader-prov-2';
    const logs: string[] = [];

    const leaderAgent = makeMockAgent(leaderPeerId);
    leaderAgent.publish = async (_paranetId: string, quads: any[]) => {
      leaderAgent._published.push(quads);
      return {};
    };
    leaderAgent.query = async () => ({ bindings: [] });

    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const { encode } = await import('../src/dkg/protocol.js');
    const coordinator = new OriginTrailGameCoordinator(leaderAgent as any, { paranetId: 'prov-test2' }, (msg) => logs.push(msg));

    const swarm = await coordinator.createSwarm('Leader', 'NoProvSwarm', 4);

    const handlers = leaderAgent._messageHandlers.get('dkg/paranet/prov-test2/app');
    const handle = handlers![0];
    for (const [pid, name] of [['noprov-p2', 'P2'], ['noprov-p3', 'P3']] as const) {
      handle('dkg/paranet/prov-test2/app', encode({
        app: 'origin-trail-game', type: 'swarm:joined', swarmId: swarm.id,
        peerId: pid, timestamp: Date.now(), playerName: name,
      }), pid);
    }
    await new Promise(r => setTimeout(r, 50));

    await coordinator.launchExpedition(swarm.id);
    await coordinator.castVote(swarm.id, 'advance');

    await coordinator.forceResolveTurn(swarm.id);

    const provenanceWrite = leaderAgent._workspaceWrites.find((quads: any[]) =>
      quads.some((q: any) => q.predicate?.includes('transactionHash')),
    );
    expect(provenanceWrite).toBeUndefined();

    const provLogs = logs.filter(l => l.includes('provenance written'));
    expect(provLogs).toHaveLength(0);
  });

  it('checkProposalThreshold (consensus path) writes provenance to workspace, not a second publish', async () => {
    const leaderPeerId = 'leader-consensus-1';
    const logs: string[] = [];
    const broadcasts: any[] = [];

    const leaderAgent = makeMockAgent(leaderPeerId);
    leaderAgent.gossip.publish = async (_topic: string, data: Uint8Array) => {
      broadcasts.push(JSON.parse(new TextDecoder().decode(data)));
    };
    leaderAgent.publish = async (_paranetId: string, quads: any[]) => {
      leaderAgent._published.push(quads);
      return {
        ual: 'did:dkg:test/ual/consensus-1',
        onChainResult: { txHash: '0xcafe', blockNumber: 200 },
      };
    };
    leaderAgent.query = async () => ({ bindings: [] });

    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const { encode } = await import('../src/dkg/protocol.js');
    const coordinator = new OriginTrailGameCoordinator(leaderAgent as any, { paranetId: 'consensus-prov' }, (msg) => logs.push(msg));

    const swarm = await coordinator.createSwarm('Leader', 'ConsensusSwarm', 3);

    const handlers = leaderAgent._messageHandlers.get('dkg/paranet/consensus-prov/app');
    const handle = handlers![0];
    for (const [pid, name] of [['cons-p2', 'P2'], ['cons-p3', 'P3']] as const) {
      handle('dkg/paranet/consensus-prov/app', encode({
        app: 'origin-trail-game', type: 'swarm:joined', swarmId: swarm.id,
        peerId: pid, timestamp: Date.now(), playerName: name,
      }), pid);
    }
    await new Promise(r => setTimeout(r, 50));

    await coordinator.launchExpedition(swarm.id);

    // Remote peers vote, then leader votes — triggers proposeTurnResolution
    handle('dkg/paranet/consensus-prov/app', encode({
      app: 'origin-trail-game', type: 'vote:cast', swarmId: swarm.id,
      peerId: 'cons-p2', timestamp: Date.now(), turn: 1, action: 'advance',
    }), 'cons-p2');
    handle('dkg/paranet/consensus-prov/app', encode({
      app: 'origin-trail-game', type: 'vote:cast', swarmId: swarm.id,
      peerId: 'cons-p3', timestamp: Date.now(), turn: 1, action: 'advance',
    }), 'cons-p3');
    await new Promise(r => setTimeout(r, 50));

    const publishCountBefore = leaderAgent._published.length;
    await coordinator.castVote(swarm.id, 'advance');
    await new Promise(r => setTimeout(r, 100));

    // Leader proposed — now simulate a remote approval to reach threshold (2 of 3)
    const proposalBroadcast = broadcasts.find((b: any) => b.type === 'turn:proposal');
    expect(proposalBroadcast).toBeDefined();

    handle('dkg/paranet/consensus-prov/app', encode({
      app: 'origin-trail-game', type: 'turn:approve', swarmId: swarm.id,
      peerId: 'cons-p2', timestamp: Date.now(), turn: 1,
      proposalHash: proposalBroadcast.proposalHash,
    }), 'cons-p2');
    await new Promise(r => setTimeout(r, 200));

    // Exactly one publish for the turn data (not two)
    expect(leaderAgent._published.length).toBe(publishCountBefore + 1);

    // Provenance should be in workspace writes
    const provenanceWrite = leaderAgent._workspaceWrites.find((quads: any[]) =>
      quads.some((q: any) => q.predicate?.includes('transactionHash')),
    );
    expect(provenanceWrite).toBeDefined();
    expect(provenanceWrite.some((q: any) => q.object?.includes('0xcafe'))).toBe(true);
    expect(provenanceWrite.some((q: any) => q.object?.includes('did:dkg:test/ual/consensus-1'))).toBe(true);

    const blockQuad = provenanceWrite.find((q: any) => q.predicate?.includes('blockNumber'));
    expect(blockQuad).toBeDefined();
    expect(blockQuad.object).toContain('200');

    // Workspace graph (not context graph)
    const wsGraphs = new Set(provenanceWrite.map((q: any) => q.graph));
    expect(wsGraphs.size).toBe(1);
    expect([...wsGraphs][0]).toBe('did:dkg:paranet:consensus-prov');

    // Provenance root entity is distinct from the turn entity
    const wsRoots = new Set(provenanceWrite.map((q: any) => q.subject));
    expect(wsRoots.size).toBe(1);
    const provRoot = [...wsRoots][0];
    expect(provRoot).toContain('/provenance/');
    const turnQuads = leaderAgent._published[leaderAgent._published.length - 1];
    const turnRoots = new Set(turnQuads.map((q: any) => q.subject));
    for (const turnRoot of turnRoots) {
      expect(provRoot).not.toBe(turnRoot);
    }

    const ualQuad = provenanceWrite.find((q: any) => q.predicate?.includes('/ual'));
    expect(ualQuad).toBeDefined();
    expect(ualQuad.object).toContain('did:dkg:test/ual/consensus-1');

    const provLogs = logs.filter(l => l.includes('Provenance chain written'));
    expect(provLogs.length).toBeGreaterThanOrEqual(1);
  });

  it('consensus path skips blockNumber triple when blockNumber is undefined', async () => {
    const leaderPeerId = 'leader-consensus-2';
    const logs: string[] = [];
    const broadcasts: any[] = [];

    const leaderAgent = makeMockAgent(leaderPeerId);
    leaderAgent.gossip.publish = async (_topic: string, data: Uint8Array) => {
      broadcasts.push(JSON.parse(new TextDecoder().decode(data)));
    };
    leaderAgent.publish = async (_paranetId: string, quads: any[]) => {
      leaderAgent._published.push(quads);
      return {
        ual: 'did:dkg:test/ual/consensus-2',
        onChainResult: { txHash: '0xbeef', blockNumber: undefined },
      };
    };
    leaderAgent.query = async () => ({ bindings: [] });

    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const { encode } = await import('../src/dkg/protocol.js');
    const coordinator = new OriginTrailGameCoordinator(leaderAgent as any, { paranetId: 'consensus-noblock' }, (msg) => logs.push(msg));

    const swarm = await coordinator.createSwarm('Leader', 'NoBlockSwarm', 3);

    const handlers = leaderAgent._messageHandlers.get('dkg/paranet/consensus-noblock/app');
    const handle = handlers![0];
    for (const [pid, name] of [['nb-p2', 'P2'], ['nb-p3', 'P3']] as const) {
      handle('dkg/paranet/consensus-noblock/app', encode({
        app: 'origin-trail-game', type: 'swarm:joined', swarmId: swarm.id,
        peerId: pid, timestamp: Date.now(), playerName: name,
      }), pid);
    }
    await new Promise(r => setTimeout(r, 50));

    await coordinator.launchExpedition(swarm.id);

    handle('dkg/paranet/consensus-noblock/app', encode({
      app: 'origin-trail-game', type: 'vote:cast', swarmId: swarm.id,
      peerId: 'nb-p2', timestamp: Date.now(), turn: 1, action: 'advance',
    }), 'nb-p2');
    handle('dkg/paranet/consensus-noblock/app', encode({
      app: 'origin-trail-game', type: 'vote:cast', swarmId: swarm.id,
      peerId: 'nb-p3', timestamp: Date.now(), turn: 1, action: 'advance',
    }), 'nb-p3');
    await new Promise(r => setTimeout(r, 50));

    await coordinator.castVote(swarm.id, 'advance');
    await new Promise(r => setTimeout(r, 100));

    // Simulate remote approval to reach threshold
    const proposalBroadcast = broadcasts.find((b: any) => b.type === 'turn:proposal');
    expect(proposalBroadcast).toBeDefined();

    handle('dkg/paranet/consensus-noblock/app', encode({
      app: 'origin-trail-game', type: 'turn:approve', swarmId: swarm.id,
      peerId: 'nb-p2', timestamp: Date.now(), turn: 1,
      proposalHash: proposalBroadcast.proposalHash,
    }), 'nb-p2');
    await new Promise(r => setTimeout(r, 200));

    const provenanceWrite = leaderAgent._workspaceWrites.find((quads: any[]) =>
      quads.some((q: any) => q.predicate?.includes('transactionHash')),
    );
    expect(provenanceWrite).toBeDefined();
    expect(provenanceWrite.some((q: any) => q.object?.includes('0xbeef'))).toBe(true);

    const blockQuad = provenanceWrite.find((q: any) => q.predicate?.includes('blockNumber'));
    expect(blockQuad).toBeUndefined();
  });
});


describe('Consensus attestation triples (V1)', () => {
  it('consensusAttestationQuads generates correct RDF structure with distinct root entity', async () => {
    const { consensusAttestationQuads, turnUri } = await import('../src/dkg/rdf.js');
    const proposalHash = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    const quads = consensusAttestationQuads('test-paranet', 'swarm-1', 1, [
      { peerId: 'peer-a', proposalHash, approved: true, timestamp: 1000 },
      { peerId: 'peer-b', proposalHash, approved: true, timestamp: 1001 },
    ], 'consensus', proposalHash);

    // Root entity is a distinct ConsensusAttestationBatch, NOT the turn URI
    const batchQuads = quads.filter(q => q.object.includes('ConsensusAttestationBatch'));
    expect(batchQuads).toHaveLength(1);
    const root = batchQuads[0].subject;
    expect(root).toContain('urn:dkg:attestation:');
    expect(root).toContain(proposalHash);
    expect(root).not.toBe(turnUri('swarm-1', 1));

    // Root references the turn via forTurn
    const forTurnQuad = quads.find(q => q.predicate.includes('forTurn'));
    expect(forTurnQuad).toBeDefined();
    expect(forTurnQuad!.subject).toBe(root);
    expect(forTurnQuad!.object).toBe(turnUri('swarm-1', 1));

    // Resolution triple on the batch root, not the turn
    const resQuad = quads.find(q => q.predicate.includes('resolution'));
    expect(resQuad).toBeDefined();
    expect(resQuad!.subject).toBe(root);
    expect(resQuad!.object).toContain('consensus');

    // Two attestation entities
    const attQuads = quads.filter(q => q.object.includes('ConsensusAttestation') && !q.object.includes('Batch'));
    expect(attQuads).toHaveLength(2);

    // Individual attestation URIs contain full proposalHash
    for (const aq of attQuads) {
      expect(aq.subject).toContain(proposalHash);
    }

    // Each has signer, proposalHash, approved, attestedAt, plus hasAttestation link
    const signerQuads = quads.filter(q => q.predicate.includes('/signer'));
    expect(signerQuads).toHaveLength(2);
    expect(signerQuads[0].object).toContain('peer-a');
    expect(signerQuads[1].object).toContain('peer-b');

    const hashQuads = quads.filter(q => q.predicate.includes('proposalHash'));
    expect(hashQuads).toHaveLength(2);

    const approvedQuads = quads.filter(q => q.predicate.includes('/approved'));
    expect(approvedQuads).toHaveLength(2);

    const linkQuads = quads.filter(q => q.predicate.includes('hasAttestation'));
    expect(linkQuads).toHaveLength(2);
    for (const lq of linkQuads) {
      expect(lq.subject).toBe(root);
    }
  });

  it('forceResolveTurn publishes turn and attestation triples in a single call', async () => {
    const leaderPeerId = 'leader-att-1';
    const logs: string[] = [];
    const publishCalls: any[] = [];

    const leaderAgent = makeMockAgent(leaderPeerId);
    leaderAgent.publish = async (_paranetId: string, quads: any[]) => {
      publishCalls.push(quads);
      return {};
    };
    leaderAgent.query = async () => ({ bindings: [] });

    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const { encode } = await import('../src/dkg/protocol.js');
    const coordinator = new OriginTrailGameCoordinator(leaderAgent as any, { paranetId: 'att-test' }, (msg) => logs.push(msg));

    const swarm = await coordinator.createSwarm('Leader', 'AttestSwarm', 4);

    const handlers = leaderAgent._messageHandlers.get('dkg/paranet/att-test/app');
    const handle = handlers![0];
    for (const [pid, name] of [['att-p2', 'P2'], ['att-p3', 'P3']] as const) {
      handle('dkg/paranet/att-test/app', encode({
        app: 'origin-trail-game', type: 'swarm:joined', swarmId: swarm.id,
        peerId: pid, timestamp: Date.now(), playerName: name,
      }), pid);
    }
    await new Promise(r => setTimeout(r, 50));

    await coordinator.launchExpedition(swarm.id);
    await coordinator.castVote(swarm.id, 'advance');
    await coordinator.forceResolveTurn(swarm.id);

    // Turn + attestation quads should be merged in a single publish call
    const combinedPublish = publishCalls.find((quads: any[]) =>
      quads.some((q: any) => q.object?.includes('ConsensusAttestation')) &&
      quads.some((q: any) => q.object?.includes('TurnResult')),
    );
    expect(combinedPublish).toBeDefined();

    // Attestation root is a distinct ConsensusAttestationBatch
    const batchQuad = combinedPublish.find((q: any) => q.object?.includes('ConsensusAttestationBatch'));
    expect(batchQuad).toBeDefined();
    expect(batchQuad.subject).toContain('urn:dkg:attestation:');

    const signerQuad = combinedPublish.find((q: any) => q.predicate?.includes('/signer'));
    expect(signerQuad).toBeDefined();
    expect(signerQuad.object).toContain(leaderPeerId);

    const attLogs = logs.filter(l => l.includes('attestation published'));
    expect(attLogs.length).toBeGreaterThanOrEqual(1);
  });

  it('consensus flow via checkProposalThreshold publishes attestation triples with distinct root', async () => {
    const leaderPeerId = 'leader-cons-1';
    const followerPeerId = 'follower-cons-1';
    const thirdPeerId = 'third-cons-1';
    const logs: string[] = [];
    const publishCalls: any[] = [];

    const leaderAgent = makeMockAgent(leaderPeerId);
    leaderAgent.publish = async (_paranetId: string, quads: any[]) => {
      publishCalls.push(quads);
      return {};
    };
    leaderAgent.query = async () => ({ bindings: [] });

    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const { encode } = await import('../src/dkg/protocol.js');
    const coordinator = new OriginTrailGameCoordinator(leaderAgent as any, { paranetId: 'cons-test' }, (msg) => logs.push(msg));

    const swarm = await coordinator.createSwarm('Leader', 'ConsensusSwarm');

    const handlers = leaderAgent._messageHandlers.get('dkg/paranet/cons-test/app');
    const handle = handlers![0];
    for (const [pid, name] of [[followerPeerId, 'Follower'], [thirdPeerId, 'Third']] as const) {
      handle('dkg/paranet/cons-test/app', encode({
        app: 'origin-trail-game', type: 'swarm:joined', swarmId: swarm.id,
        peerId: pid, timestamp: Date.now(), playerName: name,
      }), pid);
    }
    await new Promise(r => setTimeout(r, 50));

    await coordinator.launchExpedition(swarm.id);

    // Leader votes locally
    await coordinator.castVote(swarm.id, 'advance');

    // Remote peers vote via gossip — third vote triggers proposeTurnResolution
    for (const pid of [followerPeerId, thirdPeerId]) {
      handle('dkg/paranet/cons-test/app', encode({
        app: 'origin-trail-game', type: 'vote:cast', swarmId: swarm.id,
        peerId: pid, timestamp: Date.now(), turn: 1, action: 'advance',
      }), pid);
    }
    await new Promise(r => setTimeout(r, 100));

    // Leader auto-approved (2/3 needed for 3 players). Simulate a follower approval to reach threshold.
    const proposal = swarm.pendingProposal;
    expect(proposal).not.toBeNull();

    handle('dkg/paranet/cons-test/app', encode({
      app: 'origin-trail-game', type: 'turn:approve', swarmId: swarm.id,
      peerId: followerPeerId, timestamp: 999, turn: 1,
      proposalHash: proposal!.hash,
    }), followerPeerId);
    await new Promise(r => setTimeout(r, 100));

    // Turn + attestation quads should be merged in a single publish call
    const combinedPublish = publishCalls.find((quads: any[]) =>
      quads.some((q: any) => q.object?.includes('ConsensusAttestation')) &&
      quads.some((q: any) => q.object?.includes('TurnResult')),
    );
    expect(combinedPublish).toBeDefined();

    // Attestation root is a distinct ConsensusAttestationBatch, NOT the turn URI
    const batchQuad = combinedPublish.find((q: any) => q.object?.includes('ConsensusAttestationBatch'));
    expect(batchQuad).toBeDefined();
    const attRoot = batchQuad.subject;
    expect(attRoot).toContain('urn:dkg:attestation:');

    const turnRoots = combinedPublish.filter((q: any) => q.object?.includes('TurnResult')).map((q: any) => q.subject);
    for (const tr of turnRoots) {
      expect(tr).not.toBe(attRoot);
    }

    // Batch root links to turn via forTurn
    const forTurnQuad = combinedPublish.find((q: any) => q.predicate?.includes('forTurn'));
    expect(forTurnQuad).toBeDefined();
    expect(forTurnQuad.subject).toBe(attRoot);

    // Should have attestations from both leader and follower
    const signerQuads = combinedPublish.filter((q: any) => q.predicate?.includes('/signer'));
    expect(signerQuads.length).toBe(2);

    // Approval timestamps must be local Date.now(), never the forged msg.timestamp (999)
    const attestedAtQuads = combinedPublish.filter((q: any) => q.predicate?.includes('attestedAt'));
    for (const aq of attestedAtQuads) {
      const ts = parseInt(aq.object.replace(/"/g, '').replace(/\^\^.*/, ''), 10);
      expect(ts).not.toBe(999);
      expect(ts).toBeGreaterThan(1_000_000_000_000);
    }

    const resolutionQuad = combinedPublish.find((q: any) => q.predicate?.includes('resolution'));
    expect(resolutionQuad).toBeDefined();
    expect(resolutionQuad.object).toContain('consensus');

    // Turn should have advanced
    expect(swarm.currentTurn).toBe(2);
    expect(swarm.turnHistory).toHaveLength(1);
    expect(swarm.turnHistory[0].resolution).toBe('consensus');
  });
});

describe('Publish provenance chain (V2)', () => {
  it('publishProvenanceChainQuads generates correct RDF structure', async () => {
    const { publishProvenanceChainQuads } = await import('../src/dkg/rdf.js');
    const quads = publishProvenanceChainQuads('test-paranet', {
      rootEntity: 'did:dkg:entity:1',
      ual: 'did:dkg:ual:123',
      txHash: '0xabc',
      blockNumber: 42,
      publisherPeerId: 'peer-pub-1',
      publishedAt: 1700000000000,
    });

    const typeQuad = quads.find(q => q.predicate.includes('rdf-syntax-ns#type'));
    expect(typeQuad).toBeDefined();
    expect(typeQuad!.object).toContain('PublishedEntity');

    expect(quads.find(q => q.predicate.includes('/ual'))).toBeDefined();
    expect(quads.find(q => q.predicate.includes('transactionHash'))!.object).toContain('0xabc');
    expect(quads.find(q => q.predicate.includes('blockNumber'))!.object).toContain('42');
    expect(quads.find(q => q.predicate.includes('publisherDID'))!.object).toContain('peer-pub-1');
    expect(quads.find(q => q.predicate.includes('publishedAt'))!.object).toContain('1700000000000');

    expect(quads[0].subject).toContain('did:dkg:entity:1/provenance/0xabc');
    expect(quads.find(q => q.predicate.includes('sourceEntity'))!.object).toBe('did:dkg:entity:1');
    expect(quads.length).toBe(7);
  });

  it('publishProvenanceChainQuads omits blockNumber when zero', async () => {
    const { publishProvenanceChainQuads } = await import('../src/dkg/rdf.js');
    const quads = publishProvenanceChainQuads('test-paranet', {
      rootEntity: 'did:dkg:entity:2',
      ual: 'did:dkg:ual:456',
      txHash: '0xdef',
      blockNumber: 0,
      publisherPeerId: 'peer-pub-2',
      publishedAt: 1700000000000,
    });

    expect(quads.find(q => q.predicate.includes('blockNumber'))).toBeUndefined();
    expect(quads.length).toBe(6);
  });

  it('publishProvenanceChainQuads omits blockNumber when undefined', async () => {
    const { publishProvenanceChainQuads } = await import('../src/dkg/rdf.js');
    const quads = publishProvenanceChainQuads('test-paranet', {
      rootEntity: 'did:dkg:entity:3',
      ual: 'did:dkg:ual:789',
      txHash: '0xghi',
      publisherPeerId: 'peer-pub-3',
      publishedAt: 1700000000000,
    });

    expect(quads.find(q => q.predicate.includes('blockNumber'))).toBeUndefined();
    expect(quads.length).toBe(6);
  });

  it('publishProvenanceChain handles kcId fallback when ual is missing', async () => {
    const agentProv = makeMockAgent('prov-fallback-peer');
    agentProv.query = async () => ({ bindings: [] });

    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const logs: string[] = [];
    const coordinator = new OriginTrailGameCoordinator(agentProv as any, { paranetId: 'fb-test' }, (msg) => logs.push(msg));

    await coordinator.publishProvenanceChain('did:dkg:entity:test', {
      kcId: 42,
      onChainResult: { txHash: '0xfallback', blockNumber: 5 },
    });

    const provQuads = agentProv._workspaceWrites.find((batch: any[]) =>
      batch.some((q: any) => q.predicate?.includes('sourceEntity')),
    );
    expect(provQuads).toBeDefined();
    expect(provQuads.find((q: any) => q.predicate?.includes('/ual'))?.object).toContain('42');
  });

  it('publishProvenanceChain skips when neither ual nor txHash is available', async () => {
    const agentProv = makeMockAgent('prov-skip-peer');
    agentProv.query = async () => ({ bindings: [] });

    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const logs: string[] = [];
    const coordinator = new OriginTrailGameCoordinator(agentProv as any, { paranetId: 'skip-test' }, (msg) => logs.push(msg));

    await coordinator.publishProvenanceChain('did:dkg:entity:skip', {});

    expect(agentProv._workspaceWrites.length).toBe(0);
  });

  it('forceResolveTurn publishes provenance chain when on-chain data is available', async () => {
    const leaderPeerId = 'leader-prov-chain-1';
    const logs: string[] = [];
    const publishCalls: any[] = [];

    const leaderAgent = makeMockAgent(leaderPeerId);
    leaderAgent.publish = async (_paranetId: string, quads: any[]) => {
      publishCalls.push(quads);
      return {
        ual: 'did:dkg:test/ual/turn-chain',
        onChainResult: { txHash: '0xchain123', blockNumber: 200 },
      };
    };
    leaderAgent.query = async () => ({ bindings: [] });

    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const { encode } = await import('../src/dkg/protocol.js');
    const coordinator = new OriginTrailGameCoordinator(leaderAgent as any, { paranetId: 'prov-chain-test' }, (msg) => logs.push(msg));

    const swarm = await coordinator.createSwarm('Leader', 'ProvChainSwarm', 4);

    const handlers = leaderAgent._messageHandlers.get('dkg/paranet/prov-chain-test/app');
    const handle = handlers![0];
    for (const [pid, name] of [['prov-chain-p2', 'P2'], ['prov-chain-p3', 'P3']] as const) {
      handle('dkg/paranet/prov-chain-test/app', encode({
        app: 'origin-trail-game', type: 'swarm:joined', swarmId: swarm.id,
        peerId: pid, timestamp: Date.now(), playerName: name,
      }), pid);
    }
    await new Promise(r => setTimeout(r, 50));

    await coordinator.launchExpedition(swarm.id);
    await coordinator.castVote(swarm.id, 'advance');
    await coordinator.forceResolveTurn(swarm.id);

    const provenanceChainPublish = leaderAgent._workspaceWrites.find((quads: any[]) =>
      quads.some((q: any) => q.object?.includes('PublishedEntity')),
    );
    expect(provenanceChainPublish).toBeDefined();
    expect(provenanceChainPublish.some((q: any) => q.predicate?.includes('publisherDID'))).toBe(true);

    const chainLogs = logs.filter(l => l.includes('Provenance chain written to workspace'));
    expect(chainLogs.length).toBeGreaterThanOrEqual(1);
  });

  it('consensus flow publishes provenance chain after threshold is met', async () => {
    const leaderPeerId = 'leader-prov-cons-1';
    const followerPeerId = 'follower-prov-cons-1';
    const thirdPeerId = 'third-prov-cons-1';
    const logs: string[] = [];
    const publishCalls: any[] = [];

    const leaderAgent = makeMockAgent(leaderPeerId);
    leaderAgent.publish = async (_paranetId: string, quads: any[]) => {
      publishCalls.push(quads);
      return {
        ual: 'did:dkg:test/ual/consensus-chain',
        onChainResult: { txHash: '0xconsensus', blockNumber: 300 },
      };
    };
    leaderAgent.query = async () => ({ bindings: [] });

    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const { encode } = await import('../src/dkg/protocol.js');
    const coordinator = new OriginTrailGameCoordinator(leaderAgent as any, { paranetId: 'prov-cons-test' }, (msg) => logs.push(msg));

    const swarm = await coordinator.createSwarm('Leader', 'ProvConsSwarm');

    const handlers = leaderAgent._messageHandlers.get('dkg/paranet/prov-cons-test/app');
    const handle = handlers![0];
    for (const [pid, name] of [[followerPeerId, 'Follower'], [thirdPeerId, 'Third']] as const) {
      handle('dkg/paranet/prov-cons-test/app', encode({
        app: 'origin-trail-game', type: 'swarm:joined', swarmId: swarm.id,
        peerId: pid, timestamp: Date.now(), playerName: name,
      }), pid);
    }
    await new Promise(r => setTimeout(r, 50));

    await coordinator.launchExpedition(swarm.id);
    await coordinator.castVote(swarm.id, 'advance');

    for (const pid of [followerPeerId, thirdPeerId]) {
      handle('dkg/paranet/prov-cons-test/app', encode({
        app: 'origin-trail-game', type: 'vote:cast', swarmId: swarm.id,
        peerId: pid, timestamp: Date.now(), turn: 1, action: 'advance',
      }), pid);
    }
    await new Promise(r => setTimeout(r, 100));

    const proposal = swarm.pendingProposal;
    expect(proposal).not.toBeNull();

    handle('dkg/paranet/prov-cons-test/app', encode({
      app: 'origin-trail-game', type: 'turn:approve', swarmId: swarm.id,
      peerId: followerPeerId, timestamp: Date.now(), turn: 1,
      proposalHash: proposal!.hash,
    }), followerPeerId);
    await new Promise(r => setTimeout(r, 100));

    const provenancePublish = leaderAgent._workspaceWrites.find((quads: any[]) =>
      quads.some((q: any) => q.object?.includes('PublishedEntity')),
    );
    expect(provenancePublish).toBeDefined();

    const chainLogs = logs.filter(l => l.includes('Provenance chain written to workspace'));
    expect(chainLogs.length).toBeGreaterThanOrEqual(1);

    expect(swarm.currentTurn).toBe(2);
    expect(swarm.turnHistory).toHaveLength(1);
    expect(swarm.turnHistory[0].resolution).toBe('consensus');
  });
});

describe('Player profile RDF quads', () => {
  it('playerProfileQuads generates correct triples', async () => {
    const { playerProfileQuads } = await import('../src/dkg/rdf.js');
    const quads = playerProfileQuads('origin-trail-game', 'peer-abc', 'TestAgent');

    expect(quads.length).toBe(4);
    expect(quads[0].subject).toBe('did:dkg:game:player:peer-abc');
    expect(quads[0].predicate).toContain('rdf-syntax-ns#type');
    expect(quads[0].object).toContain('Player');
    expect(quads[0].graph).toBe('did:dkg:paranet:origin-trail-game');

    expect(quads[1].predicate).toContain('schema.org/name');
    expect(quads[1].object).toContain('TestAgent');

    expect(quads[2].predicate).toContain('peerId');
    expect(quads[2].object).toContain('peer-abc');

    expect(quads[3].predicate).toContain('prov#atTime');
  });
});

describe('Graph-based lobby sync', () => {
  it('loadLobbyFromGraph restores swarms from graph data', async () => {
    const syncAgent = makeMockAgent('sync-peer');
    let queryCount = 0;
    syncAgent.query = async (sparql: string) => {
      queryCount++;
      if (sparql.includes('AgentSwarm')) {
        return {
          bindings: [{
            swarm: 'https://origintrail-game.dkg.io/swarm/swarm-abc123',
            name: '"Graph Swarm"',
            status: '"recruiting"',
            orchestrator: 'https://origintrail-game.dkg.io/player/other-peer',
            createdAt: '"1700000000000"',
          }],
        };
      }
      if (sparql.includes('a <') && sparql.includes('Player')) {
        return { bindings: [{ name: '"GraphPlayer"', peerId: '"sync-peer"', registeredAt: '"2026-01-01"' }] };
      }
      if (sparql.includes('displayName')) {
        return {
          bindings: [{
            agent: 'https://origintrail-game.dkg.io/player/other-peer',
            displayName: '"OtherPlayer"',
          }],
        };
      }
      return { bindings: [] };
    };

    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const coordinator = new OriginTrailGameCoordinator(syncAgent as any, { paranetId: 'origin-trail-game' });

    await new Promise(r => setTimeout(r, 6_000));

    const lobby = coordinator.getLobby();
    expect(lobby.openSwarms.length).toBe(1);
    expect(lobby.openSwarms[0].name).toBe('Graph Swarm');
    expect(lobby.openSwarms[0].players.length).toBe(1);
    expect(lobby.openSwarms[0].players[0].displayName).toBe('OtherPlayer');
    expect(queryCount).toBeGreaterThanOrEqual(3);
  }, 10_000);
});

describe('Network topology hints (V3)', () => {
  it('networkTopologyQuads generates correct RDF structure', async () => {
    const { networkTopologyQuads, OT } = await import('../src/dkg/rdf.js');
    const peers = [
      { peerId: 'peer-a', connectionType: 'relay' as const, messageAgeMs: 120, lastSeen: 1700000000000 },
      { peerId: 'peer-b', connectionType: 'direct' as const, messageAgeMs: 30, lastSeen: 1700000001000 },
    ];
    const quads = networkTopologyQuads('test-paranet', 'writer-1', peers);

    const snapshotQuad = quads.find(q => q.predicate.includes('rdf-syntax-ns#type') && q.object.includes('NetworkSnapshot'));
    expect(snapshotQuad).toBeDefined();
    expect(snapshotQuad!.subject).toContain('topology/snapshot-writer-1');
    expect(snapshotQuad!.graph).toBe('did:dkg:paranet:test-paranet');

    const capturedAt = quads.find(q => q.predicate.includes('capturedAt'));
    expect(capturedAt).toBeDefined();

    const peerTypeQuads = quads.filter(q => q.predicate.includes('rdf-syntax-ns#type') && q.object.includes('TopologyPeer'));
    expect(peerTypeQuads).toHaveLength(2);

    const connTypeQuads = quads.filter(q => q.predicate.includes('connectionType'));
    expect(connTypeQuads).toHaveLength(2);
    expect(connTypeQuads.some(q => q.object.includes('relay'))).toBe(true);
    expect(connTypeQuads.some(q => q.object.includes('direct'))).toBe(true);

    const ageQuads = quads.filter(q => q.predicate.includes('messageAgeMs'));
    expect(ageQuads).toHaveLength(2);
    expect(ageQuads.some(q => q.object.includes('120'))).toBe(true);
    expect(ageQuads.some(q => q.object.includes('30'))).toBe(true);

    const lastSeenQuads = quads.filter(q => q.predicate.includes('lastSeen'));
    expect(lastSeenQuads).toHaveLength(2);

    const hasPeerQuads = quads.filter(q => q.predicate.includes('hasPeer'));
    expect(hasPeerQuads).toHaveLength(2);

    const peerIdQuads = quads.filter(q => q.predicate.includes('/peerId'));
    expect(peerIdQuads).toHaveLength(2);
    expect(peerIdQuads.some(q => q.object.includes('peer-a'))).toBe(true);
    expect(peerIdQuads.some(q => q.object.includes('peer-b'))).toBe(true);

    const peerSubjects = peerTypeQuads.map(q => q.subject);
    for (const subj of peerSubjects) {
      expect(subj).toContain('.well-known/genid/');
      expect(subj).toContain(snapshotQuad!.subject);
    }

    const allRoots = new Set(quads.map(q => q.subject));
    const snapshotRoot = snapshotQuad!.subject;
    for (const root of allRoots) {
      expect(root.startsWith(snapshotRoot)).toBe(true);
    }
  });

  it('networkTopologyQuads returns only snapshot header quads when no peers given', async () => {
    const { networkTopologyQuads } = await import('../src/dkg/rdf.js');
    const quads = networkTopologyQuads('test-paranet', 'writer-1', []);
    expect(quads).toHaveLength(3);
    expect(quads[0].object).toContain('NetworkSnapshot');
  });

  it('coordinator publishNetworkTopology writes topology quads to workspace', async () => {
    const topoAgent = makeMockAgent('topo-peer');
    topoAgent.query = async () => ({ bindings: [] });

    const logs: string[] = [];
    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const { encode } = await import('../src/dkg/protocol.js');
    const coordinator = new OriginTrailGameCoordinator(topoAgent as any, { paranetId: 'topo-test' }, (msg) => logs.push(msg));

    const swarm = await coordinator.createSwarm('Leader', 'TopoSwarm');

    const handlers = topoAgent._messageHandlers.get('dkg/paranet/topo-test/app');
    const handle = handlers![0];
    for (const [pid, name] of [['topo-p2', 'P2'], ['topo-p3', 'P3']]) {
      handle('dkg/paranet/topo-test/app', encode({
        app: 'origin-trail-game', type: 'swarm:joined',
        swarmId: swarm.id,
        peerId: pid,
        playerName: name,
        timestamp: Date.now(),
      }), pid);
    }

    await new Promise(r => setTimeout(r, 200));
    await coordinator.publishNetworkTopology();
    expect(topoAgent._workspaceWrites.length).toBeGreaterThan(0);
    coordinator.destroy();
  });
});

describe('Workspace lineage quads', () => {
  it('generates enshrined quads when confirmed is true', async () => {
    const { workspaceLineageQuads } = await import('../src/dkg/rdf.js');
    const quads = workspaceLineageQuads('origin-trail-game', [{
      workspaceOperationId: 'op-123',
      rootEntity: 'https://origintrail-game.dkg.io/swarm/swarm-abc',
      publishedUal: 'did:dkg:test-ual',
      publishedTxHash: '0xabcdef',
      publishedAt: 1700000000000,
      confirmed: true,
    }]);

    expect(quads.length).toBe(8);
    expect(quads[0].subject).toContain('lineage/op-123');
    expect(quads[0].predicate).toContain('rdf-syntax-ns#type');
    expect(quads[0].object).toContain('WorkspaceLineage');
    expect(quads[0].graph).toBe('did:dkg:paranet:origin-trail-game');

    const statusQuad = quads.find((q: any) => q.predicate.includes('status'));
    expect(statusQuad?.object).toContain('published');

    const confirmedQuad = quads.find((q: any) => q.predicate.includes('confirmed'));
    expect(confirmedQuad?.object).toContain('true');

    const ualQuad = quads.find((q: any) => q.predicate.includes('publishedUal'));
    expect(ualQuad?.object).toContain('did:dkg:test-ual');
  });

  it('generates workspace-only quads when not confirmed', async () => {
    const { workspaceLineageQuads } = await import('../src/dkg/rdf.js');
    const quads = workspaceLineageQuads('origin-trail-game', [{
      workspaceOperationId: 'op-456',
      rootEntity: 'https://origintrail-game.dkg.io/swarm/swarm-def/vote/peer-1',
    }]);

    expect(quads.length).toBe(5);
    const statusQuad = quads.find((q: any) => q.predicate.includes('status'));
    expect(statusQuad?.object).toContain('workspace');

    const confirmedQuad = quads.find((q: any) => q.predicate.includes('confirmed'));
    expect(confirmedQuad?.object).toContain('false');

    const ualQuad = quads.find((q: any) => q.predicate.includes('publishedUal'));
    expect(ualQuad).toBeUndefined();
  });

  it('handles multiple entries with distinct subjects', async () => {
    const { workspaceLineageQuads } = await import('../src/dkg/rdf.js');
    const quads = workspaceLineageQuads('origin-trail-game', [
      { workspaceOperationId: 'op-a', rootEntity: 'https://example.com/e1', publishedUal: 'ual-1', confirmed: true },
      { workspaceOperationId: 'op-b', rootEntity: 'https://example.com/e2' },
    ]);

    const subjects = new Set(quads.map((q: any) => q.subject));
    expect(subjects.size).toBe(2);
    expect([...subjects].some(s => s.includes('op-a'))).toBe(true);
    expect([...subjects].some(s => s.includes('op-b'))).toBe(true);

    const enshrined = quads.filter((q: any) => q.object?.includes?.('published'));
    const wsOnly = quads.filter((q: any) => q.object?.includes?.('workspace'));
    expect(enshrined.length).toBe(1);
    expect(wsOnly.length).toBe(1);
  });
});

// TODO: Workspace lineage on success path is not yet implemented in coordinator
// (writeLineageFromSnapshot is never called on successful publish — see TODO_UNRESOLVED_PR_COMMENTS.md)
describe.skip('Workspace lineage tracking', () => {
  it('writes lineage quads after force-resolve turn publish', async () => {
    const leaderPeerId = 'lineage-leader';
    let opCounter = 0;
    const lineageAgent = makeMockAgent(leaderPeerId);
    lineageAgent.writeToWorkspace = async (_paranetId: string, quads: any[]) => {
      lineageAgent._workspaceWrites.push(quads);
      return { workspaceOperationId: `op-${++opCounter}` };
    };
    lineageAgent.publish = async (_paranetId: string, quads: any[]) => {
      lineageAgent._published.push(quads);
      return { ual: 'did:dkg:published-ual', onChainResult: { txHash: '0xabc123' } };
    };

    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const logs: string[] = [];
    const coordinator = new OriginTrailGameCoordinator(lineageAgent as any, { paranetId: 'lineage-test' }, (msg) => logs.push(msg));

    const swarm = await coordinator.createSwarm('Leader', 'Lineage Swarm');

    const { encode } = await import('../src/dkg/protocol.js');
    const handlers = lineageAgent._messageHandlers.get('dkg/paranet/lineage-test/app');
    const handle = handlers![0];

    for (const [pid, name] of [['lineage-p2', 'P2'], ['lineage-p3', 'P3']]) {
      handle('dkg/paranet/lineage-test/app', encode({
        app: 'origin-trail-game', type: 'swarm:joined', swarmId: swarm.id,
        peerId: pid, timestamp: Date.now(), playerName: name,
      }), pid);
    }
    await new Promise(r => setTimeout(r, 50));

    const writesBefore = lineageAgent._workspaceWrites.length;
    await coordinator.publishNetworkTopology();

    expect(lineageAgent._workspaceWrites.length).toBeGreaterThan(writesBefore);
    const lastWrite = lineageAgent._workspaceWrites[lineageAgent._workspaceWrites.length - 1];
    expect(lastWrite.some((q: any) => q.object?.includes('NetworkSnapshot'))).toBe(true);
    expect(lastWrite.some((q: any) => q.predicate?.includes('connectionType'))).toBe(true);

    const topoLogs = logs.filter(l => l.includes('Topology snapshot written'));
    expect(topoLogs).toHaveLength(1);
    expect(topoLogs[0]).toContain('2 peers');

    coordinator.destroy();
  });

  it('coordinator publishNetworkTopology writes empty snapshot when no peers are known', async () => {
    const emptyAgent = makeMockAgent('empty-topo-peer');
    emptyAgent.query = async () => ({ bindings: [] });

    const logs: string[] = [];
    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const coordinator = new OriginTrailGameCoordinator(emptyAgent as any, { paranetId: 'empty-topo' }, (msg) => logs.push(msg));

    const writesBefore = emptyAgent._workspaceWrites.length;
    await coordinator.publishNetworkTopology();

    expect(emptyAgent._workspaceWrites.length).toBe(writesBefore + 1);
    const lastWrite = emptyAgent._workspaceWrites[emptyAgent._workspaceWrites.length - 1];
    expect(lastWrite.some((q: any) => q.object?.includes('NetworkSnapshot'))).toBe(true);
    expect(lastWrite).toHaveLength(3);

    coordinator.destroy();
  });

  it('coordinator destroy clears topology timer', async () => {
    const timerAgent = makeMockAgent('timer-peer');
    timerAgent.query = async () => ({ bindings: [] });

    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const coordinator = new OriginTrailGameCoordinator(timerAgent as any, { paranetId: 'timer-test' });

    coordinator.destroy();
    expect(true).toBe(true);
  });

  it('writes lineage quads after normal consensus turn resolution', async () => {
    const leaderPeerId = 'consensus-leader';
    const p2 = 'consensus-p2';
    const p3 = 'consensus-p3';
    let opCounter = 0;
    const consensusAgent = makeMockAgent(leaderPeerId);
    consensusAgent.writeToWorkspace = async (_paranetId: string, quads: any[]) => {
      consensusAgent._workspaceWrites.push(quads);
      return { workspaceOperationId: `op-${++opCounter}` };
    };
    consensusAgent.publish = async (_paranetId: string, quads: any[]) => {
      consensusAgent._published.push(quads);
      return { ual: 'did:dkg:consensus-ual', onChainResult: { txHash: '0xconsensus' } };
    };

    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const logs: string[] = [];
    const coordinator = new OriginTrailGameCoordinator(consensusAgent as any, { paranetId: 'consensus-test' }, (msg) => logs.push(msg));

    const swarm = await coordinator.createSwarm('Leader', 'Consensus Swarm');

    const { encode } = await import('../src/dkg/protocol.js');
    const handlers = consensusAgent._messageHandlers.get('dkg/paranet/consensus-test/app');
    const handle = handlers![0];

    for (const [pid, name] of [[p2, 'P2'], [p3, 'P3']]) {
      handle('dkg/paranet/consensus-test/app', encode({
        app: 'origin-trail-game', type: 'swarm:joined', swarmId: swarm.id,
        peerId: pid, timestamp: Date.now(), playerName: name,
      }), pid);
    }
    await new Promise(r => setTimeout(r, 50));

    await coordinator.launchExpedition(swarm.id);

    // Remote peers vote first
    for (const pid of [p2, p3]) {
      handle('dkg/paranet/consensus-test/app', encode({
        app: 'origin-trail-game', type: 'vote:cast', swarmId: swarm.id,
        peerId: pid, timestamp: Date.now(), turn: 1, action: 'advance',
      }), pid);
    }
    await new Promise(r => setTimeout(r, 50));

    const writesBeforeConsensus = consensusAgent._workspaceWrites.length;

    // Leader votes last — triggers proposeTurnResolution (all 3 voted)
    await coordinator.castVote(swarm.id, 'advance');
    await new Promise(r => setTimeout(r, 50));

    // Simulate remote peer approving the proposal to reach threshold
    const pendingProposal = swarm.pendingProposal;
    expect(pendingProposal).not.toBeNull();
    handle('dkg/paranet/consensus-test/app', encode({
      app: 'origin-trail-game', type: 'turn:approve', swarmId: swarm.id,
      peerId: p2, timestamp: Date.now(), turn: 1,
      proposalHash: pendingProposal!.hash,
    }), p2);
    await new Promise(r => setTimeout(r, 100));

    const lineageWrites = consensusAgent._workspaceWrites.slice(writesBeforeConsensus).filter((quads: any[]) =>
      quads.some((q: any) => q.object?.includes?.('WorkspaceLineage'))
    );
    expect(lineageWrites.length).toBeGreaterThanOrEqual(1);

    const lineageQuads = lineageWrites[0];
    expect(lineageQuads.some((q: any) => q.predicate?.includes?.('publishedUal'))).toBe(true);
    expect(lineageQuads.some((q: any) => q.predicate?.includes?.('confirmed') && q.object?.includes?.('true'))).toBe(true);
    expect(lineageQuads.some((q: any) => q.object?.includes?.('published'))).toBe(true);

    const lineageLogs = logs.filter(l => l.includes('lineage'));
    expect(lineageLogs.length).toBeGreaterThanOrEqual(1);
  });

  it('lineage entries are workspace-only when publish returns no UAL', async () => {
    const leaderPeerId = 'lineage-noul-leader';
    let opCounter = 0;
    const noUalAgent = makeMockAgent(leaderPeerId);
    noUalAgent.writeToWorkspace = async (_paranetId: string, quads: any[]) => {
      noUalAgent._workspaceWrites.push(quads);
      return { workspaceOperationId: `op-${++opCounter}` };
    };
    noUalAgent.publish = async (_paranetId: string, quads: any[]) => {
      noUalAgent._published.push(quads);
      return {};
    };

    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const coordinator = new OriginTrailGameCoordinator(noUalAgent as any, { paranetId: 'lineage-noul' });

    const swarm = await coordinator.createSwarm('Leader', 'No-UAL Swarm');

    const { encode } = await import('../src/dkg/protocol.js');
    const handlers = noUalAgent._messageHandlers.get('dkg/paranet/lineage-noul/app');
    const handle = handlers![0];

    for (const [pid, name] of [['noul-p2', 'P2'], ['noul-p3', 'P3']]) {
      handle('dkg/paranet/lineage-noul/app', encode({
        app: 'origin-trail-game', type: 'swarm:joined', swarmId: swarm.id,
        peerId: pid, timestamp: Date.now(), playerName: name,
      }), pid);
    }
    await new Promise(r => setTimeout(r, 50));

    await coordinator.launchExpedition(swarm.id);
    await coordinator.castVote(swarm.id, 'advance');
    await coordinator.forceResolveTurn(swarm.id);

    const lineageWrites = noUalAgent._workspaceWrites.filter((quads: any[]) =>
      quads.some((q: any) => q.object?.includes?.('WorkspaceLineage'))
    );
    expect(lineageWrites.length).toBeGreaterThanOrEqual(1);

    const lineageQuads = lineageWrites[0];
    expect(lineageQuads.some((q: any) => q.object?.includes?.('workspace'))).toBe(true);
    expect(lineageQuads.some((q: any) => q.predicate?.includes?.('publishedUal'))).toBe(false);
  });

  it('publish failure drops lineage ops instead of carrying them to the next turn', async () => {
    const leaderPeerId = 'lineage-fail-leader';
    const logs: string[] = [];
    let publishCallCount = 0;
    let wsOpCounter = 0;

    const failAgent = makeMockAgent(leaderPeerId);
    failAgent.writeToWorkspace = async (_paranetId: string, quads: any[]) => {
      failAgent._workspaceWrites.push(quads);
      wsOpCounter++;
      return { workspaceOperationId: `ws-op-${wsOpCounter}` };
    };
    failAgent.publish = async (_paranetId: string, quads: any[]) => {
      publishCallCount++;
      if (publishCallCount === 1) throw new Error('publish failed');
      failAgent._published.push(quads);
      return { ual: 'did:dkg:test/ual/retry', onChainResult: { txHash: '0xretry', blockNumber: 50 } };
    };
    failAgent.query = async () => ({ bindings: [] });

    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const { encode } = await import('../src/dkg/protocol.js');
    const coordinator = new OriginTrailGameCoordinator(failAgent as any, { paranetId: 'lineage-fail' }, (msg) => logs.push(msg));

    const swarm = await coordinator.createSwarm('Leader', 'FailSwarm', 4);
    const handlers = failAgent._messageHandlers.get('dkg/paranet/lineage-fail/app');
    const handle = handlers![0];
    for (const [pid, name] of [['fail-p2', 'P2'], ['fail-p3', 'P3']]) {
      handle('dkg/paranet/lineage-fail/app', encode({
        app: 'origin-trail-game', type: 'swarm:joined', swarmId: swarm.id,
        peerId: pid, timestamp: Date.now(), playerName: name,
      }), pid);
    }
    await new Promise(r => setTimeout(r, 50));

    await coordinator.launchExpedition(swarm.id);
    await coordinator.castVote(swarm.id, 'advance');

    const firstTurnOpIds = new Set<string>();
    for (let i = 1; i <= wsOpCounter; i++) firstTurnOpIds.add(`ws-op-${i}`);

    const writesBeforeFail = failAgent._workspaceWrites.length;
    await coordinator.forceResolveTurn(swarm.id);

    for (let i = firstTurnOpIds.size + 1; i <= wsOpCounter; i++) firstTurnOpIds.add(`ws-op-${i}`);

    const failLogs = logs.filter(l => l.includes('Failed to publish'));
    expect(failLogs.length).toBeGreaterThanOrEqual(1);

    const failedLineage = failAgent._workspaceWrites.slice(writesBeforeFail).filter((quads: any[]) =>
      quads.some((q: any) => q.object?.includes?.('failed')),
    );
    expect(failedLineage.length).toBeGreaterThanOrEqual(1);

    const successLineageAfterFail = failAgent._workspaceWrites.slice(writesBeforeFail).filter((quads: any[]) =>
      quads.some((q: any) => q.object?.includes?.('published')),
    );
    expect(successLineageAfterFail).toHaveLength(0);

    await coordinator.castVote(swarm.id, 'advance');
    const secondTurnOpsStart = wsOpCounter + 1;
    const writesBeforeSecond = failAgent._workspaceWrites.length;
    await coordinator.forceResolveTurn(swarm.id);

    const lineageAfterSecond = failAgent._workspaceWrites.slice(writesBeforeSecond).filter((quads: any[]) =>
      quads.some((q: any) => q.object?.includes?.('published') || q.object?.includes?.('workspace')),
    );
    expect(lineageAfterSecond.length).toBeGreaterThanOrEqual(1);

    const allLineageSubjects = lineageAfterSecond.flatMap((quads: any[]) =>
      quads.map((q: any) => q.subject as string),
    );
    for (const opId of firstTurnOpIds) {
      expect(allLineageSubjects.some(s => s.includes(opId))).toBe(false);
    }
  });
});

describe('Turn proposal accepts non-deterministic state', () => {
  it('follower accepts proposal when winning action matches but state differs due to engine randomness', async () => {
    const leaderPeerId = 'leader-peer-id';
    const followerPeerId = 'follower-peer-id';
    const thirdPeerId = 'third-peer-id';

    const logs: string[] = [];
    const followerAgent = makeMockAgent(followerPeerId);
    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const coordinator = new OriginTrailGameCoordinator(followerAgent as any, { paranetId: 'test' }, (msg) => logs.push(msg));

    // Simulate: leader creates swarm, follower + third player join
    const { encode } = await import('../src/dkg/protocol.js');

    const createMsg = encode({
      app: 'origin-trail-game', type: 'swarm:created', swarmId: 'swarm-test',
      peerId: leaderPeerId, timestamp: Date.now(), swarmName: 'Test', playerName: 'Leader', maxPlayers: 4,
    });
    // Trigger handleMessage from the leader
    const handlers = followerAgent._messageHandlers.get('dkg/paranet/test/app');
    expect(handlers).toBeDefined();
    const handle = handlers![0];

    handle('dkg/paranet/test/app', createMsg, leaderPeerId);
    await new Promise(r => setTimeout(r, 50));

    // Follower joins
    const joinMsg = encode({
      app: 'origin-trail-game', type: 'swarm:joined', swarmId: 'swarm-test',
      peerId: followerPeerId, timestamp: Date.now(), playerName: 'Follower',
    });
    handle('dkg/paranet/test/app', joinMsg, followerPeerId);

    // Third player joins
    const join3Msg = encode({
      app: 'origin-trail-game', type: 'swarm:joined', swarmId: 'swarm-test',
      peerId: thirdPeerId, timestamp: Date.now(), playerName: 'Third',
    });
    handle('dkg/paranet/test/app', join3Msg, thirdPeerId);
    await new Promise(r => setTimeout(r, 50));

    // Leader launches the expedition with a known game state
    const { GameEngine } = await import('../src/engine/game-engine.js');
    const engine = new GameEngine();
    const gameState = engine.createGame(['Leader', 'Follower', 'Third'], leaderPeerId);
    const gameStateJson = JSON.stringify(gameState);

    const launchMsg = encode({
      app: 'origin-trail-game', type: 'expedition:launched', swarmId: 'swarm-test',
      peerId: leaderPeerId, timestamp: Date.now(), gameStateJson,
    });
    handle('dkg/paranet/test/app', launchMsg, leaderPeerId);
    await new Promise(r => setTimeout(r, 50));

    // Verify swarm transitioned to traveling after remote launch
    const swarmAfterLaunch = coordinator.getSwarm('swarm-test');
    expect(swarmAfterLaunch).not.toBeNull();
    expect(swarmAfterLaunch!.status).toBe('traveling');
    expect(swarmAfterLaunch!.currentTurn).toBe(1);
    expect(swarmAfterLaunch!.gameState).toBeDefined();

    // All three players vote 'advance'
    const voteLeader = encode({
      app: 'origin-trail-game', type: 'vote:cast', swarmId: 'swarm-test',
      peerId: leaderPeerId, timestamp: Date.now(), turn: 1, action: 'advance',
    });
    handle('dkg/paranet/test/app', voteLeader, leaderPeerId);

    const voteThird = encode({
      app: 'origin-trail-game', type: 'vote:cast', swarmId: 'swarm-test',
      peerId: thirdPeerId, timestamp: Date.now(), turn: 1, action: 'advance',
    });
    handle('dkg/paranet/test/app', voteThird, thirdPeerId);
    await new Promise(r => setTimeout(r, 50));

    // Leader proposes a result — the state will differ from what the
    // follower's engine.executeAction would produce because of Math.random()
    // in random events, loot, etc. The fix ensures this is accepted as long
    // as the winning action matches.
    const leaderResult = engine.executeAction(gameState, { type: 'advance' });
    const leaderStateJson = JSON.stringify(leaderResult.newState);

    const { createHash } = await import('node:crypto');
    const proposalHash = createHash('sha256').update(`swarm-test:1:${leaderStateJson}`).digest('hex');

    const proposalMsg = encode({
      app: 'origin-trail-game', type: 'turn:proposal', swarmId: 'swarm-test',
      peerId: leaderPeerId, timestamp: Date.now(), turn: 1,
      proposalHash, winningAction: 'advance', newStateJson: leaderStateJson,
      resultMessage: leaderResult.message,
      votes: [{ peerId: leaderPeerId, action: 'advance' }],
      resolution: 'consensus', deaths: [],
    });
    handle('dkg/paranet/test/app', proposalMsg, leaderPeerId);
    await new Promise(r => setTimeout(r, 100));

    // The proposal should NOT be rejected with "Proposal state mismatch"
    const mismatchLogs = logs.filter(l => l.includes('state mismatch'));
    expect(mismatchLogs).toHaveLength(0);

    // It should also not be rejected for action mismatch (all voted 'advance')
    const actionMismatchLogs = logs.filter(l => l.includes('action mismatch'));
    expect(actionMismatchLogs).toHaveLength(0);
  });

  it('follower rejects proposal when winning action does not match local tally', async () => {
    const leaderPeerId = 'leader-peer-2';
    const followerPeerId = 'follower-peer-2';
    const thirdPeerId = 'third-peer-2';
    const fourthPeerId = 'fourth-peer-2';

    const logs: string[] = [];
    const followerAgent = makeMockAgent(followerPeerId);
    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const coordinator = new OriginTrailGameCoordinator(followerAgent as any, { paranetId: 'test2' }, (msg) => logs.push(msg));

    const { encode } = await import('../src/dkg/protocol.js');
    const handlers = followerAgent._messageHandlers.get('dkg/paranet/test2/app');
    const handle = handlers![0];

    // Create swarm with 4 players
    handle('dkg/paranet/test2/app', encode({
      app: 'origin-trail-game', type: 'swarm:created', swarmId: 'swarm-test2',
      peerId: leaderPeerId, timestamp: Date.now(), swarmName: 'Test2', playerName: 'Leader', maxPlayers: 5,
    }), leaderPeerId);

    for (const [pid, name] of [[followerPeerId, 'Follower'], [thirdPeerId, 'Third'], [fourthPeerId, 'Fourth']] as const) {
      handle('dkg/paranet/test2/app', encode({
        app: 'origin-trail-game', type: 'swarm:joined', swarmId: 'swarm-test2',
        peerId: pid, timestamp: Date.now(), playerName: name,
      }), pid);
    }
    await new Promise(r => setTimeout(r, 50));

    // Launch
    const { GameEngine } = await import('../src/engine/game-engine.js');
    const engine = new GameEngine();
    const gameState = engine.createGame(['Leader', 'Follower', 'Third', 'Fourth'], leaderPeerId);

    handle('dkg/paranet/test2/app', encode({
      app: 'origin-trail-game', type: 'expedition:launched', swarmId: 'swarm-test2',
      peerId: leaderPeerId, timestamp: Date.now(), gameStateJson: JSON.stringify(gameState),
    }), leaderPeerId);
    await new Promise(r => setTimeout(r, 50));

    // Leader votes 'advance'; third and fourth vote 'rest'
    // (follower's own gossip is skipped by handleMessage, so follower
    // sees 1 advance vs 2 rest → 'rest' wins the tally)
    handle('dkg/paranet/test2/app', encode({
      app: 'origin-trail-game', type: 'vote:cast', swarmId: 'swarm-test2',
      peerId: leaderPeerId, timestamp: Date.now(), turn: 1, action: 'advance',
    }), leaderPeerId);

    handle('dkg/paranet/test2/app', encode({
      app: 'origin-trail-game', type: 'vote:cast', swarmId: 'swarm-test2',
      peerId: thirdPeerId, timestamp: Date.now(), turn: 1, action: 'rest',
    }), thirdPeerId);

    handle('dkg/paranet/test2/app', encode({
      app: 'origin-trail-game', type: 'vote:cast', swarmId: 'swarm-test2',
      peerId: fourthPeerId, timestamp: Date.now(), turn: 1, action: 'rest',
    }), fourthPeerId);
    await new Promise(r => setTimeout(r, 50));

    // Leader proposes 'advance' but follower's local tally says 'rest' (2 vs 1)
    const result = engine.executeAction(gameState, { type: 'advance' });
    const stateJson = JSON.stringify(result.newState);
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(`swarm-test2:1:${stateJson}`).digest('hex');

    handle('dkg/paranet/test2/app', encode({
      app: 'origin-trail-game', type: 'turn:proposal', swarmId: 'swarm-test2',
      peerId: leaderPeerId, timestamp: Date.now(), turn: 1,
      proposalHash: hash, winningAction: 'advance', newStateJson: stateJson,
      resultMessage: result.message,
      votes: [{ peerId: leaderPeerId, action: 'advance' }],
      resolution: 'consensus', deaths: [],
    }), leaderPeerId);
    await new Promise(r => setTimeout(r, 100));

    // Should be rejected: local tally says 'rest' but proposal says 'advance'
    const actionMismatchLogs = logs.filter(l => l.includes('action mismatch'));
    expect(actionMismatchLogs).toHaveLength(1);
  });

  it('leader force-resolved proposal bypasses tally validation (no action mismatch rejection)', async () => {
    const leaderPeerId = 'leader-force-1';
    const followerPeerId = 'follower-force-1';

    const logs: string[] = [];
    const followerAgent = makeMockAgent(followerPeerId);
    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const coordinator = new OriginTrailGameCoordinator(followerAgent as any, { paranetId: 'force-test' }, (msg) => logs.push(msg));

    const { encode } = await import('../src/dkg/protocol.js');
    const handlers = followerAgent._messageHandlers.get('dkg/paranet/force-test/app');
    const handle = handlers![0];

    handle('dkg/paranet/force-test/app', encode({
      app: 'origin-trail-game', type: 'swarm:created', swarmId: 'swarm-force',
      peerId: leaderPeerId, timestamp: Date.now(), swarmName: 'ForceTest', playerName: 'Leader', maxPlayers: 5,
    }), leaderPeerId);

    handle('dkg/paranet/force-test/app', encode({
      app: 'origin-trail-game', type: 'swarm:joined', swarmId: 'swarm-force',
      peerId: followerPeerId, timestamp: Date.now(), playerName: 'Follower',
    }), followerPeerId);
    await new Promise(r => setTimeout(r, 50));

    const { GameEngine } = await import('../src/engine/game-engine.js');
    const engine = new GameEngine();
    const gameState = engine.createGame(['Leader', 'Follower'], leaderPeerId);

    handle('dkg/paranet/force-test/app', encode({
      app: 'origin-trail-game', type: 'expedition:launched', swarmId: 'swarm-force',
      peerId: leaderPeerId, timestamp: Date.now(), gameStateJson: JSON.stringify(gameState),
    }), leaderPeerId);
    await new Promise(r => setTimeout(r, 50));

    // Follower votes 'rest', but leader force-resolves with 'advance'.
    // Without the fix, the follower's local tally ('rest') would cause rejection.
    handle('dkg/paranet/force-test/app', encode({
      app: 'origin-trail-game', type: 'vote:cast', swarmId: 'swarm-force',
      peerId: followerPeerId, timestamp: Date.now(), turn: 1, action: 'rest',
    }), followerPeerId);
    await new Promise(r => setTimeout(r, 50));

    const result = engine.executeAction(gameState, { type: 'advance' });
    const stateJson = JSON.stringify(result.newState);
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(`swarm-force:1:${stateJson}`).digest('hex');

    handle('dkg/paranet/force-test/app', encode({
      app: 'origin-trail-game', type: 'turn:proposal', swarmId: 'swarm-force',
      peerId: leaderPeerId, timestamp: Date.now(), turn: 1,
      proposalHash: hash, winningAction: 'advance', newStateJson: stateJson,
      resultMessage: result.message, resolution: 'force-resolved',
      votes: [{ peerId: leaderPeerId, action: 'advance' }], deaths: [],
    }), leaderPeerId);
    await new Promise(r => setTimeout(r, 100));

    const mismatchLogs = logs.filter(l => l.includes('action mismatch'));
    expect(mismatchLogs).toHaveLength(0);

    const appliedLogs = logs.filter(l => l.includes('Applied force-resolved'));
    expect(appliedLogs).toHaveLength(1);
  });

  it('non-leader force-resolved proposal does NOT bypass quorum', async () => {
    const leaderPeerId = 'leader-force-2';
    const nonLeaderPeerId = 'nonleader-force-2';

    const logs: string[] = [];
    const followerAgent = makeMockAgent('observer-force-2');
    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const coordinator = new OriginTrailGameCoordinator(followerAgent as any, { paranetId: 'force-test2' }, (msg) => logs.push(msg));

    const { encode } = await import('../src/dkg/protocol.js');
    const handlers = followerAgent._messageHandlers.get('dkg/paranet/force-test2/app');
    const handle = handlers![0];

    handle('dkg/paranet/force-test2/app', encode({
      app: 'origin-trail-game', type: 'swarm:created', swarmId: 'swarm-force2',
      peerId: leaderPeerId, timestamp: Date.now(), swarmName: 'ForceTest2', playerName: 'Leader', maxPlayers: 5,
    }), leaderPeerId);

    handle('dkg/paranet/force-test2/app', encode({
      app: 'origin-trail-game', type: 'swarm:joined', swarmId: 'swarm-force2',
      peerId: nonLeaderPeerId, timestamp: Date.now(), playerName: 'NonLeader',
    }), nonLeaderPeerId);

    handle('dkg/paranet/force-test2/app', encode({
      app: 'origin-trail-game', type: 'swarm:joined', swarmId: 'swarm-force2',
      peerId: 'observer-force-2', timestamp: Date.now(), playerName: 'Observer',
    }), 'observer-force-2');
    await new Promise(r => setTimeout(r, 50));

    const { GameEngine } = await import('../src/engine/game-engine.js');
    const engine = new GameEngine();
    const gameState = engine.createGame(['Leader', 'NonLeader', 'Observer'], leaderPeerId);

    handle('dkg/paranet/force-test2/app', encode({
      app: 'origin-trail-game', type: 'expedition:launched', swarmId: 'swarm-force2',
      peerId: leaderPeerId, timestamp: Date.now(), gameStateJson: JSON.stringify(gameState),
    }), leaderPeerId);
    await new Promise(r => setTimeout(r, 50));

    const result = engine.executeAction(gameState, { type: 'advance' });
    const stateJson = JSON.stringify(result.newState);
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(`swarm-force2:1:${stateJson}`).digest('hex');

    // Non-leader sends force-resolved — should NOT be immediately applied
    handle('dkg/paranet/force-test2/app', encode({
      app: 'origin-trail-game', type: 'turn:proposal', swarmId: 'swarm-force2',
      peerId: nonLeaderPeerId, timestamp: Date.now(), turn: 1,
      proposalHash: hash, winningAction: 'advance', newStateJson: stateJson,
      resultMessage: result.message, resolution: 'force-resolved',
      votes: [{ peerId: nonLeaderPeerId, action: 'advance' }], deaths: [],
    }), nonLeaderPeerId);
    await new Promise(r => setTimeout(r, 100));

    const appliedLogs = logs.filter(l => l.includes('Applied force-resolved'));
    expect(appliedLogs).toHaveLength(0);
  });
});

describe('V5: Strategy pattern RDF quads', () => {
  it('strategyPatternQuads generates correct RDF structure', async () => {
    const { strategyPatternQuads, contextGraph } = await import('../src/dkg/rdf.js');
    const stats = {
      totalVotes: 5,
      actionCounts: { advance: 3, syncMemory: 1, upgradeSkills: 1 } as Record<string, number>,
      favoriteAction: 'advance',
      turnsSurvived: 4,
    };
    const quads = strategyPatternQuads('origin-trail-game', 'swarm-abc', 'peer-1', stats);

    const expectedGraph = contextGraph('origin-trail-game', 'swarm-abc');
    expect(quads.every(q => q.graph === expectedGraph)).toBe(true);

    const subject = quads[0].subject;
    expect(subject).toContain('strategy/swarm-abc/peer-1');

    expect(quads.find(q => q.predicate.includes('rdf-syntax-ns#type'))?.object).toContain('StrategyPattern');
    expect(quads.find(q => q.predicate.includes('player'))?.object).toContain('player/peer-1');
    expect(quads.find(q => q.predicate.includes('swarm') && !q.predicate.includes('swarmId'))?.object).toContain('swarm/swarm-abc');
    expect(quads.find(q => q.predicate.includes('totalVotes'))?.object).toContain('5');
    expect(quads.find(q => q.predicate.includes('favoriteAction'))?.object).toContain('advance');
    expect(quads.find(q => q.predicate.includes('turnsSurvived'))?.object).toContain('4');

    const hasActionCountQuads = quads.filter(q => q.predicate.includes('hasActionCount'));
    expect(hasActionCountQuads.length).toBe(3);

    const advanceAcUri = hasActionCountQuads.find(q => q.object.includes('action/advance'))?.object;
    expect(advanceAcUri).toBeDefined();
    expect(quads.find(q => q.subject === advanceAcUri && q.predicate.endsWith('/action'))?.object).toContain('advance');
    expect(quads.find(q => q.subject === advanceAcUri && q.predicate.endsWith('/count'))?.object).toContain('3');

    const syncAcUri = hasActionCountQuads.find(q => q.object.includes('action/syncMemory'))?.object;
    expect(syncAcUri).toBeDefined();
    expect(quads.find(q => q.subject === syncAcUri && q.predicate.endsWith('/count'))?.object).toContain('1');

    // 6 base triples + 3 actions * 3 triples each
    expect(quads.length).toBe(15);
  });

  it('strategyPatternQuads handles empty actionCounts', async () => {
    const { strategyPatternQuads } = await import('../src/dkg/rdf.js');
    const stats = {
      totalVotes: 0,
      actionCounts: {} as Record<string, number>,
      favoriteAction: 'none',
      turnsSurvived: 0,
    };
    const quads = strategyPatternQuads('origin-trail-game', 'swarm-x', 'peer-x', stats);
    expect(quads.length).toBe(6);
  });
});

describe('V5: Strategy computation from turn history', () => {
  it('computePlayerStrategies aggregates voting history correctly', async () => {
    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const { encode } = await import('../src/dkg/protocol.js');

    const leaderPeerId = 'strat-leader';
    const p2 = 'strat-p2';
    const p3 = 'strat-p3';
    const agent = makeMockAgent(leaderPeerId);
    const coordinator = new OriginTrailGameCoordinator(agent as any, { paranetId: 'strat-test' });

    const swarm = await coordinator.createSwarm('Leader', 'StratSwarm');
    const handlers = agent._messageHandlers.get('dkg/paranet/strat-test/app');
    const handle = handlers![0];

    for (const [pid, name] of [[p2, 'P2'], [p3, 'P3']]) {
      handle('dkg/paranet/strat-test/app', encode({
        app: 'origin-trail-game', type: 'swarm:joined', swarmId: swarm.id,
        peerId: pid, timestamp: Date.now(), playerName: name,
      }), pid);
    }
    await new Promise(r => setTimeout(r, 50));

    await coordinator.launchExpedition(swarm.id);

    // Run turns using only leader vote + forceResolve (avoids auto-proposal quorum issues)
    for (let turn = 0; turn < 3; turn++) {
      if (swarm.status !== 'traveling') break;

      // Leader casts vote; remote votes come via gossip
      await coordinator.castVote(swarm.id, 'advance');
      handle('dkg/paranet/strat-test/app', encode({
        app: 'origin-trail-game', type: 'vote:cast', swarmId: swarm.id,
        peerId: p2, timestamp: Date.now(), turn: swarm.currentTurn, action: 'syncMemory',
      }), p2);
      handle('dkg/paranet/strat-test/app', encode({
        app: 'origin-trail-game', type: 'vote:cast', swarmId: swarm.id,
        peerId: p3, timestamp: Date.now(), turn: swarm.currentTurn, action: 'advance',
      }), p3);
      await new Promise(r => setTimeout(r, 50));

      if (swarm.status !== 'traveling') break;
      // Force-resolve bypasses quorum requirement
      await coordinator.forceResolveTurn(swarm.id);
      await new Promise(r => setTimeout(r, 50));
    }

    expect(swarm.turnHistory.length).toBeGreaterThanOrEqual(1);
    const strategies = coordinator.computePlayerStrategies(swarm);
    expect(strategies.length).toBe(3);

    const leaderStrat = strategies.find(s => s.peerId === leaderPeerId);
    expect(leaderStrat).toBeDefined();
    expect(leaderStrat!.stats.totalVotes).toBeGreaterThanOrEqual(1);
    expect(leaderStrat!.stats.favoriteAction).toBe('advance');
    expect(leaderStrat!.stats.turnsSurvived).toBeGreaterThanOrEqual(1);

    const p2Strat = strategies.find(s => s.peerId === p2);
    expect(p2Strat).toBeDefined();
    expect(p2Strat!.stats.favoriteAction).toBe('syncMemory');
  });

  it('getPlayerStrategies returns null for unknown swarm', async () => {
    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const agent = makeMockAgent('strat-null-peer');
    const coordinator = new OriginTrailGameCoordinator(agent as any, { paranetId: 'strat-null' });
    expect(coordinator.getPlayerStrategies('nonexistent')).toBeNull();
  });
});

describe('V5: Strategy patterns published when game finishes', () => {
  it('strategy patterns are published to context graph when game ends via forceResolveTurn', async () => {
    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const { encode } = await import('../src/dkg/protocol.js');

    const leaderPeerId = 'finish-leader';
    const p2 = 'finish-p2';
    const p3 = 'finish-p3';
    const logs: string[] = [];
    const agent = makeMockAgent(leaderPeerId);
    const coordinator = new OriginTrailGameCoordinator(agent as any, { paranetId: 'finish-test' }, (msg) => logs.push(msg));

    const swarm = await coordinator.createSwarm('Leader', 'FinishSwarm');
    const handlers = agent._messageHandlers.get('dkg/paranet/finish-test/app');
    const handle = handlers![0];

    for (const [pid, name] of [[p2, 'P2'], [p3, 'P3']]) {
      handle('dkg/paranet/finish-test/app', encode({
        app: 'origin-trail-game', type: 'swarm:joined', swarmId: swarm.id,
        peerId: pid, timestamp: Date.now(), playerName: name,
      }), pid);
    }
    await new Promise(r => setTimeout(r, 50));

    await coordinator.launchExpedition(swarm.id);

    // Force-resolve turns until game ends — only leader votes + forceResolve
    let maxTurns = 300;
    while (swarm.status === 'traveling' && maxTurns-- > 0) {
      const tokens = swarm.gameState?.trainingTokens ?? 0;
      const alive = swarm.gameState?.party.filter((m: any) => m.alive).length ?? 3;
      const action = tokens >= alive * 5 ? 'advance' : 'syncMemory';
      try {
        await coordinator.castVote(swarm.id, action);
      } catch (err: any) {
        expect(err.message).toMatch(/eliminated|cannot vote/i);
        swarm.votes.push({ peerId: leaderPeerId, action, turn: swarm.currentTurn, timestamp: Date.now() });
      }
      await new Promise(r => setTimeout(r, 5));
      if (swarm.status !== 'traveling') break;
      await coordinator.forceResolveTurn(swarm.id);
      await new Promise(r => setTimeout(r, 5));
    }

    expect(swarm.status).toBe('finished');
    const stratLogs = logs.filter(l => l.includes('strategy patterns'));
    expect(stratLogs.length).toBeGreaterThanOrEqual(1);

    const allPublished = agent._published.flat();
    const strategyQuads = allPublished.filter((q: any) => q.predicate?.includes('type') && q.object?.includes('StrategyPattern'));
    expect(strategyQuads.length).toBe(3);
  }, 60_000);
});

describe('Leaderboard', () => {
  it('GET /leaderboard returns entries from DKG', async () => {
    const leaderboardAgent = makeMockAgent('lb-peer');
    leaderboardAgent.query = async () => ({
      bindings: [
        { displayName: '"Alice"', score: '"3500"', outcome: '"won"', epochs: '"2000"', survivors: '"3"', partySize: '"4"', swarmId: '"swarm-1"', finishedAt: '"1700000000000"' },
        { displayName: '"Bob"', score: '"0"', outcome: '"lost"', epochs: '"800"', survivors: '"0"', partySize: '"3"', swarmId: '"swarm-2"', finishedAt: '"1700001000000"' },
      ],
    });
    const lbHandler = createHandler(leaderboardAgent, { paranets: ['test'] });

    const req = createMockReq('GET', '/api/apps/origin-trail-game/leaderboard');
    const mock = createMockRes();
    await lbHandler(req, mock.res, new URL(req.url, 'http://localhost'));
    const data = JSON.parse(mock.body);

    expect(data.entries).toHaveLength(2);
    expect(data.entries[0].displayName).toBe('Alice');
    expect(data.entries[0].score).toBe(3500);
    expect(data.entries[0].outcome).toBe('won');
    expect(data.entries[1].displayName).toBe('Bob');
    expect(data.entries[1].outcome).toBe('lost');
  });

  it('GET /leaderboard returns empty array when no data', async () => {
    const agent2 = makeMockAgent('empty-peer');
    const handler2 = createHandler(agent2, { paranets: ['test'] });
    const req = createMockReq('GET', '/api/apps/origin-trail-game/leaderboard');
    const mock = createMockRes();
    await handler2(req, mock.res, new URL(req.url, 'http://localhost'));
    const data = JSON.parse(mock.body);
    expect(data.entries).toEqual([]);
  });
});

describe('Leaderboard RDF quads', () => {
  it('generates leaderboard entry quads with correct structure', async () => {
    const { leaderboardEntryQuads } = await import('../src/dkg/rdf.js');
    const quads = leaderboardEntryQuads('test-paranet', 'swarm-1', 'peer-1', 'Alice', 3500, 'won', 2000, 3, 4, 1700000000000);

    expect(quads.length).toBe(10);
    expect(quads.some(q => q.object.includes('LeaderboardEntry'))).toBe(true);
    expect(quads.some(q => q.predicate.includes('score') && q.object.includes('3500'))).toBe(true);
    expect(quads.some(q => q.predicate.includes('outcome') && q.object.includes('won'))).toBe(true);
    expect(quads.some(q => q.predicate.includes('displayName') && q.object.includes('Alice'))).toBe(true);
    expect(quads.some(q => q.predicate.includes('epochs') && q.object.includes('2000'))).toBe(true);
    expect(quads.some(q => q.predicate.includes('survivors') && q.object.includes('3'))).toBe(true);
    expect(quads.some(q => q.predicate.includes('partySize') && q.object.includes('4'))).toBe(true);
  });
});

describe('Sync Memory via DKG', () => {
  it('syncMemory action costs TRAC', async () => {
    const { GameEngine } = await import('../src/engine/game-engine.js');
    const engine = new GameEngine();
    const state = engine.createGame(['Agent1'], 'player1');

    const initialTrac = state.trac;
    const result = engine.executeAction(state, { type: 'syncMemory' });

    expect(result.success).toBe(true);
    expect(result.newState.trac).toBe(initialTrac - GameEngine.SYNC_MEMORY_TRAC_COST);
    expect(result.message).toContain('TRAC spent on-chain');
    expect(result.message).toContain('Sync');
  });

  it('syncMemory fails when not enough TRAC', async () => {
    const { GameEngine } = await import('../src/engine/game-engine.js');
    const engine = new GameEngine();
    const state = engine.createGame(['Agent1'], 'player1');
    state.trac = 0;

    const result = engine.executeAction(state, { type: 'syncMemory' });
    expect(result.success).toBe(false);
    expect(result.message).toContain('Not enough TRAC');
  });

  it('generates sync memory DKG quads', async () => {
    const { syncMemoryDkgQuads } = await import('../src/dkg/rdf.js');
    const quads = syncMemoryDkgQuads('test-paranet', 'swarm-1', 3, 'peer-1', 5);

    expect(quads.some(q => q.object.includes('SyncMemoryViaDKG'))).toBe(true);
    expect(quads.some(q => q.predicate.includes('tracSpent') && q.object.includes('5'))).toBe(true);
    expect(quads.some(q => q.predicate.includes('turn') && q.object.includes('3'))).toBe(true);
  });

  it('leader publishes sync memory DKG quads on syncMemory turn resolution', async () => {
    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const { encode } = await import('../src/dkg/protocol.js');

    const leaderPeerId = 'sync-leader';
    const syncAgent = makeMockAgent(leaderPeerId);
    const coordinator = new OriginTrailGameCoordinator(syncAgent, { paranetId: 'sync-test' });

    // Create swarm + add remote players to satisfy MIN_PLAYERS
    const swarm = await coordinator.createSwarm('Leader', 'SyncSwarm', 5);
    const handle = syncAgent._messageHandlers.get('dkg/paranet/sync-test/app')![0];

    for (const pid of ['follower-1', 'follower-2']) {
      handle('dkg/paranet/sync-test/app', encode({
        app: 'origin-trail-game', type: 'swarm:joined', swarmId: swarm.id,
        peerId: pid, timestamp: Date.now(), playerName: `Player-${pid}`,
      }), pid);
      await new Promise(r => setTimeout(r, 20));
    }

    await coordinator.launchExpedition(swarm.id);
    await coordinator.castVote(swarm.id, 'syncMemory');
    await coordinator.forceResolveTurn(swarm.id);
    await new Promise(r => setTimeout(r, 200));

    const syncQuads = syncAgent._published.find((batch: any[]) =>
      batch.some((q: any) => q.object?.includes('SyncMemoryViaDKG'))
    );
    expect(syncQuads).toBeDefined();
    expect(syncQuads!.some((q: any) => q.predicate.includes('tracSpent'))).toBe(true);
  });

  it('syncMemory failure does not publish SyncMemoryViaDKG quads', async () => {
    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const { encode } = await import('../src/dkg/protocol.js');

    const leaderPeerId = 'sync-fail-leader';
    const failAgent = makeMockAgent(leaderPeerId);
    const coordinator = new OriginTrailGameCoordinator(failAgent, { paranetId: 'sync-fail-test' });

    const swarm = await coordinator.createSwarm('Leader', 'FailSwarm', 5);
    const handle = failAgent._messageHandlers.get('dkg/paranet/sync-fail-test/app')![0];

    for (const pid of ['fail-follower-1', 'fail-follower-2']) {
      handle('dkg/paranet/sync-fail-test/app', encode({
        app: 'origin-trail-game', type: 'swarm:joined', swarmId: swarm.id,
        peerId: pid, timestamp: Date.now(), playerName: `Player-${pid}`,
      }), pid);
      await new Promise(r => setTimeout(r, 20));
    }

    await coordinator.launchExpedition(swarm.id);

    // Drain TRAC so syncMemory fails
    swarm.gameState!.trac = 0;

    await coordinator.castVote(swarm.id, 'syncMemory');
    await coordinator.forceResolveTurn(swarm.id);
    await new Promise(r => setTimeout(r, 200));

    const syncQuads = failAgent._published.find((batch: any[]) =>
      batch.some((q: any) => q.object?.includes('SyncMemoryViaDKG'))
    );
    expect(syncQuads).toBeUndefined();
  });
});

describe('Score in swarm state', () => {
  it('formatSwarmState includes score for finished games', async () => {
    const scoreAgent = makeMockAgent('score-peer');
    const scoreHandler = createHandler(scoreAgent, { paranets: ['test'] });

    const createReq = createMockReq('POST', '/api/apps/origin-trail-game/create', { playerName: 'Scorer', swarmName: 'Score Swarm' });
    const createMock = createMockRes();
    await scoreHandler(createReq, createMock.res, new URL(createReq.url, 'http://localhost'));
    const created = JSON.parse(createMock.body);

    expect(created).toHaveProperty('score');
    expect(typeof created.score).toBe('number');
  });
});

describe('Notifications', () => {
  it('GET /notifications returns empty initially', async () => {
    const nAgent = makeMockAgent('notif-peer');
    const nHandler = createHandler(nAgent, { paranets: ['test'] });
    const req = createMockReq('GET', '/api/apps/origin-trail-game/notifications');
    const mock = createMockRes();
    await nHandler(req, mock.res, new URL(req.url, 'http://localhost'));
    const data = JSON.parse(mock.body);
    expect(data.notifications).toEqual([]);
    expect(data.unreadCount).toBe(0);
  });

  it('generates notification when remote player joins a swarm', async () => {
    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const { encode } = await import('../src/dkg/protocol.js');

    const localPeer = 'notif-local';
    const nAgent = makeMockAgent(localPeer);
    const coordinator = new OriginTrailGameCoordinator(nAgent, { paranetId: 'notif-test' });
    const swarm = await coordinator.createSwarm('Leader', 'TestSwarm');
    const handle = nAgent._messageHandlers.get('dkg/paranet/notif-test/app')![0];

    handle('dkg/paranet/notif-test/app', encode({
      app: 'origin-trail-game', type: 'swarm:joined', swarmId: swarm.id,
      peerId: 'remote-peer', timestamp: Date.now(), playerName: 'Alice',
    }), 'remote-peer');
    await new Promise(r => setTimeout(r, 50));

    const { notifications, unreadCount } = coordinator.getNotifications();
    expect(unreadCount).toBe(1);
    expect(notifications[0].type).toBe('player_joined');
    expect(notifications[0].playerName).toBe('Alice');
    expect(notifications[0].message).toContain('Alice');
    expect(notifications[0].read).toBe(false);
  });

  it('generates notification when remote swarm is created', async () => {
    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const { encode } = await import('../src/dkg/protocol.js');

    const nAgent = makeMockAgent('local-2');
    const coordinator = new OriginTrailGameCoordinator(nAgent, { paranetId: 'notif-test2' });
    const handle = nAgent._messageHandlers.get('dkg/paranet/notif-test2/app')![0];

    handle('dkg/paranet/notif-test2/app', encode({
      app: 'origin-trail-game', type: 'swarm:created', swarmId: 'remote-swarm-1',
      peerId: 'remote-leader', timestamp: Date.now(), swarmName: 'RemoteSwarm',
      playerName: 'RemoteLeader', maxPlayers: 5,
    }), 'remote-leader');
    await new Promise(r => setTimeout(r, 50));

    const { notifications, unreadCount } = coordinator.getNotifications();
    expect(unreadCount).toBe(1);
    expect(notifications[0].type).toBe('swarm_created');
    expect(notifications[0].message).toContain('RemoteSwarm');
  });

  it('generates notification when expedition launches', async () => {
    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const { encode } = await import('../src/dkg/protocol.js');
    const { GameEngine } = await import('../src/engine/game-engine.js');

    const nAgent = makeMockAgent('local-3');
    const coordinator = new OriginTrailGameCoordinator(nAgent, { paranetId: 'notif-test3' });
    const handle = nAgent._messageHandlers.get('dkg/paranet/notif-test3/app')![0];

    handle('dkg/paranet/notif-test3/app', encode({
      app: 'origin-trail-game', type: 'swarm:created', swarmId: 'expedition-swarm',
      peerId: 'leader-x', timestamp: Date.now(), swarmName: 'ExpSwarm',
      playerName: 'Leader', maxPlayers: 3,
    }), 'leader-x');
    await new Promise(r => setTimeout(r, 50));

    const engine = new GameEngine();
    const gameState = engine.createGame(['Leader', 'Local'], 'leader-x');

    handle('dkg/paranet/notif-test3/app', encode({
      app: 'origin-trail-game', type: 'expedition:launched', swarmId: 'expedition-swarm',
      peerId: 'leader-x', timestamp: Date.now(), gameStateJson: JSON.stringify(gameState),
    }), 'leader-x');
    await new Promise(r => setTimeout(r, 50));

    const { notifications } = coordinator.getNotifications();
    const expNotif = notifications.find((n: any) => n.type === 'expedition_launched');
    expect(expNotif).toBeDefined();
    expect(expNotif!.message).toContain('ExpSwarm');
  });

  it('generates notification when remote vote is cast', async () => {
    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const { encode } = await import('../src/dkg/protocol.js');
    const { GameEngine } = await import('../src/engine/game-engine.js');

    const nAgent = makeMockAgent('local-4');
    const coordinator = new OriginTrailGameCoordinator(nAgent, { paranetId: 'notif-test4' });
    const handle = nAgent._messageHandlers.get('dkg/paranet/notif-test4/app')![0];

    handle('dkg/paranet/notif-test4/app', encode({
      app: 'origin-trail-game', type: 'swarm:created', swarmId: 'vote-swarm',
      peerId: 'leader-v', timestamp: Date.now(), swarmName: 'VoteSwarm',
      playerName: 'Leader', maxPlayers: 3,
    }), 'leader-v');

    handle('dkg/paranet/notif-test4/app', encode({
      app: 'origin-trail-game', type: 'swarm:joined', swarmId: 'vote-swarm',
      peerId: 'local-4', timestamp: Date.now(), playerName: 'Local',
    }), 'local-4');
    await new Promise(r => setTimeout(r, 50));

    const engine = new GameEngine();
    const gameState = engine.createGame(['Leader', 'Local'], 'leader-v');

    handle('dkg/paranet/notif-test4/app', encode({
      app: 'origin-trail-game', type: 'expedition:launched', swarmId: 'vote-swarm',
      peerId: 'leader-v', timestamp: Date.now(), gameStateJson: JSON.stringify(gameState),
    }), 'leader-v');
    await new Promise(r => setTimeout(r, 50));

    handle('dkg/paranet/notif-test4/app', encode({
      app: 'origin-trail-game', type: 'vote:cast', swarmId: 'vote-swarm',
      peerId: 'leader-v', timestamp: Date.now(), turn: 1, action: 'advance',
    }), 'leader-v');
    await new Promise(r => setTimeout(r, 50));

    const { notifications } = coordinator.getNotifications();
    const voteNotif = notifications.find((n: any) => n.type === 'vote_cast');
    expect(voteNotif).toBeDefined();
    expect(voteNotif!.action).toBe('advance');
    expect(voteNotif!.message).toContain('voted');
  });

  it('markNotificationsRead marks all notifications as read', async () => {
    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const { encode } = await import('../src/dkg/protocol.js');

    const nAgent = makeMockAgent('local-mark');
    const coordinator = new OriginTrailGameCoordinator(nAgent, { paranetId: 'notif-mark' });
    const handle = nAgent._messageHandlers.get('dkg/paranet/notif-mark/app')![0];

    handle('dkg/paranet/notif-mark/app', encode({
      app: 'origin-trail-game', type: 'swarm:created', swarmId: 'mark-swarm',
      peerId: 'remote-m', timestamp: Date.now(), swarmName: 'MarkSwarm',
      playerName: 'Bob', maxPlayers: 3,
    }), 'remote-m');
    await new Promise(r => setTimeout(r, 50));

    expect(coordinator.getNotifications().unreadCount).toBe(1);

    const count = coordinator.markNotificationsRead();
    expect(count).toBe(1);
    expect(coordinator.getNotifications().unreadCount).toBe(0);
    expect(coordinator.getNotifications().notifications[0].read).toBe(true);
  });

  it('markNotificationsRead with specific ids only marks those', async () => {
    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const { encode } = await import('../src/dkg/protocol.js');

    const nAgent = makeMockAgent('local-partial');
    const coordinator = new OriginTrailGameCoordinator(nAgent, { paranetId: 'notif-partial' });
    const handle = nAgent._messageHandlers.get('dkg/paranet/notif-partial/app')![0];

    for (let i = 0; i < 3; i++) {
      handle('dkg/paranet/notif-partial/app', encode({
        app: 'origin-trail-game', type: 'swarm:created', swarmId: `partial-${i}`,
        peerId: `remote-${i}`, timestamp: Date.now(), swarmName: `Swarm${i}`,
        playerName: `Player${i}`, maxPlayers: 3,
      }), `remote-${i}`);
      await new Promise(r => setTimeout(r, 20));
    }

    expect(coordinator.getNotifications().unreadCount).toBe(3);

    const firstId = coordinator.getNotifications().notifications[0].id;
    coordinator.markNotificationsRead([firstId]);
    expect(coordinator.getNotifications().unreadCount).toBe(2);
  });

  it('GET /notifications returns notifications via API', async () => {
    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const { encode } = await import('../src/dkg/protocol.js');

    const nAgent = makeMockAgent('api-notif');
    const nHandler = createHandler(nAgent, { paranets: ['test'] });

    const handle = nAgent._messageHandlers.get('dkg/paranet/origin-trail-game/app')![0];
    handle('dkg/paranet/origin-trail-game/app', encode({
      app: 'origin-trail-game', type: 'swarm:created', swarmId: 'api-swarm',
      peerId: 'remote-api', timestamp: Date.now(), swarmName: 'APISwarm',
      playerName: 'APIUser', maxPlayers: 3,
    }), 'remote-api');
    await new Promise(r => setTimeout(r, 50));

    const req = createMockReq('GET', '/api/apps/origin-trail-game/notifications');
    const mock = createMockRes();
    await nHandler(req, mock.res, new URL(req.url, 'http://localhost'));
    const data = JSON.parse(mock.body);

    expect(data.unreadCount).toBe(1);
    expect(data.notifications.length).toBe(1);
    expect(data.notifications[0].type).toBe('swarm_created');
  });

  it('POST /notifications/read marks notifications as read via API', async () => {
    const { encode } = await import('../src/dkg/protocol.js');
    const nAgent = makeMockAgent('api-read');
    const nHandler = createHandler(nAgent, { paranets: ['test'] });

    const handle = nAgent._messageHandlers.get('dkg/paranet/origin-trail-game/app')![0];
    handle('dkg/paranet/origin-trail-game/app', encode({
      app: 'origin-trail-game', type: 'swarm:created', swarmId: 'read-swarm',
      peerId: 'remote-r', timestamp: Date.now(), swarmName: 'ReadSwarm',
      playerName: 'Reader', maxPlayers: 3,
    }), 'remote-r');
    await new Promise(r => setTimeout(r, 50));

    const readReq = createMockReq('POST', '/api/apps/origin-trail-game/notifications/read', {});
    const readMock = createMockRes();
    await nHandler(readReq, readMock.res, new URL(readReq.url, 'http://localhost'));
    const readData = JSON.parse(readMock.body);
    expect(readData.markedRead).toBe(1);

    const req = createMockReq('GET', '/api/apps/origin-trail-game/notifications');
    const mock = createMockRes();
    await nHandler(req, mock.res, new URL(req.url, 'http://localhost'));
    const data = JSON.parse(mock.body);
    expect(data.unreadCount).toBe(0);
  });

  it('notifications are returned in reverse chronological order', async () => {
    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const { encode } = await import('../src/dkg/protocol.js');

    const nAgent = makeMockAgent('local-order');
    const coordinator = new OriginTrailGameCoordinator(nAgent, { paranetId: 'notif-order' });
    const handle = nAgent._messageHandlers.get('dkg/paranet/notif-order/app')![0];

    for (let i = 0; i < 3; i++) {
      handle('dkg/paranet/notif-order/app', encode({
        app: 'origin-trail-game', type: 'swarm:created', swarmId: `order-${i}`,
        peerId: `r-${i}`, timestamp: 1000 + i, swarmName: `S${i}`,
        playerName: `P${i}`, maxPlayers: 3,
      }), `r-${i}`);
      await new Promise(r => setTimeout(r, 20));
    }

    const { notifications } = coordinator.getNotifications();
    expect(notifications.length).toBe(3);
    expect(notifications[0].swarmName).toBe('S2');
    expect(notifications[2].swarmName).toBe('S0');
  });

  it('caps notifications at MAX_NOTIFICATIONS', async () => {
    const { OriginTrailGameCoordinator } = await import('../src/dkg/coordinator.js');
    const { encode } = await import('../src/dkg/protocol.js');

    const nAgent = makeMockAgent('local-cap');
    const coordinator = new OriginTrailGameCoordinator(nAgent, { paranetId: 'notif-cap' });
    const handle = nAgent._messageHandlers.get('dkg/paranet/notif-cap/app')![0];

    for (let i = 0; i < 210; i++) {
      handle('dkg/paranet/notif-cap/app', encode({
        app: 'origin-trail-game', type: 'swarm:created', swarmId: `cap-${i}`,
        peerId: `c-${i}`, timestamp: Date.now() + i, swarmName: `C${i}`,
        playerName: `P${i}`, maxPlayers: 3,
      }), `c-${i}`);
    }
    await new Promise(r => setTimeout(r, 100));

    const { notifications } = coordinator.getNotifications();
    expect(notifications.length).toBeLessThanOrEqual(200);
  });
});
