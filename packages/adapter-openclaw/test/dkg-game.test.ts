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
  it('registers all 10 game tools', () => {
    const api = mockApi();
    const plugin = new DkgGamePlugin(mockClient(), {}, undefined);
    plugin.register(api);

    const toolNames = api.tools.map(t => t.name);
    expect(toolNames).toContain('game_lobby');
    expect(toolNames).toContain('game_join');
    expect(toolNames).toContain('game_create');
    expect(toolNames).toContain('game_start');
    expect(toolNames).toContain('game_status');
    expect(toolNames).toContain('game_vote');
    expect(toolNames).toContain('game_locations');
    expect(toolNames).toContain('game_leaderboard');
    expect(toolNames).toContain('game_autopilot_start');
    expect(toolNames).toContain('game_autopilot_stop');
    expect(api.tools.length).toBe(10);
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
    // 8 core DKG tools + 10 game tools = 18
    expect(toolNames).toContain('dkg_status');
    expect(toolNames).toContain('game_lobby');
    expect(toolNames).toContain('game_autopilot_start');
    expect(tools.length).toBe(18);
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
    expect(tools.length).toBe(8); // Only core DKG tools
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
    // Mock the getSwarm call to prevent actual HTTP
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ locations: [] }),
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
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ locations: [] }),
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
    expect(result.params).toEqual({ item: 'trainingTokens' });
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
