import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { registerReadTools } from '../src/tools.js';
import { FakeServer, FakeClient, makeConfig } from './harness.js';

describe('dkg_query — two-axis schema migration (post-#17 rename + split)', () => {
  let server: FakeServer;
  let client: FakeClient;

  beforeEach(() => {
    server = new FakeServer();
    client = new FakeClient();
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
  });

  it('registers dkg_query and removes the legacy dkg_sparql binding', () => {
    expect(server.tools.has('dkg_query')).toBe(true);
    expect(server.tools.has('dkg_sparql')).toBe(false);
  });

  it('accepts the post-rename two-axis input shape: view + includeSharedMemory', async () => {
    const result = await server.call('dkg_query', {
      sparql: 'SELECT ?s WHERE { ?s ?p ?o }',
      view: 'shared-working-memory',
    });
    expect(result.isError).toBeFalsy();
    const lastCall = client.queryCalls.at(-1)!;
    expect(lastCall.view).toBe('shared-working-memory');
    expect(lastCall.includeSharedMemory).toBeUndefined();
  });

  it('accepts the WM∪SWM union shape via view: working-memory + includeSharedMemory: true', async () => {
    const result = await server.call('dkg_query', {
      sparql: 'SELECT ?s WHERE { ?s ?p ?o }',
      view: 'working-memory',
      includeSharedMemory: true,
    });
    expect(result.isError).toBeFalsy();
    const lastCall = client.queryCalls.at(-1)!;
    expect(lastCall.view).toBe('working-memory');
    expect(lastCall.includeSharedMemory).toBe(true);
  });

  it.each(['working-memory', 'shared-working-memory', 'verified-memory'])(
    'accepts the canonical view enum value %s',
    async (view) => {
      const result = await server.call('dkg_query', {
        sparql: 'SELECT ?s WHERE { ?s ?p ?o }',
        view,
      });
      expect(result.isError).toBeFalsy();
      expect(client.queryCalls.at(-1)!.view).toBe(view);
    },
  );

  it('post-#17 + F27: legacy `layer` key is silently dropped at parse, call runs with V10 default scope', async () => {
    // Post-W2 #17 the schema migrated to the two-axis (view,
    // includeSharedMemory) shape. The legacy `layer` field is no
    // longer declared. Production MCP SDK silently drops undeclared
    // keys at parse — it does NOT reject them. Pre-F27 the harness
    // ran `.strict()` and asserted these calls *throw*; that
    // assertion was a harness artefact (production would never have
    // thrown). The honest production-equivalent test: every legacy
    // `layer` value parses cleanly and the handler runs with the
    // default scope (no `view`, no `includeSharedMemory` — i.e.
    // dkg_query's default WM-only routing).
    for (const layer of ['wm', 'swm', 'union', 'vm']) {
      const before = client.queryCalls.length;
      const result = await server.call('dkg_query', {
        sparql: 'SELECT ?s WHERE { ?s ?p ?o }',
        layer,
      });
      expect(result.isError).toBeFalsy();
      const lastCall = client.queryCalls[before];
      // Default scope: no view, no includeSharedMemory — `layer`
      // was silently dropped, NOT mapped to anything.
      expect(lastCall.view).toBeUndefined();
      expect(lastCall.includeSharedMemory).toBeUndefined();
      // And the legacy `layer` key itself must not have leaked
      // through to the wire (the parsed input doesn't carry it).
      expect((lastCall as Record<string, unknown>).layer).toBeUndefined();
    }
  });

  it("rejects view values that aren't on the canonical enum (regression: silent typo routes)", async () => {
    await expect(
      server.call('dkg_query', {
        sparql: 'SELECT ?s WHERE { ?s ?p ?o }',
        view: 'wm',
      }),
    ).rejects.toThrow();
    await expect(
      server.call('dkg_query', {
        sparql: 'SELECT ?s WHERE { ?s ?p ?o }',
        view: 'private',
      }),
    ).rejects.toThrow();
  });

  it('inputSchema declares only post-migration knobs (no legacy `layer` key)', () => {
    const tool = server.get('dkg_query');
    const shape = tool.config.inputSchema!;
    const keys = Object.keys(shape);
    // Post-migration surface: sparql, projectId, subGraphName, view,
    // includeSharedMemory, limit. The legacy `layer` key MUST be gone.
    expect(keys).toEqual(
      expect.arrayContaining([
        'sparql',
        'view',
        'includeSharedMemory',
      ]),
    );
    expect(keys).not.toContain('layer');
  });

  it('view enum locks to exactly the canonical three values (alphabetical sort guard)', () => {
    const tool = server.get('dkg_query');
    const viewSchema = tool.config.inputSchema!.view as z.ZodOptional<z.ZodEnum<[string, ...string[]]>>;
    const inner = viewSchema.unwrap() as z.ZodEnum<[string, ...string[]]>;
    expect([...inner.options].sort()).toEqual([
      'shared-working-memory',
      'verified-memory',
      'working-memory',
    ]);
  });
});

