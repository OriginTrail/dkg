import { describe, expect, it } from 'vitest';
import { validateWritableQuads } from '../src/daemon/http-utils.js';

const quad = (overrides: Partial<{ subject: string; predicate: string; object: string }> = {}) => ({
  subject: 'https://example.org/s',
  predicate: 'https://schema.org/name',
  object: '"v"',
  ...overrides,
});

const EXPECTED = {
  subject: 'an absolute IRI or blank node',
  predicate: 'an absolute IRI',
  object: 'a quoted literal term, absolute IRI or blank node',
} as const;

describe('validateWritableQuads', () => {
  it.each([
    ['an absolute IRI subject', quad()],
    ['a did subject', quad({ subject: 'did:dkg:context-graph:0xabc/cg' })],
    ['angle-bracketed terms', quad({ subject: '<urn:s>', predicate: '<urn:p>', object: '<urn:o>' })],
    ['blank-node subject and object', quad({ subject: '_:b0', object: '_:b1' })],
    ['a non-ASCII IRI', quad({ subject: 'https://example.org/café/Δ' })],
    ['a bare IRI object', quad({ object: 'urn:o' })],
    ['a typed literal object', quad({ object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>' })],
    ['a language-tagged literal object', quad({ object: '"hallo"@de' })],
  ])('accepts %s', (_name, value) => {
    expect(validateWritableQuads('quads', [value])).toBeNull();
  });

  it.each([
    ['a subject with a space', { subject: 'urn:a b' }, 'subject'],
    ['a relative subject', { subject: 'not-an-iri' }, 'subject'],
    ['a subject with a caret', { subject: 'urn:x^y' }, 'subject'],
    ['a subject with a newline', { subject: 'urn:x\ny' }, 'subject'],
    ['a whitespace-padded subject', { subject: ' urn:s' }, 'subject'],
    ['an invalid blank-node label', { subject: '_:a b' }, 'subject'],
    ['a literal subject', { subject: '"s"' }, 'subject'],
    ['a predicate with a caret', { predicate: 'https://schema.org/na^me' }, 'predicate'],
    ['a predicate with braces', { predicate: 'urn:{p}' }, 'predicate'],
    ['a blank-node predicate', { predicate: '_:p' }, 'predicate'],
    ['a half-bracketed predicate', { predicate: '<urn:p' }, 'predicate'],
    ['a bare-word object', { object: 'hello' }, 'object'],
    ['a malformed IRI object', { object: 'urn:o^1' }, 'object'],
    ['a half-bracketed object', { object: '<urn:o' }, 'object'],
    ['a whitespace-padded blank-node object', { object: ' _:b0 ' }, 'object'],
    ['a whitespace-padded bracketed object', { object: ' <urn:o> ' }, 'object'],
    ['a whitespace-padded IRI object', { object: ' urn:o' }, 'object'],
    ['a whitespace-padded literal object', { object: ' "v"' }, 'object'],
  ] as const)('rejects %s', (_name, overrides, field) => {
    expect(validateWritableQuads('quads', [quad(), quad(overrides)])).toEqual({
      error: `Invalid "quads[1].${field}": RDF ${field} must be ${EXPECTED[field]}`,
    });
  });

  it('rejects string-shaped quads before looking at terms', () => {
    expect(validateWritableQuads('quads', ['<urn:s> <urn:p> <urn:o> .'])).toEqual({
      error: '"quads" must be an array of { subject, predicate, object } objects (graph optional); string-shaped quads are not accepted',
    });
  });

  it('returns the oversized-literal body after the terms pass', () => {
    expect(validateWritableQuads('quads', [quad({ object: `"${'x'.repeat(60_000)}"` })])).toMatchObject({
      code: 'OVERSIZED_RDF_LITERAL',
    });
  });
});
