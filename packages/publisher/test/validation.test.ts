import { describe, it, expect } from 'vitest';
import {
  assertWritableQuadTerms,
  findMalformedQuadTerm,
  validateCanonicalGraphScopedKnowledgeAssetPayload,
  validateKnowledgeAssetPublishRequest,
  validatePublishRequest,
} from '../src/validation.js';
import type { KAManifestEntry } from '../src/publisher.js';
import type { Quad } from '@origintrail-official/dkg-storage';
import { SparqlTermValidationError } from '@origintrail-official/dkg-core';

const P = 'test-contextGraph';
const G = `did:dkg:context-graph:${P}`;

function quad(s: string, p: string, o: string, graph = G): Quad {
  return { subject: s, predicate: p, object: o, graph };
}

function manifest(root: string, tokenId = 1n, extra: Partial<KAManifestEntry> = {}): KAManifestEntry[] {
  return [{ tokenId, rootEntity: root, ...extra }];
}

describe('validatePublishRequest', () => {
  it('accepts a minimal valid publish', () => {
    const root = 'urn:entity:root';
    const nquads = [quad(root, 'http://ex.org/p', '"o"')];
    const r = validatePublishRequest(nquads, manifest(root), P, new Set());
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('Rule 1: rejects quads in a graph other than the contextGraph graph', () => {
    const root = 'urn:entity:root';
    const nquads = [quad(root, 'http://ex.org/p', '"o"', 'http://wrong-graph')];
    const r = validatePublishRequest(nquads, manifest(root), P, new Set());
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('Rule 1'))).toBe(true);
  });

  it('Rule 2: rejects subject not in manifest and not skolemized under a root', () => {
    const root = 'urn:entity:root';
    const nquads = [
      quad(root, 'http://ex.org/p', '"o"'),
      quad('urn:stranger', 'http://ex.org/q', '"x"'),
    ];
    const r = validatePublishRequest(nquads, manifest(root), P, new Set());
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('Rule 2'))).toBe(true);
  });

  it('Rule 2: accepts skolemized subjects under a manifest rootEntity', () => {
    const root = 'urn:entity:root';
    const sk = `${root}/.well-known/genid/b1`;
    const nquads = [quad(sk, 'http://ex.org/p', '"o"')];
    const r = validatePublishRequest(nquads, manifest(root), P, new Set());
    expect(r.valid).toBe(true);
  });

  it('Rule 3: rejects manifest root with no public triples when not fully private', () => {
    const root = 'urn:entity:orphan';
    const nquads = [quad('urn:other', 'http://ex.org/p', '"o"')];
    const r = validatePublishRequest(nquads, manifest(root), P, new Set());
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('Rule 3'))).toBe(true);
  });

  it('Rule 3: allows fully private KA with no public triples', () => {
    const root = 'urn:entity:private';
    const r = validatePublishRequest([], manifest(root, 1n, { privateTripleCount: 3 }), P, new Set());
    expect(r.valid).toBe(true);
  });

  it('Rule 4: rejects duplicate rootEntity in contextGraph', () => {
    const root = 'urn:entity:exists';
    const nquads = [quad(root, 'http://ex.org/p', '"o"')];
    const r = validatePublishRequest(nquads, manifest(root), P, new Set([root]));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('Rule 4'))).toBe(true);
  });

  it('Rule 4: allows upsert when root is in upsertableEntities', () => {
    const root = 'urn:entity:mine';
    const nquads = [quad(root, 'http://ex.org/p', '"o"')];
    const r = validatePublishRequest(nquads, manifest(root), P, new Set([root]), {
      allowUpsert: true,
      upsertableEntities: new Set([root]),
    });
    expect(r.valid).toBe(true);
  });

  it('Rule 5: rejects blank node subjects', () => {
    const root = 'urn:entity:root';
    const nquads = [
      quad(root, 'http://ex.org/p', '"o"'),
      { subject: '_:b1', predicate: 'http://ex.org/q', object: '"x"', graph: G },
    ];
    const r = validatePublishRequest(nquads, manifest(root), P, new Set());
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('Rule 5'))).toBe(true);
  });
});

