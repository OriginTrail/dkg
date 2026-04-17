import { describe, it, expect, beforeEach } from 'vitest';
import { HermesAdapterPlugin } from '../src/HermesAdapterPlugin.js';
import { registerHermesRoutes } from '../src/hermes-routes.js';
import type { DaemonPluginApi, SessionTurnPayload, SessionEndPayload } from '../src/types.js';

interface TrackingApi extends DaemonPluginApi {
  routes: Map<string, (req: any, res: any) => Promise<void>>;
  hooks: Map<string, () => Promise<void>>;
  registerHttpRouteCalls: any[];
  registerHookCalls: any[];
}

function createTrackingApi(): TrackingApi {
  const routes = new Map<string, (req: any, res: any) => Promise<void>>();
  const hooks = new Map<string, () => Promise<void>>();
  const registerHttpRouteCalls: any[] = [];
  const registerHookCalls: any[] = [];

  const storeChatTurnCalls: any[][] = [];
  const importMemoriesCalls: any[][] = [];
  let storeChatTurnError: Error | null = null;
  let importMemoriesError: Error | null = null;

  return {
    routes,
    hooks,
    registerHttpRouteCalls,
    registerHookCalls,
    registerHttpRoute: (opts: any) => {
      registerHttpRouteCalls.push(opts);
      routes.set(`${opts.method} ${opts.path}`, opts.handler);
    },
    registerHook: (event: string, handler: any, meta?: any) => {
      registerHookCalls.push({ event, handler, meta });
      hooks.set(event, handler);
    },
    logger: {
      info: () => {},
      warn: () => {},
      debug: () => {},
    },
    agent: {
      query: async () => {},
      share: async () => {},
      importMemories: async (...args: any[]) => {
        importMemoriesCalls.push(args);
        if (importMemoriesError) throw importMemoriesError;
        return undefined;
      },
      storeChatTurn: async (...args: any[]) => {
        storeChatTurnCalls.push(args);
        if (storeChatTurnError) throw storeChatTurnError;
        return undefined;
      },
      _storeChatTurnCalls: storeChatTurnCalls,
      _importMemoriesCalls: importMemoriesCalls,
      _setStoreChatTurnError: (e: Error | null) => { storeChatTurnError = e; },
      _setImportMemoriesError: (e: Error | null) => { importMemoriesError = e; },
    },
  } as any;
}

function trackingRes() {
  const calls: { status?: number; json?: any }[] = [];
  const res: any = {};
  res.status = (code: number) => { calls.push({ status: code }); return res; };
  res.json = (body: any) => { calls.push({ json: body }); return res; };
  return { res, calls };
}

describe('HermesAdapterPlugin', () => {
  it('registers HTTP routes on first call', () => {
    const plugin = new HermesAdapterPlugin();
    const api = createTrackingApi();

    plugin.register(api);

    expect(api.registerHttpRouteCalls).toHaveLength(3);
    expect(api.routes.has('POST /api/hermes/session-turn')).toBe(true);
    expect(api.routes.has('POST /api/hermes/session-end')).toBe(true);
    expect(api.routes.has('GET /api/hermes/status')).toBe(true);
  });

  it('registers session_end lifecycle hook', () => {
    const plugin = new HermesAdapterPlugin();
    const api = createTrackingApi();

    plugin.register(api);

    expect(api.registerHookCalls.some(
      (c: any) => c.event === 'session_end' && c.meta?.name === 'hermes-adapter-stop',
    )).toBe(true);
  });

  it('skips route registration on second call (idempotent)', () => {
    const plugin = new HermesAdapterPlugin();
    const api = createTrackingApi();

    plugin.register(api);
    plugin.register(api);

    expect(api.registerHttpRouteCalls).toHaveLength(3);
  });
});

