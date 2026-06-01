// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import {
  isSubjectResidue,
  isObjectResourceResidue,
  isPerLayerResidue,
  isCanonicalResidue,
} from '../src/ui/views/project/helpers.js';
import {
  buildMemoryEntities,
  type LayeredTriple,
  type MemoryEntity,
} from '../src/ui/hooks/useMemoryEntities.js';

// GH #890 round 2 (Codex sweep 1 🟡 B) — unit tests for the
// row-level residue predicates extracted as a single source of
// truth for `useLayerTriples`, `applyCanonicalAdmission`, and
// `useMemoryCounts`. The triple-producing helpers and the fused
// counter previously ran three hand-rolled copies; future rule
// refinements (the #819 cycle had ~10 of them) now update the
// predicate once, all consumers get it.
//
// Boundary cases per predicate:
// - `isSubjectResidue`: subject not in entities (orphan literal)
//   → false; subject at the row's layer → false; subject past it
//   → true.
// - `isObjectResourceResidue`: literal object → false (always);
//   resource object not in entities → false; resource object at
//   the row's layer → false; resource object past it → true.
// - `isPerLayerResidue` = OR of the two.
// - `isCanonicalResidue` = AND of the two.

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

function entitiesFor(triples: LayeredTriple[]): ReadonlyMap<string, MemoryEntity> {
  return buildMemoryEntities(triples);
}

describe('isSubjectResidue', () => {
  it('false when subject has no entity record (orphan, e.g. class IRI)', () => {
    const triples: LayeredTriple[] = [
      { subject: 'urn:e:wm-a', predicate: RDF_TYPE, object: 'http://schema.org/Thing', layer: 'working' },
    ];
    const t = triples[0];
    expect(isSubjectResidue(t, entitiesFor(triples))).toBe(false);
  });

  it('false when subject canonical layer equals row layer', () => {
    const triples: LayeredTriple[] = [
      { subject: 'urn:e:wm-a', predicate: 'http://schema.org/name', object: '"A"', layer: 'working' },
    ];
    const ents = entitiesFor(triples);
    expect(ents.get('urn:e:wm-a')?.trustLevel).toBe('working');
    expect(isSubjectResidue(triples[0], ents)).toBe(false);
  });

  it('true when subject has moved past the row layer (promoted)', () => {
    const triples: LayeredTriple[] = [
      // Promote subject to SWM via this row.
      { subject: 'urn:e:promoted', predicate: 'http://schema.org/name', object: '"P"', layer: 'shared' },
      // WM-stored row for the same subject — subject canonical
      // is now 'shared', row layer is 'working' → residue.
      { subject: 'urn:e:promoted', predicate: 'http://schema.org/keyword', object: '"k"', layer: 'working' },
    ];
    const ents = entitiesFor(triples);
    expect(ents.get('urn:e:promoted')?.trustLevel).toBe('shared');
    expect(isSubjectResidue(triples[1], ents)).toBe(true);
  });
});

describe('isObjectResourceResidue', () => {
  it('false when object is a literal (always, regardless of subject)', () => {
    const triples: LayeredTriple[] = [
      // Promote subject — verifies the predicate ignores subject status.
      { subject: 'urn:e:p', predicate: 'http://schema.org/name', object: '"P"', layer: 'shared' },
      // WM row with literal object — even with subject promoted,
      // object-residue is FALSE because the object is a literal.
      { subject: 'urn:e:p', predicate: 'http://schema.org/keyword', object: '"k"', layer: 'working' },
    ];
    expect(isObjectResourceResidue(triples[1], entitiesFor(triples))).toBe(false);
  });

  it('false when resource object has no entity record', () => {
    const triples: LayeredTriple[] = [
      { subject: 'urn:e:a', predicate: 'http://schema.org/knows', object: 'urn:e:dangling', layer: 'working' },
    ];
    expect(isObjectResourceResidue(triples[0], entitiesFor(triples))).toBe(false);
  });

  it('false when resource object canonical layer equals row layer', () => {
    const triples: LayeredTriple[] = [
      // Both subject and object at WM canonical.
      { subject: 'urn:e:wm-a', predicate: 'http://schema.org/name', object: '"A"', layer: 'working' },
      { subject: 'urn:e:wm-b', predicate: 'http://schema.org/name', object: '"B"', layer: 'working' },
      { subject: 'urn:e:wm-a', predicate: 'http://schema.org/knows', object: 'urn:e:wm-b', layer: 'working' },
    ];
    expect(isObjectResourceResidue(triples[2], entitiesFor(triples))).toBe(false);
  });

  it('true when resource object has moved past the row layer', () => {
    const triples: LayeredTriple[] = [
      // Subject stays WM canonical.
      { subject: 'urn:e:wm-a', predicate: 'http://schema.org/name', object: '"A"', layer: 'working' },
      // Promote object to SWM.
      { subject: 'urn:e:swm-b', predicate: 'http://schema.org/name', object: '"B"', layer: 'shared' },
      // WM-stored row pointing at the promoted object.
      { subject: 'urn:e:wm-a', predicate: 'http://schema.org/knows', object: 'urn:e:swm-b', layer: 'working' },
    ];
    const ents = entitiesFor(triples);
    expect(ents.get('urn:e:swm-b')?.trustLevel).toBe('shared');
    expect(isObjectResourceResidue(triples[2], ents)).toBe(true);
  });
});

