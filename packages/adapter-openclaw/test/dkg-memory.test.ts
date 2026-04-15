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
  // By default, stamp the workspace config to name adapter-openclaw as
  // the memory-slot owner. This represents a fully-migrated modern
  // gateway (post setup) where the slot is elected correctly. Tests that
  // need to simulate the pre-migration state (modern gateway API
  // available but slot still unset / pointing elsewhere) can override
  // this by reassigning `api.config` before calling `plugin.register`.
  // See Codex Bug B25.
  return {
    config: {
      plugins: {
        slots: {
          memory: 'adapter-openclaw',
        },
      },
    },
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
  // B43: Resolver fixtures provide a RAW peer-ID form by default,
  // mirroring the real `DkgNodePlugin.memorySessionResolver` which
  // returns `this.nodePeerId` (populated from the daemon's
  // `/api/status.peerId` field as a raw peer identifier). The
  // consumption sites (`DkgMemorySearchManager.search` for WM routing,
  // `handleImport` for the `schema:creator` triple) normalize through
  // `toAgentPeerId` / `toAgentDid` at their respective boundaries,
  // so overrides that pass a DID-form address exercise the
  // normalization guard defensively.
  const pending = overrides?.defaultAgentAddress === null;
  const defaultAgentAddress = pending
    ? undefined
    : overrides?.defaultAgentAddress ?? overrides?.agentAddress ?? 'peer-test';
  const sessionAgentAddress = pending
    ? undefined
    : overrides?.agentAddress ?? 'peer-test';
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

  it('registers only the memory slot capability, no conventional memory tools (Codex B-retire)', () => {
    // Regression guard against accidentally re-introducing
    // `dkg_memory_import` / `dkg_memory_search` on the modern-gateway
    // path. Both explicit tool surfaces were retired in the
    // openclaw-dkg-primary-memory workstream; the memory slot is the
    // single entry point for reads and writes. This test exhaustively
    // asserts that `plugin.register` does not call `api.registerTool`
    // at all — if a future change adds a memory tool by accident, this
    // fails fast instead of shipping a duplicate recall/write surface.
    const api = makeApi();
    plugin.register(api);

    expect(api.registerMemoryCapability).toHaveBeenCalledTimes(1);
    expect(api.registerTool).not.toHaveBeenCalled();
  });

  it('does not fall back to a compat memory tool on legacy gateways (Codex B-retire)', () => {
    // Complement of the modern-gateway regression guard above: on a
    // legacy gateway where `api.registerMemoryCapability` is absent,
    // the adapter must NOT fall back to a compat `dkg_memory_search`
    // tool registration. The compat surface was retired alongside
    // `dkg_memory_import`; legacy gateways get no memory surface from
    // this adapter at all (operators must upgrade the gateway to
    // restore recall). This locks down the legacy-gateway branch of
    // `registerCapability` against accidental re-introduction of a
    // fallback tool registration.
    const legacyApi = makeApi();
    (legacyApi as any).registerMemoryCapability = undefined;
    plugin.register(legacyApi);

    expect(legacyApi.registerTool).not.toHaveBeenCalled();
  });

  it('skips registerMemoryCapability when plugins.slots.memory points at another plugin (Codex B58)', () => {
    // B58: register() must not silently override the operator's elected
    // memory provider. If plugins.slots.memory points at a different
    // plugin, this adapter must no-op the capability registration and
    // log a diagnostic — not steal the slot by merely being loaded.
    const api = makeApi();
    (api.config as any).plugins.slots.memory = 'some-other-memory-plugin';
    plugin.register(api);

    expect(api.registerMemoryCapability).not.toHaveBeenCalled();
    expect(api.registerTool).not.toHaveBeenCalled();
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('plugins.slots.memory is not set to "adapter-openclaw"'),
    );
  });

  it('skips registerMemoryCapability when plugins.slots.memory is unset (Codex B58)', () => {
    // B58 second branch: an unelected slot (fresh install, no setup run
    // yet, or partial migration) must also no-op. Operators have to
    // explicitly elect this adapter via `dkg setup` before it claims
    // the slot.
    const api = makeApi();
    (api.config as any).plugins.slots.memory = undefined;
    plugin.register(api);

    expect(api.registerMemoryCapability).not.toHaveBeenCalled();
    expect(api.registerTool).not.toHaveBeenCalled();
  });

  it('reads plugins.slots.memory from api.cfg when api.config is missing (Codex B58 gateway shim)', () => {
    // Some OpenClaw gateway builds expose the merged config on `api.cfg`
    // instead of `api.config`. The slot-ownership gate mirrors the same
    // fallback order as DkgChannelPlugin.register so those runtimes
    // still resolve correctly and don't get a false negative that would
    // leave the adapter unregistered after a successful setup.
    const api = makeApi();
    (api as any).cfg = api.config;
    (api as any).config = undefined;
    plugin.register(api);

    expect(api.registerMemoryCapability).toHaveBeenCalledTimes(1);
  });

  it('DkgMemorySearchManager.search floors fractional maxResults into a valid SPARQL LIMIT (Codex B37)', async () => {
    // B37: the clamped value is interpolated directly into the SPARQL
    // `LIMIT` clause. A fractional input like `2.5` would produce
    // `LIMIT 2.5`, which is invalid SPARQL and gets swallowed by the
    // per-query `.catch` blocks as an empty result set. The fix floors
    // the clamped value so fractional caller intent maps to the
    // nearest valid integer.
    const querySpy = vi.spyOn(client, 'query').mockResolvedValue({
      result: { bindings: [] },
    });
    const manager = new DkgMemorySearchManager({ client, resolver: makeResolver() });

    await manager.search('alpha beta', { maxResults: 2.5 });

    expect(querySpy).toHaveBeenCalled();
    const sparql = querySpy.mock.calls[0][0] as string;
    // The interpolated LIMIT must be an integer (no dot).
    expect(sparql).toMatch(/LIMIT \d+(\s|$)/);
    // Specifically 2 for input 2.5 (Math.floor after clamp).
    expect(sparql).toContain('LIMIT 2');
    expect(sparql).not.toContain('LIMIT 2.5');
  });

  it('DkgMemorySearchManager.search clamps-then-floors extreme fractional inputs (Codex B37)', async () => {
    // Belt-and-suspenders for the B37 clamp-then-floor interaction.
    // Input 150.9 → clamped to 100 → floored to 100. Input 0.4 →
    // clamped to 1 (via Math.max(1, ...)) → floored to 1.
    const querySpy = vi.spyOn(client, 'query').mockResolvedValue({
      result: { bindings: [] },
    });
    const managerHi = new DkgMemorySearchManager({ client, resolver: makeResolver() });
    await managerHi.search('alpha', { maxResults: 150.9 });
    const managerLo = new DkgMemorySearchManager({ client, resolver: makeResolver() });
    await managerLo.search('alpha', { maxResults: 0.4 });

    const sparqlHi = querySpy.mock.calls[0][0] as string;
    const sparqlLo = querySpy.mock.calls[1][0] as string;
    expect(sparqlHi).toContain('LIMIT 100');
    expect(sparqlLo).toContain('LIMIT 1');
  });

  it('DkgMemorySearchManager.search strips the did:dkg:agent: prefix when the resolver returns a DID-form address (Codex B43)', async () => {
    // B43 for the WM read path: the daemon's query engine uses the raw
    // peer-ID form for assertion-graph URI scoping when `view: 'working-memory'`.
    // A DID-form input from the resolver must be normalized to the raw
    // form before being passed to `client.query`, otherwise the read
    // looks in an assertion graph scoped to a literal DID string and
    // finds nothing.
    const querySpy = vi.spyOn(client, 'query').mockResolvedValue({ result: { bindings: [] } });
    const manager = new DkgMemorySearchManager({
      client,
      resolver: makeResolver({ agentAddress: 'did:dkg:agent:peer-readtest' }),
    });

    await manager.search('hello world');

    expect(querySpy).toHaveBeenCalled();
    const opts = querySpy.mock.calls[0][1]!;
    expect(opts.agentAddress).toBe('peer-readtest');
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
      // B43: WM view routing uses the raw peer-ID form. The fixture
      // provides a raw peer id (`peer-test`), which is passed through
      // to the query engine as-is — consumers that pass DID-form
      // addresses through the resolver would be normalized by
      // `toAgentPeerId` at the consumption site.
      expect(opts.agentAddress).toBe('peer-test');
    });

    it('issues four parallel /api/query calls when a project CG is resolved (chat-turns WM + project WM/SWM/VM)', async () => {
      // Workstream A expanded the slot-backed retrieval path to fan out
      // across all three project-memory views — working-memory,
      // shared-working-memory, and verified-memory — in addition to the
      // agent-context chat-turns working-memory query. `chat-turns` is
      // WM-only by persistence-path design (chat history only ever lands
      // in the agent-context WM assertion), so the total call count is
      // 4 (= 1 WM chat-turns + 3 project-memory views), not 6.
      const querySpy = vi.spyOn(client, 'query').mockResolvedValue({ result: { bindings: [] } });
      const manager = new DkgMemorySearchManager({
        client,
        resolver: makeResolver({ projectContextGraphId: 'research-x' }),
      });

      await manager.search('hello world');

      expect(querySpy).toHaveBeenCalledTimes(4);
      const allOpts = querySpy.mock.calls.map(c => c[1]!);

      const chatTurns = allOpts.filter(o => o.contextGraphId === AGENT_CONTEXT_GRAPH);
      expect(chatTurns).toHaveLength(1);
      expect(chatTurns[0].assertionName).toBe(CHAT_TURNS_ASSERTION);
      expect(chatTurns[0].view).toBe('working-memory');
      expect(chatTurns[0].agentAddress).toBe('peer-test');

      const projectOpts = allOpts.filter(o => o.contextGraphId === 'research-x');
      expect(projectOpts).toHaveLength(3);
      for (const opts of projectOpts) {
        expect(opts.assertionName).toBe(PROJECT_MEMORY_ASSERTION);
        expect(opts.agentAddress).toBe('peer-test');
      }
      const projectViews = projectOpts.map(o => o.view).sort();
      expect(projectViews).toEqual(
        ['shared-working-memory', 'verified-memory', 'working-memory'],
      );
    });

    it('merges results from all four layers and tags them with the correct source + layer', async () => {
      // Deterministic ordering lines up with the plan array in
      // DkgMemorySearchManager.search: chat-turns WM first, then
      // project WM, project SWM, project VM.
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
              { uri: { value: 'urn:m:2' }, text: { value: 'project wm hello world draft' } },
            ],
          },
        })
        .mockResolvedValueOnce({
          result: {
            bindings: [
              { uri: { value: 'urn:m:3' }, text: { value: 'project swm hello world shared' } },
            ],
          },
        })
        .mockResolvedValueOnce({
          result: {
            bindings: [
              { uri: { value: 'urn:m:4' }, text: { value: 'project vm hello world verified' } },
            ],
          },
        });

      const manager = new DkgMemorySearchManager({
        client,
        resolver: makeResolver({ projectContextGraphId: 'research-x' }),
      });

      const results = await manager.search('hello world');
      expect(results).toHaveLength(4);
      const layers = results.map(r => r.layer).sort();
      expect(layers).toEqual(['chat-turns-wm', 'project-swm', 'project-vm', 'project-wm']);
      // source stays on the closed upstream union — sessions for
      // chat-turns-wm, memory for every project layer.
      const sources = results.map(r => r.source).sort();
      expect(sources).toEqual(['memory', 'memory', 'memory', 'sessions']);
      for (const r of results) {
        expect(r.startLine).toBe(1);
        expect(r.endLine).toBe(1);
        expect(typeof r.path).toBe('string');
        expect(typeof r.snippet).toBe('string');
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(1);
      }
    });

    it('issues only one chat-turns WM query when no project CG is resolved (chat-turns is WM-only by design)', async () => {
      // Regression guard for the "chat-turns is WM-only" invariant.
      // Without a project CG the plan contains exactly the chat-turns
      // entry, so no SWM/VM calls should fire regardless of how the
      // fan-out expanded for project memory.
      const querySpy = vi.spyOn(client, 'query').mockResolvedValue({ result: { bindings: [] } });
      const manager = new DkgMemorySearchManager({ client, resolver: makeResolver() });

      await manager.search('hello world');

      expect(querySpy).toHaveBeenCalledTimes(1);
      const opts = querySpy.mock.calls[0][1]!;
      expect(opts.contextGraphId).toBe(AGENT_CONTEXT_GRAPH);
      expect(opts.assertionName).toBe(CHAT_TURNS_ASSERTION);
      expect(opts.view).toBe('working-memory');
    });

    it('ranks with trust-weighted scores: VM×1.3 > SWM×1.15 > WM×1.0 when raw overlap is comparable', async () => {
      // All four layers return a single result with identical keyword
      // overlap (`hello world` matches both keywords → raw score 1.0).
      // The trust weights then order the results VM > SWM > WM (both
      // WM layers tie in trust; rely on raw score for the tie-break).
      vi.spyOn(client, 'query')
        .mockResolvedValueOnce({
          result: {
            bindings: [
              { uri: { value: 'urn:m:ct' }, text: { value: 'hello world chat turn' } },
            ],
          },
        })
        .mockResolvedValueOnce({
          result: {
            bindings: [
              { uri: { value: 'urn:m:wm' }, text: { value: 'hello world project wm' } },
            ],
          },
        })
        .mockResolvedValueOnce({
          result: {
            bindings: [
              { uri: { value: 'urn:m:swm' }, text: { value: 'hello world project swm' } },
            ],
          },
        })
        .mockResolvedValueOnce({
          result: {
            bindings: [
              { uri: { value: 'urn:m:vm' }, text: { value: 'hello world project vm' } },
            ],
          },
        });

      const manager = new DkgMemorySearchManager({
        client,
        resolver: makeResolver({ projectContextGraphId: 'research-x' }),
      });

      const results = await manager.search('hello world');
      expect(results).toHaveLength(4);
      // First entry should be the VM hit (highest trust weight).
      expect(results[0].layer).toBe('project-vm');
      // Second entry should be SWM (next-highest trust weight).
      expect(results[1].layer).toBe('project-swm');
      // The two WM-trust entries round out the tail in some order;
      // assert only that both WM layers land in the bottom half.
      const tailLayers = [results[2].layer, results[3].layer].sort();
      expect(tailLayers).toEqual(['chat-turns-wm', 'project-wm']);
    });

    it('dedups across layers by (cg, uri), keeping the highest-trust layer', async () => {
      // The same memory URI surfaces in VM, SWM, and WM for the
      // project CG — a verified memory that is still present in the
      // working-memory draft and the shared-working-memory view. The
      // three layers should collapse to one result tagged with the
      // VM layer.
      const sameUri = { value: 'urn:m:shared' };
      const sameText = { value: 'hello world canonical memory' };
      vi.spyOn(client, 'query')
        .mockResolvedValueOnce({ result: { bindings: [] } }) // chat-turns WM
        .mockResolvedValueOnce({ result: { bindings: [{ uri: sameUri, text: sameText }] } })
        .mockResolvedValueOnce({ result: { bindings: [{ uri: sameUri, text: sameText }] } })
        .mockResolvedValueOnce({ result: { bindings: [{ uri: sameUri, text: sameText }] } });

      const manager = new DkgMemorySearchManager({
        client,
        resolver: makeResolver({ projectContextGraphId: 'research-x' }),
      });

      const results = await manager.search('hello world');
      expect(results).toHaveLength(1);
      expect(results[0].layer).toBe('project-vm');
      expect(results[0].source).toBe('memory');
    });

    it('degrades to the succeeding layers when one view query fails, with one warn per failing (cg, view) pair', async () => {
      // VM query fails; WM and SWM succeed. The failed layer emits
      // exactly one warn identifying the (cg, view) pair, and the
      // surviving two project layers contribute results alongside
      // the chat-turns WM result.
      vi.spyOn(client, 'query')
        .mockResolvedValueOnce({
          result: { bindings: [{ uri: { value: 'urn:m:ct' }, text: { value: 'match match hit' } }] },
        }) // chat-turns WM
        .mockResolvedValueOnce({
          result: { bindings: [{ uri: { value: 'urn:m:wm' }, text: { value: 'match project wm' } }] },
        }) // project WM
        .mockResolvedValueOnce({
          result: { bindings: [{ uri: { value: 'urn:m:swm' }, text: { value: 'match project swm' } }] },
        }) // project SWM
        .mockRejectedValueOnce(new Error('verified-memory view offline')); // project VM

      const warnSpy = vi.fn();
      const manager = new DkgMemorySearchManager({
        client,
        resolver: makeResolver({ projectContextGraphId: 'research-x' }),
        logger: { info: vi.fn(), warn: warnSpy, debug: vi.fn() } as any,
      });

      const results = await manager.search('match');
      const layers = results.map(r => r.layer).sort();
      expect(layers).toEqual(['chat-turns-wm', 'project-swm', 'project-wm']);

      const vmWarns = warnSpy.mock.calls.filter(c =>
        typeof c[0] === 'string' && c[0].includes('project-vm'),
      );
      expect(vmWarns).toHaveLength(1);
      expect(vmWarns[0][0]).toContain('research-x');
      expect(vmWarns[0][0]).toContain('verified-memory');
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
