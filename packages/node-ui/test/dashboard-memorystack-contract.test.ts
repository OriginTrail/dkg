// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  useCanonicalTriples,
  useLayerTriples,
  useMemoryCounts,
} from '../src/ui/views/project/helpers.js';
import {
  buildMemoryEntities,
  type LayeredTriple,
  type MemoryData,
} from '../src/ui/hooks/useMemoryEntities.js';

// GH #819 round 5 (Codex sweep 3 🟡 #10) — view-level regression
// guard for DashboardView + MemoryStackView. Both views derive
// per-layer triple counts from `useLayerTriples(memory, layer)`
// and the total from `useCanonicalTriples(memory).total`. The
// guard locks two invariants the views rely on:
//
//   (1) `wm + swm + vm <= total` — per-layer cells use the OR-rule
//       (drop if subject OR resource-object moved past `t.layer`)
//       while the total uses the canonical AND-rule (drop only
//       when BOTH endpoints moved). The gap = mixed-layer edges
//       canonical keeps but per-layer slices drop.
//   (2) Cross-graph SPO duplicates + WM residue drop out of all
//       four numbers. Pre-#819 the views iterated `mem.allTriples`
//       directly and inflated both the total and the per-layer
//       cells. Post-#819 the helpers handle dedup + residue so the
//       view-level numbers stay honest.
//
// We don't render the views (heavy `useFetch` + `useNodeEvents`
// state machines wouldn't add coverage over what the helpers
// already test). We DO render the helpers through React so the
// hook-level memoization runs end-to-end; an isomorphic Probe
// surfaces the four numbers as data attributes for assertion.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

function memoryFor(triples: LayeredTriple[]): MemoryData {
  const entities = buildMemoryEntities(triples);
  return {
    entities,
    entityList: [...entities.values()],
    allTriples: triples,
    graphTriples: [],
    trustMap: new Map(),
    counts: { wm: 0, swm: 0, vm: 0, total: entities.size },
    loading: false,
    error: null,
    partial: false,
    layerStatus: { wm: 'ok', swm: 'ok', vm: 'ok' },
    refresh: () => {},
  } as unknown as MemoryData;
}

// Mirror of DashboardView.tsx:368-377 / MemoryStackView.tsx:103-105
// — the exact derivation both views ship.
function ViewCountsProbe({ memory }: { memory: MemoryData }) {
  const wm = useLayerTriples(memory as any, 'wm').length;
  const swm = useLayerTriples(memory as any, 'swm').length;
  const vm = useLayerTriples(memory as any, 'vm').length;
  const { total } = useCanonicalTriples(memory as any);
  return React.createElement('div', {
    id: 'probe',
    'data-wm': String(wm),
    'data-swm': String(swm),
    'data-vm': String(vm),
    'data-total': String(total),
  });
}

function readProbe(container: Element) {
  const probe = container.querySelector('#probe')!;
  return {
    wm: Number(probe.getAttribute('data-wm')),
    swm: Number(probe.getAttribute('data-swm')),
    vm: Number(probe.getAttribute('data-vm')),
    total: Number(probe.getAttribute('data-total')),
  };
}

