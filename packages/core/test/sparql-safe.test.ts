import { describe, it, expect } from 'vitest';
import {
  assertSafeIri,
  isSafeIri,
  sparqlIri,
  escapeSparqlLiteral,
  sparqlString,
  sparqlInt,
} from '../src/index.js';

describe('assertSafeIri', () => {
  it('accepts normal URIs', () => {
    expect(assertSafeIri('http://example.org/resource')).toBe('http://example.org/resource');
    expect(assertSafeIri('did:dkg:paranet:agents')).toBe('did:dkg:paranet:agents');
    expect(assertSafeIri('urn:uuid:550e8400-e29b-41d4-a716-446655440000')).toBe('urn:uuid:550e8400-e29b-41d4-a716-446655440000');
    expect(assertSafeIri('did:dkg:paranet:agents/_meta')).toBe('did:dkg:paranet:agents/_meta');
  });

  it('rejects empty string', () => {
    expect(() => assertSafeIri('')).toThrow('Unsafe or empty IRI');
  });

  it('rejects angle brackets', () => {
    expect(() => assertSafeIri('http://x>')).toThrow();
    expect(() => assertSafeIri('<http://x')).toThrow();
  });

  it('rejects double quotes', () => {
    expect(() => assertSafeIri('http://x"y')).toThrow();
  });

  it('rejects curly braces', () => {
    expect(() => assertSafeIri('http://x{y}')).toThrow();
  });

  it('rejects backslash', () => {
    expect(() => assertSafeIri('http://x\\y')).toThrow();
  });

  it('rejects backtick', () => {
    expect(() => assertSafeIri('http://x`y')).toThrow();
  });

  it('rejects pipe', () => {
    expect(() => assertSafeIri('http://x|y')).toThrow();
  });

  it('rejects caret', () => {
    expect(() => assertSafeIri('http://x^y')).toThrow();
  });

  it('rejects spaces', () => {
    expect(() => assertSafeIri('http://x y')).toThrow();
  });

  it('rejects control characters', () => {
    expect(() => assertSafeIri('http://x\x00y')).toThrow();
    expect(() => assertSafeIri('http://x\ny')).toThrow();
    expect(() => assertSafeIri('http://x\ry')).toThrow();
    expect(() => assertSafeIri('http://x\ty')).toThrow();
  });
});

describe('isSafeIri', () => {
  it('returns true for valid scheme-prefixed IRIs', () => {
    expect(isSafeIri('http://example.org/resource')).toBe(true);
    expect(isSafeIri('did:dkg:paranet:test')).toBe(true);
    expect(isSafeIri('urn:test:123')).toBe(true);
  });

  it('returns false for empty and missing-scheme values', () => {
    expect(isSafeIri('')).toBe(false);
    expect(isSafeIri('no-scheme')).toBe(false);
    expect(isSafeIri('/relative/path')).toBe(false);
    expect(isSafeIri('123:starts-with-digit')).toBe(false);
  });

  it('returns false for values with unsafe characters', () => {
    expect(isSafeIri('http://x"y')).toBe(false);
    expect(isSafeIri('http://x>y')).toBe(false);
    expect(isSafeIri('http://x y')).toBe(false);
  });
});

describe('sparqlIri', () => {
  it('wraps valid IRIs in angle brackets', () => {
    expect(sparqlIri('http://example.org/p')).toBe('<http://example.org/p>');
    expect(sparqlIri('did:dkg:paranet:agents/_meta')).toBe('<did:dkg:paranet:agents/_meta>');
  });

  it('throws on unsafe IRIs', () => {
    expect(() => sparqlIri('http://x"y')).toThrow();
    expect(() => sparqlIri('')).toThrow();
  });
});

