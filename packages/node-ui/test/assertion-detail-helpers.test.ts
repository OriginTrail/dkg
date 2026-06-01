import { describe, expect, it } from 'vitest';
import {
  assertionStageTone,
  canPromoteAssertion,
  assertionSubgraphLine,
  buildAssertionTrail,
} from '../src/ui/views/project/helpers.js';

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
