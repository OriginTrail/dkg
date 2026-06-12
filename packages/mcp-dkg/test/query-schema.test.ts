import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { registerReadTools } from '../src/tools.js';
import { FakeServer } from './harness.js';
import { LIVE, API, TOKEN, CG, liveClient, liveConfig } from './live.js';

// ── NO MOCKS ─────────────────────────────────────────────────────────
// Two lanes:
//   • PURE schema/registration tests build the REAL `DkgClient` (never
//     invoked — registration + zod parsing don't touch the network) and
//     use `FakeServer.parse` (schema-only). They run in every lane.
//   • The two-axis ROUTING + rendering behaviour (view → wm/swm/vm) is
//     proven END-TO-END against a live daemon below (gated on
//     MCP_INTEGRATION_TEST): we seed an SWM-only entity and assert which
//     `view` surfaces it. The retired FakeClient could only *spy* on the
//     args the tool computed; here the real daemon's routing is the oracle.

describe('dkg_query — two-axis schema migration (post-#17 rename + split)', () => {
  let server: FakeServer;

  beforeEach(() => {
    server = new FakeServer();
    registerReadTools(server.asMcpServer(), liveClient(), liveConfig());
  });

  it('registers dkg_query and removes the legacy dkg_sparql binding', () => {
    expect(server.tools.has('dkg_query')).toBe(true);
    expect(server.tools.has('dkg_sparql')).toBe(false);
  });

  it('accepts the post-rename two-axis input shape: view + includeSharedMemory (schema parse)', () => {
    expect(() =>
      server.parse('dkg_query', { sparql: 'SELECT ?s WHERE { ?s ?p ?o }', view: 'shared-working-memory' }),
    ).not.toThrow();
    const parsed = server.parse('dkg_query', {
      sparql: 'SELECT ?s WHERE { ?s ?p ?o }',
      view: 'working-memory',
      includeSharedMemory: true,
    });
    expect(parsed.view).toBe('working-memory');
    expect(parsed.includeSharedMemory).toBe(true);
  });

  it.each(['working-memory', 'shared-working-memory', 'verifiable-memory'])(
    'accepts the canonical view enum value %s (schema parse)',
    (view) => {
      const parsed = server.parse('dkg_query', { sparql: 'SELECT ?s WHERE { ?s ?p ?o }', view });
      expect(parsed.view).toBe(view);
    },
  );

  it('post-#17 + F27: legacy `layer` key is silently dropped at parse (production MCP SDK posture)', () => {
    for (const layer of ['wm', 'swm', 'union', 'vm']) {
      const parsed = server.parse('dkg_query', { sparql: 'SELECT ?s WHERE { ?s ?p ?o }', layer });
      // `layer` is not a declared field → dropped at parse, NOT mapped.
      expect(parsed.view).toBeUndefined();
      expect(parsed.includeSharedMemory).toBeUndefined();
      expect((parsed as Record<string, unknown>).layer).toBeUndefined();
    }
  });

  it("rejects view values that aren't on the canonical enum (regression: silent typo routes)", () => {
    expect(() => server.parse('dkg_query', { sparql: 'SELECT ?s WHERE { ?s ?p ?o }', view: 'wm' })).toThrow();
    expect(() => server.parse('dkg_query', { sparql: 'SELECT ?s WHERE { ?s ?p ?o }', view: 'private' })).toThrow();
  });

  it('inputSchema declares only post-migration knobs (no legacy `layer` key)', () => {
    const tool = server.get('dkg_query');
    const keys = Object.keys(tool.config.inputSchema!);
    expect(keys).toEqual(expect.arrayContaining(['sparql', 'view', 'includeSharedMemory']));
    expect(keys).not.toContain('layer');
  });

  it('view enum locks to exactly the canonical three values (alphabetical sort guard)', () => {
    const tool = server.get('dkg_query');
    const viewSchema = tool.config.inputSchema!.view as z.ZodOptional<z.ZodEnum<[string, ...string[]]>>;
    const inner = viewSchema.unwrap() as z.ZodEnum<[string, ...string[]]>;
    expect([...inner.options].sort()).toEqual([
      'shared-working-memory',
      'verifiable-memory',
      'working-memory',
    ]);
  });
});

// ── F1 sweep: schema-migration uniformity guard ──────────────────────
describe('F1 schema-migration sweep — no public tool exposes legacy `layer` field', () => {
  it('asserts every registered tool uses `view + includeSharedMemory` (or no scope field at all)', () => {
    const server = new FakeServer();
    registerReadTools(server.asMcpServer(), liveClient(), liveConfig());
    for (const [name, tool] of server.tools.entries()) {
      expect(
        Object.keys(tool.config.inputSchema ?? {}),
        `Tool '${name}' must not expose the legacy 'layer' field; use 'view' + 'includeSharedMemory' per W2 #17 schema migration.`,
      ).not.toContain('layer');
    }
  });

  it('dkg_get_entity accepts `view: "verifiable-memory"` post-F1 (schema parse)', () => {
    const server = new FakeServer();
    registerReadTools(server.asMcpServer(), liveClient(), liveConfig());
    const parsed = server.parse('dkg_get_entity', { uri: 'urn:test:entity', view: 'verifiable-memory' });
    expect(parsed.view).toBe('verifiable-memory');
  });

  it('F27: dkg_get_entity silently drops legacy `layer: "union"` at parse', () => {
    const server = new FakeServer();
    registerReadTools(server.asMcpServer(), liveClient(), liveConfig());
    const parsed = server.parse('dkg_get_entity', { uri: 'urn:test:entity', layer: 'union' });
    expect(parsed.view).toBeUndefined();
    expect((parsed as Record<string, unknown>).layer).toBeUndefined();
  });

  it('dkg_list_activity accepts `view: "shared-working-memory"` post-F1 (schema parse)', () => {
    const server = new FakeServer();
    registerReadTools(server.asMcpServer(), liveClient(), liveConfig());
    const parsed = server.parse('dkg_list_activity', { view: 'shared-working-memory' });
    expect(parsed.view).toBe('shared-working-memory');
  });
});

