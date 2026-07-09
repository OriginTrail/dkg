import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  importBundle,
  exportBundle,
  loadBundleDir,
  quadsToNQuads,
  validateBundle,
  DKG_HAS_SECTION,
  SECTION_GENID_INFIX,
} from '../src/index.js';
import type { Quad } from '../src/index.js';

const files = loadBundleDir(fileURLToPath(new URL('./fixtures/crypto_bitcoin', import.meta.url)));

/**
 * The semantic graph: concept-subject quads minus presentational `dkg:hasSection`
 * structure (the `hasSection` edges and the skolemized section nodes). Round-trip
 * equivalence is asserted over this projection (export is graph-faithful, not
 * byte-faithful — see export.ts).
 */
function semantic(quads: Quad[]): string {
  return quadsToNQuads(
    quads.filter(
      (q) =>
        !q.subject.includes(SECTION_GENID_INFIX) &&
        q.predicate !== DKG_HAS_SECTION,
    ),
  );
}

describe('round-trip: import → export → import (§4.2)', () => {
  const first = importBundle(files);
  const exported = exportBundle(first);
  const second = importBundle(exported);

  it('reproduces an equivalent semantic graph', () => {
    expect(semantic(second.quads)).toBe(semantic(first.quads));
  });

  it('reproduces the same 5 concepts and reconstructed edges', () => {
    expect(second.concepts.map((c) => c.conceptId).sort()).toEqual(
      first.concepts.map((c) => c.conceptId).sort(),
    );
    const edgesOf = (r: typeof first, id: string) =>
      [...new Set(r.concepts.find((c) => c.conceptId === id)!.resolvedLinks.map((l) => l.targetConceptId))].sort();
    for (const id of first.concepts.map((c) => c.conceptId)) {
      expect(edgesOf(second, id)).toEqual(edgesOf(first, id));
    }
  });

  it('produces a §9-conformant bundle', () => {
    expect(validateBundle(exported).conformant).toBe(true);
  });
});

describe('round-trip preserves typed producer-key scalars (export fidelity)', () => {
  // Producer-defined numeric/boolean keys must keep their RDF datatype across
  // import → export → import; otherwise `count: 3` degrades to a string literal.
  const bundle = [
    {
      path: 'm.md',
      content:
        '---\n' +
        'type: Metric\n' +
        'title: M\n' +
        'count: 3\n' +
        'ratio: 1.5\n' +
        'active: true\n' +
        'archived: false\n' +
        '---\n\nbody\n',
    },
  ];

  const first = importBundle(bundle);
  const second = importBundle(exportBundle(first));

  const objFor = (r: typeof first, predicate: string) =>
    r.concepts[0].quads.find((q) => q.predicate === predicate)?.object;

  it('keeps xsd:integer / xsd:decimal / xsd:boolean datatypes', () => {
    expect(objFor(second, 'http://schema.org/count')).toBe(
      '"3"^^<http://www.w3.org/2001/XMLSchema#integer>',
    );
    expect(objFor(second, 'http://schema.org/ratio')).toBe(
      '"1.5"^^<http://www.w3.org/2001/XMLSchema#decimal>',
    );
    expect(objFor(second, 'http://schema.org/active')).toBe(
      '"true"^^<http://www.w3.org/2001/XMLSchema#boolean>',
    );
    expect(objFor(second, 'http://schema.org/archived')).toBe(
      '"false"^^<http://www.w3.org/2001/XMLSchema#boolean>',
    );
    // and they match the first import exactly
    for (const p of ['count', 'ratio', 'active', 'archived']) {
      expect(objFor(second, `http://schema.org/${p}`)).toBe(objFor(first, `http://schema.org/${p}`));
    }
  });
});
