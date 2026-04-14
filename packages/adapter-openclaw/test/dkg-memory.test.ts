import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DkgMemoryPlugin,
  DkgMemorySearchManager,
  buildDkgMemoryRuntime,
  AGENT_CONTEXT_GRAPH,
  CHAT_TURNS_ASSERTION,
  PROJECT_MEMORY_ASSERTION,
  type DkgMemorySession,
  type DkgMemorySessionResolver,
} from '../src/DkgMemoryPlugin.js';
import { DkgDaemonClient } from '../src/dkg-client.js';
import type {
  MemoryPluginCapability,
  MemoryRuntimeRequest,
  OpenClawPluginApi,
} from '../src/types.js';

type RegisterToolSpy = ReturnType<typeof vi.fn>;
type RegisterMemoryCapabilitySpy = ReturnType<typeof vi.fn>;

interface MockApi extends OpenClawPluginApi {
  registerTool: RegisterToolSpy;
  registerHook: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  registerMemoryCapability: RegisterMemoryCapabilitySpy;
}

function makeApi(): MockApi {
  return {
    config: {},
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    on: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    registerMemoryCapability: vi.fn(),
  };
}

function makeResolver(
  overrides?: Partial<DkgMemorySession> & { available?: string[] },
): DkgMemorySessionResolver {
  return {
    getSession: () => ({
      projectContextGraphId: overrides?.projectContextGraphId,
      agentAddress: overrides?.agentAddress ?? 'did:dkg:agent:test',
    }),
    getDefaultAgentAddress: () => overrides?.agentAddress ?? 'did:dkg:agent:test',
    listAvailableContextGraphs: () => overrides?.available ?? [],
  };
}

describe('DkgMemoryPlugin.register', () => {
  let client: DkgDaemonClient;
  let plugin: DkgMemoryPlugin;

  beforeEach(() => {
    client = new DkgDaemonClient({ baseUrl: 'http://localhost:9200' });
    plugin = new DkgMemoryPlugin(client, { enabled: true }, makeResolver());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls api.registerMemoryCapability exactly once with a runtime factory', () => {
    const api = makeApi();
    plugin.register(api);

    expect(api.registerMemoryCapability).toHaveBeenCalledTimes(1);
    const capability = api.registerMemoryCapability.mock.calls[0][0] as MemoryPluginCapability;
    expect(typeof capability.runtime?.getMemorySearchManager).toBe('function');
  });

  it('registers dkg_memory_import as a conventional tool (not dkg_memory_search)', () => {
    const api = makeApi();
    plugin.register(api);

    const calls = api.registerTool.mock.calls;
    const toolNames = calls.map((c: any) => c[0].name);
    expect(toolNames).toContain('dkg_memory_import');
    expect(toolNames).not.toContain('dkg_memory_search');
  });

  it('dkg_memory_import returns needs_clarification when no CG can be resolved', async () => {
    const api = makeApi();
    plugin.register(api);
    const importTool = api.registerTool.mock.calls.find((c: any) => c[0].name === 'dkg_memory_import')[0];
    const result = await importTool.execute('call-1', { text: 'some memory' });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe('needs_clarification');
    expect(payload).toHaveProperty('availableContextGraphs');
  });

  it('dkg_memory_import writes into the memory assertion when an explicit CG is provided', async () => {
    const createSpy = vi.spyOn(client, 'createAssertion').mockResolvedValue({
      assertionUri: 'urn:test:assertion',
      alreadyExists: false,
    });
    const writeSpy = vi.spyOn(client, 'writeAssertion').mockResolvedValue({ written: 4 });

    const api = makeApi();
    plugin.register(api);
    const importTool = api.registerTool.mock.calls.find((c: any) => c[0].name === 'dkg_memory_import')[0];
    const result = await importTool.execute('call-1', {
      text: 'Prefers dark mode',
      contextGraphId: 'research-x',
    });

    expect(createSpy).toHaveBeenCalledWith('research-x', PROJECT_MEMORY_ASSERTION, undefined);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [cg, assertion, quads] = writeSpy.mock.calls[0];
    expect(cg).toBe('research-x');
    expect(assertion).toBe(PROJECT_MEMORY_ASSERTION);
    expect(Array.isArray(quads)).toBe(true);
    // Minimal schema-aligned shape: schema:Thing + schema:description + schema:dateCreated + schema:creator
    expect(quads.length).toBe(4);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe('stored');
    expect(payload.contextGraphId).toBe('research-x');
    expect(payload.assertionName).toBe(PROJECT_MEMORY_ASSERTION);
  });

  it('dkg_memory_import passes subGraphName through to createAssertion and writeAssertion', async () => {
    const createSpy = vi.spyOn(client, 'createAssertion').mockResolvedValue({
      assertionUri: 'urn:test:assertion',
      alreadyExists: false,
    });
    const writeSpy = vi.spyOn(client, 'writeAssertion').mockResolvedValue({ written: 4 });

    const api = makeApi();
    const pluginWithResolver = new DkgMemoryPlugin(client, { enabled: true }, makeResolver({
      available: ['research-x'],
    }));
    pluginWithResolver.register(api);
    const importTool = api.registerTool.mock.calls.find((c: any) => c[0].name === 'dkg_memory_import')[0];
    await importTool.execute('call-1', {
      text: 'a protocol decision',
      contextGraphId: 'research-x',
      subGraphName: 'protocols',
    });

    expect(createSpy).toHaveBeenCalledWith('research-x', PROJECT_MEMORY_ASSERTION, { subGraphName: 'protocols' });
    expect(writeSpy).toHaveBeenCalledWith(
      'research-x',
      PROJECT_MEMORY_ASSERTION,
      expect.any(Array),
      { subGraphName: 'protocols' },
    );
  });

  it('dkg_memory_import rejects empty text with a tool-level error', async () => {
    const api = makeApi();
    plugin.register(api);
    const importTool = api.registerTool.mock.calls.find((c: any) => c[0].name === 'dkg_memory_import')[0];
    const result = await importTool.execute('call-1', { text: '  ' });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toMatch(/text/);
  });
});