describe('dkg_list_context_graphs / dkg_sub_graph_list — rename guards', () => {
  let server: FakeServer;

  beforeEach(() => {
    server = new FakeServer();
    registerReadTools(server.asMcpServer(), liveClient(), liveConfig({ defaultProject: null }));
  });

  it('registers under the canonical name dkg_list_context_graphs (not dkg_list_projects)', () => {
    expect(server.tools.has('dkg_list_context_graphs')).toBe(true);
    expect(server.tools.has('dkg_list_projects')).toBe(false);
  });

  it("description includes the canonical-naming reconciliation note: \"called 'projects' in the DKG node UI\"", () => {
    expect(server.get('dkg_list_context_graphs').config.description).toContain("called 'projects' in the DKG node UI");
  });

  it('registers under the canonical name dkg_sub_graph_list (not dkg_list_subgraphs)', () => {
    expect(server.tools.has('dkg_sub_graph_list')).toBe(true);
    expect(server.tools.has('dkg_list_subgraphs')).toBe(false);
  });
});

// ── Live routing + rendering (real daemon, no mocks) ─────────────────
describe.skipIf(!LIVE)('dkg_query / dkg_get_entity — two-axis routing on a live daemon', () => {
  const RUN = `qs-${Date.now().toString(36)}`;
  const subj = `urn:qs:${RUN}:swm-only`;
  const objLiteral = `swm-only marker ${RUN}`;
  let server: FakeServer;

  beforeEach(() => {
    server = new FakeServer();
    registerReadTools(server.asMcpServer(), liveClient(), liveConfig());
  });

  // Seed an entity into LOOSE SWM only (POST /api/shared-memory/write),
  // so "which view surfaces it" is a real routing oracle: SWM-scoped reads
  // see it, WM-only reads do not.
  it('seeds an SWM-only entity through the real daemon', async () => {
    const did = `did:dkg:context-graph:${CG}`;
    const res = await fetch(`${API}/api/shared-memory/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        contextGraphId: CG,
        quads: [
          { subject: subj, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'urn:qs:Marker', graph: did },
          { subject: subj, predicate: 'urn:qs:p:label', object: `"${objLiteral}"`, graph: did },
        ],
      }),
    });
    expect(res.ok, `seed /api/shared-memory/write failed: ${res.status}`).toBe(true);
  });

  it('view: "shared-working-memory" surfaces the SWM-only entity', async () => {
    const r = await server.call('dkg_query', {
      sparql: `SELECT ?o WHERE { <${subj}> <urn:qs:p:label> ?o }`,
      view: 'shared-working-memory',
    });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain(objLiteral);
  });

  it('view: "working-memory" (WM-only) does NOT surface the SWM-only entity', async () => {
    const r = await server.call('dkg_query', {
      sparql: `SELECT ?o WHERE { <${subj}> <urn:qs:p:label> ?o }`,
      view: 'working-memory',
    });
    expect(r.isError).toBeFalsy();
    // The SWM marker must not bleed into a WM-only read — proves `view`
    // actually routes (a tool that dropped `view` would show it).
    expect(r.content[0].text).not.toContain(objLiteral);
  });

  it('dkg_get_entity default scope (no view) returns the WM∪SWM union — finds the SWM entity', async () => {
    const r = await server.call('dkg_get_entity', { uri: subj });
    expect(r.isError).toBeFalsy();
    // Default == V9-era layer:"union" (includeSharedMemory:true) → SWM visible.
    expect(r.content[0].text).toContain('urn:qs:p:label');
  });
});

describe.skipIf(!LIVE)('dkg_list_context_graphs — rendering against a live daemon', () => {
  it('renders the registered devnet CG and honours scope all/mine', async () => {
    const server = new FakeServer();
    registerReadTools(server.asMcpServer(), liveClient(), liveConfig({ defaultProject: CG }));

    const all = await server.call('dkg_list_context_graphs', { scope: 'all' });
    expect(all.isError).toBeFalsy();
    expect(all.content[0].text).toMatch(/Found \d+ context graph\(s\) \(known\)/);
    expect(all.content[0].text).toContain(CG);

    const mine = await server.call('dkg_list_context_graphs', { scope: 'mine' });
    expect(mine.isError).toBeFalsy();
    expect(mine.content[0].text).toMatch(/Found \d+ context graph\(s\) \(created\/joined\)/);
    // The devnet CG is pinned via defaultProject → must carry the ★ marker.
    expect(mine.content[0].text).toMatch(new RegExp(`\\*\\*${CG}\\*\\* ★`));
  });
});
