import { describe, expect, it } from 'vitest';
import { shouldFetchSwmAttribution } from '../src/ui/views/project/helpers.js';

// R2-Local-1 (PR #656) — pins the predicate that ProjectView uses to
// decide whether to feed `useSwmAttributions` a real `contextGraphId`
// or `undefined`. Critical that opening an entity detail does NOT
// flip the predicate to `false` — the hook would clear its cached
// events and force a 5000-row re-fetch on detail-close, making the
// Overview activity feed visibly flicker.
describe('shouldFetchSwmAttribution — ProjectView gate predicate', () => {
  it('is true on the Overview tab (activity feed consumer)', () => {
    expect(shouldFetchSwmAttribution({ activeLayer: 'overview', activeSubGraph: null })).toBe(true);
  });

  it('is true on the SWM tab (layer graph consumer)', () => {
    expect(shouldFetchSwmAttribution({ activeLayer: 'swm', activeSubGraph: null })).toBe(true);
  });

  it('is false on WM / VM / graph-overview / query (no consumer)', () => {
    expect(shouldFetchSwmAttribution({ activeLayer: 'wm', activeSubGraph: null })).toBe(false);
    expect(shouldFetchSwmAttribution({ activeLayer: 'vm', activeSubGraph: null })).toBe(false);
    expect(shouldFetchSwmAttribution({ activeLayer: 'graph-overview', activeSubGraph: null })).toBe(false);
    expect(shouldFetchSwmAttribution({ activeLayer: 'query', activeSubGraph: null })).toBe(false);
  });

  it('is false while a sub-graph page is active (real route change)', () => {
    expect(shouldFetchSwmAttribution({ activeLayer: 'overview', activeSubGraph: 'docs' })).toBe(false);
    expect(shouldFetchSwmAttribution({ activeLayer: 'swm', activeSubGraph: 'docs' })).toBe(false);
  });

  // The flicker bug — opening an entity detail overlay must keep the
  // gate `true` on consumer views so the hook's cached events stay
  // populated through the detail-open/close round-trip. The predicate
  // intentionally takes no `selectedUri` arg; this test pins that
  // omission as an invariant rather than an oversight.
  it('round-tripping a flicker scenario (Overview → detail → Overview) keeps the gate true (R2-Local-1)', () => {
    // The caller passes `{ activeLayer, activeSubGraph }` only; the
    // detail overlay is orthogonal to both. So the predicate cannot
    // observe a transient `selectedUri` and therefore cannot flip.
    const overview = { activeLayer: 'overview' as const, activeSubGraph: null };
    expect(shouldFetchSwmAttribution(overview)).toBe(true);
    // Simulated detail-open: same args, same answer.
    expect(shouldFetchSwmAttribution(overview)).toBe(true);
    // Simulated detail-close: same args, same answer.
    expect(shouldFetchSwmAttribution(overview)).toBe(true);
  });
});
