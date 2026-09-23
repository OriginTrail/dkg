import { describe, expect, it } from 'vitest';
import {
  validateQuadObjectTerms,
  validateQuadSubjectPredicateTerms,
} from '../src/daemon/http-utils.js';

const quad = (overrides: Partial<{ subject: string; predicate: string; object: string }> = {}) => ({
  subject: 'https://example.org/s',
  predicate: 'https://schema.org/name',
  object: '"v"',
  ...overrides,
});

describe('validateQuadSubjectPredicateTerms', () => {
  it.each([
    ['an absolute IRI subject', quad()],
    ['a urn / did subject', quad({ subject: 'did:dkg:context-graph:0xabc/cg' })],
    ['an angle-bracketed subject and predicate', quad({ subject: '<urn:s>', predicate: '<urn:p>' })],
    ['a blank-node subject', quad({ subject: '_:b0' })],
    ['a non-ASCII IRI', quad({ subject: 'https://example.org/café/Δ' })],
  ])('accepts %s', (_name, value) => {
    expect(validateQuadSubjectPredicateTerms('quads', [value])).toBeNull();
  });

  it.each([
    ['a subject with a space', { subject: 'urn:a b' }, 'subject'],
    ['a relative subject', { subject: 'not-an-iri' }, 'subject'],
    ['a subject with a caret', { subject: 'urn:x^y' }, 'subject'],
    ['a subject with a newline', { subject: 'urn:x\ny' }, 'subject'],
    ['an invalid blank-node label', { subject: '_:a b' }, 'subject'],
    ['a literal subject', { subject: '"s"' }, 'subject'],
    ['a predicate with a caret', { predicate: 'https://schema.org/na^me' }, 'predicate'],
    ['a predicate with braces', { predicate: 'urn:{p}' }, 'predicate'],
    ['a blank-node predicate', { predicate: '_:p' }, 'predicate'],
    ['a half-bracketed predicate', { predicate: '<urn:p' }, 'predicate'],
  ])('rejects %s', (_name, overrides, field) => {
    expect(validateQuadSubjectPredicateTerms('quads', [quad(), quad(overrides)])).toBe(
      `Invalid "quads[1].${field}": RDF ${field} must be ${field === 'subject' ? 'an absolute IRI or blank node' : 'an absolute IRI'}`,
    );
  });
});

describe('validateQuadObjectTerms', () => {
  it('keeps the wm/write rule: literals and bare absolute IRIs only', () => {
    expect(validateQuadObjectTerms('quads', [quad({ object: 'https://example.org/o' })])).toBeNull();
    for (const object of ['_:b0', '<urn:o>', 'hello']) {
      expect(validateQuadObjectTerms('quads', [quad({ object })])).toBe(
        'Invalid "quads[0].object": RDF object must be a quoted literal term or absolute IRI',
      );
    }
  });

  it('accepts blank nodes and bracketed IRIs when the route allows them', () => {
    const lax = { blankNodes: true, bracketedIris: true };
    for (const object of ['"v"', 'urn:o', '<urn:o>', '_:b0']) {
      expect(validateQuadObjectTerms('quads', [quad({ object })], lax)).toBeNull();
    }
    for (const object of ['hello', 'urn:o^1', '<urn:o', '_:a b']) {
      expect(validateQuadObjectTerms('quads', [quad({ object })], lax)).toBe(
        'Invalid "quads[0].object": RDF object must be a quoted literal term, blank node or absolute IRI',
      );
    }
  });
});
