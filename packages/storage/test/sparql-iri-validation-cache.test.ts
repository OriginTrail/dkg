import { describe, expect, it, vi } from 'vitest';
import { isSafeIri } from '@origintrail-official/dkg-core';
import { decodeSparqlJsonQueryResult, parseSparqlJsonSelectResponse, SparqlJsonResultsShapeError } from '../src/sparql-json-query-result.js';

// Count the validations the decoder actually performs; the cache is otherwise
// unobservable because a hit returns the same answer as the regex test.
vi.mock('@origintrail-official/dkg-core', async importOriginal => {
  const actual = await importOriginal<typeof import('@origintrail-official/dkg-core')>();
  return { ...actual, isSafeIri: vi.fn(actual.isSafeIri) };
});
const validations = vi.mocked(isSafeIri);

const uri = (value = 'urn:test:valid') => ({ type: 'uri', value });
const response = (terms: unknown[]) => ({ head: { vars: ['v'] }, results: { bindings: terms.map(v => ({ v })) } });
const decodeBoth = (input: unknown) => [
  () => parseSparqlJsonSelectResponse(input),
  () => decodeSparqlJsonQueryResult(JSON.stringify(input), 'select'),
];

describe('bounded response-local IRI validation reuse', () => {
  it('preserves URI, datatype, and RDF literal identity across repeated rows', () => {
    const input = response([uri(), uri(),
      { type: 'literal', value: '42', datatype: 'urn:test:valid' },
      { type: 'literal', value: '43', datatype: 'urn:test:valid' },
      uri(),
    ]);
    for (const decode of decodeBoth(input)) expect(decode()).toMatchObject({ bindings: [
      { v: 'urn:test:valid' }, { v: 'urn:test:valid' },
      { v: '"42"^^<urn:test:valid>' }, { v: '"43"^^<urn:test:valid>' }, { v: 'urn:test:valid' },
    ] });
  });

  it.each([
    { ...uri(), extra: true }, { type: 'uri', value: 'relative' },
    { type: 'unsupported', value: 'urn:test:valid' },
    { type: 'literal', value: 'x', datatype: 'urn:test:valid', 'xml:lang': 'en' },
  ])('does not skip malformed term checks after warming a repeated IRI', term => {
    for (const decode of decodeBoth(response([uri(), term]))) expect(decode).toThrow(SparqlJsonResultsShapeError);
  });

  it('never bypasses descriptor, symbol, or non-enumerable checks at object entrypoints', () => {
    let calls = 0;
    const accessor = { type: 'uri' };
    Object.defineProperty(accessor, 'value', { enumerable: true, get() { calls++; return 'urn:test:valid'; } });
    const hidden = uri();
    Object.defineProperty(hidden, 'value', { enumerable: false, value: 'urn:test:valid' });
    const symbolic = { ...uri(), [Symbol('extra')]: true };
    for (const term of [accessor, hidden, symbolic]) {
      expect(() => parseSparqlJsonSelectResponse(response([uri(), term]))).toThrow(SparqlJsonResultsShapeError);
    }
    expect(calls).toBe(0);
  });

  it('still validates long IRIs and columns beyond the bounded cache', () => {
    const long = `urn:test:${'a'.repeat(4096)}`;
    for (const decode of decodeBoth(response([uri(long), uri(long)]))) {
      validations.mockClear();
      expect(decode()).toMatchObject({ bindings: [{ v: long }, { v: long }] });
      // Too long to retain, so the repeat cannot hit and pays the validator.
      expect(validations.mock.calls.filter(([value]) => value === long)).toHaveLength(2);
    }
    for (const decode of decodeBoth(response([uri(long), uri(`${long}>`)]))) expect(decode).toThrow(SparqlJsonResultsShapeError);
    const vars = Array.from({ length: 129 }, (_, i) => `v${i}`);
    const row = Object.fromEntries(vars.map(v => [v, uri()]));
    const beyond = 'urn:test:beyond-cached-columns';
    const beyondRow = { ...row, v128: uri(beyond) };
    for (const decode of decodeBoth({ head: { vars }, results: { bindings: [beyondRow, beyondRow] } })) {
      validations.mockClear();
      decode();
      // The 129th column gets no cache slot, so its repeat is revalidated too.
      expect(validations.mock.calls.filter(([value]) => value === beyond)).toHaveLength(2);
    }
    const input = { head: { vars }, results: { bindings: [row, { ...row, v128: uri('relative') }] } };
    for (const decode of decodeBoth(input)) expect(decode).toThrow(SparqlJsonResultsShapeError);
  });

  it('re-arms the cache for a repeated run that follows a unique prefix', () => {
    const repeated = 'urn:test:repeated';
    const repeats = 400;
    const terms = [
      ...Array.from({ length: 20 }, (_, index) => uri(`urn:test:unique:${index}`)),
      ...Array.from({ length: repeats }, () => uri(repeated)),
    ];
    for (const decode of decodeBoth(response(terms))) {
      validations.mockClear();
      expect(decode()).toMatchObject({ bindings: terms.map(term => ({ v: term.value })) });
      // A unique prefix may pause comparisons, but it must not latch them off
      // for the rest of the response: the repeated tail stops being revalidated.
      const revalidated = validations.mock.calls.filter(([value]) => value === repeated);
      expect(revalidated.length).toBeLessThan(repeats / 2);
    }
  });

  it('keeps term values and literal datatypes in separate cache slots', () => {
    const datatype = 'urn:test:datatype';
    const terms = Array.from({ length: 20 }, (_, index) => (index % 2 === 0
      ? uri(`urn:test:subject:${index}`)
      : { type: 'literal', value: `row ${index}`, datatype }));
    for (const decode of decodeBoth(response(terms))) {
      validations.mockClear();
      decode();
      expect(validations.mock.calls.filter(([value]) => value === datatype)).toHaveLength(1);
    }
  });

  it('keeps validating high-cardinality columns after cache comparison is disabled', () => {
    const unique = Array.from({ length: 50 }, (_, i) => uri(`urn:test:unique:${i}`));
    for (const decode of decodeBoth(response(unique))) expect(decode()).toMatchObject({ bindings: unique.map(v => ({ v: v.value })) });
    for (const decode of decodeBoth(response([...unique, uri('relative')]))) expect(decode).toThrow(SparqlJsonResultsShapeError);
  });
});
