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
      getDefaultAgentAddress: () => '0xNODE',
    };

    await expect(
      PublishMethods.prototype.publishAsync.call(
        agentStub as never,
        { kind: 'node' },
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

  it('rejects a malformed admission before any staging, and never falls back to the node', async () => {
    // 3829496422 — the union is erased at runtime, so a JavaScript plugin can present an unknown
    // kind. Reading "not 'agent'" as node admission would silently rebuild the ownership defect
    // this parameter exists to prevent, and a blank identity must not become the node owner.
    // Rejection happens BEFORE any workspace work: `contextGraphExists` is the first thing the
    // publish path touches, so it not being called is the evidence nothing was staged.
    const contextGraphExists = vi.fn(async () => true);
    const agentStub = { contextGraphExists, getDefaultAgentAddress: () => '0xNODE' };
    const content = { publicQuads: [], privateQuads: [] };

    for (const bad of [
      { kind: 'agnt', agentAddress: '0xSUBMITTER' },  // typo: must NOT become node-owned
      { kind: 'agent' },                              // no address
      { kind: 'agent', agentAddress: '' },            // blank
      { kind: 'agent', agentAddress: '   ' },         // whitespace only
      { kind: 'agent', agentAddress: null },          // wrong type, and used to throw late
      {},                                             // no kind at all
      undefined,
    ]) {
      await expect(
        PublishMethods.prototype.publishAsync.call(
          agentStub as never,
          bad as never,
          'computer-history',
          content as never,
        ),
      ).rejects.toThrow(/admission/i);
    }

    // Nothing was staged for any of them.
    expect(contextGraphExists).not.toHaveBeenCalled();
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
