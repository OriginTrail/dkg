// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { useLayerTriples } from '../src/ui/views/project/helpers.js';
import { buildMemoryEntities, type LayeredTriple, type MemoryData, type Triple } from '../src/ui/hooks/useMemoryEntities.js';

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

function ProbeLayerTriples({ memory, layer }: { memory: MemoryData; layer: 'wm' | 'swm' | 'vm' }) {
  const triples = useLayerTriples(memory as any, layer);
  const subjects = triples.map((t: Triple) => t.subject).join('|');
  return React.createElement('div', { id: 'probe', 'data-subjects': subjects });
}

describe('useLayerTriples — promoted-entity residue filter (P1)', () => {
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

  // The daemon's `wmSparql` returns triples from every `/assertion/*`
  // named graph, so a promoted entity's WM triples keep coming back
  // even though the entity has logically moved to SWM (post-promote
  // bug). The hook must drop those — the WM Graph view should only
  // render triples whose subject is still genuinely in WM.
  it('drops WM triples whose subject has been promoted (entity.trustLevel === shared)', () => {
    // urn:e:wm-only is genuinely WM. urn:e:promoted has both WM
    // residue and an SWM triple — its canonical layer is `shared`.
    const triples: LayeredTriple[] = [
      { subject: 'urn:e:wm-only',   predicate: RDF_TYPE, object: 'http://schema.org/Thing', layer: 'working' },
      { subject: 'urn:e:promoted',  predicate: RDF_TYPE, object: 'http://schema.org/Thing', layer: 'working' }, // residue
      { subject: 'urn:e:promoted',  predicate: 'http://schema.org/name', object: '"Promoted"', layer: 'shared' },
    ];
    const memory = memoryFor(triples);
    expect(memory.entities.get('urn:e:wm-only')?.trustLevel).toBe('working');
    expect(memory.entities.get('urn:e:promoted')?.trustLevel).toBe('shared');

    act(() => {
      root.render(React.createElement(ProbeLayerTriples, { memory, layer: 'wm' }));
    });

    const probe = container.querySelector('#probe')!;
    const subjects = (probe.getAttribute('data-subjects') ?? '').split('|').filter(Boolean);

    // WM view: only the genuinely-WM subject survives. The promoted
    // entity's WM residue is filtered out.
    expect(subjects).toContain('urn:e:wm-only');
    expect(subjects).not.toContain('urn:e:promoted');
  });

  it('SWM view: keeps triples on subjects whose canonical layer is SWM, drops VM-promoted ones', () => {
    const triples: LayeredTriple[] = [
      { subject: 'urn:e:swm-only',  predicate: RDF_TYPE, object: 'http://schema.org/Thing', layer: 'shared' },
      { subject: 'urn:e:vm-promoted', predicate: RDF_TYPE, object: 'http://schema.org/Thing', layer: 'shared' }, // residue
      { subject: 'urn:e:vm-promoted', predicate: 'http://schema.org/name', object: '"Verified"', layer: 'verified' },
    ];
    const memory = memoryFor(triples);

    act(() => {
      root.render(React.createElement(ProbeLayerTriples, { memory, layer: 'swm' }));
    });

    const probe = container.querySelector('#probe')!;
    const subjects = (probe.getAttribute('data-subjects') ?? '').split('|').filter(Boolean);
    expect(subjects).toContain('urn:e:swm-only');
    expect(subjects).not.toContain('urn:e:vm-promoted');
  });

  it('passes through triples whose subject has no entity record (literal orphans / class IRIs)', () => {
    // No entity record means there's nothing to compare trustLevel
    // against — the triple should not be filtered. The realistic case
    // is a stray triple whose subject is an anonymous URI that never
    // surfaces in the entity list.
    const triples: LayeredTriple[] = [
      { subject: 'urn:e:wm-only',  predicate: 'http://schema.org/name', object: '"WM"', layer: 'working' },
    ];
    const memory = memoryFor(triples);
    // Force a subject that has no entity record by patching the entities
    // map after the fact.
    memory.entities.delete('urn:e:wm-only');
    (memory as any).entityList = [];

    act(() => {
      root.render(React.createElement(ProbeLayerTriples, { memory, layer: 'wm' }));
    });
    const probe = container.querySelector('#probe')!;
    expect(probe.getAttribute('data-subjects')).toBe('urn:e:wm-only');
  });

  // R2-1 regression: the residue filter looks entities up by triple
  // subject, but `buildEntities` canonicalises entity keys (drops <>
  // wrappers and trims). The daemon's wmSparql/swmSparql/vmSparql
  // sometimes ships subjects wrapped (`<urn:...>`) — a raw lookup
  // misses the entity record, the filter silently bypasses, and the
  // promoted entity's residual WM triples render as phantom nodes.
  // Canonicalising first restores the filter.
  it('canonicalises wrapped triple subjects when looking up the entity for the residue filter (R2-1)', () => {
    // Two genuinely-WM and one promoted entity. The promoted entity's
    // WM residue triple ships with a wrapped subject — the regression
    // is that without canonicalisation, this slips past the filter.
    const triples: LayeredTriple[] = [
      { subject: 'urn:e:wm-only',   predicate: RDF_TYPE, object: 'http://schema.org/Thing', layer: 'working' },
      { subject: '<urn:e:promoted-wrapped>',  predicate: RDF_TYPE, object: 'http://schema.org/Thing', layer: 'working' }, // residue, wrapped
      { subject: 'urn:e:promoted-wrapped',  predicate: 'http://schema.org/name', object: '"Promoted (canon)"', layer: 'shared' },
    ];
    const memory = memoryFor(triples);
    // `buildEntities` canonicalises both subjects to the same entity.
    const promoted = memory.entities.get('urn:e:promoted-wrapped');
    expect(promoted).toBeDefined();
    expect(promoted!.trustLevel).toBe('shared');

    act(() => {
      root.render(React.createElement(ProbeLayerTriples, { memory, layer: 'wm' }));
    });

    const probe = container.querySelector('#probe')!;
    const subjects = (probe.getAttribute('data-subjects') ?? '').split('|').filter(Boolean);
    // WM view: only the genuinely-WM subject. The wrapped-subject
    // residue triple for the promoted entity must be filtered out
    // even though the lookup key (`<urn:e:promoted-wrapped>`) differs
    // from the entity's canonical key (`urn:e:promoted-wrapped`).
    expect(subjects).toContain('urn:e:wm-only');
    expect(subjects).not.toContain('<urn:e:promoted-wrapped>');
    expect(subjects).not.toContain('urn:e:promoted-wrapped');
  });

  // Issue A regression: a WM triple `wm-entity-A relatesTo swm-entity-B`
  // passes the subject check (A is WM) but renders BOTH endpoints as
  // canvas nodes — so the promoted-entity URI leaks in as an object.
  // Asymmetric C17 form: subject-local (rdf:type / labels / literals)
  // ALWAYS pass; resource→resource edges drop when the object has
  // been promoted past the requested layer.
  it('drops WM resource-to-resource edges whose object has been promoted to SWM/VM (Issue A object-side leak)', () => {
    const triples: LayeredTriple[] = [
      { subject: 'urn:e:wm-a',   predicate: RDF_TYPE, object: 'http://schema.org/Thing', layer: 'working' },
      { subject: 'urn:e:wm-b',   predicate: RDF_TYPE, object: 'http://schema.org/Thing', layer: 'working' },
      { subject: 'urn:e:promoted-b', predicate: RDF_TYPE, object: 'http://schema.org/Thing', layer: 'shared' },
      // The leaky edge — WM-tagged, subject is WM, object has been
      // promoted to SWM. Pre-Issue-A this passed the filter and the
      // RdfGraph rendered urn:e:promoted-b as a phantom canvas node.
      { subject: 'urn:e:wm-a', predicate: 'http://schema.org/knows', object: 'urn:e:promoted-b', layer: 'working' },
      // A non-leaky edge for the same subject — both endpoints are WM.
      { subject: 'urn:e:wm-a', predicate: 'http://schema.org/related', object: 'urn:e:wm-b', layer: 'working' },
      // Subject-local triples on the WM subject — must always pass.
      { subject: 'urn:e:wm-a', predicate: 'http://schema.org/name', object: '"A"', layer: 'working' },
    ];
    const memory = memoryFor(triples);
    expect(memory.entities.get('urn:e:promoted-b')?.trustLevel).toBe('shared');

    act(() => {
      root.render(React.createElement(ProbeLayerTriples, { memory, layer: 'wm' }));
    });

    const probe = container.querySelector('#probe')!;
    const subjects = (probe.getAttribute('data-subjects') ?? '').split('|');

    // 3 WM-subject triples should pass: rdf:type on wm-a, knows wm-b, name "A".
    // The rdf:type on wm-b also passes. The leaky `knows promoted-b`
    // triple — same subject, same predicate, different object — used
    // to slip through; with the object-side check it's now dropped.
    // We assert by counting triples with `urn:e:wm-a` as subject.
    const wmASubjectCount = subjects.filter(s => s === 'urn:e:wm-a').length;
    // Expect 3 (rdf:type + knows wm-b + name) — NOT 4 (which would
    // include the leaky promoted edge).
    expect(wmASubjectCount).toBe(3);

    // No triple at all whose subject is the leaked promoted entity.
    expect(subjects).not.toContain('urn:e:promoted-b');
  });
});
