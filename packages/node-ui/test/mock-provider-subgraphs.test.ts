import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MOCK_CONTEXT_GRAPHS, MOCK_SUBGRAPHS } from '../src/ui/mocks/data.js';
import { mockApi } from '../src/ui/mocks/provider.js';

// GH#1763 — `provider.ts` used to read `(mock as any).MOCK_SUBGRAPHS`, a symbol
// `data.ts` never exported. The optional lookup stopped mock mode from
// crashing, so the only visible symptom was a Vite missing-export warning on
// every production build — and the per-CG override the provider's own comment
// advertised silently could not work. These tests pin both halves of the
// contract so the export cannot regress back into an untyped lookup.
describe('mockApi.fetchSubGraphs (GH#1763)', () => {
  it('returns the per-context-graph override when one is defined', async () => {
    const result = await mockApi.fetchSubGraphs('cg:pharma-drug-interactions');

    expect(result).toEqual(MOCK_SUBGRAPHS['cg:pharma-drug-interactions']);
    expect(result.contextGraphId).toBe('cg:pharma-drug-interactions');
    expect(result.subGraphs).toHaveLength(2);
    expect(result.subGraphs.map((s) => s.name)).toEqual(['interactions', 'contraindications']);
  });

  it('falls back to an empty list for a context graph with no override', async () => {
    // `cg:supply-chain-eu` is a real mock CG deliberately left out of
    // MOCK_SUBGRAPHS so the fallback path stays covered.
    expect(MOCK_SUBGRAPHS['cg:supply-chain-eu']).toBeUndefined();

    const result = await mockApi.fetchSubGraphs('cg:supply-chain-eu');

    expect(result).toEqual({ contextGraphId: 'cg:supply-chain-eu', subGraphs: [] });
  });

  it('falls back to an empty list for an entirely unknown context graph', async () => {
    const result = await mockApi.fetchSubGraphs('cg:does-not-exist');

    expect(result).toEqual({ contextGraphId: 'cg:does-not-exist', subGraphs: [] });
  });

  it('only overrides context graphs that mock mode actually lists', () => {
    const knownCgIds = new Set(MOCK_CONTEXT_GRAPHS.contextGraphs.map((cg) => cg.id));
    for (const id of Object.keys(MOCK_SUBGRAPHS)) {
      expect(knownCgIds.has(id)).toBe(true);
    }
  });
});

// PR #2131 review — the previous version of the suite had a case titled
// "matching the real response shape" that asserted only `typeof name ===
// 'string'`, which is why a fixture with a whitespace slug and a prefix-less
// URI shipped green. These assert the actual production invariants.
describe('MOCK_SUBGRAPHS fidelity to /api/sub-graph/list', () => {
  // Mirror of `validateSubGraphName` in `packages/core/src/constants.ts:650`.
  // node-ui tests mirror core helpers rather than importing them (see
  // `sub-graph-uri.test.ts`). Whitespace is the clause that matters here.
  const UNSAFE_SUB_GRAPH_CHARS = /[<>"{}|^`\\\s]/;
  const RESERVED_SEGMENTS = new Set(['context', 'assertion', 'draft']);

  const rows = Object.entries(MOCK_SUBGRAPHS).flatMap(([cgId, entry]) =>
    entry.subGraphs.map((subGraph) => ({ cgId, subGraph })),
  );

  it('fixture is non-empty, so the invariants below are not vacuous', () => {
    expect(rows.length).toBeGreaterThan(0);
  });

  it('keys every override by its own contextGraphId', () => {
    for (const [id, entry] of Object.entries(MOCK_SUBGRAPHS)) {
      expect(entry.contextGraphId).toBe(id);
    }
  });

  it('uses slugs the daemon could actually emit', () => {
    for (const { subGraph } of rows) {
      expect(subGraph.name.length).toBeGreaterThan(0);
      expect(subGraph.name.startsWith('_')).toBe(false);
      expect(subGraph.name).not.toContain('/');
      expect(UNSAFE_SUB_GRAPH_CHARS.test(subGraph.name)).toBe(false);
      expect(RESERVED_SEGMENTS.has(subGraph.name)).toBe(false);
    }
  });

  it('builds every uri as did:dkg:context-graph:<cgId>/<name>', () => {
    // Mirror of `contextGraphSubGraphUri` in `packages/core/src/constants.ts:563`.
    for (const { cgId, subGraph } of rows) {
      expect(subGraph.uri).toBe(`did:dkg:context-graph:${cgId}/${subGraph.name}`);
    }
  });

  it('carries the createdBy/createdAt the list route always emits', () => {
    // `cli/src/daemon/routes/context-graph.ts:1004-1010` passes both through
    // unconditionally, so a row missing either is unreachable in production.
    for (const { subGraph } of rows) {
      expect(typeof subGraph.createdBy).toBe('string');
      expect(subGraph.createdBy).toMatch(/^did:dkg:agent:0x[0-9a-fA-F]{40}$/);
      expect(typeof subGraph.createdAt).toBe('string');
      expect(Number.isNaN(Date.parse(subGraph.createdAt as string))).toBe(false);
    }
  });

  it('carries finite counts', () => {
    for (const { subGraph } of rows) {
      expect(Number.isFinite(subGraph.entityCount)).toBe(true);
      expect(Number.isFinite(subGraph.tripleCount)).toBe(true);
    }
  });
});

// PR #2131 review — exporting the fixture only helps the one `fetchSubGraphs`
// consumer that goes through `api-wrapper`. `SubGraphBar` and
// `SubGraphOverviewGrid` imported it straight from `api.js`, so demo mode
// showed the Overview "Subgraphs" stat disagreeing with an empty Subgraph
// Explorer for the same CG. Source-level guard because a rendering test would
// not catch a future component re-importing the unwrapped function.
describe('every fetchSubGraphs consumer routes through api-wrapper', () => {
  const consumers = [
    '../src/ui/components/SubGraphBar.tsx',
    '../src/ui/views/project/components/subgraph.tsx',
    '../src/ui/views/ProjectView.tsx',
  ];

  for (const rel of consumers) {
    it(`${rel} does not import fetchSubGraphs from api.js`, () => {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

      expect(src).toMatch(/fetchSubGraphs/);
      expect(src).toMatch(/api\.fetchSubGraphs\(/);
      // The unwrapped import is what desyncs mock mode.
      expect(src).not.toMatch(/import\s*{[^}]*\bfetchSubGraphs\b[^}]*}\s*from\s*'[^']*\/api\.js'/);
    });
  }
});