describe('POST /api/hermes/session-turn', () => {
  let api: TrackingApi;
  let handler: (req: any, res: any) => Promise<void>;

  beforeEach(() => {
    api = createTrackingApi();
    registerHermesRoutes(api);
    handler = api.routes.get('POST /api/hermes/session-turn')!;
  });

  it('stores chat turn and returns success', async () => {
    const body: SessionTurnPayload = { sessionId: 's1', user: 'hello', assistant: 'hi there' };
    const { res, calls } = trackingRes();

    await handler({ body }, res);

    expect((api.agent as any)._storeChatTurnCalls[0]).toEqual(['s1', 'hello', 'hi there']);
    expect((api.agent as any)._importMemoriesCalls[0][0]).toBe('hi there');
    expect((api.agent as any)._importMemoriesCalls[0][1]).toBe('hermes-session:s1');
    expect(calls.some(c => c.json?.success === true && c.json?.sessionId === 's1')).toBe(true);
  });

  it('prefixes source tag with agentName when provided', async () => {
    const body = { sessionId: 's1', user: '', assistant: 'response', agentName: 'Atlas' };
    const { res } = trackingRes();

    await handler({ body }, res);

    expect((api.agent as any)._importMemoriesCalls[0][1]).toBe('Atlas:hermes-session:s1');
  });

  it('returns 400 when sessionId is missing', async () => {
    const { res, calls } = trackingRes();

    await handler({ body: { user: 'hello' } }, res);

    expect(calls.some(c => c.status === 400)).toBe(true);
    expect(calls.some(c => c.json?.success === false)).toBe(true);
  });

  it('returns 400 when both user and assistant are missing', async () => {
    const { res, calls } = trackingRes();

    await handler({ body: { sessionId: 's1' } }, res);

    expect(calls.some(c => c.status === 400)).toBe(true);
  });

  it('succeeds with only user (no assistant)', async () => {
    const { res, calls } = trackingRes();

    await handler({ body: { sessionId: 's1', user: 'hello' } }, res);

    expect(calls.some(c => c.json?.success === true && c.json?.sessionId === 's1')).toBe(true);
    expect((api.agent as any)._importMemoriesCalls).toHaveLength(0);
  });

  it('does not fail when importMemories throws', async () => {
    (api.agent as any)._setImportMemoriesError(new Error('LLM timeout'));
    const { res, calls } = trackingRes();

    await handler({ body: { sessionId: 's1', user: '', assistant: 'x' } }, res);

    expect(calls.some(c => c.json?.success === true && c.json?.sessionId === 's1')).toBe(true);
  });

  it('returns 500 when storeChatTurn throws', async () => {
    (api.agent as any)._setStoreChatTurnError(new Error('DB error'));
    const { res, calls } = trackingRes();

    await handler({ body: { sessionId: 's1', user: 'u', assistant: 'a' } }, res);

    expect(calls.some(c => c.status === 500)).toBe(true);
    expect(calls.some(c => c.json?.success === false)).toBe(true);
  });

  it('handles absent storeChatTurn gracefully', async () => {
    api.agent.storeChatTurn = undefined;
    const { res, calls } = trackingRes();

    await handler({ body: { sessionId: 's1', user: 'u', assistant: 'a' } }, res);

    expect(calls.some(c => c.json?.success === true && c.json?.sessionId === 's1')).toBe(true);
  });

  it('handles absent importMemories gracefully', async () => {
    api.agent.importMemories = undefined;
    const { res, calls } = trackingRes();

    await handler({ body: { sessionId: 's1', user: '', assistant: 'stuff' } }, res);

    expect(calls.some(c => c.json?.success === true && c.json?.sessionId === 's1')).toBe(true);
  });
});

describe('POST /api/hermes/session-end', () => {
  let api: TrackingApi;
  let handler: (req: any, res: any) => Promise<void>;

  beforeEach(() => {
    api = createTrackingApi();
    registerHermesRoutes(api);
    handler = api.routes.get('POST /api/hermes/session-end')!;
  });

  it('accepts a valid session-end payload', async () => {
    const body: SessionEndPayload = { sessionId: 's1', turnCount: 5 };
    const { res, calls } = trackingRes();

    await handler({ body }, res);

    expect(calls.some(c => c.json?.success === true && c.json?.sessionId === 's1')).toBe(true);
  });

  it('returns 400 when sessionId is missing', async () => {
    const { res, calls } = trackingRes();

    await handler({ body: {} }, res);

    expect(calls.some(c => c.status === 400)).toBe(true);
    expect(calls.some(c => c.json?.success === false)).toBe(true);
  });

  it('works without optional turnCount', async () => {
    const { res, calls } = trackingRes();

    await handler({ body: { sessionId: 's2' } }, res);

    expect(calls.some(c => c.json?.success === true && c.json?.sessionId === 's2')).toBe(true);
  });
});

describe('GET /api/hermes/status', () => {
  it('returns adapter status JSON', async () => {
    const api = createTrackingApi();
    registerHermesRoutes(api);
    const handler = api.routes.get('GET /api/hermes/status')!;
    const { res, calls } = trackingRes();

    await handler({}, res);

    expect(calls.some(c =>
      c.json?.adapter === 'hermes' &&
      c.json?.framework === 'hermes-agent' &&
      c.json?.status === 'connected',
    )).toBe(true);
  });
});