// ── F1 sweep: schema-migration uniformity guard ──────────────────────
// Per qa-review-round-1.md F1: the W2 #17 schema migration replaced
// the `layer: 'wm'|'swm'|'union'|'vm'` enum with `view + includeSharedMemory`,
// but the migration was originally applied to `dkg_query` only. F1
// flipped `dkg_get_entity` and `dkg_list_activity` to the canonical
// shape. This sweep asserts that NO public-facing tool surface still
// exposes the legacy `layer` field — same bug-class guard as the
// drop-sweep block in `drop-sweep.test.ts`.
describe('F1 schema-migration sweep — no public tool exposes legacy `layer` field', () => {
  it('asserts every registered tool uses `view + includeSharedMemory` (or no scope field at all)', () => {
    const server = new FakeServer();
    const client = new FakeClient();
    const config = makeConfig();
    registerReadTools(server.asMcpServer(), client.asDkgClient(), config);

    for (const [name, tool] of server.tools.entries()) {
      const shape = tool.config.inputSchema ?? {};
      // The legacy single-axis `layer` field MUST NOT appear on any
      // public-facing tool's inputSchema. Tools that don't take a
      // memory-tier scope at all (e.g. `dkg_get_agent`, listings) are
      // free to omit both — that's also valid.
      expect(
        Object.keys(shape),
        `Tool '${name}' must not expose the legacy 'layer' field; use 'view' + 'includeSharedMemory' per W2 #17 schema migration.`,
      ).not.toContain('layer');
    }
  });

  it('dkg_get_entity accepts `view: "verified-memory"` post-F1', async () => {
    const server = new FakeServer();
    const client = new FakeClient();
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
    const result = await server.call('dkg_get_entity', {
      uri: 'urn:test:entity',
      view: 'verified-memory',
    });
    expect(result.isError).toBeFalsy();
    const lastCall = client.queryCalls.at(-1)!;
    expect(lastCall.view).toBe('verified-memory');
  });

  it('F27: dkg_get_entity silently drops legacy `layer: "union"`, falls back to V9-era default WM∪SWM scope', async () => {
    // Post-F1 the legacy `layer` field is no longer on the schema
    // (replaced by `view + includeSharedMemory`). Production MCP SDK
    // drops undeclared keys at parse — pre-F27 the harness's strict
    // mode falsely asserted that `layer: 'union'` throws here.
    // Honest assertion: the legacy key drops, the handler falls
    // through to the no-view default which preserves the V9-era
    // `layer: 'union'` semantics on the wire (`includeSharedMemory: true`).
    const server = new FakeServer();
    const client = new FakeClient();
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
    const result = await server.call('dkg_get_entity', {
      uri: 'urn:test:entity',
      layer: 'union',
    });
    expect(result.isError).toBeFalsy();
    // Two query calls fire (outgoing + incoming neighbourhood);
    // both must use the no-view default scope.
    expect(client.queryCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of client.queryCalls) {
      expect(call.view).toBeUndefined();
      expect(call.includeSharedMemory).toBe(true);
    }
  });

  it('dkg_list_activity accepts `view: "shared-working-memory"` post-F1', async () => {
    const server = new FakeServer();
    const client = new FakeClient();
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
    const result = await server.call('dkg_list_activity', {
      view: 'shared-working-memory',
    });
    expect(result.isError).toBeFalsy();
    const lastCall = client.queryCalls.at(-1)!;
    expect(lastCall.graphSuffix).toBe('_shared_memory');
  });

  it('F27: dkg_list_activity silently drops legacy `layer: "wm"`, falls back to V9-era default WM∪SWM scope', async () => {
    // F27-bug-class twin to the dkg_get_entity case above. Production
    // MCP SDK drops the legacy `layer` key at parse; the handler
    // falls through to the no-view default. The `layer: 'wm'` value
    // does NOT route to a WM-only query — it gets dropped entirely,
    // leaving the call to use the V9-era WM∪SWM default.
    const server = new FakeServer();
    const client = new FakeClient();
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
    const result = await server.call('dkg_list_activity', { layer: 'wm' });
    expect(result.isError).toBeFalsy();
    const lastCall = client.queryCalls.at(-1)!;
    expect(lastCall.view).toBeUndefined();
    expect(lastCall.includeSharedMemory).toBe(true);
    expect(lastCall.graphSuffix).toBeUndefined();
  });

  it('dkg_get_entity default (no view) preserves V9-era WM∪SWM behaviour', async () => {
    const server = new FakeServer();
    const client = new FakeClient();
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
    await server.call('dkg_get_entity', { uri: 'urn:test:entity' });
    // Default scope must produce WM∪SWM — the historical `layer: 'union'`
    // default. Encoded as `includeSharedMemory: true` on the wire.
    const lastCall = client.queryCalls.at(-1)!;
    expect(lastCall.includeSharedMemory).toBe(true);
    expect(lastCall.view).toBeUndefined();
  });
});

