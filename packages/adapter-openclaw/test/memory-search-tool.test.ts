/**
 * memory_search tool — agent-callable recall button (plan v2.1 §3.1, commit 5).
 *
 * Covers: registration, input validation, output shape, error paths,
 * peer-ID-unavailable graceful degradation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DkgNodePlugin } from '../src/DkgNodePlugin';
import type { OpenClawPluginApi, OpenClawTool } from '../src/types';

type RegisteredTool = OpenClawTool;

function mkApi(tools: RegisteredTool[] = [], hooks: Array<{ event: string; name?: string }> = []): OpenClawPluginApi {
  return {
    registerTool: (t: any) => { tools.push(t); },
    registerHook: (event: any, _h: any, opts: any) => { hooks.push({ event: String(event), name: opts?.name }); },
    on: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    config: {},
    registrationMode: 'full' as const,
  } as unknown as OpenClawPluginApi;
}

describe('memory_search tool', () => {
  let plugin: DkgNodePlugin;
  let tools: RegisteredTool[];

  beforeEach(() => {
    plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      memory: { enabled: true },
      channel: { enabled: false },
    } as any);
    tools = [];
    plugin.register(mkApi(tools));
  });

  it('is registered as a tool', () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain('memory_search');
  });

  it('has a description steering agents away from dkg_query for free-text recall', () => {
    const tool = tools.find((t) => t.name === 'memory_search')!;
    expect(tool.description).toMatch(/memory/i);
    expect(tool.description).toMatch(/prefer/i);
    expect(tool.description).toMatch(/dkg_query/);
  });

  it('has a query parameter and required list includes it', () => {
    const tool = tools.find((t) => t.name === 'memory_search')!;
    const params = tool.parameters as any;
    expect(params.properties.query).toBeDefined();
    expect(params.required).toContain('query');
  });

  it('accepts optional limit as number OR stringified number', () => {
    const tool = tools.find((t) => t.name === 'memory_search')!;
    const params = tool.parameters as any;
    expect(params.properties.limit).toBeDefined();
    const limitType = params.properties.limit.type;
    if (Array.isArray(limitType)) {
      expect(limitType).toContain('number');
      expect(limitType).toContain('string');
    } else {
      expect(['number', 'string']).toContain(limitType);
    }
  });

  it('returns a structured error when query is missing', async () => {
    const tool = tools.find((t) => t.name === 'memory_search')!;
    const result = await tool.execute('t1', {});
    expect((result as any).details?.error).toBeTruthy();
  });

  it('returns a structured error when query is empty string', async () => {
    const tool = tools.find((t) => t.name === 'memory_search')!;
    const result = await tool.execute('t1', { query: '   ' });
    expect((result as any).details?.error).toBeTruthy();
  });

  it('rejects 1-char queries upfront instead of silently returning [] (R10.5)', async () => {
    // The internal SPARQL builder strips keywords <2 chars, so a 1-char
    // query falls through to the search and returns []. Pre-fix that
    // looked like "no results found" to the agent. Now the tool rejects.
    const tool = tools.find((t) => t.name === 'memory_search')!;
    const result = await tool.execute('t1-shortq', { query: 'x' });
    const text = (result as any).content?.[0]?.text ?? '';
    expect(text).toMatch(/≥2 chars|2 chars|required/i);
  });

  it('handler is callable and returns a tool result when query is valid', async () => {
    const tool = tools.find((t) => t.name === 'memory_search')!;
    // Patch the daemon client to avoid a real network call.
    const client = (plugin as any).client;
    client.query = vi.fn().mockResolvedValue({ results: { bindings: [] } });
    // Stub the resolver so the not-ready guard passes.
    (plugin as any).memorySessionResolver.getDefaultAgentAddress = () => '12D3KooWReady';

    const result = await tool.execute('t2', { query: 'project milestones' });
    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
  });

  it('returns "not ready" error when the resolver has no agent identity yet (R7.6 / T51)', async () => {
    const tool = tools.find((t) => t.name === 'memory_search')!;
    // Force resolver to surface no agent address (neither session-bound nor default).
    (plugin as any).memorySessionResolver.getSession = () => undefined;
    (plugin as any).memorySessionResolver.getDefaultAgentAddress = () => undefined;

    const result = await tool.execute('t-not-ready', { query: 'tatooine' });
    const text = (result as any).content?.[0]?.text ?? '';
    // Tool should return the structured "not ready" error, NOT an empty hits list.
    expect(text).toMatch(/not ready/i);
    expect(text).toMatch(/agent identity/i);
    expect(text).toMatch(/node API token/i);
  });

  it('T76 — probes ensureNodePeerId when identity is unresolved and nodePeerId is still undefined (mirrors dkg_query WM branch)', async () => {
    // T76 — Codex flagged: pre-fix, `handleMemorySearch` returned the
    // "agent eth address not resolved" error whenever the resolver
    // surfaced no address, even when the only remaining gap was a missed
    // `/api/status` peerId probe. The dkg_query WM branch already triggers
    // `ensureNodePeerId()` in that case; memory_search did not, so
    // it stayed falsely unavailable until the deferred probe retry
    // fired (which can be many turns later).
    //
    // After the fix, memory_search awaits both `ensureNodeAgentAddress`
    // and `ensureNodePeerId` before resolving the default address.
    const tool = tools.find((t) => t.name === 'memory_search')!;
    const client = (plugin as any).client;
    client.query = vi.fn().mockResolvedValue({ result: { bindings: [] } });

    // Set up identity-not-yet-resolved with peerId not yet probed.
    (plugin as any).nodeAgentAddress = undefined;
    (plugin as any).nodePeerId = undefined;

    // Spy on the probe methods. Make `ensureNodePeerId` resolve the
    // peerId, mirroring what a recovered /api/status call would do.
    const ensureAgentSpy = vi.fn().mockResolvedValue(undefined);
    const ensurePeerIdSpy = vi.fn(async () => {
      (plugin as any).nodePeerId = '12D3KooWRecoveredPeer';
    });
    (plugin as any).ensureNodeAgentAddress = ensureAgentSpy;
    (plugin as any).ensureNodePeerId = ensurePeerIdSpy;

    const result = await tool.execute('t-no-keystore-recover', { query: 'tatooine' });

    // Both probes were awaited.
    // Called at least once — exact count varies because the resolver's
    // `getSession` and `getDefaultAgentAddress` also fire it
    // fire-and-forget. All calls are idempotent (debounced via
    // `agentAddressProbeInFlight`).
    expect(ensureAgentSpy).toHaveBeenCalled();
    expect(ensurePeerIdSpy).toHaveBeenCalled();

    // After the peerId probe lands, the resolver returns the recovered
    // peerId via `resolveDefaultAgentAddress`, so the tool proceeds with
    // the search instead of returning the "not ready" error.
    const text = (result as any).content?.[0]?.text ?? '';
    expect(text).not.toMatch(/not ready/i);
    expect((result as any).details?.error).toBeFalsy();
  });

  it('T76 — probes ensureNodePeerId when identity is unresolved, without the retired keystore-absent gate', async () => {
    // Mirrors dkg_query's post-#324 fallback chain: the adapter first tries
    // the daemon identity endpoint, then gives the peerId fallback a chance.
    // The old local-keystore-absence gate is gone with the local
    // keystore identity probe.
    const tool = tools.find((t) => t.name === 'memory_search')!;
    const client = (plugin as any).client;
    client.query = vi.fn().mockResolvedValue({ result: { bindings: [] } });

    (plugin as any).nodeAgentAddress = undefined;
    (plugin as any).nodePeerId = undefined;

    const ensureAgentSpy = vi.fn().mockResolvedValue(undefined);
    const ensurePeerIdSpy = vi.fn(async () => {
      (plugin as any).nodePeerId = '12D3KooWRecoveredPeerNoKeystoreGate';
    });
    (plugin as any).ensureNodeAgentAddress = ensureAgentSpy;
    (plugin as any).ensureNodePeerId = ensurePeerIdSpy;

    const result = await tool.execute('t-peerid-fallback-no-keystore-gate', { query: 'tatooine' });

    // ensureNodeAgentAddress fires first; ensureNodePeerId is no longer
    // gated by local keystore state.
    // Called at least once — exact count varies because the resolver's
    // `getSession` and `getDefaultAgentAddress` also fire it
    // fire-and-forget. All calls are idempotent (debounced via
    // `agentAddressProbeInFlight`).
    expect(ensureAgentSpy).toHaveBeenCalled();
    expect(ensurePeerIdSpy).toHaveBeenCalled();

    const text = (result as any).content?.[0]?.text ?? '';
    expect(text).not.toMatch(/not ready/i);
    expect((result as any).details?.error).toBeFalsy();
  });

  it('re-asserts memory-slot capability before running the search (R7.5 mode-independent anchor)', async () => {
    const tool = tools.find((t) => t.name === 'memory_search')!;
    const client = (plugin as any).client;
    client.query = vi.fn().mockResolvedValue({ results: { bindings: [] } });
    (plugin as any).memorySessionResolver.getDefaultAgentAddress = () => '12D3KooWReady';
    // Spy on reAssertCapability — must be called exactly once per tool invocation.
    const spy = vi.fn();
    (plugin as any).memoryPlugin.reAssertCapability = spy;

    await tool.execute('t-reassert', { query: 'anything' });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('memory_search when memory module disabled', () => {
  it('tool is still registered but returns a structured error on call', async () => {
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      memory: { enabled: false },
      channel: { enabled: false },
    } as any);
    const tools: RegisteredTool[] = [];
    plugin.register(mkApi(tools));

    const tool = tools.find((t) => t.name === 'memory_search');
    expect(tool).toBeDefined();
    const result = await tool!.execute('t1', { query: 'x' });
    expect((result as any).details?.error).toBeTruthy();
  });
});
