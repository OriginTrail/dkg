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
  it('exports a typed MOCK_SUBGRAPHS map from the mock data module', () => {
    expect(MOCK_SUBGRAPHS).toBeDefined();
    expect(typeof MOCK_SUBGRAPHS).toBe('object');
  });

  it('returns the per-context-graph override when one is defined', async () => {
    const result = await mockApi.fetchSubGraphs('cg:pharma-drug-interactions');

    expect(result).toEqual(MOCK_SUBGRAPHS['cg:pharma-drug-interactions']);
    expect(result.contextGraphId).toBe('cg:pharma-drug-interactions');
    expect(result.subGraphs).toHaveLength(2);
    expect(result.subGraphs.map((s) => s.name)).toEqual(['Interactions', 'Contraindications']);
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

  it('keys every override by its own contextGraphId, matching the real response shape', () => {
    for (const [id, entry] of Object.entries(MOCK_SUBGRAPHS)) {
      expect(entry.contextGraphId).toBe(id);
      for (const subGraph of entry.subGraphs) {
        expect(typeof subGraph.name).toBe('string');
        expect(typeof subGraph.uri).toBe('string');
        expect(Number.isFinite(subGraph.entityCount)).toBe(true);
        expect(Number.isFinite(subGraph.tripleCount)).toBe(true);
      }
    }
  });

  it('only overrides context graphs that mock mode actually lists', () => {
    const knownCgIds = new Set(MOCK_CONTEXT_GRAPHS.contextGraphs.map((cg) => cg.id));
    for (const id of Object.keys(MOCK_SUBGRAPHS)) {
      expect(knownCgIds.has(id)).toBe(true);
    }
  });
});
