// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { useCanonicalTriples } from '../src/ui/views/project/helpers.js';
import { buildMemoryEntities, type LayeredTriple, type MemoryData } from '../src/ui/hooks/useMemoryEntities.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

// Build a MemoryData fixture from a flat triple list. `entities` is
// produced by `buildMemoryEntities` so `trustLevel` (the canonical
// highest-layer-membership) is computed correctly — the residue rule
// is keyed on this exact derivation.
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

// Surface the canonical helper's `total` + a SPO-joined list via
// data-attributes so individual test assertions can pattern-match
// without React-testing-library overhead.
function ProbeCanonicalTriples({ memory }: { memory: MemoryData }) {
  const { triples, total } = useCanonicalTriples(memory as any);
  const spo = triples
    .map(t => `${t.subject}|${t.predicate}|${t.object}`)
    .join('\n');
  return React.createElement('div', {
    id: 'probe',
    'data-total': String(total),
    'data-spo': spo,
  });
}

function readProbe(container: Element): { total: number; spo: string[] } {
  const probe = container.querySelector('#probe')!;
  return {
    total: Number(probe.getAttribute('data-total') ?? 'NaN'),
    spo: (probe.getAttribute('data-spo') ?? '').split('\n').filter(Boolean),
  };
}

describe('useCanonicalTriples — canonical project-wide triple total (GH #819)', () => {
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
      root.render(React.createElement(ProbeCanonicalTriples, { memory }));
    });
  }

  // T1 — untagged WM-only triple stays. Locks the baseline: a row
  // whose subject is canonically at the row's layer (no promotion)
  // passes the residue check and admits.
  it('T1 — admits a WM-only triple whose subject is canonically WM', () => {
    const triples: LayeredTriple[] = [
      { subject: 'urn:e:wm-only', predicate: RDF_TYPE, object: 'http://schema.org/Thing', layer: 'working' },
    ];
    render(memoryFor(triples));
    const { total, spo } = readProbe(container);
    expect(total).toBe(1);
    expect(spo[0]).toBe('urn:e:wm-only|' + RDF_TYPE + '|http://schema.org/Thing');
  });

  // T2 — cross-layer subject promoted: the triple drops if the
  // OBJECT was also promoted past `t.layer` (unambiguous residue);
  // it STAYS if the object is still at the row's layer (legitimate
  // mixed-layer edge that `useLayerTriples` would have dropped).
  //
  // This is the load-bearing distinction from the per-layer rule.
  it('T2 — keeps a mixed-layer edge where only the subject moved past `t.layer`', () => {
    // urn:e:moved is canonically SWM (has both working + shared
    // layers); urn:e:wm-still is canonically WM (only working).
    // The WM row connecting them: subject moved past WM, object
    // still at WM → KEEP (mixed-layer edge is a fact).
    const triples: LayeredTriple[] = [
      // Promotes urn:e:moved to SWM canonical.
      { subject: 'urn:e:moved', predicate: 'http://schema.org/name', object: '"Moved"', layer: 'shared' },
      // urn:e:wm-still stays WM canonical (no SWM membership).
      { subject: 'urn:e:wm-still', predicate: RDF_TYPE, object: 'http://schema.org/Thing', layer: 'working' },
      // The mixed-layer edge — subject is SWM canonical, object is
      // WM canonical, row stored at WM. Per ux-lead's rule this is
      // a legitimate fact (one endpoint still at `t.layer`) and
      // must admit.
      { subject: 'urn:e:moved', predicate: 'http://schema.org/knows', object: 'urn:e:wm-still', layer: 'working' },
    ];
    const memory = memoryFor(triples);
    expect(memory.entities.get('urn:e:moved')?.trustLevel).toBe('shared');
    expect(memory.entities.get('urn:e:wm-still')?.trustLevel).toBe('working');
    render(memory);
    const { total, spo } = readProbe(container);
    // All 3 facts survive — mixed-layer edge is NOT dropped.
    expect(total).toBe(3);
    expect(spo).toContain('urn:e:moved|http://schema.org/knows|urn:e:wm-still');
  });

  // T2 companion — when BOTH endpoints moved past `t.layer` the row
  // IS unambiguous residue and drops. Mirrors the
  // `useLayerTriples` behavior on the worst-case shape; ensures
  // the new helper doesn't over-include.
  it('T2-residue — drops a WM row whose subject AND object both moved past WM', () => {
    const triples: LayeredTriple[] = [
      { subject: 'urn:e:a', predicate: 'http://schema.org/name', object: '"A"', layer: 'shared' },
      { subject: 'urn:e:b', predicate: 'http://schema.org/name', object: '"B"', layer: 'shared' },
      // Both endpoints SWM canonical; row stored at WM = residue.
      { subject: 'urn:e:a', predicate: 'http://schema.org/knows', object: 'urn:e:b', layer: 'working' },
    ];
    const memory = memoryFor(triples);
    expect(memory.entities.get('urn:e:a')?.trustLevel).toBe('shared');
    expect(memory.entities.get('urn:e:b')?.trustLevel).toBe('shared');
    render(memory);
    const { total, spo } = readProbe(container);
    // Only the 2 SWM literal-name rows survive; the WM residue
    // row drops.
    expect(total).toBe(2);
    expect(spo).not.toContain('urn:e:a|http://schema.org/knows|urn:e:b');
  });

  // T3 — SPO dedup across multiple graph URIs. The same canonical
  // `(s, p, o)` shipped from multiple sources collapses to a single
  // admitted row (this is the SWM cross-graph duplication shape +
  // any other cross-graph collision).
  it('T3 — collapses SPO duplicates across multiple graph URIs to a single row', () => {
    const triples: LayeredTriple[] = [
      // Same SPO, two graph URIs (one tagged + one untagged — both
      // canonicalize to the same dedup key).
      { subject: 'urn:e:x', predicate: 'http://schema.org/name', object: '"X"', layer: 'shared', subGraph: 'recipes' },
      { subject: 'urn:e:x', predicate: 'http://schema.org/name', object: '"X"', layer: 'shared' },
      // Distinct second SPO to verify total isn't trivially 1.
      { subject: 'urn:e:y', predicate: 'http://schema.org/name', object: '"Y"', layer: 'shared' },
    ];
    render(memoryFor(triples));
    const { total } = readProbe(container);
    // 2 distinct SPOs after dedup, not 3.
    expect(total).toBe(2);
  });

  // T4 — layered residue interacting with dedup. Across multiple
  // layers, ensures the per-layer SPO-tracking works: an SPO that
  // legitimately appears in WM AND its mixed-layer variant in SWM
  // admits once (same SPO key collapses them); a WM residue copy
  // of an SWM-canonical SPO drops AFTER dedup, not before.
  it('T4 — per-layer residue interacts cleanly with global SPO dedup', () => {
    const triples: LayeredTriple[] = [
      // urn:e:p promotes to SWM via this row.
      { subject: 'urn:e:p', predicate: 'http://schema.org/name', object: '"P"', layer: 'shared' },
      // Same SPO shipped at WM — would be residue (subject is SWM
      // canonical, object is literal so no second-endpoint
      // promotion). BUT the SPO collapses via dedup with the SWM
      // copy above, so total stays at 1 even before residue logic
      // gets a vote.
      { subject: 'urn:e:p', predicate: 'http://schema.org/name', object: '"P"', layer: 'working' },
      // A separate WM-only entity for total-counting.
      { subject: 'urn:e:wm', predicate: RDF_TYPE, object: 'http://schema.org/Thing', layer: 'working' },
    ];
    render(memoryFor(triples));
    const { total } = readProbe(container);
    expect(total).toBe(2);
  });

  // T5 — canonicalization: wrapped IRI `<urn:...>` and bare `urn:...`
  // of the same SPO collapse to one. Discrete lock — easy to under-
  // cover; the wrapped-form is what the daemon ships in places.
  it('T5 — collapses wrapped + bare IRI variants of the same SPO', () => {
    const triples: LayeredTriple[] = [
      // Wrapped subject form.
      { subject: '<urn:e:wrapped>', predicate: 'http://schema.org/knows', object: 'urn:e:other', layer: 'working' },
      // Bare subject form — same canonical SPO. Object also varies
      // in wrap to exercise the object-side canonicalisation.
      { subject: 'urn:e:wrapped', predicate: 'http://schema.org/knows', object: '<urn:e:other>', layer: 'working' },
    ];
    render(memoryFor(triples));
    const { total } = readProbe(container);
    expect(total).toBe(1);
  });

  // T6 — orphan-entity guard. A triple whose subject is NOT in the
  // entity map (literal orphan / class IRI / blank node anchor)
  // must admit unfiltered — without the `subjectEntity &&` guard
  // these rows would silently drop because the residue check would
  // crash (undefined `trustLevel`) or fail the equality.
  //
  // Construct a fixture where the subject is a synthetic URN never
  // emitted with its own typed triples — `buildMemoryEntities` only
  // adds entries when a subject has at least one outgoing row, so
  // a hand-crafted memory fixture WITHOUT the subject in the
  // entity map exercises this branch.
  it('T6 — admits a triple whose subject is not in the entity map (orphan-entity guard)', () => {
    // Build a memory fixture manually so we can prove the orphan
    // case — entity map empty, but allTriples has a row.
    const triples: LayeredTriple[] = [
      { subject: 'urn:class:OrphanType', predicate: RDF_TYPE, object: 'http://schema.org/Class', layer: 'working' },
    ];
    const memory: MemoryData = {
      entities: new Map(), // orphan — subject not present
      entityList: [],
      allTriples: triples,
      graphTriples: [],
      trustMap: new Map(),
      counts: { wm: 0, swm: 0, vm: 0, total: 0 },
      loading: false,
      error: null,
      partial: false,
      layerStatus: { wm: 'ok', swm: 'ok', vm: 'ok' },
      refresh: () => {},
    } as unknown as MemoryData;
    render(memory);
    const { total, spo } = readProbe(container);
    // Orphan triple admits — without the guard the row would have
    // been silently dropped or thrown.
    expect(total).toBe(1);
    expect(spo).toContain('urn:class:OrphanType|' + RDF_TYPE + '|http://schema.org/Class');
  });

  // T7 — canonical regression-prevent. A composite scenario that
  // hits the full pipeline: residue + cross-graph dedup + mixed-
  // layer keep + orphan + canonicalisation, all in one fixture.
  // Locks the helper against ANY single-rule regression.
  it('T7 — composite scenario (residue + dedup + mixed-layer + canonicalisation, all interacting)', () => {
    const triples: LayeredTriple[] = [
      // 1) Promotes urn:e:a to SWM.
      { subject: 'urn:e:a', predicate: 'http://schema.org/name', object: '"A"', layer: 'shared' },
      // 2) Promotes urn:e:b to SWM.
      { subject: 'urn:e:b', predicate: 'http://schema.org/name', object: '"B"', layer: 'shared' },
      // 3) WM-canonical entity urn:e:c with its name.
      { subject: 'urn:e:c', predicate: 'http://schema.org/name', object: '"C"', layer: 'working' },
      // 4) WM residue — same SPO as (1), shipped under WM
      //    via a `/_assertion/` graph. Dedups with (1).
      { subject: 'urn:e:a', predicate: 'http://schema.org/name', object: '"A"', layer: 'working' },
      // 5) Mixed-layer edge — SWM subject, WM object, stored at
      //    WM. Per ux-lead's rule: KEEP (one endpoint still at
      //    t.layer).
      { subject: 'urn:e:a', predicate: 'http://schema.org/knows', object: 'urn:e:c', layer: 'working' },
      // 6) Full-residue edge — both endpoints SWM canonical,
      //    stored at WM. Drops as residue.
      { subject: 'urn:e:a', predicate: 'http://schema.org/knows', object: 'urn:e:b', layer: 'working' },
      // 7) Cross-graph dedup — same SPO as (2), shipped under a
      //    per-sub-graph SWM graph. Dedups with (2).
      { subject: 'urn:e:b', predicate: 'http://schema.org/name', object: '"B"', layer: 'shared', subGraph: 'demo' },
      // 8) Wrapped variant of (3) — collapses with (3) via
      //    canonicalisation.
      { subject: '<urn:e:c>', predicate: 'http://schema.org/name', object: '"C"', layer: 'working' },
    ];
    const memory = memoryFor(triples);
    // Sanity-check the canonical trust levels the residue rule
    // hangs on.
    expect(memory.entities.get('urn:e:a')?.trustLevel).toBe('shared');
    expect(memory.entities.get('urn:e:b')?.trustLevel).toBe('shared');
    expect(memory.entities.get('urn:e:c')?.trustLevel).toBe('working');
    render(memory);
    const { total, spo } = readProbe(container);
    // 4 distinct admitted facts:
    //   - (a, name, "A")     — rows 1 + 4 dedup
    //   - (b, name, "B")     — rows 2 + 7 dedup
    //   - (c, name, "C")     — rows 3 + 8 dedup via canonicalisation
    //   - (a, knows, c)      — mixed-layer edge admits (row 5)
    // Row 6 (a→b at WM) drops as full-residue.
    expect(total).toBe(4);
    expect(spo).toContain('urn:e:a|http://schema.org/knows|urn:e:c');
    expect(spo).not.toContain('urn:e:a|http://schema.org/knows|urn:e:b');
  });

  // T7 — GH #819 round 7 (Codex sweep 5 🔴 #13). Literal-divergence
  // residue: when a subject is promoted past a row's layer AND a
  // canonical-layer literal exists for the same (s,p), the lower-
  // layer literal is residue from the pre-promotion state and
  // must drop. Pre-fix the resource-only residue rule admitted
  // BOTH, and SPO dedup couldn't collapse them because the literal
  // VALUE differed — entity surfaced with two label values.
  it('T7 — drops literal-divergence residue when subject moved past row.layer', () => {
    const triples: LayeredTriple[] = [
      // Promote urn:e:X to SWM canonical via its "new" literal.
      { subject: 'urn:e:X', predicate: 'http://schema.org/name', object: '"new"', layer: 'shared' },
      // WM-stored literal with a DIFFERENT value — residue from
      // before the entity was promoted. Pre-fix: this admitted
      // (resource-only residue rule) and yielded total === 2.
      { subject: 'urn:e:X', predicate: 'http://schema.org/name', object: '"old"', layer: 'working' },
    ];
    const memory = memoryFor(triples);
    expect(memory.entities.get('urn:e:X')?.trustLevel).toBe('shared');
    render(memory);
    const { total, spo } = readProbe(container);
    // Only the canonical-layer literal survives.
    expect(total).toBe(1);
    expect(spo).toContain('urn:e:X|http://schema.org/name|"new"');
    expect(spo).not.toContain('urn:e:X|http://schema.org/name|"old"');
  });

  // T7-edge-A — same literal value at both layers (subject promoted).
  // SPO dedup already collapses these; the new literal-residue
  // rule should not double-drop.
  it('T7 edge — same literal at both layers with promoted subject still admits one row', () => {
    const triples: LayeredTriple[] = [
      // Both rows have the same literal "X". Subject is SWM canonical.
      { subject: 'urn:e:X', predicate: 'http://schema.org/name', object: '"X"', layer: 'shared' },
      { subject: 'urn:e:X', predicate: 'http://schema.org/name', object: '"X"', layer: 'working' },
    ];
    render(memoryFor(triples));
    const { total } = readProbe(container);
    expect(total).toBe(1);
  });

  // T7-edge-B — different literals at two layers where the subject
  // is NOT promoted. Both rows are legitimate — no residue.
  // (In practice an entity's `trustLevel` is the highest layer it
  // appears in; if it appears at both WM and SWM, canonical is SWM,
  // so this scenario requires the entity to appear ONLY at one
  // canonical layer. We use a WM-only entity with two literal-
  // valued rows at WM to lock the no-promotion case.)
  it('T7 edge — WM-only entity with two same-(s,p) literal rows at WM admits both', () => {
    const triples: LayeredTriple[] = [
      // urn:e:wm only appears at WM, so trustLevel === 'working'.
      { subject: 'urn:e:wm', predicate: 'http://schema.org/keyword', object: '"alpha"', layer: 'working' },
      { subject: 'urn:e:wm', predicate: 'http://schema.org/keyword', object: '"beta"', layer: 'working' },
    ];
    const memory = memoryFor(triples);
    expect(memory.entities.get('urn:e:wm')?.trustLevel).toBe('working');
    render(memory);
    const { total } = readProbe(container);
    // Neither row's subject moved past `t.layer` → neither is
    // residue. SPO keys differ (literal values differ) → no dedup
    // collapse. Both admit.
    expect(total).toBe(2);
  });

  // T7-edge-C — promoted subject with a literal at WM that has NO
  // canonical-layer counterpart for the same (s,p). The lower-
  // layer literal is the ONLY recording of that fact → keeps.
  it('T7 edge — promoted subject keeps a WM literal with no canonical-layer counterpart', () => {
    const triples: LayeredTriple[] = [
      // Promote urn:e:Y to SWM via a DIFFERENT predicate.
      { subject: 'urn:e:Y', predicate: 'http://schema.org/name', object: '"Y"', layer: 'shared' },
      // WM-only literal under a different predicate — no
      // canonical-layer literal exists for (Y, keyword), so this
      // is a lower-layer-only fact, not residue.
      { subject: 'urn:e:Y', predicate: 'http://schema.org/keyword', object: '"draft"', layer: 'working' },
    ];
    const memory = memoryFor(triples);
    expect(memory.entities.get('urn:e:Y')?.trustLevel).toBe('shared');
    render(memory);
    const { total, spo } = readProbe(container);
    // Both rows survive: (Y, name, "Y") is canonical, (Y, keyword,
    // "draft") is a WM-only fact with no canonical counterpart.
    expect(total).toBe(2);
    expect(spo).toContain('urn:e:Y|http://schema.org/keyword|"draft"');
  });
});
