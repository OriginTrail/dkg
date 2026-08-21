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
      resolveAgentAddress: () => '0xNODE',
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
    const agentStub = { contextGraphExists, resolveAgentAddress: () => '0xNODE' };
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

  it('cannot be redirected by an admission whose fields change between reads', async () => {
    // 3830105265 — the admission object is caller-owned and may expose getters or be a Proxy. When
    // the guard and the resolver each read it, a value that answers 'node' once and 'agent' after
    // slipped an empty owner past the non-blank check. Every field is snapshotted once now, so a
    // shifting object either fails validation or is pinned to whatever the FIRST read returned.
    const contextGraphExists = vi.fn(async () => true);
    const agentStub = { contextGraphExists, resolveAgentAddress: () => '0xNODE' };

    let kindReads = 0;
    const shifting = {
      get kind() { return ++kindReads === 1 ? 'node' : 'agent'; },
      get agentAddress() { return '   '; },
    };
    await PublishMethods.prototype.publishAsync.call(
      agentStub as never,
      shifting as never,
      'computer-history',
      { publicQuads: [], privateQuads: [OVERSIZED_TEXT_QUAD] } as never,
    ).catch(() => undefined);
    // The invariant is the single read. Pinned to its first answer the object IS valid node
    // admission, so it proceeds — what must never happen is the guard seeing 'node' and the
    // resolver then seeing 'agent' with a blank address, which needs a SECOND read to occur.
    expect(kindReads).toBe(1);

    // The mirror case: an object that starts as a valid agent and then blanks itself is pinned to
    // the identity that was validated, never to the later blank.
    let addressReads = 0;
    const decaying = {
      kind: 'agent',
      get agentAddress() { return ++addressReads === 1 ? '0xSUBMITTER' : '   '; },
    };
    await expect(
      PublishMethods.prototype.publishAsync.call(
        agentStub as never,
        decaying as never,
        'computer-history',
        { publicQuads: [], privateQuads: [OVERSIZED_TEXT_QUAD] } as never,
      ),
    ).rejects.toMatchObject({ code: 'OVERSIZED_RDF_LITERAL' });
    // Admission resolved (it got past the gate to the literal check) reading the address ONCE.
    expect(addressReads).toBe(1);
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
