/**
 * The shared reading of a SELECT answer (`select-response.ts`), proven without a devnet:
 * which envelope is picked, what the lenient reading (`queryNode`'s) hands back and what it
 * rejects, what the strict reading (the hash-subscription suite's) checks and projects, how a
 * rejection is reported, and the term normalizers that share the module with the cell type.
 *
 * That `queryNode` reads exactly as it did before it delegated here is `query-node.test.ts`;
 * that the suite's parser says what it said is its `wire.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  lexical,
  normTerm,
  selectBindings,
  selectEnvelope,
  unwrapIri,
  valueOf,
  type RejectSelect,
  type SparqlBindingCell,
} from './select-response.js';

const ROWS = [
  { p: '<urn:a>', o: '"1"' },
  { p: { value: 'urn:b', type: 'uri' }, o: { value: 'x', datatype: 'urn:dt', 'xml:lang': 'en', extra: 1 } },
];

class Rejected extends Error {
  constructor(readonly path: string, readonly expected: string, readonly actual: unknown) {
    super(`${path} expected ${expected}`);
  }
}

/** A reject callback that records its calls and throws, as a caller's must. */
function recordingReject() {
  const calls: Array<{ path: string; expected: string; actual: unknown }> = [];
  const reject: RejectSelect = (path, expected, actual) => {
    calls.push({ path, expected, actual });
    throw new Rejected(path, expected, actual);
  };
  return { reject, calls };
}

const lenient = (json: unknown) => {
  const { reject, calls } = recordingReject();
  return { run: () => selectBindings(json, { strict: false, reject }), calls };
};
const strict = (json: unknown) => {
  const { reject, calls } = recordingReject();
  return { run: () => selectBindings(json, { strict: true, reject }), calls };
};

describe('selectEnvelope (one rule for both readings)', () => {
  it('takes result.bindings, then results.bindings, then a flat bindings', () => {
    expect(selectEnvelope({ result: { bindings: [1] }, results: { bindings: [2] }, bindings: [3] })).toEqual({ path: 'reply.result.bindings', value: [1] });
    expect(selectEnvelope({ results: { bindings: [2] }, bindings: [3] })).toEqual({ path: 'reply.results.bindings', value: [2] });
    expect(selectEnvelope({ bindings: [3] })).toEqual({ path: 'reply.bindings', value: [3] });
  });

  it('reads past an envelope whose bindings is null or undefined, but not past one that holds anything else', () => {
    expect(selectEnvelope({ result: { bindings: null }, results: { bindings: [2] } })).toEqual({ path: 'reply.results.bindings', value: [2] });
    expect(selectEnvelope({ result: {}, bindings: [3] })).toEqual({ path: 'reply.bindings', value: [3] });
    expect(selectEnvelope({ result: { bindings: 'x' }, bindings: [3] })).toEqual({ path: 'reply.result.bindings', value: 'x' });
    expect(selectEnvelope({ result: { bindings: 0 }, bindings: [3] })).toEqual({ path: 'reply.result.bindings', value: 0 });
    expect(selectEnvelope({ result: { bindings: false }, bindings: [3] })).toEqual({ path: 'reply.result.bindings', value: false });
  });

  it('reads past a holder that has no members to have bindings (null, a number, a string, an array)', () => {
    expect(selectEnvelope({ result: null, results: 3, bindings: [3] })).toEqual({ path: 'reply.bindings', value: [3] });
    expect(selectEnvelope({ result: 'str', results: [], bindings: [3] })).toEqual({ path: 'reply.bindings', value: [3] });
  });

  it.each([[null], [undefined], ['str'], [42], [true], [[]], [{}], [{ result: {} }]])('finds nothing in %j', (json) => {
    expect(selectEnvelope(json)).toBeUndefined();
  });
});

