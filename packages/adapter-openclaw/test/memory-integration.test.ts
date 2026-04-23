/**
 * Memory integration round-trip — issue #199 Phase 1 + Phase 2.
 *
 * Phase 1: simulate a canonical memory write. Verify that when the
 * agent writes a `schema:description` literal to `memory` assertion
 * in a context graph, the write flows through to the daemon with
 * the expected shape.
 *
 * Phase 2: simulate slot-backed recall. Verify that
 * `DkgMemorySearchManager.search` issues the expected 6-layer
 * fan-out with correct view + contextGraphId + assertionName
 * parameters that WOULD match what Phase 1 wrote.
 *
 * Phase 3 (live daemon) is a manual validation step post-merge,
 * per plan §5.2 — covered by the live-test checklist in the PR
 * description.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DkgMemorySearchManager } from '../src/DkgMemoryPlugin';
import { DkgNodePlugin } from '../src/DkgNodePlugin';
import type { OpenClawPluginApi, OpenClawTool } from '../src/types';

function mkApi(tools: OpenClawTool[] = []): OpenClawPluginApi {
  return {
    registerTool: (t: any) => { tools.push(t); },
    registerHook: vi.fn(),
    on: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    config: {},
    registrationMode: 'full' as const,
  } as unknown as OpenClawPluginApi;
}

describe('Memory integration round-trip (issue #199 Phase 1 + Phase 2)', () => {
  let mockQuery: ReturnType<typeof vi.fn>;
  let plugin: DkgNodePlugin;
  let tools: OpenClawTool[];

  beforeEach(() => {
    plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      memory: { enabled: true },
      channel: { enabled: false },
    } as any);
    tools = [];
    plugin.register(mkApi(tools));

    const client = (plugin as any).client;
    // Simulate a daemon that returns a Tatooine memory for any query
    // that mentions "tatooine". Tracks the last query for assertions.
    mockQuery = vi.fn().mockImplementation(async (_sparql: string, opts: any) => {
      const isTatooineQuery = /tatooine|sun/i.test(String(_sparql));
      if (!isTatooineQuery) return { results: { bindings: [] } };
      if (opts.view !== 'working-memory') return { results: { bindings: [] } };
      return {
        results: {
          bindings: [
            {
              uri: { type: 'uri', value: 'urn:memory:tatooine-fact' },
              pred: { type: 'uri', value: 'http://schema.org/description' },
              text: { type: 'literal', value: 'The sky on Tatooine has two suns.' },
            },
          ],
        },
      };
    });
    client.query = mockQuery;
    // Give the manager a peer ID so B28 preflight doesn't early-return.
    (plugin as any).nodePeerId = '12D3KooWTestPeerIdRoundTrip';
  });

  describe('Phase 1 — canonical write contract', () => {
    it('dkg_assertion_write tool is registered with the expected shape', () => {
      const tool = tools.find((t) => t.name === 'dkg_assertion_write');
      expect(tool).toBeDefined();
      const params = tool!.parameters as any;
      expect(params.required).toContain('context_graph_id');
      expect(params.required).toContain('name');
      expect(params.required).toContain('quads');
    });

    it('calling dkg_assertion_write flows to client.writeAssertion', async () => {
      const tool = tools.find((t) => t.name === 'dkg_assertion_write')!;
      const client = (plugin as any).client;
      client.writeAssertion = vi.fn().mockResolvedValue({ written: 1 });
      await tool.execute('t1', {
        context_graph_id: 'test-cg-memory-roundtrip',
        name: 'memory',
        quads: [
          {
            subject: 'urn:memory:tatooine-fact',
            predicate: 'http://schema.org/description',
            object: 'The sky on Tatooine has two suns.',
          },
        ],
      });
      expect(client.writeAssertion).toHaveBeenCalledWith(
        'test-cg-memory-roundtrip',
        'memory',
        expect.arrayContaining([
          expect.objectContaining({
            subject: 'urn:memory:tatooine-fact',
            predicate: 'http://schema.org/description',
          }),
        ]),
        expect.any(Object),
      );
    });
  });

  describe('Phase 2 — slot-backed recall fan-out', () => {
    it('memory_search tool issues SPARQL queries against agent-context graph with WM/SWM/VM views', async () => {
      const tool = tools.find((t) => t.name === 'memory_search')!;
      await tool.execute('t1', { query: 'tatooine suns' });

      const calls = mockQuery.mock.calls;
      // At least 3 queries for agent-context (WM + SWM + VM); if a
      // project CG is resolved, 3 more. No project in this test.
      expect(calls.length).toBeGreaterThanOrEqual(3);

      const agentContextViews = calls
        .filter((c) => c[1].contextGraphId === 'agent-context')
        .map((c) => c[1].view);
      expect(agentContextViews).toContain('working-memory');
      expect(agentContextViews).toContain('shared-working-memory');
      expect(agentContextViews).toContain('verified-memory');
    });

    it('memory_search finds the tatooine memory that Phase 1 wrote (round-trip alignment)', async () => {
      const tool = tools.find((t) => t.name === 'memory_search')!;
      const result = await tool.execute('t1', { query: 'tatooine' });
      const text = result.content?.[0]?.text ?? '';
      const payload = JSON.parse(text);
      expect(payload.count).toBeGreaterThanOrEqual(1);
      const snippet = payload.hits[0].snippet as string;
      expect(snippet.toLowerCase()).toContain('tatooine');
    });

    it('searchNarrow (W3 auto-recall) filters to WM layers only', async () => {
      const manager = new DkgMemorySearchManager({
        client: (plugin as any).client,
        resolver: (plugin as any).memorySessionResolver,
      });
      const hits = await manager.searchNarrow('tatooine', { maxResults: 5 });
      // All returned hits must be from a WM layer.
      for (const h of hits) {
        expect(['agent-context-wm', 'project-wm']).toContain(h.layer);
      }
    });
  });

  describe('Contract alignment (the 2026-04-15 regression guard)', () => {
    it('memory_search agent-context query issues WM + SWM + VM views (unscoped across assertions)', async () => {
      const tool = tools.find((t) => t.name === 'memory_search')!;
      await tool.execute('t1', { query: 'anything at all' });
      const agentContextCalls = mockQuery.mock.calls.filter(
        (c) => c[1].contextGraphId === 'agent-context',
      );
      const views = agentContextCalls.map((c) => c[1].view).sort();
      expect(views).toEqual(['shared-working-memory', 'verified-memory', 'working-memory']);
    });

    it('memory_search sends agentAddress on WM reads (required by A-1 isolation at query boundary)', async () => {
      const tool = tools.find((t) => t.name === 'memory_search')!;
      await tool.execute('t1', { query: 'anything at all' });
      const wmCalls = mockQuery.mock.calls.filter((c) => c[1].view === 'working-memory');
      expect(wmCalls.length).toBeGreaterThanOrEqual(1);
      for (const call of wmCalls) {
        expect(call[1].agentAddress).toBeDefined();
      }
    });
  });
});
