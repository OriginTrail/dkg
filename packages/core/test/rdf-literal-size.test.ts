import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DKG_CHUNK_INDEX,
  DKG_CHUNK_VALUE,
  DKG_HAS_TEXT_BODY,
  DKG_HAS_TEXT_CHUNK,
  DKG_RDF_LITERAL_SAFE_MUTF8_BYTES,
  DKG_TEXT_CHUNK_COUNT,
  DKG_TEXT_CONTENT_SHA256,
  DKG_TEXT_DATATYPE,
  DKG_TEXT_LANGUAGE,
  DKG_TEXT_LITERAL_TERM_SHA256,
  DKG_TEXT_SOURCE_PREDICATE,
  OVERSIZED_RDF_LITERAL_ERROR_CODE,
  XSD_STRING_IRI,
  assertQuadLiteralsMutf8Safe,
  assertRdfLiteralMutf8Safe,
  javaModifiedUtf8ByteLength,
  normalizeLargeRdfLiteralsForBlazegraph,
  parseRdfLiteralTerm,
  rdfLiteralTermMutf8ByteLength,
  type QuadLiteralLike,
} from '../src/rdf-literal-size.js';

interface ReconstructedChunkedTextBody {
  readonly subject: string;
  readonly bodySubject: string;
  readonly sourcePredicate: string;
  readonly lexical: string;
  readonly literalTerm: string;
  readonly chunkCount: number;
  readonly lexicalSha256: string;
  readonly literalTermSha256: string;
  readonly language?: string;
  readonly datatype?: string;
}

function reconstructChunkedTextBodies(
  quads: readonly QuadLiteralLike[],
  options: { subject?: string; bodySubject?: string; sourcePredicate?: string } = {},
): ReconstructedChunkedTextBody[] {
  const bySubject = indexQuadsBySubject(quads);
  const bodyLinks = quads.filter((q) =>
    q.predicate === DKG_HAS_TEXT_BODY &&
    (!options.subject || q.subject === options.subject) &&
    (!options.bodySubject || q.object === options.bodySubject)
  );
  const explicitBody = options.bodySubject && bodyLinks.length === 0
    ? [{ subject: findOwnerSubject(quads, options.bodySubject), object: options.bodySubject }]
    : [];
  const bodies = [...bodyLinks, ...explicitBody];
  const reconstructed: ReconstructedChunkedTextBody[] = [];

  for (const link of bodies) {
    const bodySubject = link.object;
    const bodyQuads = bySubject.get(bodySubject) ?? [];
    const sourcePredicate = iriObject(bodyQuads, DKG_TEXT_SOURCE_PREDICATE);
    if (!sourcePredicate) throw new Error(`Chunked text body ${bodySubject} is missing source predicate`);
    if (options.sourcePredicate && sourcePredicate !== options.sourcePredicate) continue;

    const count = integerObject(bodyQuads, DKG_TEXT_CHUNK_COUNT);
    if (count === undefined) throw new Error(`Chunked text body ${bodySubject} is missing chunk count`);
    const lexicalSha256 = literalObject(bodyQuads, DKG_TEXT_CONTENT_SHA256);
    if (!lexicalSha256) throw new Error(`Chunked text body ${bodySubject} is missing content hash`);
    const literalTermSha256 = literalObject(bodyQuads, DKG_TEXT_LITERAL_TERM_SHA256);
    if (!literalTermSha256) throw new Error(`Chunked text body ${bodySubject} is missing literal term hash`);
    const language = literalObject(bodyQuads, DKG_TEXT_LANGUAGE);
    const datatype = iriObject(bodyQuads, DKG_TEXT_DATATYPE);
    const chunkSubjects = bodyQuads.filter((q) => q.predicate === DKG_HAS_TEXT_CHUNK).map((q) => q.object);
    if (chunkSubjects.length !== count) {
      throw new Error(`Chunked text body ${bodySubject} expected ${count} chunks but found ${chunkSubjects.length}`);
    }

    const chunks = chunkSubjects.map((chunkSubject) => {
      const chunkQuads = bySubject.get(chunkSubject) ?? [];
      const index = integerObject(chunkQuads, DKG_CHUNK_INDEX);
      if (index === undefined) throw new Error(`Chunk ${chunkSubject} is missing chunkIndex`);
      const valueTerm = literalTermObject(chunkQuads, DKG_CHUNK_VALUE);
      if (!valueTerm) throw new Error(`Chunk ${chunkSubject} is missing chunkValue`);
      const parsed = parseRdfLiteralTerm(valueTerm);
      if (!parsed) throw new Error(`Chunk ${chunkSubject} has invalid chunkValue`);
      return { index, lexical: parsed.lexical };
    }).sort((a, b) => a.index - b.index);

    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i]!.index !== i) {
        throw new Error(`Chunked text body ${bodySubject} has non-contiguous chunk index ${chunks[i]!.index}`);
      }
    }

    const lexical = chunks.map((chunk) => chunk.lexical).join('');
    const suffix = suffixFromMetadata(language, datatype);
    const literalTerm = rdfLiteralTerm(lexical, suffix);
    if (sha256Hex(lexical) !== lexicalSha256) {
      throw new Error(`Chunked text body ${bodySubject} content hash mismatch`);
    }
    if (sha256Hex(literalTerm) !== literalTermSha256) {
      throw new Error(`Chunked text body ${bodySubject} literal term hash mismatch`);
    }

    reconstructed.push({
      subject: link.subject,
      bodySubject,
      sourcePredicate,
      lexical,
      literalTerm,
      chunkCount: chunks.length,
      lexicalSha256,
      literalTermSha256,
      ...(language !== undefined ? { language } : {}),
      ...(datatype !== undefined ? { datatype } : {}),
    });
  }

  return reconstructed;
}

function indexQuadsBySubject(quads: readonly QuadLiteralLike[]): Map<string, QuadLiteralLike[]> {
  const map = new Map<string, QuadLiteralLike[]>();
  for (const quad of quads) {
    const list = map.get(quad.subject);
    if (list) list.push(quad);
    else map.set(quad.subject, [quad]);
  }
  return map;
}

function findOwnerSubject(quads: readonly QuadLiteralLike[], bodySubject: string): string {
  return quads.find((q) => q.predicate === DKG_HAS_TEXT_BODY && q.object === bodySubject)?.subject ?? '';
}

function literalTermObject(quads: readonly QuadLiteralLike[], predicate: string): string | undefined {
  const object = quads.find((q) => q.predicate === predicate)?.object;
  return object?.startsWith('"') ? object : undefined;
}

function literalObject(quads: readonly QuadLiteralLike[], predicate: string): string | undefined {
  const term = literalTermObject(quads, predicate);
  if (!term) return undefined;
  const parsed = parseRdfLiteralTerm(term);
  return parsed?.lexical;
}

function iriObject(quads: readonly QuadLiteralLike[], predicate: string): string | undefined {
  const object = quads.find((q) => q.predicate === predicate)?.object;
  return object && !object.startsWith('"') ? object : undefined;
}

function integerObject(quads: readonly QuadLiteralLike[], predicate: string): number | undefined {
  const value = literalObject(quads, predicate);
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  return Number(value);
}

function suffixFromMetadata(language?: string, datatype?: string): string {
  if (language) return `@${language}`;
  if (datatype) return `^^<${datatype}>`;
  return '';
}

function rdfLiteralTerm(lexical: string, suffix = ''): string {
  return `${JSON.stringify(lexical)}${suffix}`;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

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