describe('dkg_list_context_graphs — rename + UX-note pair', () => {
  let server: FakeServer;
  let client: FakeClient;

  beforeEach(() => {
    server = new FakeServer();
    client = new FakeClient();
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig({ defaultProject: null }));
  });

  it('registers under the canonical name dkg_list_context_graphs (not dkg_list_projects)', () => {
    expect(server.tools.has('dkg_list_context_graphs')).toBe(true);
    expect(server.tools.has('dkg_list_projects')).toBe(false);
  });

  it("description includes the canonical-naming reconciliation note: \"called 'projects' in the DKG node UI\"", () => {
    const tool = server.get('dkg_list_context_graphs');
    expect(tool.config.description).toContain("called 'projects' in the DKG node UI");
  });

  it('happy path: invokes client.listProjects and renders rows', async () => {
    client.contextGraphs.add('foo');
    client.contextGraphs.add('bar');
    const result = await server.call('dkg_list_context_graphs', {});
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/Found 2 context graph\(s\)/);
    expect(result.content[0].text).toMatch(/\*\*foo\*\*/);
    expect(result.content[0].text).toMatch(/\*\*bar\*\*/);
  });
});

describe('dkg_sub_graph_list — wave-2 rename guard', () => {
  let server: FakeServer;
  let client: FakeClient;

  beforeEach(() => {
    server = new FakeServer();
    client = new FakeClient();
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
  });

  it('registers under the canonical name dkg_sub_graph_list (not dkg_list_subgraphs)', () => {
    expect(server.tools.has('dkg_sub_graph_list')).toBe(true);
    expect(server.tools.has('dkg_list_subgraphs')).toBe(false);
  });
});
