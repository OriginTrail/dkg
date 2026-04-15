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

  it('registers dkg_memory_import as a conventional tool (not dkg_memory_search) on a modern gateway where this adapter owns the memory slot', () => {
    // On a fully-migrated modern gateway — registerMemoryCapability is
    // available AND `plugins.slots.memory` elects this adapter — the
    // memory slot routes reads, so `dkg_memory_search` MUST NOT be
    // registered (it would compete with the slot router). The default
    // `makeApi` mock now stamps both conditions via its `config.plugins.slots.memory`
    // field. See Codex Bug B7 (original introduction) and B25 (scoping
    // the suppression to actual slot ownership).
    const api = makeApi();
    plugin.register(api);

    const calls = api.registerTool.mock.calls;
    const toolNames = calls.map((c: any) => c[0].name);
    expect(toolNames).toContain('dkg_memory_import');
    expect(toolNames).not.toContain('dkg_memory_search');
  });

  it('keeps the dkg_memory_search compat tool when the gateway is modern but slot election has NOT happened (Codex B25)', () => {
    // B25: the earlier `includeLegacySearchTool: !slotRegistered` logic
    // suppressed the compat tool whenever `api.registerMemoryCapability`
    // existed. But slot election is a separate setup-time step that
    // writes `plugins.slots.memory = "adapter-openclaw"` to the workspace
    // config. On upgrade, an install can end up with a modern gateway
    // (API available) but a stale slot config (slot unset or pointing
    // at another plugin) — in that window, slot-backed recall doesn't
    // route through this adapter, so dropping the compat tool would
    // leave agents with no recall path at all. The fix gates suppression
    // on ACTUAL slot ownership: only drop the compat tool when both the
    // capability was registered AND the workspace config names this
    // adapter as the memory-slot owner.
    const api = makeApi();
    // Simulate a gateway that supports registerMemoryCapability but
    // whose workspace config does NOT yet name this adapter as the
    // memory-slot owner (stale post-upgrade state, pre-setup-rerun).
    api.config = {
      plugins: {
        slots: {
          // Slot is pointing elsewhere — some other plugin, or undefined,
          // or a stale literal. The B25 guard must treat any non-match
          // as "not our slot" and keep the compat tool.
          memory: 'some-other-memory-plugin',
        },
      },
    };
    plugin.register(api);

    const toolNames = api.registerTool.mock.calls.map((c: any) => c[0].name);
    expect(toolNames).toContain('dkg_memory_import');
    expect(toolNames).toContain('dkg_memory_search');
    // The capability WAS registered — the gateway supports the slot
    // contract, it's just not elected to us.
    expect(api.registerMemoryCapability).toHaveBeenCalledTimes(1);
    // A warning should have been logged so operators notice the
    // misconfiguration and rerun setup.
    expect(api.logger.warn).toHaveBeenCalled();
    const warnMsgs = (api.logger.warn as any).mock.calls
      .map((c: any[]) => String(c[0]))
      .filter((m: string) => m.includes('plugins.slots.memory'));
    expect(warnMsgs.length).toBeGreaterThan(0);
  });

  it('keeps the dkg_memory_search compat tool when plugins.slots.memory is entirely unset on a modern gateway (Codex B25)', () => {
    // Belt-and-suspenders for the bare-config case — a modern gateway
    // whose workspace config has no `plugins.slots` section at all
    // (fresh install that hasn't run setup yet, or old config predating
    // the slot schema). The B25 guard must still fall through to the
    // compat tool.
    const api = makeApi();
    api.config = {}; // no plugins, no slots
    plugin.register(api);

    const toolNames = api.registerTool.mock.calls.map((c: any) => c[0].name);
    expect(toolNames).toContain('dkg_memory_import');
    expect(toolNames).toContain('dkg_memory_search');
    expect(api.registerMemoryCapability).toHaveBeenCalledTimes(1);
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

  it('dkg_memory_search compat tool schema accepts both number and string for maxResults/limit/minScore (Codex B35)', () => {
    // B35: schema-aware hosts validate tool-call arguments against this
    // schema before the handler runs. Declaring the numeric params as
    // strict `type: 'number'` would cause those hosts to reject
    // `{ limit: '5' }` from legacy callers before `handleLegacySearch`
    // could coerce the value — making the B18 / B32 compat shims
    // unreachable on the exact hosts they were meant to protect. The
    // schema must declare these as the JSON Schema union
    // `['number', 'string']` so stringified inputs pass validation.
    const legacyApi = makeApi();
    (legacyApi as any).registerMemoryCapability = undefined;
    plugin.register(legacyApi);
    const searchToolDef = legacyApi.registerTool.mock.calls
      .map((c: any) => c[0])
      .find((t: any) => t.name === 'dkg_memory_search');
    expect(searchToolDef).toBeDefined();
    const props = searchToolDef.parameters.properties;
    expect(props.maxResults.type).toEqual(['number', 'string']);
    expect(props.limit.type).toEqual(['number', 'string']);
    expect(props.minScore.type).toEqual(['number', 'string']);
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
    // B36: the compat path returns the retired tool's envelope shape
    // directly — `content[0].text` is the JSON-serialized raw result
    // array, and `details` is the raw result array itself (not a
    // wrapper object). Legacy prompts parsing the old envelope get
    // back exactly what the pre-workstream tool produced.
    const payload = JSON.parse(result.content[0].text);
    expect(Array.isArray(payload)).toBe(true);
    expect(Array.isArray(result.details)).toBe(true);
    expect(querySpy).toHaveBeenCalled();
    const opts = querySpy.mock.calls[0][1]!;
    expect(opts.contextGraphId).toBe(AGENT_CONTEXT_GRAPH);
    expect(opts.assertionName).toBe(CHAT_TURNS_ASSERTION);
    expect(opts.view).toBe('working-memory');
  });

  it('dkg_memory_search compat tool preserves the retired tool\'s raw-array details envelope (Codex B36)', async () => {
    // B36: the retired pre-workstream `dkg_memory_search` tool returned
    // `{ content: [{ type: 'text', text: JSON.stringify(results) }],
    // details: results }` — the raw result array WAS the `details`
    // payload. Legacy prompts / hosts parsing that envelope expect
    // `details` to be an array they can iterate, not a `{status,
    // results}` wrapper. The compat path must mirror the retired
    // envelope exactly.
    vi.spyOn(client, 'query').mockResolvedValue({
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

    const result = await searchTool.execute('call-1', { query: 'alpha beta' });
    // `details` is the raw result array, not an envelope object.
    expect(Array.isArray(result.details)).toBe(true);
    // `content[0].text` is the JSON-serialized raw array, not a wrapper.
    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
    // No wrapper object / envelope fields on the success shape.
    expect(result.details).not.toHaveProperty('status');
    expect(result.details).not.toHaveProperty('results');
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

  it('dkg_memory_import returns needs_clarification when no contextGraphId is supplied AND resolver has no dispatch-scoped CG', async () => {
    // After Bug B16: handleImport can resolve an implicit project CG from
    // the ALS-scoped resolver (post-B6 refactor). When BOTH sources are
    // unavailable — no explicit contextGraphId AND no dispatch-scoped
    // projectContextGraphId on the resolver — the tool falls back to a
    // structured clarification response so the agent can ask the user.
    // The default `makeResolver()` fixture returns a session with
    // `projectContextGraphId: undefined` (no override), so this test
    // exercises the both-unavailable fallback path.
    const api = makeApi();
    plugin.register(api);
    const importTool = api.registerTool.mock.calls.find((c: any) => c[0].name === 'dkg_memory_import')[0];
    const result = await importTool.execute('call-1', { text: 'some memory' });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe('needs_clarification');
    expect(payload).toHaveProperty('availableContextGraphs');
    expect(payload.reason).toMatch(/context graph|UI-selected project/i);
  });

  it('dkg_memory_import uses the dispatch-scoped project CG from the resolver when contextGraphId is omitted (Codex B16)', async () => {
    // B16 regression guard. Post-B6 ALS, the channel dispatches run under
    // `runWithDispatchContext` and `DkgNodePlugin.memorySessionResolver`
    // reads `projectContextGraphId` from the ALS store via
    // `channelPlugin.getSessionProjectContextGraphId`. `handleImport`
    // must honor that dispatch-scoped CG when the agent omits an
    // explicit `contextGraphId` — otherwise users with a project
    // selected in the UI hit `needs_clarification` on every turn.
    const createSpy = vi.spyOn(client, 'createAssertion').mockResolvedValue({
      assertionUri: 'urn:test:assertion',
      alreadyExists: false,
    });
    const writeSpy = vi.spyOn(client, 'writeAssertion').mockResolvedValue({ written: 4 });

    const api = makeApi();
    const pluginWithDispatchCg = new DkgMemoryPlugin(
      client,
      { enabled: true },
      makeResolver({ projectContextGraphId: 'ui-selected-b16' }),
    );
    pluginWithDispatchCg.register(api);
    const importTool = api.registerTool.mock.calls.find((c: any) => c[0].name === 'dkg_memory_import')[0];

    // No `contextGraphId` in params — the resolver's dispatch-scoped CG
    // MUST be used instead of falling through to needs_clarification.
    const result = await importTool.execute('call-1', { text: 'user likes dark mode' });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.status).toBe('stored');
    expect(payload.contextGraphId).toBe('ui-selected-b16');
    expect(createSpy).toHaveBeenCalledWith('ui-selected-b16', PROJECT_MEMORY_ASSERTION);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy.mock.calls[0][0]).toBe('ui-selected-b16');
  });

  it('dkg_memory_import prefers explicit contextGraphId over the resolver dispatch-scoped CG (Codex B16)', async () => {
    // When the agent passes an explicit `contextGraphId`, it must win
    // over the resolver's dispatch-scoped project CG. This keeps the
    // agent-addressable escape hatch for cross-project writes — e.g.,
    // recording a memory into project X while the UI has project Y
    // selected.
    const createSpy = vi.spyOn(client, 'createAssertion').mockResolvedValue({
      assertionUri: 'urn:test:assertion',
      alreadyExists: false,
    });
    const writeSpy = vi.spyOn(client, 'writeAssertion').mockResolvedValue({ written: 4 });

    const api = makeApi();
    const pluginWithDispatchCg = new DkgMemoryPlugin(
      client,
      { enabled: true },
      makeResolver({ projectContextGraphId: 'ui-selected-b16' }),
    );
    pluginWithDispatchCg.register(api);
    const importTool = api.registerTool.mock.calls.find((c: any) => c[0].name === 'dkg_memory_import')[0];

    const result = await importTool.execute('call-1', {
      text: 'cross-project memory',
      contextGraphId: 'explicit-override',
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.status).toBe('stored');
    expect(payload.contextGraphId).toBe('explicit-override');
    expect(createSpy).toHaveBeenCalledWith('explicit-override', PROJECT_MEMORY_ASSERTION);
    expect(writeSpy.mock.calls[0][0]).toBe('explicit-override');
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

  it('dkg_memory_search compat tool coerces stringified maxResults/minScore to numbers (Codex B18)', async () => {
    // B18: legacy tool-call serializers on older gateways often stringify
    // numeric arguments. The retired `dkg_memory_search` tool tolerated
    // that via parseInt; the new compat tool must do the same, otherwise
    // callers passing `{ maxResults: "5" }` silently fall back to the
    // search manager's default limit, which is a silent correctness
    // regression from the legacy behavior.
    const searchSpy = vi.spyOn(DkgMemorySearchManager.prototype, 'search').mockResolvedValue([]);

    const legacyApi = makeApi();
    (legacyApi as any).registerMemoryCapability = undefined;
    plugin.register(legacyApi);
    const searchTool = legacyApi.registerTool.mock.calls.find(
      (c: any) => c[0].name === 'dkg_memory_search',
    )[0];

    await searchTool.execute('call-1', {
      query: 'alpha beta',
      maxResults: '7',
      minScore: '0.25',
    });

    expect(searchSpy).toHaveBeenCalledTimes(1);
    const opts = searchSpy.mock.calls[0][1];
    expect(opts).toEqual({ maxResults: 7, minScore: 0.25 });
  });

  it('dkg_memory_search compat tool accepts the legacy `limit` parameter as an alias for maxResults (Codex B32)', async () => {
    // B32: The retired pre-workstream `dkg_memory_search` tool used
    // `limit` as the parameter name. Older prompts and tool callers on
    // the legacy-gateway path still pass `limit`. The compat tool must
    // honor that name (in addition to the new `maxResults`) or those
    // callers silently fall back to the default cap of 10 — a silent
    // regression from the contract this compat tool is supposed to
    // preserve.
    const searchSpy = vi.spyOn(DkgMemorySearchManager.prototype, 'search').mockResolvedValue([]);

    const legacyApi = makeApi();
    (legacyApi as any).registerMemoryCapability = undefined;
    plugin.register(legacyApi);
    const searchTool = legacyApi.registerTool.mock.calls.find(
      (c: any) => c[0].name === 'dkg_memory_search',
    )[0];

    await searchTool.execute('call-1', { query: 'alpha beta', limit: 25 });

    expect(searchSpy).toHaveBeenCalledTimes(1);
    const opts = searchSpy.mock.calls[0][1];
    expect(opts?.maxResults).toBe(25);
  });

  it('dkg_memory_search compat tool prefers maxResults over limit when both are provided (Codex B32)', async () => {
    // When a caller supplies both the new `maxResults` and the legacy
    // `limit` alias, the new name wins. Otherwise a progressive-
    // enhancement caller that starts sending both during a migration
    // would see its new value ignored.
    const searchSpy = vi.spyOn(DkgMemorySearchManager.prototype, 'search').mockResolvedValue([]);

    const legacyApi = makeApi();
    (legacyApi as any).registerMemoryCapability = undefined;
    plugin.register(legacyApi);
    const searchTool = legacyApi.registerTool.mock.calls.find(
      (c: any) => c[0].name === 'dkg_memory_search',
    )[0];

    await searchTool.execute('call-1', { query: 'alpha beta', maxResults: 7, limit: 99 });

    expect(searchSpy).toHaveBeenCalledTimes(1);
    const opts = searchSpy.mock.calls[0][1];
    expect(opts?.maxResults).toBe(7);
  });

  it('dkg_memory_search compat tool accepts stringified `limit` alias (Codex B18 + B32)', async () => {
    // Combination guard for the two compat shims: stringified numeric
    // values (B18) AND the `limit` alias (B32). Legacy serializers on
    // older gateways can emit both at once.
    const searchSpy = vi.spyOn(DkgMemorySearchManager.prototype, 'search').mockResolvedValue([]);

    const legacyApi = makeApi();
    (legacyApi as any).registerMemoryCapability = undefined;
    plugin.register(legacyApi);
    const searchTool = legacyApi.registerTool.mock.calls.find(
      (c: any) => c[0].name === 'dkg_memory_search',
    )[0];

    await searchTool.execute('call-1', { query: 'alpha beta', limit: '42' });

    expect(searchSpy).toHaveBeenCalledTimes(1);
    const opts = searchSpy.mock.calls[0][1];
    expect(opts?.maxResults).toBe(42);
  });

  it('dkg_memory_search compat tool falls back to default when stringified params are non-numeric (Codex B18)', async () => {
    // Non-numeric strings like `{ maxResults: "none" }` must not crash
    // or produce NaN. They should fall through to `undefined` so the
    // search manager uses its built-in default.
    const searchSpy = vi.spyOn(DkgMemorySearchManager.prototype, 'search').mockResolvedValue([]);

    const legacyApi = makeApi();
    (legacyApi as any).registerMemoryCapability = undefined;
    plugin.register(legacyApi);
    const searchTool = legacyApi.registerTool.mock.calls.find(
      (c: any) => c[0].name === 'dkg_memory_search',
    )[0];

    await searchTool.execute('call-1', {
      query: 'alpha beta',
      maxResults: 'not-a-number',
      minScore: '',
    });

    expect(searchSpy).toHaveBeenCalledTimes(1);
    const opts = searchSpy.mock.calls[0][1];
    expect(opts).toEqual({ maxResults: undefined, minScore: undefined });
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

  it('dkg_memory_import rejects the reserved agent-context graph with a tool-level error (Codex B42)', async () => {
    // B42: `agent-context` is reserved for the adapter's chat-turns WM
    // assertion. Writing user memories into it would corrupt the
    // chat-persistence graph, so the tool rejects that target
    // explicitly even if the caller passes it in `contextGraphId`.
    const createSpy = vi.spyOn(client, 'createAssertion');
    const writeSpy = vi.spyOn(client, 'writeAssertion');
    const api = makeApi();
    plugin.register(api);
    const importTool = api.registerTool.mock.calls.find((c: any) => c[0].name === 'dkg_memory_import')[0];

    const result = await importTool.execute('call-1', {
      text: 'malicious write attempt',
      contextGraphId: 'agent-context',
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toMatch(/reserved|agent-context/i);
    // Neither daemon call fired — the reservation guard runs before
    // createAssertion / writeAssertion.
    expect(createSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('dkg_memory_import rejects contextGraphIds not in the subscribed list when the cache is populated (Codex B42)', async () => {
    // B42: when the subscribed-CG cache is non-empty, typo'd or stale
    // project ids must be rejected before they can create orphaned
    // assertion graphs. Returns a needs_clarification with the
    // actual available list so the agent can self-correct.
    const createSpy = vi.spyOn(client, 'createAssertion');
    const writeSpy = vi.spyOn(client, 'writeAssertion');
    const api = makeApi();
    const pluginWithSubs = new DkgMemoryPlugin(
      client,
      { enabled: true },
      makeResolver({ available: ['research-x', 'research-y'] }),
    );
    pluginWithSubs.register(api);
    const importTool = api.registerTool.mock.calls.find((c: any) => c[0].name === 'dkg_memory_import')[0];

    const result = await importTool.execute('call-1', {
      text: 'some memory',
      contextGraphId: 'research-typo',
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe('needs_clarification');
    expect(payload.reason).toMatch(/not in the subscribed|typo|stale/i);
    expect(payload.availableContextGraphs).toEqual(['research-x', 'research-y']);
    expect(createSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('dkg_memory_import accepts contextGraphIds that are in the subscribed list (Codex B42)', async () => {
    // Positive case for B42: a valid project id in the subscribed list
    // passes through the guard and reaches createAssertion / writeAssertion.
    const createSpy = vi.spyOn(client, 'createAssertion').mockResolvedValue({
      assertionUri: 'urn:test:assertion',
      alreadyExists: false,
    });
    const writeSpy = vi.spyOn(client, 'writeAssertion').mockResolvedValue({ written: 4 });
    const api = makeApi();
    const pluginWithSubs = new DkgMemoryPlugin(
      client,
      { enabled: true },
      makeResolver({ available: ['research-x', 'research-y'] }),
    );
    pluginWithSubs.register(api);
    const importTool = api.registerTool.mock.calls.find((c: any) => c[0].name === 'dkg_memory_import')[0];

    const result = await importTool.execute('call-1', {
      text: 'valid memory',
      contextGraphId: 'research-y',
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe('stored');
    expect(createSpy).toHaveBeenCalledWith('research-y', PROJECT_MEMORY_ASSERTION);
    expect(writeSpy.mock.calls[0][0]).toBe('research-y');
  });

  it('dkg_memory_import normalizes a DID-form agentAddress from the resolver and emits a single-prefix creator triple (Codex B43)', async () => {
    // B43: The resolver contract does not enforce whether agentAddress
    // comes through as a raw peer id or as a `did:dkg:agent:<peerId>`
    // DID. A consumer passing a DID-form address must NOT produce a
    // double-prefixed `did:dkg:agent:did:dkg:agent:...` creator triple,
    // which would match no real agent.
    const createSpy = vi.spyOn(client, 'createAssertion').mockResolvedValue({
      assertionUri: 'urn:test:assertion',
      alreadyExists: false,
    });
    const writeSpy = vi.spyOn(client, 'writeAssertion').mockResolvedValue({ written: 4 });
    const api = makeApi();
    // Resolver passes a DID-form address into the handler — e.g. a
    // consumer that normalized upstream, or a future wiring that
    // stores the DID form in session state.
    const pluginWithDidResolver = new DkgMemoryPlugin(
      client,
      { enabled: true },
      makeResolver({ agentAddress: 'did:dkg:agent:peer-abc123' }),
    );
    pluginWithDidResolver.register(api);
    const importTool = api.registerTool.mock.calls.find((c: any) => c[0].name === 'dkg_memory_import')[0];

    await importTool.execute('call-1', {
      text: 'provenance test',
      contextGraphId: 'research-x',
    });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const quads = writeSpy.mock.calls[0][2] as Array<{ predicate: string; object: string }>;
    const creatorQuad = quads.find((q) => q.predicate.endsWith('creator'));
    expect(creatorQuad).toBeDefined();
    // Exactly one `did:dkg:agent:` prefix — not two.
    expect(creatorQuad!.object).toBe('did:dkg:agent:peer-abc123');
    expect(creatorQuad!.object).not.toContain('did:dkg:agent:did:dkg:agent:');
  });

  it('dkg_memory_import emits a well-formed creator triple when the resolver provides a raw peer id (Codex B43)', async () => {
    // Negative test complement of the DID-form case: raw peer id input
    // also produces a single-prefix DID creator triple.
    const createSpy = vi.spyOn(client, 'createAssertion').mockResolvedValue({
      assertionUri: 'urn:test:assertion',
      alreadyExists: false,
    });
    const writeSpy = vi.spyOn(client, 'writeAssertion').mockResolvedValue({ written: 4 });
    const api = makeApi();
    const pluginWithRawResolver = new DkgMemoryPlugin(
      client,
      { enabled: true },
      makeResolver({ agentAddress: 'peer-abc123' }),
    );
    pluginWithRawResolver.register(api);
    const importTool = api.registerTool.mock.calls.find((c: any) => c[0].name === 'dkg_memory_import')[0];

    await importTool.execute('call-1', {
      text: 'raw peer id test',
      contextGraphId: 'research-x',
    });

    const quads = writeSpy.mock.calls[0][2] as Array<{ predicate: string; object: string }>;
    const creatorQuad = quads.find((q) => q.predicate.endsWith('creator'));
    expect(creatorQuad!.object).toBe('did:dkg:agent:peer-abc123');
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
      // B43: WM view routing uses the raw peer-ID form. The fixture
      // provides a raw peer id (`peer-test`), which is passed through
      // to the query engine as-is — consumers that pass DID-form
      // addresses through the resolver would be normalized by
      // `toAgentPeerId` at the consumption site.
      expect(opts.agentAddress).toBe('peer-test');
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