describe('Dashboard + MemoryStack derivation contract (GH #819 round 5 — Codex sweep 3 🟡 #10)', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(memory: MemoryData) {
    act(() => {
      root.render(React.createElement(ViewCountsProbe, { memory }));
    });
  }

  it('wm + swm + vm <= total invariant holds; gap == mixed-layer edge count', () => {
    // Fixture mirrors the recipe-app CG shape that motivated #819:
    // - Two WM-only entities with literal-name rows (cleanly WM)
    // - One SWM entity with a literal-name row (cleanly SWM)
    // - One mixed-layer edge from the SWM entity to a WM entity
    //   (subject moved past WM, object still WM — KEEPS as fact)
    const triples: LayeredTriple[] = [
      // Two WM-only literal-name rows — admit per-layer wm, admit canonical.
      { subject: 'urn:e:wm-a', predicate: 'http://schema.org/name', object: '"A"', layer: 'working' },
      { subject: 'urn:e:wm-b', predicate: 'http://schema.org/name', object: '"B"', layer: 'working' },
      // SWM entity literal-name row — admits per-layer swm, admits canonical.
      { subject: 'urn:e:swm-c', predicate: 'http://schema.org/name', object: '"C"', layer: 'shared' },
      // Mixed-layer edge: subject SWM canonical, object WM canonical, row
      // stored at WM. Per-layer wm DROPS this (subject moved past WM via
      // OR-rule). Canonical KEEPS this (only one endpoint moved via
      // BOTH-endpoints AND-rule). This row IS the wm+swm+vm vs total gap.
      { subject: 'urn:e:swm-c', predicate: 'http://schema.org/knows', object: 'urn:e:wm-a', layer: 'working' },
    ];
    render(memoryFor(triples));
    const { wm, swm, vm, total } = readProbe(container);

    // wm = 2 (the two WM-only literal-name rows). The mixed-layer
    // edge dropped from wm because subject moved past WM.
    expect(wm).toBe(2);
    // swm = 1 (the SWM literal-name row only). The mixed-layer
    // edge is stored at layer=working, so it does NOT contribute
    // to swm's count either.
    expect(swm).toBe(1);
    expect(vm).toBe(0);
    // canonical keeps all 4 rows (3 cleanly-per-layer + 1 mixed-layer fact).
    expect(total).toBe(4);

    // Invariant: per-layer sum <= total.
    expect(wm + swm + vm).toBeLessThanOrEqual(total);
    // Gap === count of mixed-layer edges (1 in this fixture).
    expect(total - (wm + swm + vm)).toBe(1);
  });

  it('WM-residue post-promote drops from every cell + total (no inflation vs raw allTriples)', () => {
    // Two entities both promoted past WM (canonical 'shared').
    // The WM-residue row connecting them is unambiguous residue
    // (BOTH endpoints moved) — drops from wm-layer AND from
    // canonical. Raw `allTriples.length` would have counted it;
    // the helpers correctly exclude it.
    const triples: LayeredTriple[] = [
      // Promote both entities to SWM canonical via their literal-name rows.
      { subject: 'urn:e:promoted-a', predicate: 'http://schema.org/name', object: '"A"', layer: 'shared' },
      { subject: 'urn:e:promoted-b', predicate: 'http://schema.org/name', object: '"B"', layer: 'shared' },
      // Honest SWM resource-edge between them — admits in swm + total.
      { subject: 'urn:e:promoted-a', predicate: 'http://schema.org/knows', object: 'urn:e:promoted-b', layer: 'shared' },
      // WM residue resource-edge — both endpoints SWM canonical,
      // row stored at WM. Drops in wm-layer (OR-rule, subject moved)
      // AND in canonical (AND-rule, both endpoints moved). This is
      // the GH #805 / GH #819 residue family.
      { subject: 'urn:e:promoted-a', predicate: 'http://schema.org/knows', object: 'urn:e:promoted-b', layer: 'working' },
    ];
    render(memoryFor(triples));
    const { wm, swm, vm, total } = readProbe(container);

    // Raw `allTriples.length` would be 4 (the inflated, pre-#819 value).
    // Post-#819:
    expect(wm).toBe(0); // residue row dropped from wm-layer
    expect(swm).toBe(3); // 2 literal-name + 1 honest resource-edge
    expect(vm).toBe(0);
    // Canonical: 3 (residue row dropped, no mixed-layer fact present).
    expect(total).toBe(3);
    expect(wm + swm + vm).toBe(total); // no gap on this fixture
    // Verify the helpers strictly under-report raw `allTriples` by
    // the residue-row count (1).
    expect(total).toBeLessThan(triples.length);
  });

  it('Cross-graph SPO duplicate (same row in two named graphs) deduplicates in per-layer + total', () => {
    // Same SPO row at the SAME layer, shipped via two different
    // graphs (e.g. `<cg>/<sg>` and `<cg>/<sg>/_shared_memory`).
    // `useLayerTriples` SPO-dedups within the layer; canonical
    // SPO-dedups globally. Both should report 1, not 2.
    const triples: LayeredTriple[] = [
      // Promote subject to SWM canonical.
      { subject: 'urn:e:swm-c', predicate: 'http://schema.org/name', object: '"C"', layer: 'shared' },
      // Same literal-name row again — different graph in production,
      // identical SPO. Must collapse.
      { subject: 'urn:e:swm-c', predicate: 'http://schema.org/name', object: '"C"', layer: 'shared' },
    ];
    render(memoryFor(triples));
    const { wm, swm, vm, total } = readProbe(container);

    // Pre-#819 view-level totals would have inflated to 2.
    expect(wm).toBe(0);
    expect(swm).toBe(1);
    expect(vm).toBe(0);
    expect(total).toBe(1);
    expect(wm + swm + vm).toBe(total);
  });
});

// GH #881 (post-#847 follow-up) — single-pass `useMemoryCounts`
// helper that produces the same four counts in one iteration over
// `memory.allTriples`. The fixtures above each ran `useLayerTriples`
// ×3 + `useCanonicalTriples` ×1 = 4 passes per render. This suite
// locks: (1) the fused helper produces identical numbers across all
// 3 fixtures; (2) it iterates `memory.allTriples` exactly once per
// memoized result.

function FusedCountsProbe({ memory }: { memory: MemoryData }) {
  const { wm, swm, vm, canonical } = useMemoryCounts(memory as any);
  return React.createElement('div', {
    id: 'probe-fused',
    'data-wm': String(wm),
    'data-swm': String(swm),
    'data-vm': String(vm),
    'data-total': String(canonical),
  });
}

