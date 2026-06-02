import { describe, expect, it } from 'vitest';
import {
  assertionStageTone,
  canPromoteAssertion,
  assertionSubgraphLine,
  buildAssertionTrail,
  assertionEmptyStateCopy,
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

describe('assertionEmptyStateCopy — ux §4.7.1 state-keyed empty copy (Codex round-3 #3)', () => {
  it('created → "no extracted entities" (the generalization must NOT loosen this)', () => {
    const c = assertionEmptyStateCopy('created');
    expect(c.title).toBe('No entities in this assertion.');
    expect(c.description).toBe('This assertion has no extracted entities.');
  });

  it('promoted → SWM forward-path line (unchanged)', () => {
    const c = assertionEmptyStateCopy('promoted');
    expect(c.title).toBe('No entities in this assertion.');
    expect(c.description).toContain('now live in Shared Working Memory');
    expect(c.description).toContain('Open the Shared Working Memory tab');
    expect(c.description).not.toContain('no extracted entities');
  });

  it('published AND finalized → VM / Knowledge-Assets line, NOT "no extracted entities"', () => {
    for (const s of ['published', 'finalized'] as const) {
      const c = assertionEmptyStateCopy(s);
      expect(c.title).toBe('No entities in this assertion.');
      expect(c.description).toBe('This assertion was published — its entities are now Knowledge Assets in Verifiable Memory. Open the Verifiable Memory tab to view them.');
      expect(c.description).not.toContain('no extracted entities');
      expect(c.description).not.toContain('Shared Working Memory');
    }
  });

  it('discarded → terminal copy, no "open X tab" forward path', () => {
    const c = assertionEmptyStateCopy('discarded');
    expect(c.title).toBe('This assertion was discarded.');
    expect(c.description).toBe('This assertion was discarded.');
    expect(c.description).not.toContain('Open the');
  });

  it('hydrating (null) falls back to the created copy', () => {
    expect(assertionEmptyStateCopy(null).description).toBe('This assertion has no extracted entities.');
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
  // When NO origin snapshot is threaded, the middle hop falls back to the
  // current subgraph (pre-8-2 behaviour — and still correct for callers
  // that don't supply the origin). Codex round-8 (8-2) layers the
  // origin-aware labelling ON TOP of this fallback (see the next describe).
  it('reflects the active subgraph on the middle hop (no origin threaded → current fallback)', () => {
    const before = buildBreadcrumbHops({
      contextGraphName: 'CG', activeLayer: 'wm',
      activeSubGraph: 'demo', subGraphDisplayName: 'Demo',
      detailLabel: 'Entity A',
    });
    expect(before[1].label).toBe('Demo');

    const after = buildBreadcrumbHops({
      contextGraphName: 'CG', activeLayer: 'wm',
      activeSubGraph: 'other', subGraphDisplayName: 'Other',
      detailLabel: 'Entity B',
    });
    expect(after[1].label).toBe('Other');
    expect(after[2].label).toBe('Entity B');
  });
});

describe('buildBreadcrumbHops — origin-derived middle hop (Codex round-8 / 8-2)', () => {
  // When a detail is open the middle hop's target is `'origin'` (clicking
  // closes the detail back to where it was opened). After an M2(b)
  // cross-subgraph follow the CURRENT subgraph diverges from the origin, so
  // the middle hop's LABEL must name the ORIGIN — where the click returns
  // you — not the followed-into subgraph.
  it('labels the middle hop with the ORIGIN subgraph, not the current one (M2(b) divergence)', () => {
    const hops = buildBreadcrumbHops({
      contextGraphName: 'CG', activeLayer: 'wm',
      // Current page is subgraph "other" (followed into via M2(b)) …
      activeSubGraph: 'other', subGraphDisplayName: 'Other',
      detailLabel: 'Entity B',
      // … but the detail was OPENED from subgraph "demo".
      originLayer: 'wm',
      originSubGraph: 'demo', originSubGraphDisplayName: 'Demo',
    });
    // Middle hop names the origin (Demo) — clicking it returns there.
    expect(hops[1].label).toBe('Demo');
    expect(hops[1].target).toBe('origin');
    // ONLY the middle hop changes — trailing stays the entity name.
    expect(hops[2].label).toBe('Entity B');
    expect(hops[2].target).toBe('current');
    // The followed-into subgraph name must NOT appear anywhere.
    expect(hops.some(h => h.label === 'Other')).toBe(false);
  });

  it('labels the middle hop with the ORIGIN layer when the origin was a layer page', () => {
    const hops = buildBreadcrumbHops({
      contextGraphName: 'CG',
      // Current location followed into a subgraph …
      activeLayer: 'wm', activeSubGraph: 'other', subGraphDisplayName: 'Other',
      detailLabel: 'Entity B',
      // … but the detail was opened from the SWM layer list (no subgraph).
      originLayer: 'swm', originSubGraph: null, originSubGraphDisplayName: null,
    });
    expect(hops[1].label).toBe('Shared Working Memory');
    expect(hops[1].target).toBe('origin');
  });

  it('synthesises NO middle hop when the origin was the overview (2-hop rule holds)', () => {
    const hops = buildBreadcrumbHops({
      contextGraphName: 'CG',
      activeLayer: 'wm', activeSubGraph: 'other', subGraphDisplayName: 'Other',
      detailLabel: 'Entity B',
      // Origin was the overview — no middle to return to.
      originLayer: 'overview', originSubGraph: null, originSubGraphDisplayName: null,
    });
    expect(hops.map(h => h.label)).toEqual(['CG', 'Entity B']);
    expect(hops[1].target).toBe('current');
  });

  it('falls back to current-scope labelling when no origin is threaded (back-compat)', () => {
    // Detail open but origin props omitted (undefined) → current label.
    const hops = buildBreadcrumbHops({
      contextGraphName: 'CG', activeLayer: 'wm',
      activeSubGraph: 'other', subGraphDisplayName: 'Other',
      detailLabel: 'Entity B',
    });
    expect(hops[1].label).toBe('Other');
  });
});

describe('buildBreadcrumbHops — first-hop restores origin for an overview-opened detail (Codex round-10 / 10-2)', () => {
  const CG = 'Hello World';

  // Detail opened from the OVERVIEW → 2-hop `[Context Graph › Detail]`, no
  // middle. The first hop is the SOLE back-affordance, so it must restore
  // the M2 origin (target 'origin' → onRestoreOrigin), NOT do a fresh
  // top-of-overview nav that drops the captured scroll/tab.
  it('detail-from-overview (2-hop): the first hop target is "origin", not "overview"', () => {
    const hops = buildBreadcrumbHops({
      contextGraphName: CG,
      activeLayer: 'wm', activeSubGraph: 'other', subGraphDisplayName: 'Other',
      detailLabel: 'Entity B',
      // Origin was the overview — no middle hop.
      originLayer: 'overview', originSubGraph: null, originSubGraphDisplayName: null,
    });
    expect(hops.map(h => h.label)).toEqual([CG, 'Entity B']); // 2 hops, no middle
    expect(hops[0].target).toBe('origin');   // first hop restores origin
    expect(hops[1].target).toBe('current');  // trailing = you are here
  });

  // Detail opened from a LAYER (3-hop) → the first hop stays 'overview' (a
  // genuine go-UP-to-CG-root, distinct from the middle hop's 'origin'
  // restore). The carve-out must hold.
  it('detail-from-layer (3-hop): the first hop stays "overview" (carve-out)', () => {
    const hops = buildBreadcrumbHops({
      contextGraphName: CG,
      activeLayer: 'wm', activeSubGraph: null,
      detailLabel: 'Entity B',
      originLayer: 'swm', originSubGraph: null, originSubGraphDisplayName: null,
    });
    expect(hops.map(h => h.label)).toEqual([CG, 'Shared Working Memory', 'Entity B']); // 3 hops
    expect(hops[0].target).toBe('overview'); // go up to CG root — unchanged
    expect(hops[1].target).toBe('origin');   // middle restores origin
    expect(hops[2].target).toBe('current');
  });

  // No detail open: the first hop is 'overview' (unchanged baseline).
  it('no detail open: the first hop is "overview" (unchanged)', () => {
    const hops = buildBreadcrumbHops({
      contextGraphName: CG, activeLayer: 'wm', activeSubGraph: null,
    });
    expect(hops[0].target).toBe('overview');
    expect(hops[1].target).toBe('current');
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