describe('DkgMemorySearchManager', () => {
  let client: DkgDaemonClient;

  beforeEach(() => {
    client = new DkgDaemonClient({ baseUrl: 'http://localhost:9200' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('readFile', () => {
    it('returns an empty shell for any relPath without calling the daemon', async () => {
      const querySpy = vi.spyOn(client, 'query');
      const manager = new DkgMemorySearchManager({ client, resolver: makeResolver() });
      const result = await manager.readFile({ relPath: 'MEMORY.md' });
      expect(result).toEqual({ text: '', path: 'MEMORY.md' });
      expect(querySpy).not.toHaveBeenCalled();
    });
  });

  describe('status', () => {
    it('returns a synchronous MemoryProviderStatus with backend=builtin and provider=dkg', () => {
      const manager = new DkgMemorySearchManager({ client, resolver: makeResolver() });
      const status = manager.status();
      expect(status.backend).toBe('builtin');
      expect(status.provider).toBe('dkg');
      expect(status.vector).toEqual({ enabled: false, available: false });
      expect(status.fts).toEqual({ enabled: false, available: false });
      expect(status.sources).toEqual(['memory', 'sessions']);
    });
  });

  describe('probes', () => {
    it('probeEmbeddingAvailability returns ok:false with an explanation', async () => {
      const manager = new DkgMemorySearchManager({ client, resolver: makeResolver() });
      const result = await manager.probeEmbeddingAvailability();
      expect(result.ok).toBe(false);
      expect(result.error).toBeTypeOf('string');
    });

    it('probeVectorAvailability returns a bare boolean false (not an object)', async () => {
      // FAIL #2 from openclaw-runtime's contract audit: upstream declares
      // this method Promise<boolean>, and upstream's `if (available) …`
      // check would treat any object (even {ok:false}) as truthy and
      // silently claim a vector backend is available. The DKG provider
      // must return a bare `false` to opt out honestly.
      const manager = new DkgMemorySearchManager({ client, resolver: makeResolver() });
      const result = await manager.probeVectorAvailability();
      expect(result).toBe(false);
      expect(typeof result).toBe('boolean');
      // And the truthiness check must evaluate to false the way upstream
      // uses it, not the way a {ok:false,...} object would (truthy).
      expect(result ? 'upstream-would-use-vector' : 'upstream-skips-vector').toBe('upstream-skips-vector');
    });
  });

  describe('search', () => {
    it('issues one /api/query against agent-context / chat-turns when no project CG is resolved', async () => {
      const querySpy = vi.spyOn(client, 'query').mockResolvedValue({ result: { bindings: [] } });
      const manager = new DkgMemorySearchManager({ client, resolver: makeResolver() });

      await manager.search('hello world');

      expect(querySpy).toHaveBeenCalledTimes(1);
      const opts = querySpy.mock.calls[0][1]!;
      expect(opts.contextGraphId).toBe(AGENT_CONTEXT_GRAPH);
      expect(opts.view).toBe('working-memory');
      expect(opts.assertionName).toBe(CHAT_TURNS_ASSERTION);
      expect(opts.agentAddress).toBe('did:dkg:agent:test');
    });

    it('issues two parallel /api/query calls when a project CG is resolved', async () => {
      const querySpy = vi.spyOn(client, 'query').mockResolvedValue({ result: { bindings: [] } });
      const manager = new DkgMemorySearchManager({
        client,
        resolver: makeResolver({ projectContextGraphId: 'research-x' }),
      });

      await manager.search('hello world');

      expect(querySpy).toHaveBeenCalledTimes(2);
      const firstOpts = querySpy.mock.calls[0][1]!;
      const secondOpts = querySpy.mock.calls[1][1]!;
      const optsByCg: Record<string, any> = {
        [firstOpts.contextGraphId!]: firstOpts,
        [secondOpts.contextGraphId!]: secondOpts,
      };
      expect(optsByCg[AGENT_CONTEXT_GRAPH].assertionName).toBe(CHAT_TURNS_ASSERTION);
      expect(optsByCg[AGENT_CONTEXT_GRAPH].view).toBe('working-memory');
      expect(optsByCg['research-x'].assertionName).toBe(PROJECT_MEMORY_ASSERTION);
      expect(optsByCg['research-x'].view).toBe('working-memory');
    });

    it('merges results from both graphs and tags them with the correct source', async () => {
      vi.spyOn(client, 'query')
        .mockResolvedValueOnce({
          result: {
            bindings: [
              { uri: { value: 'urn:m:1' }, text: { value: 'session hello world note' } },
            ],
          },
        })
        .mockResolvedValueOnce({
          result: {
            bindings: [
              { uri: { value: 'urn:m:2' }, text: { value: 'project hello world memory' } },
            ],
          },
        });

      const manager = new DkgMemorySearchManager({
        client,
        resolver: makeResolver({ projectContextGraphId: 'research-x' }),
      });

      const results = await manager.search('hello world');
      expect(results).toHaveLength(2);
      const sources = results.map(r => r.source).sort();
      expect(sources).toEqual(['memory', 'sessions']);
      for (const r of results) {
        expect(r.startLine).toBe(1);
        expect(r.endLine).toBe(1);
        expect(typeof r.path).toBe('string');
        expect(typeof r.snippet).toBe('string');
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(1);
      }
    });

    it('degrades to the succeeding graph when one query fails', async () => {
      vi.spyOn(client, 'query')
        .mockResolvedValueOnce({ result: { bindings: [{ uri: { value: 'urn:m:1' }, text: { value: 'session match hit' } }] } })
        .mockRejectedValueOnce(new Error('project cg offline'));

      const manager = new DkgMemorySearchManager({
        client,
        resolver: makeResolver({ projectContextGraphId: 'research-x' }),
      });

      const results = await manager.search('match');
      expect(results).toHaveLength(1);
      expect(results[0].source).toBe('sessions');
    });

    it('returns an empty array for queries with no meaningful keywords', async () => {
      const querySpy = vi.spyOn(client, 'query');
      const manager = new DkgMemorySearchManager({ client, resolver: makeResolver() });
      const results = await manager.search('a');
      expect(results).toEqual([]);
      expect(querySpy).not.toHaveBeenCalled();
    });

    it('respects maxResults when merging results', async () => {
      vi.spyOn(client, 'query').mockResolvedValue({
        result: {
          bindings: Array.from({ length: 20 }, (_, i) => ({
            uri: { value: `urn:m:${i}` },
            text: { value: `hello world item ${i}` },
          })),
        },
      });

      const manager = new DkgMemorySearchManager({ client, resolver: makeResolver() });
      const results = await manager.search('hello world', { maxResults: 5 });
      expect(results.length).toBeLessThanOrEqual(5);
    });
  });
});

describe('buildDkgMemoryRuntime', () => {
  it('returns a factory that yields a DkgMemorySearchManager wired to the given resolver', async () => {
    const client = new DkgDaemonClient({ baseUrl: 'http://localhost:9200' });
    const runtime = buildDkgMemoryRuntime(client, makeResolver());

    const request: MemoryRuntimeRequest = { sessionKey: 'test-session' };
    const result = await runtime.getMemorySearchManager(request);
    expect(result.manager).toBeInstanceOf(DkgMemorySearchManager);
    expect(result.error).toBeUndefined();
  });

  it('returns { manager: null, error } when DkgMemorySearchManager construction throws', async () => {
    // FAIL #3 from openclaw-runtime's audit: MemoryRuntimeResult.manager
    // must be nullable so the runtime can gracefully decline to build a
    // manager rather than propagating a construction throw. Simulate a
    // construction failure by spying on the class prototype.
    const client = new DkgDaemonClient({ baseUrl: 'http://localhost:9200' });
    const runtime = buildDkgMemoryRuntime(client, makeResolver());

    const buildStatusSpy = vi
      .spyOn(DkgMemorySearchManager.prototype as any, 'buildStatus')
      .mockImplementation(() => {
        throw new Error('simulated construction failure');
      });
    try {
      const result = await runtime.getMemorySearchManager({ sessionKey: 'test-session' });
      expect(result.manager).toBeNull();
      expect(result.error).toContain('simulated construction failure');
    } finally {
      buildStatusSpy.mockRestore();
    }
  });

  it('resolveMemoryBackendConfig reports kind=dkg and the agent-context graph', () => {
    const client = new DkgDaemonClient({ baseUrl: 'http://localhost:9200' });
    const runtime = buildDkgMemoryRuntime(client, makeResolver());
    const cfg = runtime.resolveMemoryBackendConfig!({});
    expect(cfg.kind).toBe('dkg');
    expect(cfg.agentContextGraph).toBe(AGENT_CONTEXT_GRAPH);
  });
});
