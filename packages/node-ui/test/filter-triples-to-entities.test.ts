import { describe, expect, it } from 'vitest';
import { filterTriplesToEntities } from '../src/ui/views/project/helpers.js';
import type { Triple } from '../src/ui/hooks/useMemoryEntities.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

// Task #25 (PR #677) — the graph-render-side entity filter. Lives in
// `LayerGraphPanel` not `useLayerTriples` because triple counts and
// the VM hero stats want the honest raw triple list. Mirrors the
// `entityList` membership rule the Entities tab uses
// (`useMemoryEntities.ts:467-469`): entity iff has at least one of
// `types` / own `properties` / outgoing `connections`. Pure-object
// URIs (vocabulary constants, `ipfs://` file refs, `did:` identity
// refs, blank-node compound-property anchors) drop uniformly.
describe('filterTriplesToEntities — graph-render entity filter', () => {
  it('keeps entity→entity edges when both endpoints are in entityUris', () => {
    const triples: Triple[] = [
      { subject: 'urn:e:event', predicate: 'http://schema.org/about', object: 'urn:e:other-entity' },
    ];
    const result = filterTriplesToEntities(triples, new Set(['urn:e:event', 'urn:e:other-entity']));
    expect(result.map(t => t.object)).toEqual(['urn:e:other-entity']);
  });

  it('drops vocabulary-constant objects (`cbv:BizStep-packing` not in entityUris)', () => {
    const triples: Triple[] = [
      { subject: 'urn:e:event', predicate: 'http://schema.org/about', object: 'urn:e:other-entity' },
      { subject: 'urn:e:event', predicate: 'https://ref.gs1.org/cbv/bizStep', object: 'https://ref.gs1.org/cbv/BizStep-packing' },
    ];
    const result = filterTriplesToEntities(triples, new Set(['urn:e:event', 'urn:e:other-entity']));
    const objects = result.map(t => t.object);
    expect(objects).not.toContain('https://ref.gs1.org/cbv/BizStep-packing');
    expect(objects).toContain('urn:e:other-entity');
  });

  it('drops `ipfs://` file-ref objects (not in entityUris — they are property values)', () => {
    const triples: Triple[] = [
      { subject: 'urn:e:doc', predicate: 'http://dkg.io/ontology/sourceFile', object: 'ipfs://QmExampleCidHash' },
    ];
    const result = filterTriplesToEntities(triples, new Set(['urn:e:doc']));
    expect(result).toHaveLength(0);
  });

  it('drops `did:` identity-ref objects when used purely as a property value', () => {
    const triples: Triple[] = [
      { subject: 'urn:e:doc', predicate: 'http://www.w3.org/ns/prov#wasAttributedTo', object: 'did:dkg:agent:0xabc123' },
    ];
    const result = filterTriplesToEntities(triples, new Set(['urn:e:doc']));
    expect(result).toHaveLength(0);
  });

  it('keeps `did:` objects when the DID is in entityUris (real agent entity)', () => {
    // When a DID has its own data in the layer (rdf:type / properties)
    // it IS in entityList and the edge to it is kept. Mirrors the
    // Entities tab.
    const triples: Triple[] = [
      { subject: 'urn:e:doc', predicate: 'http://www.w3.org/ns/prov#wasAttributedTo', object: 'did:dkg:agent:alice' },
    ];
    const result = filterTriplesToEntities(triples, new Set(['urn:e:doc', 'did:dkg:agent:alice']));
    expect(result.map(t => t.object)).toEqual(['did:dkg:agent:alice']);
  });

  it('keeps blank-node objects only when they appear in entityUris', () => {
    const triples: Triple[] = [
      { subject: 'urn:e:event', predicate: 'http://schema.org/location', object: '_:loc-anon' },
      { subject: 'urn:e:event', predicate: 'http://schema.org/contributor', object: '_:loc-named' },
    ];
    const result = filterTriplesToEntities(triples, new Set(['urn:e:event', '_:loc-named']));
    const objects = result.map(t => t.object);
    expect(objects).not.toContain('_:loc-anon');
    expect(objects).toContain('_:loc-named');
  });

  it('exempts rdf:type triples regardless of object membership (classColors needs them)', () => {
    // The downstream `splitGraphTriplesForShelf` rdf:type guard
    // prevents the class IRI from becoming a canvas node; we just
    // need the triple to feed `classColors`.
    const triples: Triple[] = [
      { subject: 'urn:e:typed', predicate: RDF_TYPE, object: 'http://schema.org/Thing' },
    ];
    const result = filterTriplesToEntities(triples, new Set(['urn:e:typed']));
    expect(result.map(t => t.object)).toEqual(['http://schema.org/Thing']);
  });

  it('keeps literal objects (not resources — never go through the membership check)', () => {
    const triples: Triple[] = [
      { subject: 'urn:e:event', predicate: 'http://schema.org/name', object: '"E"' },
      { subject: 'urn:e:event', predicate: 'http://schema.org/startDate', object: '"2026-05-26"' },
    ];
    const result = filterTriplesToEntities(triples, new Set(['urn:e:event']));
    expect(result).toHaveLength(2);
  });

  it('canonicalises wrapped <urn:...> objects before the membership lookup', () => {
    // The daemon ships some bindings wrapped; `entityUris` is built
    // from canonical entity URIs. Without canonicalising in the
    // filter, wrapped object URIs would miss the membership match
    // and drop legitimate edges.
    const triples: Triple[] = [
      { subject: 'urn:e:event', predicate: 'http://schema.org/about', object: '<urn:e:other-entity>' },
    ];
    const result = filterTriplesToEntities(triples, new Set(['urn:e:event', 'urn:e:other-entity']));
    expect(result.map(t => t.object)).toEqual(['<urn:e:other-entity>']);
  });

  it('drops triples whose subject is not in entityUris (subject-side gate)', () => {
    // PR #677 Codex EwIbn — without the subject check, a non-entity
    // subject (synthesised stub or filtered-out URI) whose object
    // happens to be a real entity would still emit a phantom edge.
    const triples: Triple[] = [
      { subject: 'urn:e:non-entity-stub', predicate: 'http://schema.org/about', object: 'urn:e:real-entity' },
      { subject: 'urn:e:real-entity', predicate: 'http://schema.org/name', object: '"Real"' },
    ];
    const result = filterTriplesToEntities(triples, new Set(['urn:e:real-entity']));
    // The phantom edge from the stub is dropped; the real entity's
    // own literal property survives.
    expect(result).toHaveLength(1);
    expect(result[0].subject).toBe('urn:e:real-entity');
  });

  it('keeps triples whose subject is only in focalSubjects (KADetailView focal exemption)', () => {
    // `focalSubjects` allowlists the entity-detail focus so it
    // survives the subject-side gate even when the layer's
    // `entityList` wouldn't otherwise include it (e.g. cross-layer
    // navigation where the focal entity lives in a different layer).
    const triples: Triple[] = [
      { subject: 'urn:e:focal', predicate: 'http://schema.org/name', object: '"Focal"' },
      { subject: 'urn:e:focal', predicate: 'http://schema.org/about', object: 'urn:e:neighbor' },
    ];
    const result = filterTriplesToEntities(
      triples,
      new Set(['urn:e:neighbor']),
      { focalSubjects: new Set(['urn:e:focal']) },
    );
    expect(result).toHaveLength(2);
    expect(result.map(t => t.subject)).toEqual(['urn:e:focal', 'urn:e:focal']);
  });

  it('focalSubjects without entityUris membership still drops object-side non-entities', () => {
    // Focal exemption only bypasses the subject-side gate. The
    // object side still has to be a real entity (or an rdf:type
    // target) — otherwise focusing on a focal would silently re-
    // introduce vocab-value nodes via the focal's properties.
    const triples: Triple[] = [
      { subject: 'urn:e:focal', predicate: 'https://ref.gs1.org/cbv/bizStep', object: 'https://ref.gs1.org/cbv/BizStep-packing' },
    ];
    const result = filterTriplesToEntities(
      triples,
      new Set<string>(),
      { focalSubjects: new Set(['urn:e:focal']) },
    );
    expect(result).toHaveLength(0);
  });
});
