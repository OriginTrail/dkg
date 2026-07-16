import { describe, expect, it, vi } from 'vitest';
import { PublishMethods } from '../src/dkg-agent-publish.js';
import type { Quad } from '@origintrail-official/dkg-storage';

const OVERSIZED_TEXT_QUAD: Quad = {
  subject: 'http://example.org/root',
  predicate: 'http://schema.org/text',
  object: `"${'x'.repeat(60_000)}"`,
  graph: 'http://example.org/graph',
};

describe('agent publish literal size validation', () => {
  it('rejects publishAsync private quads before workspace staging', async () => {
    const agentStub = {
      contextGraphExists: vi.fn(async () => true),
    };

    await expect(
      PublishMethods.prototype.publishAsync.call(
        agentStub as never,
        'computer-history',
        {
          publicQuads: [],
          privateQuads: [OVERSIZED_TEXT_QUAD],
        },
      ),
    ).rejects.toMatchObject({
      code: 'OVERSIZED_RDF_LITERAL',
      actualBytes: 60_002,
      maxBytes: 60_000,
      predicate: 'http://schema.org/text',
    });
  });

  it('rejects direct publish quads before chain or publisher work', async () => {
    const agentStub = {
      log: { info: vi.fn() },
    };

    await expect(
      PublishMethods.prototype._publish.call(
        agentStub as never,
        'computer-history',
        [OVERSIZED_TEXT_QUAD],
      ),
    ).rejects.toMatchObject({
      code: 'OVERSIZED_RDF_LITERAL',
      actualBytes: 60_002,
      maxBytes: 60_000,
      predicate: 'http://schema.org/text',
    });
  });
});
