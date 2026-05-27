import { describe, expect, it } from 'vitest';
import { shouldFetchSwmAttribution } from '../src/ui/views/project/helpers.js';

// Pins the predicate that ProjectView uses to decide whether to feed
// `useSwmAttributions` a real `contextGraphId` or `undefined`.
//
// PR #694 review fix — the Overview is no longer a consumer (the
// activity feed switched to `useAssertionLifecycleEvents` for the
// agent-DID-keyed bundle stream). Only the SWM-layer graph reads
// this hook now; the gate tightened to `'swm'`-only so the 5k-row
// SPARQL doesn't fire on Overview renders and throw the result away.
//
// Still no `selectedUri` arg: opening an entity detail on the SWM
// tab must keep the gate true so the hook's cached events survive
// the detail round-trip (R2-Local-1 flicker concern, PR #656).
describe('shouldFetchSwmAttribution — ProjectView gate predicate', () => {
  it('is true ONLY on the SWM tab (its sole remaining consumer)', () => {
    expect(shouldFetchSwmAttribution({ activeLayer: 'swm', activeSubGraph: null })).toBe(true);
  });

  it('is false on the Overview tab (PR #694 fix — Overview switched to lifecycle source)', () => {
    expect(shouldFetchSwmAttribution({ activeLayer: 'overview', activeSubGraph: null })).toBe(false);
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
  // omission as an invariant rather than an oversight (now exercised
  // on the SWM tab, the sole consumer).
  it('round-tripping a flicker scenario (SWM → detail → SWM) keeps the gate true (R2-Local-1)', () => {
    // The caller passes `{ activeLayer, activeSubGraph }` only; the
    // detail overlay is orthogonal to both. So the predicate cannot
    // observe a transient `selectedUri` and therefore cannot flip.
    const swm = { activeLayer: 'swm' as const, activeSubGraph: null };
    expect(shouldFetchSwmAttribution(swm)).toBe(true);
    // Simulated detail-open: same args, same answer.
    expect(shouldFetchSwmAttribution(swm)).toBe(true);
    // Simulated detail-close: same args, same answer.
    expect(shouldFetchSwmAttribution(swm)).toBe(true);
  });
});