describe('received quad terms', () => {
  const root = 'urn:entity:root';

  it.each<[string, Quad, 'subject' | 'predicate' | 'object']>([
    ['a relative subject IRI', quad('relative-subject', 'http://ex.org/p', '"o"'), 'subject'],
    ['a literal subject', quad('"o"', 'http://ex.org/p', '"o"'), 'subject'],
    ['an RFC 3987-invalid predicate', quad(root, 'http://ex.org/%zz', '"o"'), 'predicate'],
    ['a blank-node predicate', quad(root, '_:p', '"o"'), 'predicate'],
    ['a language tag with a character a tag may not hold', quad(root, 'http://ex.org/p', '"o"@en_GB'), 'object'],
    ['a blank-node label with a character a label may not hold', quad(root, 'http://ex.org/p', '_:node!refused'), 'object'],
    ['a relative datatype', quad(root, 'http://ex.org/p', '"42"^^<integer>'), 'object'],
    ['a literal holding a raw line break', quad(root, 'http://ex.org/p', '"line\nbreak"'), 'object'],
  ])('refuses %s, naming its quad and position without quoting it', (_label, malformed, position) => {
    const found = findMalformedQuadTerm([quad(root, 'http://ex.org/p', '"kept"'), malformed]);
    expect(found?.message).toMatch(new RegExp(`^Invalid RDF ${position} in quad 1: must be `));
    expect(found?.message).not.toContain(malformed[position]);
    expect(() => assertWritableQuadTerms([malformed])).toThrow(SparqlTermValidationError);
  });

  it('accepts well-formed terms, bracketed IRIs and blank nodes, and returns the quads', () => {
    const quads = [
      quad(root, 'http://ex.org/p', '"o"@en-GB'),
      quad(`<${root}>`, '<http://ex.org/p>', '<http://ex.org/o>'),
      quad('_:b0', 'http://ex.org/p', '"42"^^<http://www.w3.org/2001/XMLSchema#integer>'),
      quad(root, 'http://ex.org/p', '"5"^^http://www.w3.org/2001/XMLSchema#integer'),
      // A peer serializes an astral character as a UTF-16 surrogate pair of escapes.
      quad(root, 'http://ex.org/p', '"Women\\u2019s \\uD83D\\uDDD3"'),
    ];
    expect(findMalformedQuadTerm(quads, [root, `<${root}>`])).toBeNull();
    expect(assertWritableQuadTerms(quads, [root])).toBe(quads);
  });

  it('refuses a root entity that is not an absolute IRI', () => {
    expect(findMalformedQuadTerm([], [root, 'relative root'])).toEqual({
      message: 'Invalid root entity 1: must be an absolute IRI',
      kind: 'iri',
    });
    expect(() => assertWritableQuadTerms([], ['"literal root"'])).toThrow(SparqlTermValidationError);
  });

  it('Rule 6: validatePublishRequest refuses a malformed term, and a malformed root with no quads', () => {
    const malformed = validatePublishRequest([quad(root, 'http://ex.org/p', '"o"@en_GB')], manifest(root), P, new Set());
    expect(malformed.valid).toBe(false);
    expect(malformed.errors).toEqual([
      'Rule 6: Invalid RDF object in quad 0: must be a well-formed literal, absolute IRI or blank node',
    ]);
    // A fully private KA's root appears in no public quad; it is checked all the same.
    const privateOnly = validatePublishRequest([], manifest('relative-root', 1n, { privateTripleCount: 1 }), P, new Set());
    expect(privateOnly.errors).toEqual(['Rule 6: Invalid root entity 0: must be an absolute IRI']);
  });
});

describe('canonical graph-scoped KA validation policy', () => {
  const publicCanonical = 'urn:dkg:ka-skolem:c14n0';

  it('accepts exact public canonical Markdown section terms only at the named wire boundary', () => {
    const canonical = [quad(
      'urn:document:1',
      'http://dkg.io/ontology/hasSection',
      publicCanonical,
    ), quad(
      publicCanonical,
      'http://schema.org/name',
      '"Safety"',
    )];

    expect(validateKnowledgeAssetPublishRequest(canonical, G, 2).valid).toBe(false);
    expect(validateCanonicalGraphScopedKnowledgeAssetPayload(canonical, G, 2)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it.each<[string, Quad]>([
    ['private canonical subject', quad('urn:dkg:ka-skolem:private:c14n0', 'urn:p', '"x"')],
    ['private canonical object', quad('urn:s', 'urn:p', 'urn:dkg:ka-skolem:private:c14n0')],
    ['forged reserved subject', quad('urn:dkg:ka-skolem:attacker', 'urn:p', '"x"')],
    ['reserved predicate', quad('urn:s', publicCanonical, '"x"')],
    ['reserved graph', quad('urn:s', 'urn:p', '"x"', publicCanonical)],
    ['blank-node subject', quad('_:section', 'urn:p', '"x"')],
    ['blank-node object', quad('urn:s', 'urn:p', '_:section')],
    ['RFC 3987-invalid subject', quad('urn:s:%zz', 'urn:p', '"x"')],
    ['RFC 3987-invalid predicate', quad('urn:s', 'urn:p:%zz', '"x"')],
    ['relative object IRI', quad('urn:s', 'urn:p', 'relative-object')],
    ['relative literal datatype', quad('urn:s', 'urn:p', '"42"^^<integer>')],
    ['malformed language tag', quad('urn:s', 'urn:p', '"x"@en_GB')],
  ])('rejects %s', (_label, malicious) => {
    const result = validateCanonicalGraphScopedKnowledgeAssetPayload([malicious], G, 1);
    expect(result.valid).toBe(false);
  });
});
