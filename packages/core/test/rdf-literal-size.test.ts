import { describe, expect, it } from 'vitest';
import {
  DKG_RDF_LITERAL_SAFE_MUTF8_BYTES,
  OVERSIZED_RDF_LITERAL_ERROR_CODE,
  assertQuadLiteralsMutf8Safe,
  assertRdfLiteralMutf8Safe,
  javaModifiedUtf8ByteLength,
  rdfLiteralTermMutf8ByteLength,
} from '../src/rdf-literal-size.js';

describe('rdf literal Java MUTF-8 sizing', () => {
  it('counts Java Modified UTF-8 byte length by UTF-16 code unit', () => {
    expect(javaModifiedUtf8ByteLength('abc')).toBe(3);
    expect(javaModifiedUtf8ByteLength('\u0000')).toBe(2);
    expect(javaModifiedUtf8ByteLength('\u007f')).toBe(1);
    expect(javaModifiedUtf8ByteLength('\u0080')).toBe(2);
    expect(javaModifiedUtf8ByteLength('\u07ff')).toBe(2);
    expect(javaModifiedUtf8ByteLength('\u0800')).toBe(3);
    expect(javaModifiedUtf8ByteLength('😀')).toBe(6);
    expect(javaModifiedUtf8ByteLength('\ud800')).toBe(3);
    expect(javaModifiedUtf8ByteLength('\udc00')).toBe(3);
  });

  it('sizes serialized RDF literal object terms and ignores non-literals', () => {
    expect(rdfLiteralTermMutf8ByteLength('"abc"')).toBe(5);
    expect(rdfLiteralTermMutf8ByteLength('"abc"@en')).toBe(8);
    const typed = '"1"^^<http://www.w3.org/2001/XMLSchema#integer>';
    expect(rdfLiteralTermMutf8ByteLength(typed)).toBe(javaModifiedUtf8ByteLength(typed));
    expect(rdfLiteralTermMutf8ByteLength('http://example.org/not-a-literal')).toBeUndefined();
  });

  it('allows literals at the conservative safe boundary', () => {
    const body = 'x'.repeat(DKG_RDF_LITERAL_SAFE_MUTF8_BYTES - 2);
    expect(() => assertRdfLiteralMutf8Safe(`"${body}"`)).not.toThrow();
  });

  it('rejects literals above the conservative safe boundary with diagnostics', () => {
    const body = 'x'.repeat(DKG_RDF_LITERAL_SAFE_MUTF8_BYTES - 1);
    expect(() =>
      assertRdfLiteralMutf8Safe(`"${body}"`, {
        label: 'test.literal',
        subject: 'http://example.org/s',
        predicate: 'http://schema.org/text',
      }),
    ).toThrow(/Blazegraph-compatible safe limit/);

    try {
      assertRdfLiteralMutf8Safe(`"${body}"`, {
        subject: 'http://example.org/s',
        predicate: 'http://schema.org/text',
      });
    } catch (err) {
      expect(err).toMatchObject({
        code: OVERSIZED_RDF_LITERAL_ERROR_CODE,
        actualBytes: DKG_RDF_LITERAL_SAFE_MUTF8_BYTES + 1,
        maxBytes: DKG_RDF_LITERAL_SAFE_MUTF8_BYTES,
        subject: 'http://example.org/s',
        predicate: 'http://schema.org/text',
      });
    }
  });

  it('validates quad arrays and reports the offending quad', () => {
    const oversized = `"${'x'.repeat(DKG_RDF_LITERAL_SAFE_MUTF8_BYTES - 1)}"`;
    expect(() =>
      assertQuadLiteralsMutf8Safe([
        { subject: 'http://example.org/safe', predicate: 'http://schema.org/name', object: '"ok"' },
        { subject: 'http://example.org/bad', predicate: 'http://schema.org/text', object: oversized },
      ], { label: 'publish.quads' }),
    ).toThrow(/publish\.quads\[1\]\.object/);
  });
});
