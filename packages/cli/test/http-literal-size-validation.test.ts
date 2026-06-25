import { describe, expect, it } from 'vitest';
import {
  DKG_CHUNK_VALUE,
  DKG_HAS_TEXT_BODY,
} from '@origintrail-official/dkg-core';
import {
  buildImportFileResponse,
  parsePublishRequestBody,
  validateWritableQuadLiteralSizes,
} from '../src/daemon/http-utils.js';

const OVERSIZED_LITERAL = `"${'x'.repeat(60_000)}"`;

describe('HTTP RDF literal size validation', () => {
  it('normalizes oversized direct publish schema:text literals', () => {
    const parsed = parsePublishRequestBody(JSON.stringify({
      contextGraphId: 'literal-size-cg',
      quads: [{
        subject: 'http://example.org/s',
        predicate: 'http://schema.org/text',
        object: OVERSIZED_LITERAL,
        graph: 'http://example.org/g',
      }],
    }));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.literalRewrites).toHaveLength(1);
      expect(parsed.value.literalRewrites?.[0]).toMatchObject({
        subject: 'http://example.org/s',
        predicate: 'http://schema.org/text',
        originalMutf8Bytes: 60_002,
      });
      expect(parsed.value.quads.some((quad) =>
        quad.subject === 'http://example.org/s' &&
        quad.predicate === 'http://schema.org/text'
      )).toBe(false);
      expect(parsed.value.quads.some((quad) =>
        quad.subject === 'http://example.org/s' &&
        quad.predicate === DKG_HAS_TEXT_BODY
      )).toBe(true);
      expect(parsed.value.quads.some((quad) => quad.predicate === DKG_CHUNK_VALUE)).toBe(true);
    }
  });

  it('returns structured parse failure for oversized private publish literals', () => {
    const parsed = parsePublishRequestBody(JSON.stringify({
      contextGraphId: 'literal-size-cg',
      quads: [{
        subject: 'http://example.org/s',
        predicate: 'http://schema.org/name',
        object: '"safe"',
        graph: 'http://example.org/g',
      }],
      privateQuads: [{
        subject: 'http://example.org/s',
        predicate: 'http://schema.org/text',
        object: OVERSIZED_LITERAL,
        graph: 'http://example.org/g',
      }],
    }));

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.body).toMatchObject({
        code: 'OVERSIZED_RDF_LITERAL',
        actualBytes: 60_002,
        limitBytes: 60_000,
        predicate: 'http://schema.org/text',
      });
    }
  });

  it('returns structured validation failure for reject-only private/writable guards', () => {
    const result = validateWritableQuadLiteralSizes('quads', [{
      subject: 'http://example.org/s',
      predicate: 'http://schema.org/name',
      object: OVERSIZED_LITERAL,
    }]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.body).toMatchObject({
        code: 'OVERSIZED_RDF_LITERAL',
        actualBytes: 60_002,
        limitBytes: 60_000,
      });
    }
  });

  it('preserves oversized literal fields in import-file extraction responses', () => {
    expect(buildImportFileResponse({
      assertionUri: 'http://example.org/assertion',
      fileHash: '0xabc',
      detectedContentType: 'text/markdown',
      extraction: {
        status: 'failed',
        tripleCount: 1,
        pipelineUsed: 'markdown',
        error: 'RDF literal exceeds safe MUTF-8 byte limit',
        code: 'OVERSIZED_RDF_LITERAL',
        actualBytes: 60_002,
        limitBytes: 60_000,
        predicate: 'http://schema.org/text',
      },
    }).extraction).toMatchObject({
      code: 'OVERSIZED_RDF_LITERAL',
      actualBytes: 60_002,
      limitBytes: 60_000,
      predicate: 'http://schema.org/text',
    });
  });
});
