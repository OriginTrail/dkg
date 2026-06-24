import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BLAZEGRAPH_SAFE_LITERAL_MUTF8_BYTES,
  DKG_CHUNK_INDEX,
  DKG_HAS_TEXT_BODY,
  DKG_HAS_TEXT_CHUNK,
  DKG_TEXT_CHUNK_COUNT,
  DKG_TEXT_CONTENT_SHA256,
  javaModifiedUtf8Length,
  normalizeLargeRdfLiteralsForBlazegraph,
  parseRdfLiteralTerm,
  RdfLiteralSizeError,
} from '../src/rdf-literal-limits.js';

describe('RDF literal Blazegraph compatibility', () => {
  it('measures Java modified UTF-8 length', () => {
    expect(javaModifiedUtf8Length('abc')).toBe(3);
    expect(javaModifiedUtf8Length('\0')).toBe(2);
    expect(javaModifiedUtf8Length('é')).toBe(2);
    expect(javaModifiedUtf8Length('😀')).toBe(6);
  });

  it('chunks oversized schema:text literals into ordered safe child resources', () => {
    const body = `${'x'.repeat(35)}\n"${'😀'.repeat(10)}\\${'y'.repeat(35)}`;
    const result = normalizeLargeRdfLiteralsForBlazegraph([
      {
        subject: 'urn:dkg:test:computer-history',
        predicate: 'http://schema.org/text',
        object: JSON.stringify(body),
        graph: 'did:dkg:context-graph:0x599BF63E/computer-history',
      },
    ], {
      maxLiteralMutf8Bytes: 90,
      textChunkMutf8Bytes: 48,
    });

    expect(result.rewrites).toHaveLength(1);
    expect(result.rewrites[0].chunkCount).toBeGreaterThan(1);
    expect(result.quads.some((q) => q.predicate === 'http://schema.org/text' && q.subject === 'urn:dkg:test:computer-history')).toBe(false);

    const bodySubject = result.quads.find((q) => q.predicate === DKG_HAS_TEXT_BODY)?.object;
    expect(bodySubject).toMatch(/^urn:dkg:test:computer-history\/\.well-known\/genid\/text-/);

    const count = result.quads.find((q) => q.subject === bodySubject && q.predicate === DKG_TEXT_CHUNK_COUNT)?.object;
    expect(count).toBe(`"${result.rewrites[0].chunkCount}"^^<http://www.w3.org/2001/XMLSchema#integer>`);

    const sha = result.quads.find((q) => q.subject === bodySubject && q.predicate === DKG_TEXT_CONTENT_SHA256)?.object;
    expect(sha).toBe(JSON.stringify(createHash('sha256').update(body, 'utf8').digest('hex')));

    const chunkSubjects = result.quads
      .filter((q) => q.subject === bodySubject && q.predicate === DKG_HAS_TEXT_CHUNK)
      .map((q) => q.object);
    const reconstructed = chunkSubjects
      .map((chunkSubject) => {
        const indexLiteral = result.quads.find((q) => q.subject === chunkSubject && q.predicate === DKG_CHUNK_INDEX)?.object;
        const index = Number(indexLiteral?.match(/\d+/)?.[0] ?? 'NaN');
        const text = result.quads.find((q) => q.subject === chunkSubject && q.predicate === 'http://schema.org/text')?.object;
        expect(text).toBeDefined();
        expect(javaModifiedUtf8Length(text!)).toBeLessThanOrEqual(48);
        return { index, text: parseRdfLiteralTerm(text!)!.lexical };
      })
      .sort((a, b) => a.index - b.index)
      .map((chunk) => chunk.text)
      .join('');

    expect(reconstructed).toBe(body);
  });

  it('rejects oversized non-text literals before publishing', () => {
    expect(() =>
      normalizeLargeRdfLiteralsForBlazegraph([
        {
          subject: 'urn:dkg:test:bad',
          predicate: 'http://schema.org/name',
          object: JSON.stringify('x'.repeat(BLAZEGRAPH_SAFE_LITERAL_MUTF8_BYTES + 1)),
          graph: 'did:dkg:context-graph:test',
        },
      ]),
    ).toThrow(RdfLiteralSizeError);
  });
});
