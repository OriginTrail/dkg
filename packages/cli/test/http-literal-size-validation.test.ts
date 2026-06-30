import { describe, expect, it } from 'vitest';
import {
  buildImportFileResponse,
  validateWritableQuadLiteralSizes,
} from '../src/daemon/http-utils.js';

const OVERSIZED_LITERAL = `"${'x'.repeat(60_000)}"`;

describe('HTTP RDF literal size validation', () => {
  it('returns structured validation failure for lifecycle writable route quads', () => {
    const result = validateWritableQuadLiteralSizes('quads', [{
      subject: 'http://example.org/s',
      predicate: 'http://schema.org/text',
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
