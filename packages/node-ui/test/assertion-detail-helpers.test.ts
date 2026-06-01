import { describe, expect, it } from 'vitest';
import {
  assertionStageTone,
  canPromoteAssertion,
  assertionSubgraphLine,
  buildAssertionTrail,
  buildBreadcrumbHops,
  primarySubGraphOf,
} from '../src/ui/views/project/helpers.js';
import type { MemoryEntity } from '../src/ui/hooks/useMemoryEntities.js';

function entity(subGraphs: string[]): MemoryEntity {
  return {
    uri: 'urn:e', label: 'E', types: [], trustLevel: 'working',
    layers: new Set(['working']), subGraphs: new Set(subGraphs),
    properties: new Map(), connections: [],
  };
}

// S4 — pure helpers behind the assertion detail view. These pin the
// lifecycle-trail tone mapping (T01), the Promote CTA visibility
// predicate (T02), the header subgraph-line conditional (T03), and the
// trail-stage builder + `is-current` marker.

describe('assertionStageTone — lifecycle state → trail-dot tone (T01)', () => {
  it('maps each state onto the trust-layer tone vocabulary', () => {
    expect(assertionStageTone('created')).toBe('created');   // WM slate
    expect(assertionStageTone('promoted')).toBe('shared');   // SWM amber
    expect(assertionStageTone('published')).toBe('verified'); // VM green
    expect(assertionStageTone('finalized')).toBe('verified'); // VM-internal
    expect(assertionStageTone('discarded')).toBe('discarded');
  });

  it('falls back to the neutral `created` tone for null/undefined/unknown', () => {
    expect(assertionStageTone(null)).toBe('created');
    expect(assertionStageTone(undefined)).toBe('created');
    expect(assertionStageTone('bogus' as any)).toBe('created');
  });
});

describe('canPromoteAssertion — Promote CTA visibility predicate (T02)', () => {
  // Truth table: the CTA shows ONLY for a `created` WM assertion. Every
  // later state and every non-WM layer hides it (no further
  // per-assertion forward action). Hydrating (null state) hides it too
  // so it never flashes in then disappears.
  it('is true ONLY for created + wm', () => {
    expect(canPromoteAssertion('created', 'wm')).toBe(true);
  });

  it('is false for created in a non-WM layer', () => {
    expect(canPromoteAssertion('created', 'swm')).toBe(false);
    expect(canPromoteAssertion('created', 'vm')).toBe(false);
  });

  it('is false for every non-created state, even in wm', () => {
    expect(canPromoteAssertion('promoted', 'wm')).toBe(false);
    expect(canPromoteAssertion('published', 'wm')).toBe(false);
    expect(canPromoteAssertion('finalized', 'wm')).toBe(false);
    expect(canPromoteAssertion('discarded', 'wm')).toBe(false);
  });

  it('is false while the state/layer is still hydrating (null/undefined)', () => {
    expect(canPromoteAssertion(null, 'wm')).toBe(false);
    expect(canPromoteAssertion('created', null)).toBe(false);
    expect(canPromoteAssertion(undefined, undefined)).toBe(false);
  });
});

describe('assertionSubgraphLine — header line-3 conditional (T03)', () => {
  it('returns the `subgraph: <slug>` line only when a sub-graph is present', () => {
    expect(assertionSubgraphLine('research')).toBe('subgraph: research');
  });

  it('returns null for a root-scoped assertion (no trailing-undefined cliff)', () => {
    expect(assertionSubgraphLine(undefined)).toBeNull();
    expect(assertionSubgraphLine(null)).toBeNull();
    expect(assertionSubgraphLine('')).toBeNull();
    expect(assertionSubgraphLine('   ')).toBeNull();
  });
});

describe('buildAssertionTrail — lifecycle trail stages + is-current marker', () => {
  it('renders the full forward chain with the current stage marked', () => {
    const stages = buildAssertionTrail('created');
    expect(stages.map(s => s.state)).toEqual(['created', 'promoted', 'published', 'finalized']);
    expect(stages.filter(s => s.isCurrent).map(s => s.state)).toEqual(['created']);
  });

  it('marks `promoted` as current on a promoted assertion', () => {
    const stages = buildAssertionTrail('promoted');
    expect(stages.filter(s => s.isCurrent).map(s => s.state)).toEqual(['promoted']);
    // Tones follow the trust layers, not the state names.
    expect(stages.find(s => s.state === 'promoted')!.tone).toBe('shared');
    expect(stages.find(s => s.state === 'published')!.tone).toBe('verified');
  });

  it('renders a SINGLE muted discarded event (not created ▸ discarded)', () => {
    const stages = buildAssertionTrail('discarded');
    expect(stages).toHaveLength(1);
    expect(stages[0]).toMatchObject({ state: 'discarded', tone: 'discarded', isCurrent: true });
  });

  it('renders the full chain all-neutral (no current marker) while hydrating', () => {
    const stages = buildAssertionTrail(null);
    expect(stages.map(s => s.state)).toEqual(['created', 'promoted', 'published', 'finalized']);
    expect(stages.some(s => s.isCurrent)).toBe(false);
  });
});