describe('selectBindings, lenient (queryNode\'s reading)', () => {
  it('hands back the very array the daemon sent, with rows and cells untouched', () => {
    const rows = [...ROWS, 'not-a-row', null, 7, { o: { value: 7 } }];
    const json = { result: { bindings: rows } };
    const { run, calls } = lenient(json);
    expect(run()).toBe(rows);
    expect(calls).toEqual([]);
    expect(rows[1]).toBe(ROWS[1]);
  });

  it.each([
    ['result.bindings', { result: { bindings: [] } }],
    ['results.bindings', { results: { bindings: [] } }],
    ['a flat bindings', { bindings: [] }],
  ])('accepts an empty SELECT in %s', (_where, json) => {
    expect(lenient(json).run()).toEqual([]);
  });

  it('does not look at a holder that is not an object: a number, a string or null there is skipped', () => {
    expect(lenient({ result: 3, bindings: [] }).run()).toEqual([]);
    expect(lenient({ result: null, results: 'x', bindings: [ROWS[0]] }).run()).toEqual([ROWS[0]]);
  });

  it('rejects an answer with no bindings anywhere, once, naming the first envelope and that nothing was there', () => {
    const { run, calls } = lenient({ result: {}, type: 'quads' });
    expect(run).toThrow(Rejected);
    expect(calls).toEqual([{ path: 'reply.result.bindings', expected: 'an array (or results.bindings, or bindings)', actual: undefined }]);
  });

  it.each([
    ['null', null],
    ['a string', 'ok'],
    ['a number', 42],
    ['an array', []],
  ])('rejects a body that is %s', (_what, json) => {
    expect(lenient(json).run).toThrow(Rejected);
  });

  it('rejects the first envelope that holds something that is not an array, naming it', () => {
    const { run, calls } = lenient({ result: { bindings: 'none' }, bindings: [] });
    expect(run).toThrow(Rejected);
    expect(calls).toEqual([{ path: 'reply.result.bindings', expected: 'an array', actual: 'none' }]);
  });

  it('lets what the caller\'s reject throws out untouched', () => {
    const boom = new TypeError('the caller\'s own error');
    expect(() => selectBindings({}, { strict: false, reject: () => { throw boom; } })).toThrow(boom);
  });
});

describe('selectBindings, strict (the suite\'s reading)', () => {
  it('projects every cell to the fields normTerm reads, in new objects', () => {
    const json = { result: { bindings: ROWS } };
    const rows = strict(json).run();
    expect(rows).toStrictEqual([
      { p: '<urn:a>', o: '"1"' },
      { p: { value: 'urn:b', type: 'uri' }, o: { value: 'x', datatype: 'urn:dt', 'xml:lang': 'en' } },
    ]);
    expect(rows).not.toBe(json.result.bindings);
    expect(rows[1]).not.toBe(ROWS[1]);
  });

  it('keeps no field it did not check, and no key that is undefined', () => {
    const [row] = strict({ bindings: [{ o: { value: 'x', extra: 1, lang: undefined } }] }).run();
    expect(Object.keys(row!.o as object)).toEqual(['value']);
  });

  it('accepts what the lenient reading accepts when the answer is well-formed, and returns the same rows', () => {
    const json = { results: { bindings: [{ p: '<urn:a>', o: { value: 'x', type: 'literal' } }, {}] } };
    expect(strict(json).run()).toEqual(lenient(json).run());
  });

  it.each([
    ['a body that is not an object', 'ok', 'reply', 'an object', 'ok'],
    ['an array body', [], 'reply', 'an object', []],
    ['a result that is not an object', { result: 3, bindings: [] }, 'reply.result', 'an object', 3],
    ['a null result', { result: null, bindings: [] }, 'reply.result', 'an object', null],
    ['a results that is not an object', { results: 'x', bindings: [] }, 'reply.results', 'an object', 'x'],
    ['no bindings anywhere', { result: {}, type: 'quads' }, 'reply.result.bindings', 'an array (or results.bindings, or bindings)', undefined],
    ['bindings that are not an array', { result: { bindings: 'none' } }, 'reply.result.bindings', 'an array', 'none'],
    ['a row that is not an object', { results: { bindings: [{ p: 'a' }, 'row'] } }, 'reply.results.bindings[1]', 'an object', 'row'],
    ['a cell that is neither a string nor an object', { bindings: [{ p: 'a', o: 7 }] }, 'reply.bindings[0].o', 'an object', 7],
    ['a null cell', { bindings: [{ o: null }] }, 'reply.bindings[0].o', 'an object', null],
    ['a structured cell whose value is not a string', { bindings: [{ o: { value: 7 } }] }, 'reply.bindings[0].o.value', 'a string when present', 7],
    ['a structured cell whose datatype is null', { bindings: [{ o: { datatype: null } }] }, 'reply.bindings[0].o.datatype', 'a string when present', null],
    ['a structured cell whose xml:lang is not a string', { bindings: [{ o: { 'xml:lang': ['en'] } }] }, 'reply.bindings[0].o.xml:lang', 'a string when present', ['en']],
    ['a structured cell whose lang is not a string', { bindings: [{ o: { lang: ['en'] } }] }, 'reply.bindings[0].o.lang', 'a string when present', ['en']],
    ['a structured cell whose type is not a string', { bindings: [{ o: { type: 1 } }] }, 'reply.bindings[0].o.type', 'a string when present', 1],
    ['an answer whose only bindings is null', { result: { bindings: null } }, 'reply.result.bindings', 'an array', null],
    ['an answer whose bindings are null in every envelope', { result: { bindings: null }, results: { bindings: null }, bindings: null }, 'reply.result.bindings', 'an array', null],
  ])('rejects %s, once, with the path, what was expected and what arrived', (_what, json, path, expected, actual) => {
    const { run, calls } = strict(json);
    expect(run).toThrow(Rejected);
    expect(calls).toEqual([{ path, expected, actual }]);
  });

  it('accepts what the lenient reading also accepts from a malformed answer only when the lenient reading is asked', () => {
    const malformed = { result: 3, bindings: [{ o: 7 }, 'row'] };
    expect(lenient(malformed).run()).toBe(malformed.bindings);
    expect(strict(malformed).run).toThrow(Rejected);
  });
});

