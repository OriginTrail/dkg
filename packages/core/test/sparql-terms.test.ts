import { describe, expect, it } from 'vitest';
import {
  formatIriPrefix,
  formatSparqlTerm,
  SparqlTermValidationError,
  unwrapIri,
  type SparqlTermContext,
  type SparqlTermKind,
} from '../src/index.js';

const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

describe('formatSparqlTerm, the one serializer', () => {
  it.each<[string, SparqlTermContext, string, string]>([
    ['a graph name', { position: 'graph' }, 'urn:g', '<urn:g>'],
    ['a bare subject', { position: 'subject' }, 'urn:s', '<urn:s>'],
    ['an angle-bracketed subject', { position: 'subject' }, '<urn:s>', '<urn:s>'],
    ['a subject blank node where allowed', { position: 'subject', blankNodes: 'allow' }, '_:b0', '_:b0'],
    ['a predicate', { position: 'predicate' }, '<urn:p>', '<urn:p>'],
    ['an object IRI', { position: 'object' }, 'urn:o', '<urn:o>'],
    ['an object literal', { position: 'object' }, '"v"@en', '"v"@en'],
    ['an object literal with a bare datatype', { position: 'object' }, `"42"^^${XSD_INTEGER}`, `"42"^^<${XSD_INTEGER}>`],
    ['an object blank node where allowed', { position: 'object', blankNodes: 'allow' }, '_:b1', '_:b1'],
  ])('renders %s', (_name, context, term, rendered) => {
    expect(formatSparqlTerm(term, context)).toBe(rendered);
  });

  it.each<[string, SparqlTermContext, string, SparqlTermKind]>([
    ['an angle-bracketed graph name', { position: 'graph' }, '<urn:g>', 'iri'],
    ['a blank-node graph name', { position: 'graph', blankNodes: 'allow' }, '_:g', 'blank-node'],
    ['a literal graph name', { position: 'graph' }, '"g"', 'literal'],
    ['a blank-node subject by default', { position: 'subject' }, '_:b0', 'blank-node'],
    ['a literal subject', { position: 'subject', blankNodes: 'allow' }, '"s"', 'literal'],
    ['a blank-node predicate, even where blank nodes are allowed', { position: 'predicate', blankNodes: 'allow' }, '_:p', 'blank-node'],
    ['a literal predicate', { position: 'predicate' }, '"p"', 'literal'],
    ['a blank-node object by default', { position: 'object' }, '_:b0', 'blank-node'],
    ['an invalid blank-node label', { position: 'object', blankNodes: 'allow' }, '_:a b', 'blank-node'],
    ['a literal with a raw line break', { position: 'object' }, '"x\ny"', 'literal'],
    ['an IRI with a space', { position: 'predicate' }, 'urn:p q', 'iri'],
  ])('rejects %s', (_name, context, term, kind) => {
    let error: unknown;
    try {
      formatSparqlTerm(term, context);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SparqlTermValidationError);
    expect((error as SparqlTermValidationError).kind).toBe(kind);
  });

  it('keeps the core validator message for callers that match on it', () => {
    expect(() => formatSparqlTerm('urn:a b', { position: 'graph' })).toThrow(/^Unsafe or empty IRI value: urn:a b$/);
    expect(() => formatSparqlTerm('"x\ny"', { position: 'object' })).toThrow(/^Unsafe RDF term/);
  });

  it('names the violated rule', () => {
    expect(() => formatSparqlTerm('_:b0', { position: 'object' })).toThrow(/cannot be a blank node/);
    expect(() => formatSparqlTerm('_:a b', { position: 'subject', blankNodes: 'allow' })).toThrow(/Invalid blank node label/);
    expect(() => formatSparqlTerm('"x"', { position: 'subject', blankNodes: 'allow' })).toThrow(/must be an IRI/);
    expect(() => formatSparqlTerm('<urn:g>', { position: 'graph' })).toThrow(/Unsafe or empty IRI/);
  });
});

describe('formatIriPrefix', () => {
  it.each(['', 'http://ex.org/', 'urn:café#'])('renders %j as a string literal', (prefix) => {
    expect(formatIriPrefix(prefix)).toBe(JSON.stringify(prefix));
  });

  it.each(['urn:line\nbreak', 'urn:a b', 'urn:with "quotes"', 'urn:back\\slash'])(
    'rejects %j, which no IRI can start with',
    (prefix) => {
      expect(() => formatIriPrefix(prefix)).toThrow(SparqlTermValidationError);
    },
  );
});

describe('unwrapIri', () => {
  it('strips one pair of angle brackets and leaves anything else alone', () => {
    expect(unwrapIri('<urn:x>')).toBe('urn:x');
    expect(unwrapIri('urn:x')).toBe('urn:x');
    expect(unwrapIri('<urn:x')).toBe('<urn:x');
  });
});

describe('the validation error', () => {
  it('keeps the rejected datatype of a bare-datatype literal as a literal failure, with its cause', () => {
    let error: unknown;
    try {
      formatSparqlTerm('"5"^^urn:dt with space', { position: 'object' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SparqlTermValidationError);
    expect(error).toMatchObject({ name: 'SparqlTermValidationError', kind: 'literal' });
    expect((error as Error).cause).toBeInstanceOf(Error);
  });
});
