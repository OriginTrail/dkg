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
     * When set to `null`, `getDefaultAgentAddress` returns `undefined` AND
     * `getSession().agentAddress` is also undefined, simulating the node
     * peer-id probe being pending. This mirrors the real resolver in
     * `DkgNodePlugin.memorySessionResolver` where session.agentAddress is
     * always `this.nodePeerId`, so both surfaces are unresolved together.
     * Used by the B2 and B15 tests.
     */
    defaultAgentAddress?: string | null;
  },
): DkgMemorySessionResolver {
  const pending = overrides?.defaultAgentAddress === null;
  const defaultAgentAddress = pending
    ? undefined
    : overrides?.defaultAgentAddress ?? overrides?.agentAddress ?? 'did:dkg:agent:test';
  const sessionAgentAddress = pending
    ? undefined
    : overrides?.agentAddress ?? 'did:dkg:agent:test';
  return {
    getSession: () => ({
      projectContextGraphId: overrides?.projectContextGraphId,
      agentAddress: sessionAgentAddress,
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
    // Historical note: a previous revision of this file used a module-
    // level `ASSERTION_ENSURED` cache keyed by `${cg}::${assertion}` to
    // skip redundant createAssertion calls. That cache was removed in
    // the B14 fix because it was keyed by the wrong identity shape
    // (process-global, not per-agent/node). Every write now calls
    // createAssertion unconditionally; the daemon short-circuits on
    // already-created assertions.
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

  it('dkg_memory_import calls createAssertion on every write, not just the first (Codex B14)', async () => {
    // B14: previously a process-global `ASSERTION_ENSURED` Set skipped
    // subsequent createAssertion calls on the same (cg, name) pair. That
    // cache was wrong-shaped — WM assertions are per agent/node, and a
    // cached hit from a different daemon/peer or a post-reset run could
    // let a write hit an assertion that was never created. The fix
    // removes the cache and relies on the daemon's idempotent
    // createAssertion semantics each time. This test writes twice on
    // the same CG within the same plugin instance and asserts both
    // writes triggered a createAssertion call.
    const createSpy = vi.spyOn(client, 'createAssertion').mockResolvedValue({
      assertionUri: 'urn:test:assertion',
      alreadyExists: false,
    });
    const writeSpy = vi.spyOn(client, 'writeAssertion').mockResolvedValue({ written: 4 });

    const api = makeApi();
    plugin.register(api);
    const importTool = api.registerTool.mock.calls.find((c: any) => c[0].name === 'dkg_memory_import')[0];

    await importTool.execute('call-1', { text: 'first memory', contextGraphId: 'research-b14' });
    await importTool.execute('call-2', { text: 'second memory', contextGraphId: 'research-b14' });

    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(writeSpy).toHaveBeenCalledTimes(2);
    // Both calls target the same CG + assertion name.
    expect(createSpy.mock.calls[0]).toEqual(['research-b14', PROJECT_MEMORY_ASSERTION]);
    expect(createSpy.mock.calls[1]).toEqual(['research-b14', PROJECT_MEMORY_ASSERTION]);
  });

  it('dkg_memory_search compat tool returns retryable needs_clarification when peer-id probe is pending (Codex B15)', async () => {
    // B15: the legacy `dkg_memory_search` compat tool on older gateways
    // must apply the same peer-id preflight that `getMemorySearchManager`
    // uses on the slot-routed path. Without the guard, an early-turn
    // search on a legacy gateway would hit the WM query engine with
    // `agentAddress: undefined`, the engine would throw
    // `'agentAddress is required for the working-memory view'`, and
    // `search()`'s in-loop `.catch` would swallow the throw and return
    // `status: 'ok', results: []` — indistinguishable from "no memories
    // found". The guard surfaces the transient state as a retryable
    // clarification instead.
    const querySpy = vi.spyOn(client, 'query');

    const legacyApi = makeApi();
    (legacyApi as any).registerMemoryCapability = undefined;
    const pluginWithUndefinedAddress = new DkgMemoryPlugin(
      client,
      { enabled: true },
      makeResolver({ defaultAgentAddress: null }),
    );
    pluginWithUndefinedAddress.register(legacyApi);
    const searchTool = legacyApi.registerTool.mock.calls.find(
      (c: any) => c[0].name === 'dkg_memory_search',
    )[0];

    const result = await searchTool.execute('call-1', { query: 'alpha beta' });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.status).toBe('needs_clarification');
    expect(payload.retryable).toBe(true);
    expect(payload.reason).toMatch(/agent address|peer identity|pending/i);
    // CRITICAL: no WM query fired while the probe was unresolved.
    expect(querySpy).not.toHaveBeenCalled();
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

  it('returns { manager: null, error } when the node peer ID probe has not yet landed (B12)', async () => {
    // B12: before constructing the manager, the factory must resolve an
    // effective agent address (session-scoped or default). If neither is
    // available — typically because the daemon /api/status probe has not
    // yet completed — returning a live manager would turn every WM read
    // into a silently-caught query-engine throw (`agentAddress is required
    // for the working-memory view`). Instead surface "backend not ready"
    // via the null-manager contract path so upstream uses its fallback.
    const client = new DkgDaemonClient({ baseUrl: 'http://localhost:9200' });
    const resolver: DkgMemorySessionResolver = {
      getSession: () => undefined,
      getDefaultAgentAddress: () => undefined,
      listAvailableContextGraphs: () => [],
    };
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const runtime = buildDkgMemoryRuntime(client, resolver, logger as any);

    const result = await runtime.getMemorySearchManager({ sessionKey: 'test-session' });
    expect(result.manager).toBeNull();
    expect(result.error).toContain('peer ID not yet available');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('prefers session-scoped agentAddress over the default when constructing the manager (B12)', async () => {
    // When the lazy re-probe hasn't landed but a session-scoped address is
    // stamped on the dispatch, the factory must still construct a live
    // manager using the session-scoped path rather than falling through
    // to the null-manager branch.
    const client = new DkgDaemonClient({ baseUrl: 'http://localhost:9200' });
    const resolver: DkgMemorySessionResolver = {
      getSession: () => ({ agentAddress: 'did:dkg:agent:session-specific' }),
      getDefaultAgentAddress: () => undefined,
      listAvailableContextGraphs: () => [],
    };
    const runtime = buildDkgMemoryRuntime(client, resolver);

    const result = await runtime.getMemorySearchManager({ sessionKey: 'scoped-session' });
    expect(result.manager).toBeInstanceOf(DkgMemorySearchManager);
    expect(result.error).toBeUndefined();
  });

  it('constructs a live manager from the default peer ID when no session stamp exists (B12 recovery path)', async () => {
    // After the lazy re-probe completes, subsequent dispatches should see
    // a cached default address and get a live manager back — even when no
    // session-scoped stamp is present. This exercises the "default only"
    // branch of the resolvedAgentAddress fallback.
    const client = new DkgDaemonClient({ baseUrl: 'http://localhost:9200' });
    const resolver: DkgMemorySessionResolver = {
      getSession: () => undefined,
      getDefaultAgentAddress: () => 'did:dkg:agent:probed',
      listAvailableContextGraphs: () => [],
    };
    const runtime = buildDkgMemoryRuntime(client, resolver);

    const result = await runtime.getMemorySearchManager({ sessionKey: 'recovered-session' });
    expect(result.manager).toBeInstanceOf(DkgMemorySearchManager);
    expect(result.error).toBeUndefined();
  });
});