describe('the cell normalizers that share the module with the cell type', () => {
  const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
  const cases: Array<[string, SparqlBindingCell | undefined | null, { norm: string; value: string; lexical: string; iri: string }]> = [
    ['a term string', '"a"@en', { norm: '"a"@en', value: '"a"@en', lexical: 'a', iri: '"a"@en' }],
    ['an IRI term string', '<urn:x>', { norm: '<urn:x>', value: '<urn:x>', lexical: '<urn:x>', iri: 'urn:x' }],
    ['a plain literal', { value: 'v' }, { norm: '"v"', value: 'v', lexical: 'v', iri: 'v' }],
    ['a language-tagged literal', { value: 'v', 'xml:lang': 'de' }, { norm: '"v"@de', value: 'v', lexical: 'v', iri: 'v' }],
    ['a typed literal', { value: '7', datatype: 'http://www.w3.org/2001/XMLSchema#integer' }, { norm: '"7"^^<http://www.w3.org/2001/XMLSchema#integer>', value: '7', lexical: '7', iri: '7' }],
    ['an xsd:string literal', { value: 'v', datatype: XSD_STRING }, { norm: '"v"', value: 'v', lexical: 'v', iri: 'v' }],
    ['a uri cell', { value: 'urn:x', type: 'uri' }, { norm: 'urn:x', value: 'urn:x', lexical: 'urn:x', iri: 'urn:x' }],
    ['a blank node cell', { value: '_:b0', type: 'bnode' }, { norm: '_:b0', value: '_:b0', lexical: '_:b0', iri: '_:b0' }],
    ['a cell with no value', {}, { norm: '', value: '', lexical: '', iri: '' }],
    ['nothing', undefined, { norm: '', value: '', lexical: '', iri: '' }],
    ['null', null, { norm: '', value: '', lexical: '', iri: '' }],
  ];

  it.each(cases)('read %s', (_what, cell, expected) => {
    expect({ norm: normTerm(cell), value: valueOf(cell), lexical: lexical(cell), iri: unwrapIri(cell) }).toEqual(expected);
  });
});