describe('isPerLayerResidue — OR of subject and object', () => {
  it('false when neither endpoint moved', () => {
    const triples: LayeredTriple[] = [
      { subject: 'urn:e:wm-a', predicate: 'http://schema.org/name', object: '"A"', layer: 'working' },
      { subject: 'urn:e:wm-b', predicate: 'http://schema.org/name', object: '"B"', layer: 'working' },
      { subject: 'urn:e:wm-a', predicate: 'http://schema.org/knows', object: 'urn:e:wm-b', layer: 'working' },
    ];
    expect(isPerLayerResidue(triples[2], entitiesFor(triples))).toBe(false);
  });

  it('true when only subject moved (mixed-layer edge — per-layer drops it)', () => {
    const triples: LayeredTriple[] = [
      // Promote subject to SWM.
      { subject: 'urn:e:swm-a', predicate: 'http://schema.org/name', object: '"A"', layer: 'shared' },
      // WM object stays at WM.
      { subject: 'urn:e:wm-b', predicate: 'http://schema.org/name', object: '"B"', layer: 'working' },
      // Mixed-layer edge stored at WM. Subject moved past WM →
      // per-layer drops; canonical (AND) keeps.
      { subject: 'urn:e:swm-a', predicate: 'http://schema.org/knows', object: 'urn:e:wm-b', layer: 'working' },
    ];
    expect(isPerLayerResidue(triples[2], entitiesFor(triples))).toBe(true);
  });

  it('true when only resource object moved', () => {
    const triples: LayeredTriple[] = [
      { subject: 'urn:e:wm-a', predicate: 'http://schema.org/name', object: '"A"', layer: 'working' },
      { subject: 'urn:e:swm-b', predicate: 'http://schema.org/name', object: '"B"', layer: 'shared' },
      { subject: 'urn:e:wm-a', predicate: 'http://schema.org/knows', object: 'urn:e:swm-b', layer: 'working' },
    ];
    expect(isPerLayerResidue(triples[2], entitiesFor(triples))).toBe(true);
  });

  it('true when both endpoints moved (full residue — per-layer drops)', () => {
    const triples: LayeredTriple[] = [
      { subject: 'urn:e:swm-a', predicate: 'http://schema.org/name', object: '"A"', layer: 'shared' },
      { subject: 'urn:e:swm-b', predicate: 'http://schema.org/name', object: '"B"', layer: 'shared' },
      { subject: 'urn:e:swm-a', predicate: 'http://schema.org/knows', object: 'urn:e:swm-b', layer: 'working' },
    ];
    expect(isPerLayerResidue(triples[2], entitiesFor(triples))).toBe(true);
  });
});

describe('isCanonicalResidue — AND of subject and object', () => {
  it('false when neither endpoint moved', () => {
    const triples: LayeredTriple[] = [
      { subject: 'urn:e:wm-a', predicate: 'http://schema.org/name', object: '"A"', layer: 'working' },
      { subject: 'urn:e:wm-b', predicate: 'http://schema.org/name', object: '"B"', layer: 'working' },
      { subject: 'urn:e:wm-a', predicate: 'http://schema.org/knows', object: 'urn:e:wm-b', layer: 'working' },
    ];
    expect(isCanonicalResidue(triples[2], entitiesFor(triples))).toBe(false);
  });

  it('false when only subject moved (mixed-layer edge — canonical KEEPS)', () => {
    const triples: LayeredTriple[] = [
      { subject: 'urn:e:swm-a', predicate: 'http://schema.org/name', object: '"A"', layer: 'shared' },
      { subject: 'urn:e:wm-b', predicate: 'http://schema.org/name', object: '"B"', layer: 'working' },
      // Mixed-layer edge: subject moved, object still at row's layer.
      // Canonical's AND-rule keeps this as a legitimate cross-layer fact.
      { subject: 'urn:e:swm-a', predicate: 'http://schema.org/knows', object: 'urn:e:wm-b', layer: 'working' },
    ];
    expect(isCanonicalResidue(triples[2], entitiesFor(triples))).toBe(false);
  });

  it('false when only resource object moved (mixed-layer — canonical KEEPS)', () => {
    const triples: LayeredTriple[] = [
      { subject: 'urn:e:wm-a', predicate: 'http://schema.org/name', object: '"A"', layer: 'working' },
      { subject: 'urn:e:swm-b', predicate: 'http://schema.org/name', object: '"B"', layer: 'shared' },
      { subject: 'urn:e:wm-a', predicate: 'http://schema.org/knows', object: 'urn:e:swm-b', layer: 'working' },
    ];
    expect(isCanonicalResidue(triples[2], entitiesFor(triples))).toBe(false);
  });

  it('true when BOTH endpoints moved (full residue — canonical drops)', () => {
    const triples: LayeredTriple[] = [
      { subject: 'urn:e:swm-a', predicate: 'http://schema.org/name', object: '"A"', layer: 'shared' },
      { subject: 'urn:e:swm-b', predicate: 'http://schema.org/name', object: '"B"', layer: 'shared' },
      { subject: 'urn:e:swm-a', predicate: 'http://schema.org/knows', object: 'urn:e:swm-b', layer: 'working' },
    ];
    expect(isCanonicalResidue(triples[2], entitiesFor(triples))).toBe(true);
  });

  it('false when subject moved but object is a literal (literals always pass canonical)', () => {
    // Literal-object residue is the GH #819 round 9 design note:
    // we don't infer predicate cardinality, so literal-divergence
    // admits.
    const triples: LayeredTriple[] = [
      { subject: 'urn:e:swm-c', predicate: 'http://schema.org/name', object: '"new"', layer: 'shared' },
      // Subject moved past WM, but object is a literal → canonical keeps.
      { subject: 'urn:e:swm-c', predicate: 'http://schema.org/name', object: '"old"', layer: 'working' },
    ];
    expect(isCanonicalResidue(triples[1], entitiesFor(triples))).toBe(false);
  });
});
