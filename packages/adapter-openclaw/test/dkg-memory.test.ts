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
  overrides?: Partial<DkgMemorySession> & {
    available?: string[];
    /**
     * When set to `null`, `getDefaultAgentAddress` returns `undefined` to
     * simulate the node peer-id probe being pending. Used by B2 tests.
     */
    defaultAgentAddress?: string | null;
  },
): DkgMemorySessionResolver {
  const defaultAgentAddress = overrides?.defaultAgentAddress === null
    ? undefined
    : overrides?.defaultAgentAddress ?? overrides?.agentAddress ?? 'did:dkg:agent:test';
  return {
    getSession: () => ({
      projectContextGraphId: overrides?.projectContextGraphId,
      agentAddress: overrides?.agentAddress ?? 'did:dkg:agent:test',
    }),
    getDefaultAgentAddress: () => defaultAgentAddress,
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

  it('registers dkg_memory_import as a conventional tool (not dkg_memory_search) on a modern gateway', () => {
    // On a modern gateway the memory slot routes reads, so
    // `dkg_memory_search` MUST NOT be registered — it would compete with
    // the slot router. See B7: legacy fallback only.
    const api = makeApi();
    plugin.register(api);

    const calls = api.registerTool.mock.calls;
    const toolNames = calls.map((c: any) => c[0].name);
    expect(toolNames).toContain('dkg_memory_import');
    expect(toolNames).not.toContain('dkg_memory_search');
  });

  it('also registers dkg_memory_search as a compat tool when api.registerMemoryCapability is missing', () => {
    // Bug B7: older gateways do not implement the memory-slot contract,
    // so reads cannot route through `api.registerMemoryCapability`. Without
    // a fallback, the adapter would leave such installs with no recall
    // path at all. Register a compat `dkg_memory_search` tool in that
    // case so the agent can still query WM directly.
    const legacyApi = makeApi();
    (legacyApi as any).registerMemoryCapability = undefined;
    plugin.register(legacyApi);

    const toolNames = legacyApi.registerTool.mock.calls.map((c: any) => c[0].name);
    expect(toolNames).toContain('dkg_memory_import');
    expect(toolNames).toContain('dkg_memory_search');
  });

  it('dkg_memory_search compat tool delegates to DkgMemorySearchManager.search', async () => {
    // The compat tool must hit the same search path the slot uses, so
    // results are consistent across gateway generations. Verify the
    // tool triggers at least one /api/query call against agent-context.
    const querySpy = vi.spyOn(client, 'query').mockResolvedValue({
      result: {
        bindings: [
          { uri: { value: 'urn:m:1' }, text: { value: 'alpha beta memory hit' } },
        ],
      },
    });

    const legacyApi = makeApi();
    (legacyApi as any).registerMemoryCapability = undefined;
    plugin.register(legacyApi);
    const searchTool = legacyApi.registerTool.mock.calls.find(
      (c: any) => c[0].name === 'dkg_memory_search',
    )[0];

    const result = await searchTool.execute('call-1', { query: 'alpha beta', maxResults: 5 });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe('ok');
    expect(Array.isArray(payload.results)).toBe(true);
    expect(querySpy).toHaveBeenCalled();
    const opts = querySpy.mock.calls[0][1]!;
    expect(opts.contextGraphId).toBe(AGENT_CONTEXT_GRAPH);
    expect(opts.assertionName).toBe(CHAT_TURNS_ASSERTION);
    expect(opts.view).toBe('working-memory');
  });

  it('dkg_memory_search compat tool rejects an empty query with a tool-level error', async () => {
    const legacyApi = makeApi();
    (legacyApi as any).registerMemoryCapability = undefined;
    plugin.register(legacyApi);
    const searchTool = legacyApi.registerTool.mock.calls.find(
      (c: any) => c[0].name === 'dkg_memory_search',
    )[0];
    const result = await searchTool.execute('call-1', { query: '   ' });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toMatch(/query/);
  });

  it('dkg_memory_import returns needs_clarification when no contextGraphId is supplied', async () => {
    // Bug B1: `execute(toolCallId, params)` has no session-context parameter
    // from upstream, so the tool cannot resolve a UI-selected project CG
    // implicitly. The tool therefore requires the agent to pass
    // `contextGraphId` explicitly and falls back to a structured
    // clarification response when absent.
    const api = makeApi();
    plugin.register(api);
    const importTool = api.registerTool.mock.calls.find((c: any) => c[0].name === 'dkg_memory_import')[0];
    const result = await importTool.execute('call-1', { text: 'some memory' });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe('needs_clarification');
    expect(payload).toHaveProperty('availableContextGraphs');
    expect(payload.reason).toMatch(/contextGraphId|project context graph/i);
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

    // createAssertion is called with exactly two positional args — no
    // subGraphName opts. Bug B3 removed subgraph-scoped writes from v1
    // because `subGraphName` + `view: 'working-memory'` is not supported
    // by the query engine; any subgraph-scoped write would be unreadable.
    expect(createSpy).toHaveBeenCalledWith('research-x', PROJECT_MEMORY_ASSERTION);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const writeArgs = writeSpy.mock.calls[0];
    expect(writeArgs[0]).toBe('research-x');
    expect(writeArgs[1]).toBe(PROJECT_MEMORY_ASSERTION);
    expect(Array.isArray(writeArgs[2])).toBe(true);
    // writeAssertion is called with exactly three args — no opts.
    expect(writeArgs.length).toBe(3);
    // Minimal schema-aligned shape: schema:Thing + schema:description + schema:dateCreated + schema:creator
    expect(writeArgs[2].length).toBe(4);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe('stored');
    expect(payload.contextGraphId).toBe('research-x');
    expect(payload.assertionName).toBe(PROJECT_MEMORY_ASSERTION);
    // subGraphName is NOT in the stored response shape anymore.
    expect(payload).not.toHaveProperty('subGraphName');
  });

  it('dkg_memory_import ignores subGraphName in params (retired in v1 per B3)', async () => {
    // Bug B3 regression guard: even if an older agent passes
    // `subGraphName: 'protocols'`, the tool MUST NOT plumb it into
    // createAssertion / writeAssertion. Subgraph-scoped writes combined
    // with `view: 'working-memory'` reads throw from the query engine
    // at dkg-query-engine.ts:120-124, so the data would be silently
    // unreadable. Retired until V10.x supports subgraph + view together.
    //
    // Use a fresh context graph id for this test. The plugin caches
    // `${cg}::${assertion}` in a module-level ASSERTION_ENSURED Set
    // across all DkgMemoryPlugin instances, so reusing 'research-x'
    // from the previous test would skip the createAssertion call and
    // make this test's write-args assertion a no-op.
    const createSpy = vi.spyOn(client, 'createAssertion').mockResolvedValue({
      assertionUri: 'urn:test:assertion',
      alreadyExists: false,
    });
    const writeSpy = vi.spyOn(client, 'writeAssertion').mockResolvedValue({ written: 4 });

    const api = makeApi();
    plugin.register(api);
    const importTool = api.registerTool.mock.calls.find((c: any) => c[0].name === 'dkg_memory_import')[0];
    await importTool.execute('call-1', {
      text: 'a protocol decision',
      contextGraphId: 'research-subgraph-guard',
      subGraphName: 'protocols',
    });

    // Neither createAssertion nor writeAssertion receive subGraphName.
    expect(createSpy).toHaveBeenCalledWith('research-subgraph-guard', PROJECT_MEMORY_ASSERTION);
    expect(createSpy.mock.calls[0].length).toBe(2);
    const writeArgs = writeSpy.mock.calls[0];
    expect(writeArgs.length).toBe(3);
    expect(writeArgs[3]).toBeUndefined();
  });

  it('dkg_memory_import returns retryable needs_clarification when node peer-id probe is pending', async () => {
    // Bug B2: when the resolver's getDefaultAgentAddress returns undefined
    // (daemon probe not yet complete, /api/status failed, daemon down),
    // the tool MUST fail with a retryable clarification rather than
    // writing a durable `did:dkg:agent:unknown` creator triple.
    const createSpy = vi.spyOn(client, 'createAssertion');
    const writeSpy = vi.spyOn(client, 'writeAssertion');

    const api = makeApi();
    const pluginWithUndefinedAddress = new DkgMemoryPlugin(
      client,
      { enabled: true },
      makeResolver({ defaultAgentAddress: null }),
    );
    pluginWithUndefinedAddress.register(api);
    const importTool = api.registerTool.mock.calls.find((c: any) => c[0].name === 'dkg_memory_import')[0];
    const result = await importTool.execute('call-1', {
      text: 'something',
      contextGraphId: 'research-x',
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe('needs_clarification');
    expect(payload.retryable).toBe(true);
    expect(payload.reason).toMatch(/agent address|peer identity|pending/i);
    // CRITICAL: neither the assertion create nor the write fired.
    // No durable `did:dkg:agent:unknown` provenance triple was written.
    expect(createSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
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
