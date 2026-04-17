import { describe, it, expect } from 'vitest';
import {
  assertSafeIri,
  assertSafeRdfTerm,
  isSafeIri,
  sparqlIri,
  escapeSparqlLiteral,
  sparqlString,
  sparqlInt,
} from '../src/index.js';

describe('assertSafeIri', () => {
  it('accepts normal URIs', () => {
    expect(assertSafeIri('http://example.org/resource')).toBe('http://example.org/resource');
    expect(assertSafeIri('did:dkg:context-graph:agents')).toBe('did:dkg:context-graph:agents');
    expect(assertSafeIri('urn:uuid:550e8400-e29b-41d4-a716-446655440000')).toBe('urn:uuid:550e8400-e29b-41d4-a716-446655440000');
    expect(assertSafeIri('did:dkg:context-graph:agents/_meta')).toBe('did:dkg:context-graph:agents/_meta');
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
    expect(isSafeIri('did:dkg:context-graph:test')).toBe(true);
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
    expect(sparqlIri('did:dkg:context-graph:agents/_meta')).toBe('<did:dkg:context-graph:agents/_meta>');
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

  it('preserves precision for large bigint values beyond Number.MAX_SAFE_INTEGER', () => {
    const large = 9007199254740993n; // Number.MAX_SAFE_INTEGER + 2
    expect(sparqlInt(large)).toBe('9007199254740993');
    const veryLarge = 123456789012345678901234567890n;
    expect(sparqlInt(veryLarge)).toBe('123456789012345678901234567890');
  });

  it('enforces bounds on bigint values', () => {
    expect(() => sparqlInt(-1n, { min: 0 })).toThrow('below minimum');
    expect(() => sparqlInt(1001n, { max: 1000 })).toThrow('above maximum');
    expect(sparqlInt(500n, { min: 0, max: 1000 })).toBe('500');
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

describe('assertSafeRdfTerm', () => {
  it('accepts plain string literal', () => {
    expect(() => assertSafeRdfTerm('"hello"')).not.toThrow();
  });

  it('accepts string with valid escape sequences', () => {
    expect(() => assertSafeRdfTerm('"line\\none"')).not.toThrow();
    expect(() => assertSafeRdfTerm('"tab\\there"')).not.toThrow();
    expect(() => assertSafeRdfTerm('"back\\\\slash"')).not.toThrow();
    expect(() => assertSafeRdfTerm('"escaped\\"quote"')).not.toThrow();
  });

  it('accepts typed literal', () => {
    expect(() => assertSafeRdfTerm('"42"^^<http://www.w3.org/2001/XMLSchema#integer>')).not.toThrow();
    expect(() => assertSafeRdfTerm('"2024-01-01"^^<http://www.w3.org/2001/XMLSchema#date>')).not.toThrow();
  });

  it('accepts language-tagged literal', () => {
    expect(() => assertSafeRdfTerm('"hello"@en')).not.toThrow();
    expect(() => assertSafeRdfTerm('"bonjour"@fr-FR')).not.toThrow();
  });

  it('accepts language tags with numeric subtags (BCP47)', () => {
    expect(() => assertSafeRdfTerm('"name"@de-CH-1996')).not.toThrow();
    expect(() => assertSafeRdfTerm('"text"@sl-rozaj-1994')).not.toThrow();
    expect(() => assertSafeRdfTerm('"foo"@zh-Hant-TW')).not.toThrow();
  });

  it('rejects language tags starting with digits', () => {
    expect(() => assertSafeRdfTerm('"x"@123')).toThrow();
  });

  it('rejects language tags with empty subtags', () => {
    expect(() => assertSafeRdfTerm('"x"@en-')).toThrow();
    expect(() => assertSafeRdfTerm('"x"@en--GB')).toThrow();
  });

  it('accepts IRI in angle brackets', () => {
    expect(() => assertSafeRdfTerm('<http://example.org/resource>')).not.toThrow();
    expect(() => assertSafeRdfTerm('<urn:test:123>')).not.toThrow();
  });

  it('accepts unicode escape sequences', () => {
    expect(() => assertSafeRdfTerm('"caf\\u00E9"')).not.toThrow();
    expect(() => assertSafeRdfTerm('"emoji\\U0001F600"')).not.toThrow();
  });

  it('rejects raw newlines inside literal', () => {
    expect(() => assertSafeRdfTerm('"line\nbreak"')).toThrow('Unsafe RDF term');
    expect(() => assertSafeRdfTerm('"line\rbreak"')).toThrow('Unsafe RDF term');
  });

  it('rejects invalid backslash escape sequences', () => {
    expect(() => assertSafeRdfTerm('"bad\\xescape"')).toThrow('Unsafe RDF term');
    expect(() => assertSafeRdfTerm('"bad\\aescape"')).toThrow('Unsafe RDF term');
  });

  it('rejects SPARQL injection in literal', () => {
    expect(() => assertSafeRdfTerm('"recruiting" } } . DROP ALL #')).toThrow('Unsafe RDF term');
    expect(() => assertSafeRdfTerm('"x" . <urn:a> <urn:b> "pwned"')).toThrow('Unsafe RDF term');
  });

  it('rejects SPARQL injection in IRI term', () => {
    expect(() => assertSafeRdfTerm('<http://x> } DROP ALL #<y>')).toThrow('Unsafe RDF term');
  });

  it('rejects injection through language tag', () => {
    expect(() => assertSafeRdfTerm('"x"@en> } DROP ALL #')).toThrow();
  });

  it('rejects empty string', () => {
    expect(() => assertSafeRdfTerm('')).toThrow('Unsafe RDF term');
  });

  it('rejects bare unquoted string', () => {
    expect(() => assertSafeRdfTerm('recruiting')).toThrow('Unsafe RDF term');
  });

  it('rejects literal with unclosed quote', () => {
    expect(() => assertSafeRdfTerm('"unclosed')).toThrow('Unsafe RDF term');
  });

  it('rejects IRI with unsafe characters', () => {
    expect(() => assertSafeRdfTerm('<http://x"y>')).toThrow('Unsafe RDF term');
    expect(() => assertSafeRdfTerm('<http://x y>')).toThrow('Unsafe RDF term');
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
