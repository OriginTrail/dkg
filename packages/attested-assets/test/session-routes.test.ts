import { describe, it, expect } from 'vitest';
import { hexToBytes, createSessionRoutes, type SessionRouteHandler, type RouteRequest } from '../src/api/session-routes.js';
import type { SessionManager } from '../src/session-manager.js';

describe('session-routes hexToBytes validation', () => {
  it('accepts valid hex string', () => {
    expect(hexToBytes('aabbcc')).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc]));
  });

  it('accepts 0x-prefixed hex', () => {
    expect(hexToBytes('0xaabbcc')).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc]));
  });

  it('rejects odd-length hex', () => {
    expect(() => hexToBytes('abc')).toThrow('invalid hex string');
  });

  it('rejects non-hex characters', () => {
    expect(() => hexToBytes('gghhii')).toThrow('invalid hex string');
  });

  it('rejects hex with spaces', () => {
    expect(() => hexToBytes('aa bb cc')).toThrow('invalid hex string');
  });

  it('handles empty string', () => {
    expect(hexToBytes('')).toEqual(new Uint8Array(0));
  });

  it('handles 0x prefix alone (empty payload)', () => {
    expect(hexToBytes('0x')).toEqual(new Uint8Array(0));
  });

  it('handles uppercase hex', () => {
    expect(hexToBytes('0xAABBCC')).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc]));
  });

  it('handles mixed case hex', () => {
    expect(hexToBytes('0xAaBbCc')).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc]));
  });
});

class InMemorySessionManager {
  private sessions = new Map<string, any>();
  private nextId = 1;

  async createSession(
    contextGraphId: string,
    appId: string,
    membership: any[],
    quorumPolicy: any,
    reducer: any,
    roundTimeout: number,
    maxRounds: number | null,
  ) {
    const sessionId = `sess-${this.nextId++}`;
    const config = {
      sessionId,
      contextGraphId,
      appId,
      status: 'created',
      membership,
      quorumPolicy,
      reducer,
      roundTimeout,
      maxRounds,
    };
    this.sessions.set(sessionId, {
      config,
      currentRound: 0,
      latestFinalizedRound: 0,
      latestStateHash: '0x00',
      equivocators: new Set(),
      roundStates: new Map(),
      inputs: new Map(),
    });
    return config;
  }

  listSessions(contextGraphId?: string, status?: string) {
    const all = [...this.sessions.values()].map(s => s.config);
    return all.filter(c => {
      if (contextGraphId && c.contextGraphId !== contextGraphId) return false;
      if (status && c.status !== status) return false;
      return true;
    });
  }

  getSession(id: string) {
    return this.sessions.get(id) ?? null;
  }

  async acceptSession(id: string) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('session not found');
    s.config.status = 'accepted';
  }

  async activateSession(id: string) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('session not found');
    s.config.status = 'active';
  }

  async startRound(id: string, round: number) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('session not found');
    s.currentRound = round;
    s.roundStates.set(round, {
      round,
      status: 'collecting',
      proposerPeerId: 'peer-1',
      inputs: new Map(),
      acks: new Map(),
      proposal: null,
    });
  }

  async submitInput(id: string, data: Uint8Array, round: number) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('session not found');
    const rs = s.roundStates.get(round);
    if (rs) rs.inputs.set('local', data);
  }
}

function findRoute(routes: SessionRouteHandler[], method: string, path: string): SessionRouteHandler {
  const route = routes.find(r => r.method === method && r.path === path);
  if (!route) throw new Error(`Route ${method} ${path} not found`);
  return route;
}

function req(overrides?: Partial<RouteRequest>): RouteRequest {
  return { params: {}, query: {}, body: {}, ...overrides };
}

