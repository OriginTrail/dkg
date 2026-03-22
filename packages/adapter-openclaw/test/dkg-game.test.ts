import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DkgGamePlugin, parseActionResponse, type ConsultAgentFn } from '../src/DkgGamePlugin.js';
import { DkgDaemonClient } from '../src/dkg-client.js';
import { DkgNodePlugin } from '../src/DkgNodePlugin.js';
import type { OpenClawPluginApi, OpenClawTool } from '../src/types.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockApi(): OpenClawPluginApi & { tools: OpenClawTool[] } {
  const tools: OpenClawTool[] = [];
  return {
    config: {},
    tools,
    registerTool: (tool) => tools.push(tool),
    registerHook: () => {},
    on: () => {},
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  };
}

function mockClient(): DkgDaemonClient {
  return new DkgDaemonClient({ baseUrl: 'http://127.0.0.1:9200' });
}

// ---------------------------------------------------------------------------
// DkgGamePlugin — tool registration
// ---------------------------------------------------------------------------

describe('DkgGamePlugin', () => {
  it('registers all 12 game tools', () => {
    const api = mockApi();
    const plugin = new DkgGamePlugin(mockClient(), {}, undefined);
    plugin.register(api);

    const toolNames = api.tools.map(t => t.name);
    expect(toolNames).toContain('game_lobby');
    expect(toolNames).toContain('game_join');
    expect(toolNames).toContain('game_leave');
    expect(toolNames).toContain('game_create');
    expect(toolNames).toContain('game_start');
    expect(toolNames).toContain('game_status');
    expect(toolNames).toContain('game_vote');
    expect(toolNames).toContain('game_locations');
    expect(toolNames).toContain('game_leaderboard');
    expect(toolNames).toContain('game_strategy');
    expect(toolNames).toContain('game_autopilot_start');
    expect(toolNames).toContain('game_autopilot_stop');
    expect(api.tools.length).toBe(12);
  });

  it('all tools have name, description, parameters, and execute', () => {
    const api = mockApi();
    const plugin = new DkgGamePlugin(mockClient(), {}, undefined);
    plugin.register(api);

    for (const tool of api.tools) {
      expect(typeof tool.name).toBe('string');
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters.type).toBe('object');
      expect(typeof tool.execute).toBe('function');
    }
  });

  it('game_join requires swarm_id and player_name', () => {
    const api = mockApi();
    const plugin = new DkgGamePlugin(mockClient(), {}, undefined);
    plugin.register(api);

    const joinTool = api.tools.find(t => t.name === 'game_join')!;
    expect(joinTool.parameters.required).toContain('swarm_id');
    expect(joinTool.parameters.required).toContain('player_name');
  });

  it('game_create requires swarm_name and player_name', () => {
    const api = mockApi();
    const plugin = new DkgGamePlugin(mockClient(), {}, undefined);
    plugin.register(api);

    const createTool = api.tools.find(t => t.name === 'game_create')!;
    expect(createTool.parameters.required).toContain('swarm_name');
    expect(createTool.parameters.required).toContain('player_name');
  });

  it('game_vote has action enum', () => {
    const api = mockApi();
    const plugin = new DkgGamePlugin(mockClient(), {}, undefined);
    plugin.register(api);

    const voteTool = api.tools.find(t => t.name === 'game_vote')!;
    const actionProp = voteTool.parameters.properties.action;
    expect(actionProp.enum).toContain('advance');
    expect(actionProp.enum).toContain('syncMemory');
    expect(actionProp.enum).toContain('trade');
  });

  it('game_leave has optional swarm_id (no required params)', () => {
    const api = mockApi();
    const plugin = new DkgGamePlugin(mockClient(), {}, undefined);
    plugin.register(api);

    const leaveTool = api.tools.find(t => t.name === 'game_leave')!;
    expect(leaveTool.parameters.required).toEqual([]);
    expect(leaveTool.parameters.properties.swarm_id).toBeDefined();
  });

  it('game_autopilot_start requires swarm_id', () => {
    const api = mockApi();
    const plugin = new DkgGamePlugin(mockClient(), {}, undefined);
    plugin.register(api);

    const autopilotTool = api.tools.find(t => t.name === 'game_autopilot_start')!;
    expect(autopilotTool.parameters.required).toContain('swarm_id');
  });

  it('stop() is safe to call without register()', async () => {
    const plugin = new DkgGamePlugin(mockClient(), {}, undefined);
    // stop() before register() should not throw
    // (gameService is not created yet — the method guards against this)
    await expect(plugin.stop()).resolves.toBeUndefined();
  });

  it('getService() returns the GameService after register()', () => {
    const api = mockApi();
    const plugin = new DkgGamePlugin(mockClient(), {}, undefined);
    plugin.register(api);
    const service = plugin.getService();
    expect(service).toBeDefined();
    expect(service.isRunning).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DkgNodePlugin — game module integration
// ---------------------------------------------------------------------------

describe('DkgNodePlugin with game module', () => {
  it('registers game tools when game.enabled is true', () => {
    const plugin = new DkgNodePlugin({
      game: { enabled: true },
    });
    const tools: OpenClawTool[] = [];
    const api: OpenClawPluginApi = {
      config: {},
      registerTool: (tool) => tools.push(tool),
      registerHook: () => {},
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn() },
    };

    plugin.register(api);

    const toolNames = tools.map(t => t.name);
    // 11 core DKG tools + 12 game tools = 23
    expect(toolNames).toContain('dkg_status');
    expect(toolNames).toContain('game_lobby');
    expect(toolNames).toContain('game_leave');
    expect(toolNames).toContain('game_autopilot_start');
    expect(tools.length).toBe(23);
  });

  it('does not register game tools when game.enabled is false/missing', () => {
    const plugin = new DkgNodePlugin({});
    const tools: OpenClawTool[] = [];
    const api: OpenClawPluginApi = {
      config: {},
      registerTool: (tool) => tools.push(tool),
      registerHook: () => {},
      on: () => {},
      logger: {},
    };

    plugin.register(api);

    const toolNames = tools.map(t => t.name);
    expect(toolNames).not.toContain('game_lobby');
    expect(tools.length).toBe(11); // Only core DKG tools
  });

  it('warns when game enabled but channel disabled (no autopilot)', () => {
    const plugin = new DkgNodePlugin({
      game: { enabled: true },
      channel: { enabled: false },
    });
    const warnFn = vi.fn();
    const api: OpenClawPluginApi = {
      config: {},
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { info: vi.fn(), warn: warnFn },
    };

    plugin.register(api);

    expect(warnFn).toHaveBeenCalledWith(
      expect.stringContaining('autopilot unavailable'),
    );
  });
});

// ---------------------------------------------------------------------------
// GameService — autopilot lifecycle
// ---------------------------------------------------------------------------

describe('GameService via DkgGamePlugin', () => {
  let plugin: DkgGamePlugin;
  let api: ReturnType<typeof mockApi>;

  beforeEach(() => {
    api = mockApi();
    plugin = new DkgGamePlugin(
      mockClient(),
      { pollIntervalMs: 100_000 }, // Very long so no tick fires during tests
      undefined, // No consultAgent — autopilot will fail
    );
    plugin.register(api);
  });

  afterEach(async () => {
    await plugin.stop();
  });

  it('autopilot_start fails without consultAgent', async () => {
    const autopilotTool = api.tools.find(t => t.name === 'game_autopilot_start')!;
    const result = await autopilotTool.execute('test', { swarm_id: 'test-swarm' });
    const text = result.content[0].text;
    expect(text).toContain('channel bridge');
  });

  it('autopilot_stop when not running returns appropriate status', async () => {
    const stopTool = api.tools.find(t => t.name === 'game_autopilot_stop')!;
    const result = await stopTool.execute('test', {});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('autopilot_was_not_running');
  });

  it('service isRunning is false by default', () => {
    expect(plugin.getService().isRunning).toBe(false);
    expect(plugin.getService().activeSwarmId).toBeNull();
  });
});

describe('GameService with mock consultAgent', () => {
  let plugin: DkgGamePlugin;
  let consultAgent: ConsultAgentFn;

  beforeEach(() => {
    consultAgent = vi.fn().mockResolvedValue('ACTION: advance PARAMS: {"intensity": 2}');
    plugin = new DkgGamePlugin(
      mockClient(),
      { pollIntervalMs: 100_000 },
      consultAgent,
    );
    plugin.register(mockApi());
  });

  afterEach(async () => {
    await plugin.stop();
  });

  it('cannot start autopilot twice', async () => {
    const service = plugin.getService();
    // Mock fetch: getSwarm returns a traveling swarm, getLocations returns []
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/swarm/')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'traveling', gameState: null }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ locations: [] }) });
    }) as any;

    try {
      await service.start('swarm-1');
      expect(service.isRunning).toBe(true);
      expect(service.activeSwarmId).toBe('swarm-1');

      await expect(service.start('swarm-2')).rejects.toThrow('already running');
    } finally {
      await service.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('stop clears running state', async () => {
    const service = plugin.getService();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/swarm/')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'traveling', gameState: null }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ locations: [] }) });
    }) as any;

    try {
      await service.start('swarm-1');
      expect(service.isRunning).toBe(true);
      await service.stop();
      expect(service.isRunning).toBe(false);
      expect(service.activeSwarmId).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// parseActionResponse — action response parser
// ---------------------------------------------------------------------------

describe('parseActionResponse', () => {
  it('parses structured ACTION: format', () => {
    const result = parseActionResponse('ACTION: advance PARAMS: {"intensity": 2}');
    expect(result.action).toBe('advance');
    expect(result.params).toEqual({ intensity: 2 });
  });

  it('parses ACTION: without PARAMS', () => {
    const result = parseActionResponse('ACTION: syncMemory');
    expect(result.action).toBe('syncMemory');
    expect(result.params).toBeUndefined();
  });

  it('parses ACTION: payToll', () => {
    const result = parseActionResponse('ACTION: payToll');
    expect(result.action).toBe('payToll');
  });

  it('parses ACTION: forceBottleneck', () => {
    const result = parseActionResponse('ACTION: forceBottleneck');
    expect(result.action).toBe('forceBottleneck');
  });

  it('parses ACTION: trade with params', () => {
    const result = parseActionResponse('ACTION: trade PARAMS: {"item": "trainingTokens", "quantity": 50}');
    expect(result.action).toBe('trade');
    expect(result.params).toEqual({ item: 'trainingTokens', quantity: 50 });
  });

  it('parses ACTION: upgradeSkills', () => {
    const result = parseActionResponse('ACTION: upgradeSkills');
    expect(result.action).toBe('upgradeSkills');
  });

  it('extracts advance from natural language with intensity', () => {
    const result = parseActionResponse('I think we should advance with intensity 3 to make progress');
    expect(result.action).toBe('advance');
    expect(result.params).toEqual({ intensity: 3 });
  });

  it('extracts syncMemory from natural language', () => {
    const result = parseActionResponse('We need to heal, so let us use syncMemory to recover');
    expect(result.action).toBe('syncMemory');
  });

  it('extracts trade from natural language with item', () => {
    const result = parseActionResponse('We should trade for trainingTokens at this hub');
    expect(result.action).toBe('trade');
    expect(result.params).toEqual({ item: 'trainingTokens', quantity: 1 });
  });

  it('falls back to advance(1) on gibberish', () => {
    const result = parseActionResponse('Lorem ipsum dolor sit amet');
    expect(result.action).toBe('advance');
    expect(result.params).toEqual({ intensity: 1 });
  });

  it('falls back to advance(1) on empty string', () => {
    const result = parseActionResponse('');
    expect(result.action).toBe('advance');
    expect(result.params).toEqual({ intensity: 1 });
  });

  it('normalizes unknown action to advance', () => {
    const result = parseActionResponse('ACTION: runAway');
    expect(result.action).toBe('advance');
  });

  it('is case insensitive for ACTION:', () => {
    const result = parseActionResponse('action: SYNCMEMORY');
    expect(result.action).toBe('syncMemory');
  });

  it('handles multiline agent responses', () => {
    const result = parseActionResponse(
      'Given our low health and available TRAC, I recommend healing.\n\n' +
      'ACTION: syncMemory\n\n' +
      'This will restore +10 HP to all agents.',
    );
    expect(result.action).toBe('syncMemory');
  });

  it('clamps intensity to valid range', () => {
    const result = parseActionResponse('advance with intensity 5');
    expect(result.action).toBe('advance');
    expect(result.params?.intensity).toBe(3);
  });

  it('handles intensity = 0 as 1', () => {
    const result = parseActionResponse('advance with intensity 0');
    expect(result.action).toBe('advance');
    expect(result.params?.intensity).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tool error handling
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SwarmWatcher — auto-engage autopilot after join/create
// ---------------------------------------------------------------------------

describe('SwarmWatcher', () => {
  const recruitingSwarm = {
    id: 'sw-1', name: 'Test', status: 'recruiting', playerCount: 1, maxPlayers: 3,
    leaderId: 'p1', leaderName: 'Player1', players: [], currentTurn: 0, gameState: null,
    voteStatus: null, lastTurn: null,
  };

  const travelingSwarm = {
    ...recruitingSwarm, status: 'traveling',
    gameState: { sessionId: 's', player: 'p', epochs: 1, trainingTokens: 500, apiCredits: 5,
      computeUnits: 10, modelWeights: 3, trac: 100, month: 1, day: 1,
      party: [{ id: 'a1', name: 'Agent', health: 100, alive: true }],
      status: 'active', moveCount: 1 },
  };

  const fullSwarm = { ...recruitingSwarm, playerCount: 3 };

  function mockFetchForSwarm(swarmResponse: any) {
    return vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/swarm/')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(swarmResponse) });
      }
      if (String(url).includes('/join')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(swarmResponse) });
      }
      if (String(url).includes('/create')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(swarmResponse) });
      }
      if (String(url).includes('/start')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...swarmResponse, status: 'traveling', gameState: travelingSwarm.gameState }) });
      }
      if (String(url).includes('/locations')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ locations: [] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }) as any;
  }

  it('game_join with recruiting swarm starts a watcher', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchForSwarm(recruitingSwarm);
    try {
      const consultAgent = vi.fn().mockResolvedValue('ACTION: advance');
      const plugin = new DkgGamePlugin(mockClient(), { watchIntervalMs: 60_000 }, consultAgent);
      const api = mockApi();
      plugin.register(api);

      const joinTool = api.tools.find(t => t.name === 'game_join')!;
      const result = await joinTool.execute('test', { swarm_id: 'sw-1', player_name: 'Bot' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.watcher).toContain('Watching for game start');

      const ws = plugin.getWatchState();
      expect(ws.active).toBe(true);
      expect(ws.mode).toBe('wait-for-start');

      await plugin.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('game_create starts a wait-for-full watcher', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchForSwarm(recruitingSwarm);
    try {
      const consultAgent = vi.fn().mockResolvedValue('ACTION: advance');
      const plugin = new DkgGamePlugin(mockClient(), { watchIntervalMs: 60_000 }, consultAgent);
      const api = mockApi();
      plugin.register(api);

      const createTool = api.tools.find(t => t.name === 'game_create')!;
      const result = await createTool.execute('test', { swarm_name: 'Test', player_name: 'Bot' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.watcher).toContain('auto-start expedition');

      const ws = plugin.getWatchState();
      expect(ws.active).toBe(true);
      expect(ws.mode).toBe('wait-for-full');

      await plugin.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('no watcher without consultAgent', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchForSwarm(recruitingSwarm);
    try {
      const plugin = new DkgGamePlugin(mockClient(), {}, undefined);
      const api = mockApi();
      plugin.register(api);

      const joinTool = api.tools.find(t => t.name === 'game_join')!;
      const result = await joinTool.execute('test', { swarm_id: 'sw-1', player_name: 'Bot' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.watcher).toBeUndefined();
      expect(plugin.getWatchState().active).toBe(false);

      await plugin.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('game_autopilot_stop stops the watcher', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchForSwarm(recruitingSwarm);
    try {
      const consultAgent = vi.fn().mockResolvedValue('ACTION: advance');
      const plugin = new DkgGamePlugin(mockClient(), { watchIntervalMs: 60_000 }, consultAgent);
      const api = mockApi();
      plugin.register(api);

      // Start a watcher via join
      const joinTool = api.tools.find(t => t.name === 'game_join')!;
      await joinTool.execute('test', { swarm_id: 'sw-1', player_name: 'Bot' });
      expect(plugin.getWatchState().active).toBe(true);

      // Stop via autopilot_stop
      const stopTool = api.tools.find(t => t.name === 'game_autopilot_stop')!;
      await stopTool.execute('test', {});
      expect(plugin.getWatchState().active).toBe(false);

      await plugin.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('game_start stops an active watcher', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchForSwarm(recruitingSwarm);
    try {
      const consultAgent = vi.fn().mockResolvedValue('ACTION: advance');
      const plugin = new DkgGamePlugin(mockClient(), { watchIntervalMs: 60_000 }, consultAgent);
      const api = mockApi();
      plugin.register(api);

      // Start watcher via join
      const joinTool = api.tools.find(t => t.name === 'game_join')!;
      await joinTool.execute('test', { swarm_id: 'sw-1', player_name: 'Bot' });
      expect(plugin.getWatchState().active).toBe(true);

      // game_start now switches fetch to return traveling
      globalThis.fetch = mockFetchForSwarm(travelingSwarm);
      const startTool = api.tools.find(t => t.name === 'game_start')!;
      await startTool.execute('test', { swarm_id: 'sw-1' });
      expect(plugin.getWatchState().active).toBe(false);

      await plugin.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('second game_join replaces existing watcher', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchForSwarm(recruitingSwarm);
    try {
      const consultAgent = vi.fn().mockResolvedValue('ACTION: advance');
      const plugin = new DkgGamePlugin(mockClient(), { watchIntervalMs: 60_000 }, consultAgent);
      const api = mockApi();
      plugin.register(api);

      const joinTool = api.tools.find(t => t.name === 'game_join')!;
      await joinTool.execute('test', { swarm_id: 'sw-1', player_name: 'Bot' });
      expect(plugin.getWatchState().swarmId).toBe('sw-1');

      // Join a different swarm — replace the watcher
      const swarm2 = { ...recruitingSwarm, id: 'sw-2' };
      globalThis.fetch = mockFetchForSwarm(swarm2);
      await joinTool.execute('test', { swarm_id: 'sw-2', player_name: 'Bot' });
      expect(plugin.getWatchState().swarmId).toBe('sw-2');

      await plugin.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('plugin.stop() cleans up watcher', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchForSwarm(recruitingSwarm);
    try {
      const consultAgent = vi.fn().mockResolvedValue('ACTION: advance');
      const plugin = new DkgGamePlugin(mockClient(), { watchIntervalMs: 60_000 }, consultAgent);
      const api = mockApi();
      plugin.register(api);

      const joinTool = api.tools.find(t => t.name === 'game_join')!;
      await joinTool.execute('test', { swarm_id: 'sw-1', player_name: 'Bot' });
      expect(plugin.getWatchState().active).toBe(true);

      await plugin.stop();
      expect(plugin.getWatchState().active).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('watcher survives transient startExpedition failure', async () => {
    const originalFetch = globalThis.fetch;
    // Create succeeds, then startExpedition fails, then recheck shows still recruiting
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes('/create')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(fullSwarm) });
      }
      if (urlStr.includes('/start')) {
        return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('transient error') });
      }
      if (urlStr.includes('/swarm/')) {
        callCount++;
        // Recheck returns still recruiting (player may have left)
        return Promise.resolve({ ok: true, json: () => Promise.resolve(recruitingSwarm) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }) as any;

    try {
      const consultAgent = vi.fn().mockResolvedValue('ACTION: advance');
      const plugin = new DkgGamePlugin(mockClient(), { watchIntervalMs: 100 }, consultAgent);
      const api = mockApi();
      plugin.register(api);

      const createTool = api.tools.find(t => t.name === 'game_create')!;
      await createTool.execute('test', { player_name: 'Bot', swarm_name: 'MySwarm' });
      expect(plugin.getWatchState().active).toBe(true);

      // Manually trigger a watchTick by accessing internals — the watcher should survive
      // the failed startExpedition and keep watching
      await (plugin as any).watchTick((plugin as any).watchEpoch);
      expect(plugin.getWatchState().active).toBe(true); // Still watching!

      await plugin.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('game_status includes watcher state', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchForSwarm(recruitingSwarm);
    try {
      const consultAgent = vi.fn().mockResolvedValue('ACTION: advance');
      const plugin = new DkgGamePlugin(mockClient(), { watchIntervalMs: 60_000 }, consultAgent);
      const api = mockApi();
      plugin.register(api);

      // Start watcher
      const joinTool = api.tools.find(t => t.name === 'game_join')!;
      await joinTool.execute('test', { swarm_id: 'sw-1', player_name: 'Bot' });

      // Check status
      const statusTool = api.tools.find(t => t.name === 'game_status')!;
      const result = await statusTool.execute('test', { swarm_id: 'sw-1' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.watcher.active).toBe(true);
      expect(parsed.watcher.mode).toBe('wait-for-start');

      await plugin.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// game_leave tool
// ---------------------------------------------------------------------------

describe('game_leave tool', () => {
  it('returns disbanded message when leader leaves recruiting swarm', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/leave')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ disbanded: true }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }) as any;

    try {
      const api = mockApi();
      const plugin = new DkgGamePlugin(mockClient(), {}, undefined);
      plugin.register(api);

      const leaveTool = api.tools.find(t => t.name === 'game_leave')!;
      const result = await leaveTool.execute('test', { swarm_id: 'sw-1' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.status).toBe('disbanded');
      expect(parsed.message).toContain('disbanded');

      await plugin.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns swarm summary with left flag when non-leader leaves', async () => {
    const originalFetch = globalThis.fetch;
    const remainingSwarm = {
      id: 'sw-1', name: 'Test', status: 'recruiting', playerCount: 1, maxPlayers: 3,
      leaderId: 'p1', leaderName: 'Player1', players: [], currentTurn: 0, gameState: null,
      voteStatus: null, lastTurn: null,
    };
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/leave')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(remainingSwarm) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }) as any;

    try {
      const api = mockApi();
      const plugin = new DkgGamePlugin(mockClient(), {}, undefined);
      plugin.register(api);

      const leaveTool = api.tools.find(t => t.name === 'game_leave')!;
      const result = await leaveTool.execute('test', { swarm_id: 'sw-1' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe('sw-1');
      expect(parsed.left).toBe(true);

      await plugin.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('includes message when leaving a traveling swarm (finished)', async () => {
    const originalFetch = globalThis.fetch;
    const finishedSwarm = {
      id: 'sw-1', name: 'Test', status: 'finished', playerCount: 1, maxPlayers: 3,
      leaderId: 'p1', leaderName: 'Player1', players: [], currentTurn: 5,
      gameState: { status: 'lost', epochs: 200 },
      voteStatus: null, lastTurn: null,
    };
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/leave')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(finishedSwarm) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }) as any;

    try {
      const api = mockApi();
      const plugin = new DkgGamePlugin(mockClient(), {}, undefined);
      plugin.register(api);

      const leaveTool = api.tools.find(t => t.name === 'game_leave')!;
      const result = await leaveTool.execute('test', { swarm_id: 'sw-1' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.left).toBe(true);
      expect(parsed.message).toContain('ended the expedition');

      await plugin.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('stops autopilot when leaving the autopilot swarm', async () => {
    const originalFetch = globalThis.fetch;
    const travelingSwarm = {
      id: 'sw-1', name: 'Test', status: 'traveling', playerCount: 2, maxPlayers: 3,
      leaderId: 'p1', leaderName: 'Player1', players: [], currentTurn: 1,
      gameState: { sessionId: 's', player: 'p', epochs: 10, trainingTokens: 500,
        apiCredits: 5, computeUnits: 10, modelWeights: 3, trac: 100, month: 1, day: 1,
        party: [{ id: 'a1', name: 'Agent', health: 100, alive: true }],
        status: 'active', moveCount: 1 },
      voteStatus: null, lastTurn: null,
    };
    const finishedSwarm = { ...travelingSwarm, status: 'finished' };

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes('/swarm/')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(travelingSwarm) });
      }
      if (urlStr.includes('/locations')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ locations: [] }) });
      }
      if (urlStr.includes('/leave')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(finishedSwarm) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }) as any;

    try {
      const consultAgent = vi.fn().mockResolvedValue('ACTION: advance');
      const plugin = new DkgGamePlugin(mockClient(), { pollIntervalMs: 100_000 }, consultAgent);
      const api = mockApi();
      plugin.register(api);

      // Start autopilot
      await plugin.getService().start('sw-1');
      expect(plugin.getService().isRunning).toBe(true);

      // Leave should stop autopilot
      const leaveTool = api.tools.find(t => t.name === 'game_leave')!;
      await leaveTool.execute('test', { swarm_id: 'sw-1' });
      expect(plugin.getService().isRunning).toBe(false);

      await plugin.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('stops watcher when leaving the watched swarm', async () => {
    const originalFetch = globalThis.fetch;
    const recruitingSwarm = {
      id: 'sw-1', name: 'Test', status: 'recruiting', playerCount: 1, maxPlayers: 3,
      leaderId: 'p1', leaderName: 'Player1', players: [], currentTurn: 0, gameState: null,
      voteStatus: null, lastTurn: null,
    };

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes('/join')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(recruitingSwarm) });
      }
      if (urlStr.includes('/leave')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ disbanded: true }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }) as any;

    try {
      const consultAgent = vi.fn().mockResolvedValue('ACTION: advance');
      const plugin = new DkgGamePlugin(mockClient(), { watchIntervalMs: 60_000 }, consultAgent);
      const api = mockApi();
      plugin.register(api);

      // Join to start watcher
      const joinTool = api.tools.find(t => t.name === 'game_join')!;
      await joinTool.execute('test', { swarm_id: 'sw-1', player_name: 'Bot' });
      expect(plugin.getWatchState().active).toBe(true);

      // Leave should stop watcher
      const leaveTool = api.tools.find(t => t.name === 'game_leave')!;
      await leaveTool.execute('test', { swarm_id: 'sw-1' });
      expect(plugin.getWatchState().active).toBe(false);

      await plugin.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('works without swarm_id (auto-resolve)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/leave')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ disbanded: true }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }) as any;

    try {
      const api = mockApi();
      const plugin = new DkgGamePlugin(mockClient(), {}, undefined);
      plugin.register(api);

      const leaveTool = api.tools.find(t => t.name === 'game_leave')!;
      const result = await leaveTool.execute('test', {});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.status).toBe('disbanded');

      await plugin.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not stop autopilot when leaving a different swarm', async () => {
    const originalFetch = globalThis.fetch;
    const travelingSwarm = {
      id: 'sw-1', name: 'Test', status: 'traveling', playerCount: 2, maxPlayers: 3,
      leaderId: 'p1', leaderName: 'Player1', players: [], currentTurn: 1,
      gameState: { sessionId: 's', player: 'p', epochs: 10, trainingTokens: 500,
        apiCredits: 5, computeUnits: 10, modelWeights: 3, trac: 100, month: 1, day: 1,
        party: [{ id: 'a1', name: 'Agent', health: 100, alive: true }],
        status: 'active', moveCount: 1 },
      voteStatus: null, lastTurn: null,
    };

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes('/swarm/')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(travelingSwarm) });
      }
      if (urlStr.includes('/locations')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ locations: [] }) });
      }
      if (urlStr.includes('/leave')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ disbanded: true }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }) as any;

    try {
      const consultAgent = vi.fn().mockResolvedValue('ACTION: advance');
      const plugin = new DkgGamePlugin(mockClient(), { pollIntervalMs: 100_000 }, consultAgent);
      const api = mockApi();
      plugin.register(api);

      // Start autopilot for sw-1
      await plugin.getService().start('sw-1');
      expect(plugin.getService().isRunning).toBe(true);

      // Leave sw-2 — autopilot for sw-1 should NOT stop
      const leaveTool = api.tools.find(t => t.name === 'game_leave')!;
      await leaveTool.execute('test', { swarm_id: 'sw-2' });
      expect(plugin.getService().isRunning).toBe(true);

      await plugin.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not stop autopilot when leave API fails', async () => {
    const originalFetch = globalThis.fetch;
    const travelingSwarm = {
      id: 'sw-1', name: 'Test', status: 'traveling', playerCount: 2, maxPlayers: 3,
      leaderId: 'p1', leaderName: 'Player1', players: [], currentTurn: 1,
      gameState: { sessionId: 's', player: 'p', epochs: 10, trainingTokens: 500,
        apiCredits: 5, computeUnits: 10, modelWeights: 3, trac: 100, month: 1, day: 1,
        party: [{ id: 'a1', name: 'Agent', health: 100, alive: true }],
        status: 'active', moveCount: 1 },
      voteStatus: null, lastTurn: null,
    };

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes('/swarm/')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(travelingSwarm) });
      }
      if (urlStr.includes('/locations')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ locations: [] }) });
      }
      if (urlStr.includes('/leave')) {
        // Simulate API 400 error (e.g., multiple active swarms)
        return Promise.resolve({ ok: false, status: 400, text: () => Promise.resolve('Multiple active swarms found') });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }) as any;

    try {
      const consultAgent = vi.fn().mockResolvedValue('ACTION: advance');
      const plugin = new DkgGamePlugin(mockClient(), { pollIntervalMs: 100_000 }, consultAgent);
      const api = mockApi();
      plugin.register(api);

      // Start autopilot for sw-1
      await plugin.getService().start('sw-1');
      expect(plugin.getService().isRunning).toBe(true);

      // Leave with no swarm_id — API fails with 400
      const leaveTool = api.tools.find(t => t.name === 'game_leave')!;
      const result = await leaveTool.execute('test', {});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('400');

      // Autopilot should still be running since leave failed
      expect(plugin.getService().isRunning).toBe(true);

      await plugin.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Tool error handling
// ---------------------------------------------------------------------------

describe('game tool error handling', () => {
  it('returns friendly error when daemon is unreachable', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('fetch failed'));

    try {
      const api = mockApi();
      const plugin = new DkgGamePlugin(mockClient(), {}, undefined);
      plugin.register(api);

      const lobbyTool = api.tools.find(t => t.name === 'game_lobby')!;
      const result = await lobbyTool.execute('test', {});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('not reachable');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns error message for API errors', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Swarm not found'),
    });

    try {
      const api = mockApi();
      const plugin = new DkgGamePlugin(mockClient(), {}, undefined);
      plugin.register(api);

      const statusTool = api.tools.find(t => t.name === 'game_status')!;
      const result = await statusTool.execute('test', { swarm_id: 'nonexistent' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('404');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// game_start lobby guard
// ---------------------------------------------------------------------------

describe('game_start lobby guard', () => {
  const recruitingSwarm = {
    id: 'sw-1', name: 'Test', status: 'recruiting', playerCount: 1, maxPlayers: 3,
    leaderId: 'p1', leaderName: 'Player1', players: [], currentTurn: 0, gameState: null,
    voteStatus: null, lastTurn: null,
  };

  const travelingSwarm = {
    ...recruitingSwarm, status: 'traveling', currentTurn: 1,
    gameState: { sessionId: 's', player: 'p', epochs: 1, trainingTokens: 500, apiCredits: 5,
      computeUnits: 10, modelWeights: 3, trac: 100, month: 1, day: 1,
      party: [{ id: 'a1', name: 'Agent', health: 100, alive: true }],
      status: 'active', moveCount: 1 },
  };

  it('warns when lobby not full', async () => {
    const originalFetch = globalThis.fetch;
    let startCalled = false;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes('/start')) {
        startCalled = true;
        return Promise.resolve({ ok: true, json: () => Promise.resolve(travelingSwarm) });
      }
      if (urlStr.includes('/swarm/')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(recruitingSwarm) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }) as any;

    try {
      const api = mockApi();
      const plugin = new DkgGamePlugin(mockClient(), {}, undefined);
      plugin.register(api);

      const startTool = api.tools.find(t => t.name === 'game_start')!;
      const result = await startTool.execute('test', { swarm_id: 'sw-1' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.started).toBe(false);
      expect(parsed.blocked).toBe('lobby_not_full');
      expect(parsed.warning).toContain('1/3');
      expect(parsed.playerCount).toBe(1);
      expect(parsed.maxPlayers).toBe(3);
      expect(startCalled).toBe(false);

      await plugin.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('force=true bypasses lobby guard', async () => {
    const originalFetch = globalThis.fetch;
    let startCalled = false;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes('/start')) {
        startCalled = true;
        return Promise.resolve({ ok: true, json: () => Promise.resolve(travelingSwarm) });
      }
      if (urlStr.includes('/swarm/')) {
        // Return recruiting with unfilled lobby — without force, the guard would block
        return Promise.resolve({ ok: true, json: () => Promise.resolve(recruitingSwarm) });
      }
      if (urlStr.includes('/locations')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ locations: [] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }) as any;

    try {
      const consultAgent = vi.fn().mockResolvedValue('ACTION: advance');
      const plugin = new DkgGamePlugin(mockClient(), { pollIntervalMs: 100_000 }, consultAgent);
      const api = mockApi();
      plugin.register(api);

      const startTool = api.tools.find(t => t.name === 'game_start')!;
      const result = await startTool.execute('test', { swarm_id: 'sw-1', force: true });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.warning).toBeUndefined();
      expect(parsed.status).toBe('traveling');
      expect(startCalled).toBe(true);

      await plugin.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not kill watcher on API failure', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes('/join')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(recruitingSwarm) });
      }
      if (urlStr.includes('/swarm/')) {
        // Pre-check returns full lobby so guard lets it through
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...recruitingSwarm, playerCount: 3 }) });
      }
      if (urlStr.includes('/start')) {
        // API fails (e.g., not the leader)
        return Promise.resolve({ ok: false, status: 403, text: () => Promise.resolve('Only the leader can start') });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }) as any;

    try {
      const consultAgent = vi.fn().mockResolvedValue('ACTION: advance');
      const plugin = new DkgGamePlugin(mockClient(), { watchIntervalMs: 60_000 }, consultAgent);
      const api = mockApi();
      plugin.register(api);

      // Start watcher via join
      const joinTool = api.tools.find(t => t.name === 'game_join')!;
      await joinTool.execute('test', { swarm_id: 'sw-1', player_name: 'Bot' });
      expect(plugin.getWatchState().active).toBe(true);

      // game_start fails — watcher should survive
      // No force: pre-check sees full lobby (3/3), lets it through, /start returns 403
      const startTool = api.tools.find(t => t.name === 'game_start')!;
      const result = await startTool.execute('test', { swarm_id: 'sw-1' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('403');

      // Watcher survived the failed start
      expect(plugin.getWatchState().active).toBe(true);

      await plugin.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('stops watcher only on successful start', async () => {
    const originalFetch = globalThis.fetch;
    // Phase 1: join returns recruiting (starts watcher)
    // Phase 2: game_start — /swarm/ returns full lobby, /start succeeds, /swarm/ returns traveling for gameService
    let phase = 1;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (phase === 1) {
        if (urlStr.includes('/join')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(recruitingSwarm) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }
      // Phase 2: game_start flow
      if (urlStr.includes('/start')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(travelingSwarm) });
      }
      if (urlStr.includes('/swarm/')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(travelingSwarm) });
      }
      if (urlStr.includes('/locations')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ locations: [] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }) as any;

    try {
      const consultAgent = vi.fn().mockResolvedValue('ACTION: advance');
      const plugin = new DkgGamePlugin(mockClient(), { watchIntervalMs: 60_000, pollIntervalMs: 100_000 }, consultAgent);
      const api = mockApi();
      plugin.register(api);

      // Start watcher via join (phase 1: recruiting)
      const joinTool = api.tools.find(t => t.name === 'game_join')!;
      await joinTool.execute('test', { swarm_id: 'sw-1', player_name: 'Bot' });
      expect(plugin.getWatchState().active).toBe(true);

      // Switch to phase 2: game_start flow (traveling state for gameService)
      phase = 2;

      // game_start succeeds — watcher should be stopped, autopilot engaged
      const startTool = api.tools.find(t => t.name === 'game_start')!;
      await startTool.execute('test', { swarm_id: 'sw-1', force: true });
      expect(plugin.getWatchState().active).toBe(false);
      expect(plugin.getService().isRunning).toBe(true);

      await plugin.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// watchTick watcher retention on failed engage
// ---------------------------------------------------------------------------

describe('watchTick watcher retention', () => {
  const recruitingSwarm = {
    id: 'sw-1', name: 'Test', status: 'recruiting', playerCount: 1, maxPlayers: 3,
    leaderId: 'p1', leaderName: 'Player1', players: [], currentTurn: 0, gameState: null,
    voteStatus: null, lastTurn: null,
  };

  const travelingSwarm = {
    ...recruitingSwarm, status: 'traveling', currentTurn: 1,
    gameState: { sessionId: 's', player: 'p', epochs: 1, trainingTokens: 500, apiCredits: 5,
      computeUnits: 10, modelWeights: 3, trac: 100, month: 1, day: 1,
      party: [{ id: 'a1', name: 'Agent', health: 100, alive: true }],
      status: 'active', moveCount: 1 },
  };

  it('keeps watcher alive when tryAutoEngage fails', async () => {
    const originalFetch = globalThis.fetch;

    try {
      const consultAgent = vi.fn().mockResolvedValue('ACTION: advance');
      const plugin = new DkgGamePlugin(mockClient(), { watchIntervalMs: 60_000 }, consultAgent);
      const api = mockApi();
      plugin.register(api);

      // Start watcher via join (recruiting at join time)
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (String(url).includes('/join')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(recruitingSwarm) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }) as any;
      const joinTool = api.tools.find(t => t.name === 'game_join')!;
      await joinTool.execute('test', { swarm_id: 'sw-1', player_name: 'Bot' });
      expect(plugin.getWatchState().active).toBe(true);

      // Switch to traveling — watchTick enters the 'traveling' branch
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (String(url).includes('/swarm/')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(travelingSwarm) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }) as any;

      // Spy on tryAutoEngage to simulate failure (returns null) — avoids retry delays
      vi.spyOn(plugin as any, 'tryAutoEngage').mockResolvedValue(null);

      await (plugin as any).watchTick((plugin as any).watchEpoch);

      // Watcher stays alive: tryAutoEngage failed and isRunning is false
      expect(plugin.getWatchState().active).toBe(true);
      expect(plugin.getService().isRunning).toBe(false);

      await plugin.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('stops watcher after successful auto-engage', async () => {
    const originalFetch = globalThis.fetch;

    try {
      const consultAgent = vi.fn().mockResolvedValue('ACTION: advance');
      const plugin = new DkgGamePlugin(mockClient(), { watchIntervalMs: 60_000, pollIntervalMs: 100_000 }, consultAgent);
      const api = mockApi();
      plugin.register(api);

      // Join with recruiting swarm
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (String(url).includes('/join')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(recruitingSwarm) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }) as any;
      const joinTool = api.tools.find(t => t.name === 'game_join')!;
      await joinTool.execute('test', { swarm_id: 'sw-1', player_name: 'Bot' });
      expect(plugin.getWatchState().active).toBe(true);

      // Now switch to traveling — watchTick should auto-engage and stop watcher
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        const urlStr = String(url);
        if (urlStr.includes('/swarm/')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(travelingSwarm) });
        }
        if (urlStr.includes('/locations')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ locations: [] }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }) as any;

      await (plugin as any).watchTick((plugin as any).watchEpoch);

      // Autopilot engaged, watcher stopped
      expect(plugin.getService().isRunning).toBe(true);
      expect(plugin.getWatchState().active).toBe(false);

      await plugin.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// tryAutoEngage cancellation & tick overlap
// ---------------------------------------------------------------------------

describe('tryAutoEngage cancellation', () => {
  const recruitingSwarm = {
    id: 'sw-1', name: 'Test', status: 'recruiting', playerCount: 1, maxPlayers: 3,
    leaderId: 'p1', leaderName: 'Player1', players: [], currentTurn: 0, gameState: null,
    voteStatus: null, lastTurn: null,
  };

  const travelingSwarm = {
    ...recruitingSwarm, status: 'traveling', currentTurn: 1,
    gameState: { sessionId: 's', player: 'p', epochs: 1, trainingTokens: 500, apiCredits: 5,
      computeUnits: 10, modelWeights: 3, trac: 100, month: 1, day: 1,
      party: [{ id: 'a1', name: 'Agent', health: 100, alive: true }],
      status: 'active', moveCount: 1 },
  };

  it('tryAutoEngage bails when watcher is stopped during retry', async () => {
    const originalFetch = globalThis.fetch;

    try {
      const consultAgent = vi.fn().mockResolvedValue('ACTION: advance');
      const plugin = new DkgGamePlugin(mockClient(), { watchIntervalMs: 60_000 }, consultAgent);
      const api = mockApi();
      plugin.register(api);

      // Start watcher via join
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (String(url).includes('/join')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(recruitingSwarm) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }) as any;
      const joinTool = api.tools.find(t => t.name === 'game_join')!;
      await joinTool.execute('test', { swarm_id: 'sw-1', player_name: 'Bot' });
      expect(plugin.getWatchState().active).toBe(true);

      // Capture epoch, then stop watcher (simulating game_leave)
      const epoch = (plugin as any).watchEpoch;
      (plugin as any).stopWatch();

      // tryAutoEngage with the stale epoch should bail immediately
      const result = await (plugin as any).tryAutoEngage('sw-1', 2, epoch);
      expect(result).toBeNull();
      expect(plugin.getService().isRunning).toBe(false);

      await plugin.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('overlapping watchTick calls are prevented', async () => {
    const originalFetch = globalThis.fetch;

    try {
      const consultAgent = vi.fn().mockResolvedValue('ACTION: advance');
      const plugin = new DkgGamePlugin(mockClient(), { watchIntervalMs: 60_000 }, consultAgent);
      const api = mockApi();
      plugin.register(api);

      // Start watcher
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (String(url).includes('/join')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(recruitingSwarm) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }) as any;
      const joinTool = api.tools.find(t => t.name === 'game_join')!;
      await joinTool.execute('test', { swarm_id: 'sw-1', player_name: 'Bot' });
      expect(plugin.getWatchState().active).toBe(true);

      // Mock getSwarm to return traveling — tryAutoEngage will be spied to block
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (String(url).includes('/swarm/')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(travelingSwarm) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }) as any;

      // Block tryAutoEngage so the first tick stays "in progress"
      let resolveEngage!: () => void;
      const engagePromise = new Promise<void>(r => { resolveEngage = r; });
      vi.spyOn(plugin as any, 'tryAutoEngage').mockImplementation(async () => {
        await engagePromise;
        return null;
      });

      const epoch = (plugin as any).watchEpoch;

      // Fire first tick (will block on tryAutoEngage)
      const tick1 = (plugin as any).watchTick(epoch);

      // Fire second tick while first is still running — should be skipped
      const tick2Promise = (plugin as any).watchTick(epoch);

      // Unblock and wait
      resolveEngage();
      await tick1;
      await tick2Promise;

      // tryAutoEngage should have been called exactly once (second tick was skipped)
      expect((plugin as any).tryAutoEngage).toHaveBeenCalledTimes(1);

      await plugin.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Tool description assertions
// ---------------------------------------------------------------------------

describe('tool description guards', () => {
  it('game_start description discourages manual use', () => {
    const api = mockApi();
    const plugin = new DkgGamePlugin(mockClient(), {}, undefined);
    plugin.register(api);

    const startTool = api.tools.find(t => t.name === 'game_start')!;
    expect(startTool.description).toContain('Usually NOT needed');
    expect(startTool.description).toContain('watcher');
  });

  it('game_strategy sets and clears hint', async () => {
    const api = mockApi();
    const plugin = new DkgGamePlugin(mockClient(), {}, undefined);
    plugin.register(api);

    const tool = api.tools.find(t => t.name === 'game_strategy')!;

    // Set a hint
    const setResult = await tool.execute('call-1', { hint: 'play defensively' });
    const setParsed = JSON.parse(setResult.content[0].text);
    expect(setParsed.status).toBe('strategy_set');
    expect(setParsed.hint).toBe('play defensively');

    // Clear the hint
    const clearResult = await tool.execute('call-2', { hint: '' });
    const clearParsed = JSON.parse(clearResult.content[0].text);
    expect(clearParsed.status).toBe('strategy_cleared');
    expect(clearParsed.hint).toBeNull();
  });

  it('game_strategy trims whitespace-only hint to clear', async () => {
    const api = mockApi();
    const plugin = new DkgGamePlugin(mockClient(), {}, undefined);
    plugin.register(api);

    const tool = api.tools.find(t => t.name === 'game_strategy')!;
    const result = await tool.execute('call-1', { hint: '   ' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('strategy_cleared');
  });

  it('game_autopilot_start does not suggest calling game_start', () => {
    const api = mockApi();
    const plugin = new DkgGamePlugin(mockClient(), {}, undefined);
    plugin.register(api);

    const autopilotTool = api.tools.find(t => t.name === 'game_autopilot_start')!;
    expect(autopilotTool.description).not.toContain('call game_start first');
    expect(autopilotTool.description).toContain('auto-engages automatically');
  });

  it('game_create warns against manual start', () => {
    const api = mockApi();
    const plugin = new DkgGamePlugin(mockClient(), {}, undefined);
    plugin.register(api);

    const createTool = api.tools.find(t => t.name === 'game_create')!;
    expect(createTool.description).toContain('Do NOT call game_start');
  });

  it('game_join warns against calling game_start', () => {
    const api = mockApi();
    const plugin = new DkgGamePlugin(mockClient(), {}, undefined);
    plugin.register(api);

    const joinTool = api.tools.find(t => t.name === 'game_join')!;
    expect(joinTool.description).toContain('Do NOT call game_start');
  });

  it('game_start has force parameter', () => {
    const api = mockApi();
    const plugin = new DkgGamePlugin(mockClient(), {}, undefined);
    plugin.register(api);

    const startTool = api.tools.find(t => t.name === 'game_start')!;
    expect(startTool.parameters.properties.force).toBeDefined();
    expect(startTool.parameters.properties.force.type).toBe('boolean');
  });
});