describe('buildBreadcrumbHops — S5 breadcrumb hop construction (T04)', () => {
  const CG = 'Hello World';

  it('overview: a single non-interactive Context Graph hop', () => {
    const hops = buildBreadcrumbHops({ contextGraphName: CG, activeLayer: 'overview', activeSubGraph: null });
    expect(hops).toHaveLength(1);
    expect(hops[0]).toMatchObject({ label: CG, target: 'current' });
  });

  it('on a layer page: Context Graph (link) › Layer full-name (current)', () => {
    const hops = buildBreadcrumbHops({ contextGraphName: CG, activeLayer: 'wm', activeSubGraph: null });
    expect(hops.map(h => h.label)).toEqual([CG, 'Working Memory']);
    expect(hops[0].target).toBe('overview'); // clickable to overview
    expect(hops[1].target).toBe('current');  // current location
  });

  it('uses the full layer name for SWM / VM', () => {
    expect(buildBreadcrumbHops({ contextGraphName: CG, activeLayer: 'swm', activeSubGraph: null })[1].label)
      .toBe('Shared Working Memory');
    expect(buildBreadcrumbHops({ contextGraphName: CG, activeLayer: 'vm', activeSubGraph: null })[1].label)
      .toBe('Verifiable Memory');
  });

  it('on a subgraph page: the middle hop is the subgraph displayName, NOT the layer (never both)', () => {
    const hops = buildBreadcrumbHops({
      contextGraphName: CG, activeLayer: 'wm',
      activeSubGraph: 'demo', subGraphDisplayName: 'Demo Subgraph',
    });
    expect(hops.map(h => h.label)).toEqual([CG, 'Demo Subgraph']);
    // The layer name must NOT appear when a subgraph is the middle hop.
    expect(hops.some(h => h.label === 'Working Memory')).toBe(false);
  });

  it('with an open detail: Context Graph (link) › middle (link → origin) › detail name (current)', () => {
    const hops = buildBreadcrumbHops({
      contextGraphName: CG, activeLayer: 'wm', activeSubGraph: null,
      detailLabel: 'Battery cell 003',
    });
    expect(hops.map(h => h.label)).toEqual([CG, 'Working Memory', 'Battery cell 003']);
    expect(hops[0].target).toBe('overview');
    expect(hops[1].target).toBe('origin'); // middle hop closes the detail
    expect(hops[2].target).toBe('current'); // trailing = you are here
  });

  it('every hop carries a title for the unconditional tooltip', () => {
    const hops = buildBreadcrumbHops({
      contextGraphName: CG, activeLayer: 'wm', activeSubGraph: 'demo',
      subGraphDisplayName: 'Demo', detailLabel: 'X',
    });
    expect(hops.every(h => typeof h.title === 'string' && h.title.length > 0)).toBe(true);
  });
});

describe('buildBreadcrumbHops — cross-subgraph update (T05)', () => {
  // M2(b) makes a cross-subgraph entity jump switch activeSubGraph; S5's
  // breadcrumb must reflect the NEW subgraph on the middle hop. This pins
  // that the hop model is a pure function of the current subgraph — so
  // when activeSubGraph changes, the rendered middle hop changes.
  it('reflects the active subgraph on the middle hop', () => {
    const before = buildBreadcrumbHops({
      contextGraphName: 'CG', activeLayer: 'wm',
      activeSubGraph: 'demo', subGraphDisplayName: 'Demo',
      detailLabel: 'Entity A',
    });
    expect(before[1].label).toBe('Demo');

    // Entity A linked to an entity in subgraph "other" → activeSubGraph
    // follows (M2 option b); the breadcrumb middle hop updates.
    const after = buildBreadcrumbHops({
      contextGraphName: 'CG', activeLayer: 'wm',
      activeSubGraph: 'other', subGraphDisplayName: 'Other',
      detailLabel: 'Entity B',
    });
    expect(after[1].label).toBe('Other');
    expect(after[2].label).toBe('Entity B');
  });
});

describe('primarySubGraphOf — M2(b) cross-subgraph follow decision (T14)', () => {
  it('returns the first non-meta subgraph slug', () => {
    expect(primarySubGraphOf(entity(['demo']))).toBe('demo');
    expect(primarySubGraphOf(entity(['meta', 'research']))).toBe('research');
  });

  it('returns null for a root-only / meta-only entity', () => {
    expect(primarySubGraphOf(entity([]))).toBeNull();
    expect(primarySubGraphOf(entity(['meta']))).toBeNull();
  });

  it('returns null for a missing entity', () => {
    expect(primarySubGraphOf(undefined)).toBeNull();
    expect(primarySubGraphOf(null)).toBeNull();
  });
});