describe('createSessionRoutes', () => {
  function createManager(): InMemorySessionManager {
    return new InMemorySessionManager();
  }

  it('returns 10 route handlers', () => {
    const routes = createSessionRoutes(createManager() as unknown as SessionManager);
    expect(routes.length).toBe(10);
  });

  it('POST /api/sessions creates a session and returns 201', async () => {
    const manager = createManager();
    const routes = createSessionRoutes(manager as unknown as SessionManager);
    const route = findRoute(routes, 'POST', '/api/sessions');

    const response = await route.handler(req({
      body: {
        contextGraphId: 'cg-1',
        appId: 'app-1',
        membership: [{ peerId: 'peer-1', pubKey: 'aa', displayName: 'Alice', role: 'creator' }],
        quorumPolicy: { type: 'majority' },
        reducer: { type: 'append' },
        roundTimeout: 5000,
        maxRounds: null,
      },
    }));

    expect(response.status).toBe(201);
    expect((response.body as any).sessionId).toBeTruthy();
    expect((response.body as any).contextGraphId).toBe('cg-1');
  });

  it('POST /api/sessions returns 400 on invalid body', async () => {
    const routes = createSessionRoutes(createManager() as unknown as SessionManager);
    const route = findRoute(routes, 'POST', '/api/sessions');

    const response = await route.handler(req({ body: {} }));
    expect(response.status).toBe(400);
    expect((response.body as any).error).toBeTruthy();
  });

  it('GET /api/sessions lists sessions', async () => {
    const manager = createManager();
    const routes = createSessionRoutes(manager as unknown as SessionManager);

    const postRoute = findRoute(routes, 'POST', '/api/sessions');
    await postRoute.handler(req({
      body: {
        contextGraphId: 'cg-1', appId: 'app-1',
        membership: [{ peerId: 'peer-1', pubKey: 'aa', displayName: 'Alice', role: 'creator' }],
        quorumPolicy: {}, reducer: {}, roundTimeout: 5000, maxRounds: null,
      },
    }));

    const listRoute = findRoute(routes, 'GET', '/api/sessions');
    const response = await listRoute.handler(req({ query: {} }));

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect((response.body as any[]).length).toBe(1);
  });

  it('GET /api/sessions/:id returns 404 for unknown session', async () => {
    const routes = createSessionRoutes(createManager() as unknown as SessionManager);
    const route = findRoute(routes, 'GET', '/api/sessions/:id');

    const response = await route.handler(req({ params: { id: 'nonexistent' } }));
    expect(response.status).toBe(404);
    expect((response.body as any).error).toContain('session not found');
  });

  it('GET /api/sessions/:id returns session details when found', async () => {
    const manager = createManager();
    const routes = createSessionRoutes(manager as unknown as SessionManager);
    const postRoute = findRoute(routes, 'POST', '/api/sessions');

    const createResp = await postRoute.handler(req({
      body: {
        contextGraphId: 'cg-1', appId: 'app-1',
        membership: [{ peerId: 'peer-1', pubKey: 'aa', displayName: 'Alice', role: 'creator' }],
        quorumPolicy: {}, reducer: {}, roundTimeout: 5000, maxRounds: null,
      },
    }));
    const sessionId = (createResp.body as any).sessionId;

    const getRoute = findRoute(routes, 'GET', '/api/sessions/:id');
    const response = await getRoute.handler(req({ params: { id: sessionId } }));

    expect(response.status).toBe(200);
    expect((response.body as any).sessionId).toBe(sessionId);
  });

  it('POST /api/sessions/:id/accept returns 200 for existing session', async () => {
    const manager = createManager();
    const routes = createSessionRoutes(manager as unknown as SessionManager);
    const postRoute = findRoute(routes, 'POST', '/api/sessions');

    const createResp = await postRoute.handler(req({
      body: {
        contextGraphId: 'cg-1', appId: 'app-1',
        membership: [{ peerId: 'p1', pubKey: 'aa', displayName: 'A', role: 'creator' }],
        quorumPolicy: {}, reducer: {}, roundTimeout: 5000, maxRounds: null,
      },
    }));
    const sessionId = (createResp.body as any).sessionId;

    const acceptRoute = findRoute(routes, 'POST', '/api/sessions/:id/accept');
    const response = await acceptRoute.handler(req({ params: { id: sessionId } }));
    expect(response.status).toBe(200);
    expect((response.body as any).accepted).toBe(true);
  });

  it('POST /api/sessions/:id/accept returns 400 for nonexistent session', async () => {
    const routes = createSessionRoutes(createManager() as unknown as SessionManager);
    const route = findRoute(routes, 'POST', '/api/sessions/:id/accept');

    const response = await route.handler(req({ params: { id: 'bad-id' } }));
    expect(response.status).toBe(400);
  });

  it('POST /api/sessions/:id/activate returns 200', async () => {
    const manager = createManager();
    const routes = createSessionRoutes(manager as unknown as SessionManager);
    const postRoute = findRoute(routes, 'POST', '/api/sessions');

    const createResp = await postRoute.handler(req({
      body: {
        contextGraphId: 'cg-1', appId: 'app-1',
        membership: [{ peerId: 'p1', pubKey: 'aa', displayName: 'A', role: 'creator' }],
        quorumPolicy: {}, reducer: {}, roundTimeout: 5000, maxRounds: null,
      },
    }));
    const sessionId = (createResp.body as any).sessionId;

    const route = findRoute(routes, 'POST', '/api/sessions/:id/activate');
    const response = await route.handler(req({ params: { id: sessionId } }));
    expect(response.status).toBe(200);
    expect((response.body as any).activated).toBe(true);
  });

  it('POST /api/sessions/:id/rounds/:n/start starts a round', async () => {
    const manager = createManager();
    const routes = createSessionRoutes(manager as unknown as SessionManager);
    const postRoute = findRoute(routes, 'POST', '/api/sessions');

    const createResp = await postRoute.handler(req({
      body: {
        contextGraphId: 'cg-1', appId: 'app-1',
        membership: [{ peerId: 'p1', pubKey: 'aa', displayName: 'A', role: 'creator' }],
        quorumPolicy: {}, reducer: {}, roundTimeout: 5000, maxRounds: null,
      },
    }));
    const sessionId = (createResp.body as any).sessionId;

    const route = findRoute(routes, 'POST', '/api/sessions/:id/rounds/:n/start');
    const response = await route.handler(req({ params: { id: sessionId, n: '1' } }));
    expect(response.status).toBe(200);
    expect((response.body as any).round).toBe(1);
  });

  it('POST /api/sessions/:id/rounds/:n/input submits input', async () => {
    const manager = createManager();
    const routes = createSessionRoutes(manager as unknown as SessionManager);
    const postRoute = findRoute(routes, 'POST', '/api/sessions');

    const createResp = await postRoute.handler(req({
      body: {
        contextGraphId: 'cg-1', appId: 'app-1',
        membership: [{ peerId: 'p1', pubKey: 'aa', displayName: 'A', role: 'creator' }],
        quorumPolicy: {}, reducer: {}, roundTimeout: 5000, maxRounds: null,
      },
    }));
    const sessionId = (createResp.body as any).sessionId;

    const startRoute = findRoute(routes, 'POST', '/api/sessions/:id/rounds/:n/start');
    await startRoute.handler(req({ params: { id: sessionId, n: '1' } }));

    const inputRoute = findRoute(routes, 'POST', '/api/sessions/:id/rounds/:n/input');
    const response = await inputRoute.handler(req({
      params: { id: sessionId, n: '1' },
      body: { data: 'aabb' },
    }));
    expect(response.status).toBe(200);
    expect((response.body as any).submitted).toBe(true);
  });

  it('GET /api/sessions/:id/state returns session state', async () => {
    const manager = createManager();
    const routes = createSessionRoutes(manager as unknown as SessionManager);
    const postRoute = findRoute(routes, 'POST', '/api/sessions');

    const createResp = await postRoute.handler(req({
      body: {
        contextGraphId: 'cg-1', appId: 'app-1',
        membership: [{ peerId: 'p1', pubKey: 'aa', displayName: 'A', role: 'creator' }],
        quorumPolicy: {}, reducer: {}, roundTimeout: 5000, maxRounds: null,
      },
    }));
    const sessionId = (createResp.body as any).sessionId;

    const stateRoute = findRoute(routes, 'GET', '/api/sessions/:id/state');
    const response = await stateRoute.handler(req({ params: { id: sessionId } }));
    expect(response.status).toBe(200);
    expect((response.body as any).sessionId).toBe(sessionId);
    expect((response.body as any).status).toBe('created');
  });

  it('GET /api/sessions/:id/rounds/:n returns 404 for unknown round', async () => {
    const manager = createManager();
    const routes = createSessionRoutes(manager as unknown as SessionManager);
    const postRoute = findRoute(routes, 'POST', '/api/sessions');

    const createResp = await postRoute.handler(req({
      body: {
        contextGraphId: 'cg-1', appId: 'app-1',
        membership: [{ peerId: 'p1', pubKey: 'aa', displayName: 'A', role: 'creator' }],
        quorumPolicy: {}, reducer: {}, roundTimeout: 5000, maxRounds: null,
      },
    }));
    const sessionId = (createResp.body as any).sessionId;

    const roundRoute = findRoute(routes, 'GET', '/api/sessions/:id/rounds/:n');
    const response = await roundRoute.handler(req({ params: { id: sessionId, n: '99' } }));
    expect(response.status).toBe(404);
    expect((response.body as any).error).toContain('round not found');
  });
});