describe('escapeSparqlLiteral', () => {
  it('passes through safe strings unchanged', () => {
    expect(escapeSparqlLiteral('hello world')).toBe('hello world');
  });

  it('escapes backslash', () => {
    expect(escapeSparqlLiteral('a\\b')).toBe('a\\\\b');
  });

  it('escapes double quotes', () => {
    expect(escapeSparqlLiteral('say "hello"')).toBe('say \\"hello\\"');
  });

  it('escapes newlines', () => {
    expect(escapeSparqlLiteral('line1\nline2')).toBe('line1\\nline2');
  });

  it('escapes carriage returns', () => {
    expect(escapeSparqlLiteral('line1\rline2')).toBe('line1\\rline2');
  });

  it('escapes tabs', () => {
    expect(escapeSparqlLiteral('col1\tcol2')).toBe('col1\\tcol2');
  });

  it('escapes multiple special characters together', () => {
    expect(escapeSparqlLiteral('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
  });

  it('handles empty string', () => {
    expect(escapeSparqlLiteral('')).toBe('');
  });

  it('handles unicode correctly', () => {
    expect(escapeSparqlLiteral('café ☕')).toBe('café ☕');
  });
});

describe('sparqlString', () => {
  it('returns a quoted escaped literal', () => {
    expect(sparqlString('hello')).toBe('"hello"');
    expect(sparqlString('say "hi"')).toBe('"say \\"hi\\""');
    expect(sparqlString('line\nbreak')).toBe('"line\\nbreak"');
  });
});

describe('sparqlInt', () => {
  it('accepts valid integers', () => {
    expect(sparqlInt(0)).toBe('0');
    expect(sparqlInt(42)).toBe('42');
    expect(sparqlInt(-1)).toBe('-1');
  });

  it('accepts bigint values within safe range', () => {
    expect(sparqlInt(42n)).toBe('42');
  });

  it('rejects NaN', () => {
    expect(() => sparqlInt(NaN)).toThrow('Invalid SPARQL integer');
  });

  it('rejects Infinity', () => {
    expect(() => sparqlInt(Infinity)).toThrow('Invalid SPARQL integer');
    expect(() => sparqlInt(-Infinity)).toThrow('Invalid SPARQL integer');
  });

  it('rejects floats', () => {
    expect(() => sparqlInt(1.5)).toThrow('Invalid SPARQL integer');
  });

  it('enforces min bound', () => {
    expect(() => sparqlInt(-1, { min: 0 })).toThrow('below minimum');
    expect(sparqlInt(0, { min: 0 })).toBe('0');
  });

  it('enforces max bound', () => {
    expect(() => sparqlInt(1001, { max: 1000 })).toThrow('above maximum');
    expect(sparqlInt(1000, { max: 1000 })).toBe('1000');
  });
});

describe('SPARQL injection regression tests', () => {
  it('rejects peer ID literal breakout payload as IRI', () => {
    const payload = '" . } } INSERT DATA { <urn:fake> <urn:p> "evil" } #';
    expect(() => assertSafeIri(payload)).toThrow();
    expect(isSafeIri(payload)).toBe(false);
  });

  it('escapes peer ID literal breakout payload as string', () => {
    const payload = '" . } } INSERT DATA { <urn:fake> <urn:p> "evil" } #';
    const escaped = escapeSparqlLiteral(payload);
    expect(escaped).toBe('\\" . } } INSERT DATA { <urn:fake> <urn:p> \\"evil\\" } #');
    const inQuery = `"${escaped}"`;
    expect(inQuery).toBe('"\\" . } } INSERT DATA { <urn:fake> <urn:p> \\"evil\\" } #"');
  });

  it('rejects IRI breakout payload via entityUri', () => {
    const payload = 'http://x> ?p ?o } } INSERT DATA { <urn:poison> <urn:p> <urn:o> } #';
    expect(() => assertSafeIri(payload)).toThrow();
    expect(isSafeIri(payload)).toBe(false);
  });

  it('rejects double-context breakout via rootEntity', () => {
    const payload = 'http://legit" || true) } } INSERT DATA { <urn:x> <urn:y> <urn:z> } #';
    expect(() => assertSafeIri(payload)).toThrow();
    expect(isSafeIri(payload)).toBe(false);
  });

  it('escapes newline-based SPARQL injection in literals', () => {
    const payload = 'value"\n; INSERT DATA { <urn:x> <urn:y> <urn:z> }';
    const escaped = escapeSparqlLiteral(payload);
    expect(escaped).toBe('value\\"\\n; INSERT DATA { <urn:x> <urn:y> <urn:z> }');
    expect(escaped).not.toContain('\n');
  });
});
