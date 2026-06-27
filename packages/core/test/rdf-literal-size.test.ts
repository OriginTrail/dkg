import { describe, expect, it } from 'vitest';
import { reconstructChunkedTextBodies } from './helpers/chunked-text.js';
import {
  DKG_RDF_LITERAL_SAFE_MUTF8_BYTES,
  OVERSIZED_RDF_LITERAL_ERROR_CODE,
  assertQuadLiteralsMutf8Safe,
  assertRdfLiteralMutf8Safe,
  javaModifiedUtf8ByteLength,
  rdfLiteralTermMutf8ByteLength,
} from '../src/rdf-literal-size.js';
import {
  DKG_CHUNK_VALUE,
  DKG_HAS_TEXT_BODY,
  DKG_HAS_TEXT_CHUNK,
  DKG_TEXT_CONTENT_SHA256,
  DKG_TEXT_LITERAL_TERM_SHA256,
  XSD_STRING_IRI,
  normalizeLargeRdfLiteralsForBlazegraph,
  parseRdfLiteralTerm,
} from '../src/rdf-text-literal-normalization.js';

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

  it('chunks oversized schema text into DKG chunk values and reconstructs exactly', () => {
    const lexical = `${'computer history '.repeat(200)}"quoted"\n\\slash 😀`;
    const literal = `${JSON.stringify(lexical)}@en`;
    const result = normalizeLargeRdfLiteralsForBlazegraph([
      {
        subject: 'http://example.org/root',
        predicate: 'http://schema.org/text',
        object: literal,
        graph: 'did:dkg:context-graph:test',
      },
    ], {
      maxBytes: 400,
      chunkMaxBytes: 180,
      label: 'test.quads',
    });

    expect(result.rewrites).toHaveLength(1);
    expect(result.rewrites[0].chunkCount).toBeGreaterThan(1);
    expect(result.quads.some((quad) =>
      quad.subject === 'http://example.org/root' &&
      quad.predicate === 'http://schema.org/text'
    )).toBe(false);

    const bodySubject = result.quads.find((quad) => quad.predicate === DKG_HAS_TEXT_BODY)?.object;
    expect(bodySubject).toContain('/.well-known/genid/dkg-text-body-');
    expect(result.quads.some((quad) =>
      quad.predicate === 'http://schema.org/text' &&
      quad.subject.includes('/chunk-')
    )).toBe(false);

    const chunkValueQuads = result.quads.filter((quad) => quad.predicate === DKG_CHUNK_VALUE);
    expect(chunkValueQuads).toHaveLength(result.rewrites[0].chunkCount);
    expect(chunkValueQuads.every((quad) => javaModifiedUtf8ByteLength(quad.object) <= 180)).toBe(true);

    const reconstructed = reconstructChunkedTextBodies(result.quads, {
      subject: 'http://example.org/root',
      sourcePredicate: 'http://schema.org/text',
    });
    expect(reconstructed).toHaveLength(1);
    expect(reconstructed[0]).toMatchObject({
      subject: 'http://example.org/root',
      bodySubject,
      sourcePredicate: 'http://schema.org/text',
      lexical,
      literalTerm: literal,
      language: 'en',
      chunkCount: result.rewrites[0].chunkCount,
    });
  });

  it('rejects raw control characters in quoted RDF literal source', () => {
    expect(parseRdfLiteralTerm('"bad\nbody"')).toBeNull();
    expect(parseRdfLiteralTerm('"bad\rbody"')).toBeNull();
    expect(parseRdfLiteralTerm(`"bad${String.fromCharCode(1)}body"`)).toBeNull();

    const rawNewlineLiteral = `"${'x'.repeat(250)}\n${'y'.repeat(250)}"`;
    expect(() =>
      normalizeLargeRdfLiteralsForBlazegraph([
        {
          subject: 'http://example.org/raw-control',
          predicate: 'http://schema.org/text',
          object: rawNewlineLiteral,
          graph: 'did:dkg:context-graph:test',
        },
      ], { maxBytes: 200, chunkMaxBytes: 100 }),
    ).toThrow(/Blazegraph-compatible safe limit/);
  });

  it('chunks escaped control sequences and reconstructs their lexical value', () => {
    const escapedLiteral = `"${'line\\nbreak '.repeat(80)}"@en`;
    expect(parseRdfLiteralTerm('"line\\nbreak"')?.lexical).toBe('line\nbreak');

    const normalized = normalizeLargeRdfLiteralsForBlazegraph([
      {
        subject: 'http://example.org/escaped-controls',
        predicate: 'http://schema.org/text',
        object: escapedLiteral,
        graph: 'did:dkg:context-graph:test',
      },
    ], { maxBytes: 300, chunkMaxBytes: 120 });

    const reconstructed = reconstructChunkedTextBodies(normalized.quads, {
      subject: 'http://example.org/escaped-controls',
    });
    expect(reconstructed).toHaveLength(1);
    expect(reconstructed[0]).toMatchObject({
      lexical: 'line\nbreak '.repeat(80),
      language: 'en',
    });
  });

  it('normalizes idempotently and keeps generated literals below the safe limit', () => {
    const oversized = JSON.stringify('x'.repeat(1_000));
    const first = normalizeLargeRdfLiteralsForBlazegraph([
      {
        subject: 'http://example.org/idempotent',
        predicate: 'https://schema.org/text',
        object: oversized,
        graph: 'did:dkg:context-graph:test',
      },
    ], { maxBytes: 200, chunkMaxBytes: 100 });
    const second = normalizeLargeRdfLiteralsForBlazegraph(first.quads, { maxBytes: 200, chunkMaxBytes: 100 });

    expect(second.rewrites).toHaveLength(0);
    expect(second.quads).toEqual(first.quads);
    expect(first.quads.every((quad) => {
      const bytes = rdfLiteralTermMutf8ByteLength(quad.object);
      return bytes === undefined || bytes <= 200;
    })).toBe(true);
  });

  it('keeps same-subject http and https schema:text bodies distinct', () => {
    const object = JSON.stringify('shared body '.repeat(120));
    const normalized = normalizeLargeRdfLiteralsForBlazegraph([
      {
        subject: 'http://example.org/dual',
        predicate: 'http://schema.org/text',
        object,
        graph: 'did:dkg:context-graph:test',
      },
      {
        subject: 'http://example.org/dual',
        predicate: 'https://schema.org/text',
        object,
        graph: 'did:dkg:context-graph:test',
      },
    ], { maxBytes: 400, chunkMaxBytes: 180 });

    expect(normalized.rewrites).toHaveLength(2);
    expect(new Set(normalized.rewrites.map((rewrite) => rewrite.bodySubject)).size).toBe(2);
    expect(reconstructChunkedTextBodies(normalized.quads, {
      subject: 'http://example.org/dual',
      sourcePredicate: 'http://schema.org/text',
    })).toHaveLength(1);
    expect(reconstructChunkedTextBodies(normalized.quads, {
      subject: 'http://example.org/dual',
      sourcePredicate: 'https://schema.org/text',
    })).toHaveLength(1);
  });

  it('uses canonical literal hashes so escaped source forms reconstruct', () => {
    const escaped = `"${'\\u0061'.repeat(260)}"`;
    const normalized = normalizeLargeRdfLiteralsForBlazegraph([
      {
        subject: 'http://example.org/escaped',
        predicate: 'http://schema.org/text',
        object: escaped,
        graph: 'did:dkg:context-graph:test',
      },
    ], { maxBytes: 600, chunkMaxBytes: 120 });

    const reconstructed = reconstructChunkedTextBodies(normalized.quads, {
      subject: 'http://example.org/escaped',
    });
    expect(reconstructed).toHaveLength(1);
    expect(reconstructed[0].lexical).toBe('a'.repeat(260));
    expect(reconstructed[0].literalTerm).toBe(JSON.stringify('a'.repeat(260)));
  });

  it('preserves xsd:string metadata but rejects arbitrary typed oversized text', () => {
    const body = 'typed text '.repeat(100);
    const typedString = `${JSON.stringify(body)}^^<${XSD_STRING_IRI}>`;
    const normalized = normalizeLargeRdfLiteralsForBlazegraph([
      {
        subject: 'http://example.org/typed',
        predicate: 'http://schema.org/text',
        object: typedString,
        graph: 'did:dkg:context-graph:test',
      },
    ], { maxBytes: 250, chunkMaxBytes: 100 });
    expect(reconstructChunkedTextBodies(normalized.quads)[0]).toMatchObject({
      datatype: XSD_STRING_IRI,
      literalTerm: typedString,
    });

    const arbitraryTyped = `${JSON.stringify(body)}^^<http://example.org/CustomType>`;
    expect(() =>
      normalizeLargeRdfLiteralsForBlazegraph([
        {
          subject: 'http://example.org/custom',
          predicate: 'http://schema.org/text',
          object: arbitraryTyped,
          graph: 'did:dkg:context-graph:test',
        },
      ], { maxBytes: 250, chunkMaxBytes: 100 }),
    ).toThrow(/Blazegraph-compatible safe limit/);
  });

  it('rejects oversized non-text literals and unsafe chunk subjects', () => {
    const oversized = JSON.stringify('x'.repeat(500));
    expect(() =>
      normalizeLargeRdfLiteralsForBlazegraph([
        {
          subject: 'http://example.org/name',
          predicate: 'http://schema.org/name',
          object: oversized,
          graph: 'did:dkg:context-graph:test',
        },
      ], { maxBytes: 200 }),
    ).toThrow(/Blazegraph-compatible safe limit/);

    expect(() =>
      normalizeLargeRdfLiteralsForBlazegraph([
        {
          subject: '_:blank',
          predicate: 'http://schema.org/text',
          object: oversized,
          graph: 'did:dkg:context-graph:test',
        },
      ], { maxBytes: 200 }),
    ).toThrow(/Blazegraph-compatible safe limit/);
  });

  it('detects corrupt chunk metadata during reconstruction', () => {
    const normalized = normalizeLargeRdfLiteralsForBlazegraph([
      {
        subject: 'http://example.org/corrupt',
        predicate: 'http://schema.org/text',
        object: JSON.stringify('z'.repeat(500)),
        graph: 'did:dkg:context-graph:test',
      },
    ], { maxBytes: 200, chunkMaxBytes: 100 });
    const withoutOneChunk = normalized.quads.filter((quad) => quad.predicate !== DKG_HAS_TEXT_CHUNK || !quad.object.endsWith('/chunk-1'));
    expect(() => reconstructChunkedTextBodies(withoutOneChunk)).toThrow(/expected .* chunks/);

    const withoutCount = normalized.quads.filter((quad) => quad.predicate !== 'http://dkg.io/ontology/textChunkCount');
    expect(() => reconstructChunkedTextBodies(withoutCount)).toThrow(/missing chunk count/);

    const withoutHash = normalized.quads.filter((quad) => quad.predicate !== DKG_TEXT_CONTENT_SHA256);
    expect(() => reconstructChunkedTextBodies(withoutHash)).toThrow(/missing content hash/);

    const withBadHash = normalized.quads.map((quad) =>
      quad.predicate === DKG_TEXT_CONTENT_SHA256 || quad.predicate === DKG_TEXT_LITERAL_TERM_SHA256
        ? { ...quad, object: '"bad"' }
        : quad
    );
    expect(() => reconstructChunkedTextBodies(withBadHash)).toThrow(/hash mismatch/);
  });

  it('parses RDF literal suffixes supported by the chunker', () => {
    expect(parseRdfLiteralTerm('"hello"')?.lexical).toBe('hello');
    expect(parseRdfLiteralTerm('"hello"@en-US')?.language).toBe('en-US');
    expect(parseRdfLiteralTerm(`"hello"^^<${XSD_STRING_IRI}>`)?.datatype).toBe(XSD_STRING_IRI);
  });
});
