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
  // Mirror the real `useMemoryEntities` filter at src/ui/hooks/
  // useMemoryEntities.ts:467-469 — the entity-tab membership rule that
  // `useLayerTriples` now consults. Without applying it here the test
  // shim would list every synthesised entity stub (including pure
  // object URIs like `cbv:BizStep-packing`), defeating the purpose
  // of the filter under test.
  const entityList = [...entities.values()].filter(e =>
    e.types.length > 0 || e.properties.size > 0 || e.connections.length > 0,
  );
  return {
    entities,
    entityList,
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
  const objects = triples.map((t: Triple) => t.object).join('|');
  return React.createElement('div', {
    id: 'probe',
    'data-subjects': subjects,
    'data-objects': objects,
  });
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

// Task #25 — the Graph view filters resource→resource edges using the
// same `entityList` membership rule the Entities tab uses
// (`useMemoryEntities.ts:467-469`): an entity has at least one of
// `types`, own `properties`, or outgoing `connections`. URIs that
// appear only as objects with no own data (vocabulary constants like
// `cbv:BizStep-packing`, `ipfs://` file refs, `did:` identity refs,
// blank-node compound-property anchors) are property values, not
// entities, and are dropped from the graph. Single source of truth
// across the Graph view and the Entities tab — no two-rule drift.
describe('useLayerTriples — entityList membership filter (#25)', () => {
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

  it('drops vocabulary-constant objects (`cbv:BizStep-packing` — no own data)', () => {
    // `urn:e:event` is a typed entity (Event). Its two object-side
    // resources: `urn:e:other-entity` is also a real entity (has its
    // own rdf:type triple), `https://ref.gs1.org/cbv/BizStep-packing`
    // is a vocabulary constant with no own data. Entity-to-entity
    // edge stays; entity-to-vocabulary edge is dropped.
    const triples: LayeredTriple[] = [
      { subject: 'urn:e:event',        predicate: RDF_TYPE, object: 'http://schema.org/Event', layer: 'working' },
      { subject: 'urn:e:other-entity', predicate: RDF_TYPE, object: 'http://schema.org/Thing', layer: 'working' },
      { subject: 'urn:e:event', predicate: 'http://schema.org/about', object: 'urn:e:other-entity', layer: 'working' },
      { subject: 'urn:e:event', predicate: 'https://ref.gs1.org/cbv/bizStep', object: 'https://ref.gs1.org/cbv/BizStep-packing', layer: 'working' },
      { subject: 'urn:e:event', predicate: 'http://schema.org/name', object: '"E"', layer: 'working' },
    ];
    const memory = memoryFor(triples);
    act(() => {
      root.render(React.createElement(ProbeLayerTriples, { memory, layer: 'wm' }));
    });
    const probe = container.querySelector('#probe')!;
    const objects = (probe.getAttribute('data-objects') ?? '').split('|');
    expect(objects).not.toContain('https://ref.gs1.org/cbv/BizStep-packing');
    expect(objects).toContain('urn:e:other-entity');
    // rdf:type still passes — class IRI exemption for `classColors`.
    expect(objects).toContain('http://schema.org/Event');
  });

  it('drops `ipfs://` file-ref objects (sourceFile property value, no own data)', () => {
    const triples: LayeredTriple[] = [
      { subject: 'urn:e:doc', predicate: RDF_TYPE, object: 'http://schema.org/CreativeWork', layer: 'working' },
      { subject: 'urn:e:doc', predicate: 'http://dkg.io/ontology/sourceFile', object: 'ipfs://QmExampleCidHash', layer: 'working' },
    ];
    const memory = memoryFor(triples);
    act(() => {
      root.render(React.createElement(ProbeLayerTriples, { memory, layer: 'wm' }));
    });
    const probe = container.querySelector('#probe')!;
    const objects = (probe.getAttribute('data-objects') ?? '').split('|');
    expect(objects).not.toContain('ipfs://QmExampleCidHash');
  });

  it('drops `did:` identity-ref objects (wasAttributedTo property value, no own data)', () => {
    const triples: LayeredTriple[] = [
      { subject: 'urn:e:doc', predicate: RDF_TYPE, object: 'http://schema.org/CreativeWork', layer: 'working' },
      { subject: 'urn:e:doc', predicate: 'http://www.w3.org/ns/prov#wasAttributedTo', object: 'did:dkg:agent:0xabc123', layer: 'working' },
    ];
    const memory = memoryFor(triples);
    act(() => {
      root.render(React.createElement(ProbeLayerTriples, { memory, layer: 'wm' }));
    });
    const probe = container.querySelector('#probe')!;
    const objects = (probe.getAttribute('data-objects') ?? '').split('|');
    expect(objects).not.toContain('did:dkg:agent:0xabc123');
  });

  it('keeps `did:` objects when the DID has its own data in the layer (real agent entity)', () => {
    // When a DID is a first-class entity (has its own rdf:type or
    // properties), it IS in entityList and the edge to it stays.
    // Mirrors how the Entities tab would list it.
    const triples: LayeredTriple[] = [
      { subject: 'urn:e:doc',          predicate: RDF_TYPE, object: 'http://schema.org/CreativeWork', layer: 'working' },
      { subject: 'did:dkg:agent:alice', predicate: RDF_TYPE, object: 'http://schema.org/Person', layer: 'working' },
      { subject: 'urn:e:doc', predicate: 'http://www.w3.org/ns/prov#wasAttributedTo', object: 'did:dkg:agent:alice', layer: 'working' },
    ];
    const memory = memoryFor(triples);
    act(() => {
      root.render(React.createElement(ProbeLayerTriples, { memory, layer: 'wm' }));
    });
    const probe = container.querySelector('#probe')!;
    const objects = (probe.getAttribute('data-objects') ?? '').split('|');
    expect(objects).toContain('did:dkg:agent:alice');
  });

  it('keeps rdf:type triples whose object is a class IRI (exemption for `classColors`)', () => {
    const triples: LayeredTriple[] = [
      { subject: 'urn:e:typed', predicate: RDF_TYPE, object: 'http://schema.org/Thing', layer: 'working' },
    ];
    const memory = memoryFor(triples);
    act(() => {
      root.render(React.createElement(ProbeLayerTriples, { memory, layer: 'wm' }));
    });
    const probe = container.querySelector('#probe')!;
    const objects = (probe.getAttribute('data-objects') ?? '').split('|');
    expect(objects).toContain('http://schema.org/Thing');
  });

  it('still drops cross-layer resource-to-resource edges (Issue A behaviour preserved)', () => {
    const triples: LayeredTriple[] = [
      { subject: 'urn:e:wm-a',        predicate: RDF_TYPE, object: 'http://schema.org/Thing', layer: 'working' },
      { subject: 'urn:e:promoted-b',  predicate: RDF_TYPE, object: 'http://schema.org/Thing', layer: 'shared' },
      { subject: 'urn:e:wm-a', predicate: 'http://schema.org/knows', object: 'urn:e:promoted-b', layer: 'working' },
    ];
    const memory = memoryFor(triples);
    act(() => {
      root.render(React.createElement(ProbeLayerTriples, { memory, layer: 'wm' }));
    });
    const probe = container.querySelector('#probe')!;
    const objects = (probe.getAttribute('data-objects') ?? '').split('|');
    expect(objects).not.toContain('urn:e:promoted-b');
  });
});