function readFusedProbe(container: Element) {
  const probe = container.querySelector('#probe-fused')!;
  return {
    wm: Number(probe.getAttribute('data-wm')),
    swm: Number(probe.getAttribute('data-swm')),
    vm: Number(probe.getAttribute('data-vm')),
    total: Number(probe.getAttribute('data-total')),
  };
}

describe('useMemoryCounts — fused single-pass helper (GH #881)', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(memory: MemoryData) {
    act(() => {
      root.render(React.createElement(FusedCountsProbe, { memory }));
    });
  }

  // Same 3 fixtures as the legacy contract above, asserting
  // identical numbers via the fused helper.

  it('mixed-layer fixture — fused counts match 4-pass output', () => {
    const triples: LayeredTriple[] = [
      { subject: 'urn:e:wm-a', predicate: 'http://schema.org/name', object: '"A"', layer: 'working' },
      { subject: 'urn:e:wm-b', predicate: 'http://schema.org/name', object: '"B"', layer: 'working' },
      { subject: 'urn:e:swm-c', predicate: 'http://schema.org/name', object: '"C"', layer: 'shared' },
      { subject: 'urn:e:swm-c', predicate: 'http://schema.org/knows', object: 'urn:e:wm-a', layer: 'working' },
    ];
    render(memoryFor(triples));
    const { wm, swm, vm, total } = readFusedProbe(container);
    expect(wm).toBe(2);
    expect(swm).toBe(1);
    expect(vm).toBe(0);
    expect(total).toBe(4);
    expect(wm + swm + vm).toBeLessThanOrEqual(total);
    expect(total - (wm + swm + vm)).toBe(1);
  });

  it('WM-residue fixture — fused counts match 4-pass output', () => {
    const triples: LayeredTriple[] = [
      { subject: 'urn:e:promoted-a', predicate: 'http://schema.org/name', object: '"A"', layer: 'shared' },
      { subject: 'urn:e:promoted-b', predicate: 'http://schema.org/name', object: '"B"', layer: 'shared' },
      { subject: 'urn:e:promoted-a', predicate: 'http://schema.org/knows', object: 'urn:e:promoted-b', layer: 'shared' },
      { subject: 'urn:e:promoted-a', predicate: 'http://schema.org/knows', object: 'urn:e:promoted-b', layer: 'working' },
    ];
    render(memoryFor(triples));
    const { wm, swm, vm, total } = readFusedProbe(container);
    expect(wm).toBe(0);
    expect(swm).toBe(3);
    expect(vm).toBe(0);
    expect(total).toBe(3);
    expect(total).toBeLessThan(triples.length);
  });

  it('cross-graph-dedup fixture — fused counts match 4-pass output', () => {
    const triples: LayeredTriple[] = [
      { subject: 'urn:e:swm-c', predicate: 'http://schema.org/name', object: '"C"', layer: 'shared' },
      { subject: 'urn:e:swm-c', predicate: 'http://schema.org/name', object: '"C"', layer: 'shared' },
    ];
    render(memoryFor(triples));
    const { wm, swm, vm, total } = readFusedProbe(container);
    expect(wm).toBe(0);
    expect(swm).toBe(1);
    expect(vm).toBe(0);
    expect(total).toBe(1);
  });

  // Iteration-count guard: the fused helper must iterate
  // `memory.allTriples` exactly once per memoized result, vs the
  // 4 passes the legacy 4-call setup did. A counting Proxy wraps
  // the array's Symbol.iterator; we render the Probe once and
  // assert the iteration count is 1.
  it('iterates memory.allTriples exactly once per render (single-pass guarantee)', () => {
    const baseTriples: LayeredTriple[] = [
      { subject: 'urn:e:a', predicate: 'http://schema.org/name', object: '"A"', layer: 'working' },
      { subject: 'urn:e:b', predicate: 'http://schema.org/name', object: '"B"', layer: 'shared' },
      { subject: 'urn:e:c', predicate: 'http://schema.org/name', object: '"C"', layer: 'verified' },
    ];
    const baseMemory = memoryFor(baseTriples);
    let iterationCount = 0;
    const countingTriples = new Proxy(baseTriples, {
      get(target, prop) {
        if (prop === Symbol.iterator) {
          iterationCount++;
          return target[Symbol.iterator].bind(target);
        }
        return (target as any)[prop];
      },
    });
    const wrappedMemory = { ...baseMemory, allTriples: countingTriples };
    render(wrappedMemory as unknown as MemoryData);
    const { wm, swm, vm, total } = readFusedProbe(container);
    // Correctness sanity-check.
    expect(wm).toBe(1);
    expect(swm).toBe(1);
    expect(vm).toBe(1);
    expect(total).toBe(3);
    // Single-pass guarantee.
    expect(iterationCount).toBe(1);
  });
});
