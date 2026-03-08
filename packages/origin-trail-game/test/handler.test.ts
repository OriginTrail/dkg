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
    publish: async (_paranetId: string, quads: any[]) => {
      published.push(quads);
      return {};
    },
    query: async () => ({ bindings: [] }),
    _published: published,
    _workspaceWrites: workspaceWrites,
    _subscriptions: subscriptions,
    _messageHandlers: messageHandlers,
  };
}

function createMockReq(method: string, path: string, body?: any): IncomingMessage {
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
      ...swarmCreatedQuads('origin-trail-game', 'swarm-X', 'Test', 'peer-1', Date.now()),
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
    }), leaderPeerId);
    await new Promise(r => setTimeout(r, 100));

    // Should be rejected: local tally says 'rest' but proposal says 'advance'
    const actionMismatchLogs = logs.filter(l => l.includes('action mismatch'));
    expect(actionMismatchLogs).toHaveLength(1);
  });
});
