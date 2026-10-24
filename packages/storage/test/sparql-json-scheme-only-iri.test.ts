import { describe, expect, it } from 'vitest';
import { isSafeIri } from '@origintrail-official/dkg-core';
import { decodeSparqlJsonQueryResult, parseSparqlJsonSelectResponse } from '../src/sparql-json-query-result.js';

// RFC 3987 `absolute-IRI = scheme ":" ihier-part [ "?" iquery ]` lets the
// ihier-part be empty, so `a:` is an IRI that Oxigraph and Blazegraph store
// and return from SELECT. The decoder accepts that bare-scheme shape; every
// other value keeps core isSafeIri's answer.

type Bindings = Array<Record<string, string>>;
const select = (vars: string[], bindings: Array<Record<string, unknown>>) => ({ head: { vars }, results: { bindings } });
const column = (terms: unknown[]) => select(['o'], terms.map(o => ({ o })));
const uri = (value: string) => ({ type: 'uri', value });
const typed = (datatype: string) => ({ type: 'literal', value: '42', datatype });
const decodeBoth = (input: unknown) => [
  () => parseSparqlJsonSelectResponse(input).bindings,
  () => (decodeSparqlJsonQueryResult(JSON.stringify(input), 'select') as { bindings: Bindings }).bindings,
];
const URI_REJECTED = /URI value must be an absolute safe IRI/;
const DATATYPE_REJECTED = /datatype must be an absolute safe IRI/;

// RFC 3986 section 3.1: scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )
const isBareScheme = (value: string) => value.endsWith(':') && /^[A-Za-z][A-Za-z0-9+\-.]*$/.test(value.slice(0, -1));

describe('bare-scheme IRIs in SPARQL JSON results', () => {
  it.each(['a:', 'urn:', 'z9+.-:', 'A:'])('decodes %s as a URI value and as a datatype', iri => {
    for (const decode of decodeBoth(column([uri(iri)]))) expect(decode()).toEqual([{ o: iri }]);
    for (const term of [typed(iri), { type: 'typed-literal', value: '42', datatype: iri }]) {
      for (const decode of decodeBoth(column([term]))) expect(decode()).toEqual([{ o: `"42"^^<${iri}>` }]);
    }
  });

  it('decodes a stored <a:> object next to ordinary IRIs', () => {
    const row = { s: uri('http://probe.example/a-colon'), p: uri('http://probe.example/p'), o: uri('a:') };
    for (const decode of decodeBoth(select(['s', 'p', 'o'], [row]))) {
      expect(decode()).toEqual([{ s: 'http://probe.example/a-colon', p: 'http://probe.example/p', o: 'a:' }]);
    }
  });

  it('decodes a bare scheme on the cached, paused and uncached column validators', () => {
    // Repeated rows hit the per-column cache; 16 unique values in a row pause
    // cache comparisons; columns past the 128th have no cached validator.
    const unique = (prefix: string) => Array.from({ length: 20 }, (_, i) => `urn:test:${prefix}:${i}`);
    const vars = Array.from({ length: 129 }, (_, i) => `v${i}`);
    const wide = (o: unknown) => Object.fromEntries(vars.map(v => [v, v === 'v128' ? o : uri('urn:test:x')]));
    const cases: Array<[unknown, string[]]> = [
      [column([uri('a:'), uri('a:'), typed('a:'), typed('a:')]), ['a:', 'a:', '"42"^^<a:>', '"42"^^<a:>']],
      [column([...unique('value').map(uri), uri('a:')]), [...unique('value'), 'a:']],
      [column([...unique('datatype').map(typed), typed('a:')]), [...unique('datatype').map(d => `"42"^^<${d}>`), '"42"^^<a:>']],
    ];
    for (const [input, expected] of cases) {
      for (const decode of decodeBoth(input)) expect(decode().map(row => row.o)).toEqual(expected);
    }
    for (const decode of decodeBoth(select(vars, [wide(uri('a:')), wide(typed('a:'))]))) {
      expect(decode().map(row => row.v128)).toEqual(['a:', '"42"^^<a:>']);
    }
  });

  it.each([
    '', 'a', ':', '1a:', '+a:', '.a:', '-a:', 'a_b:', 'é:', 'a b:',
    ' a:', 'a: ', 'a:\n', '\na:', 'a:\r', 'a:\t', 'a:\u0000', 'a:\u00a0', 'a:\u2028', 'a:\ufeff',
    '<a:>', 'a:>', 'a:<', 'a:"', 'a:{', 'a:}', 'a:|', 'a:\\', 'a:^', 'a:`',
  ])('still rejects %j as a URI value and as a datatype', value => {
    for (const decode of decodeBoth(column([uri(value)]))) expect(decode).toThrow(URI_REJECTED);
    for (const decode of decodeBoth(column([typed(value)]))) expect(decode).toThrow(DATATYPE_REJECTED);
  });

  it('does not let a cached bare scheme admit a near miss', () => {
    for (const miss of ['a: ', 'a:>', 'a:\n', ' a:']) {
      for (const decode of decodeBoth(column([uri('a:'), uri(miss)]))) expect(decode).toThrow(URI_REJECTED);
      for (const decode of decodeBoth(column([typed('a:'), typed(miss)]))) expect(decode).toThrow(DATATYPE_REJECTED);
    }
  });

  it('accepts exactly what isSafeIri accepts plus a bare scheme', () => {
    const characters = [
      ...Array.from({ length: 0x80 }, (_, code) => String.fromCharCode(code)),
      '\u0085', '\u00a0', '\u00e9', '\u2028', '\u2029', '\u3000', '\ufeff', '\ufffd',
    ];
    const accepts = (decode: () => unknown) => {
      try { decode(); return true; } catch { return false; }
    };
    const mismatches: string[] = [];
    const widened = new Set<string>();
    for (const c of characters) {
      for (const value of [c, `${c}:`, `a${c}:`, `${c}a:`, `a:${c}`, `a:${c}b`]) {
        const expected = isSafeIri(value) || isBareScheme(value);
        if (expected && !isSafeIri(value)) widened.add(value);
        for (const term of [uri(value), typed(value)]) {
          for (const decode of decodeBoth(column([term]))) {
            if (accepts(decode) !== expected) mismatches.push(`${term.type} ${JSON.stringify(value)}`);
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
    // The sweep reaches the widened shape: `${c}:` alone gives one bare scheme per ASCII letter.
    expect(widened.size).toBeGreaterThanOrEqual(52);
  });
});
