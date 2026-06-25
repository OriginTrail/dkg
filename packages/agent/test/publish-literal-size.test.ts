import { describe, expect, it, vi } from 'vitest';
import {
  DKG_CHUNK_VALUE,
  DKG_HAS_TEXT_BODY,
  normalizeLargeRdfLiteralsForBlazegraph,
} from '@origintrail-official/dkg-core';
import { canonicalPublishPayload } from '@origintrail-official/dkg-publisher';
import { PublishMethods } from '../src/dkg-agent-publish.js';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';

const OVERSIZED_TEXT_QUAD: Quad = {
  subject: 'http://example.org/root',
  predicate: 'http://schema.org/text',
  object: `"${'x'.repeat(60_000)}"`,
  graph: 'http://example.org/graph',
};

const OVERSIZED_NAME_QUAD: Quad = {
  ...OVERSIZED_TEXT_QUAD,
  predicate: 'http://schema.org/name',
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

  it('chunks publishAsync public schema:text before workspace staging', async () => {
    const writeToWorkspace = vi.fn(async () => ({
      shareOperationId: 'swm-test',
      message: new Uint8Array([1, 2, 3]),
    }));
    const agentStub = {
      contextGraphExists: vi.fn(async () => true),
      publisher: {
        writeToWorkspace,
      },
      peerId: 'peer-test',
      store: new OxigraphStore(),
      log: {
        warn: vi.fn(),
      },
      buildAsyncLiftSeal: vi.fn(async () => undefined),
    };

    const result = await PublishMethods.prototype.publishAsync.call(
      agentStub as never,
      'computer-history',
      {
        publicQuads: [OVERSIZED_TEXT_QUAD],
        privateQuads: [],
      },
      { localOnly: true },
    );

    expect(result.captureID).toEqual(expect.any(String));
    const stagedQuads = writeToWorkspace.mock.calls[0]?.[1] as Quad[];
    expect(stagedQuads.some((quad) =>
      quad.subject === OVERSIZED_TEXT_QUAD.subject &&
      quad.predicate === 'http://schema.org/text'
    )).toBe(false);
    expect(stagedQuads.some((quad) =>
      quad.subject === OVERSIZED_TEXT_QUAD.subject &&
      quad.predicate === DKG_HAS_TEXT_BODY
    )).toBe(true);
    expect(stagedQuads.some((quad) => quad.predicate === DKG_CHUNK_VALUE)).toBe(true);
  });

  it('rejects direct publish non-text quads before chain or publisher work', async () => {
    const agentStub = {
      log: { info: vi.fn() },
    };

    await expect(
      PublishMethods.prototype._publish.call(
        agentStub as never,
        'computer-history',
        [OVERSIZED_NAME_QUAD],
      ),
    ).rejects.toMatchObject({
      code: 'OVERSIZED_RDF_LITERAL',
      actualBytes: 60_002,
      maxBytes: 60_000,
      predicate: 'http://schema.org/name',
    });
  });

  it('builds selection precomputed attestations over chunked public text quads', async () => {
    const authorAddress = '0x000000000000000000000000000000000000dEaD';
    const agentStub = {
      chain: {
        getEvmChainId: vi.fn(async () => 31337n),
        getKnowledgeAssetsLifecycleAddress: vi.fn(async () => '0x000000000000000000000000000000000000c0de'),
      },
      getContextGraphOnChainId: vi.fn(async () => 42n),
      isPrivateContextGraph: vi.fn(async () => false),
      publisher: {
        publisherFallbackAuthorAddress: vi.fn(async () => authorAddress),
        signAuthorAttestationAsPublisher: vi.fn(async () => ({
          r: new Uint8Array(32).fill(1),
          vs: new Uint8Array(32).fill(2),
        })),
      },
      kaNumberAllocator: {
        reconcile: vi.fn(),
        markReconciled: vi.fn(),
        allocate: vi.fn(() => ({ number: 7n })),
      },
      reconciledKaAuthors: new Set<string>(),
    };

    const attestation =
      await PublishMethods.prototype._buildPrecomputedAttestationForSelection.call(
        agentStub as never,
        'computer-history',
        [OVERSIZED_TEXT_QUAD],
      );

    const chunkedQuads = normalizeLargeRdfLiteralsForBlazegraph(
      [OVERSIZED_TEXT_QUAD],
      { label: 'test.expected' },
    ).quads.map((quad) => ({ ...quad, graph: quad.graph ?? '' }));
    const expectedChunkedRoot = canonicalPublishPayload(chunkedQuads, []).kcMerkleRoot;
    const unchunkedRoot = canonicalPublishPayload([OVERSIZED_TEXT_QUAD], []).kcMerkleRoot;

    expect(Array.from(attestation?.expectedMerkleRoot ?? [])).toEqual(Array.from(expectedChunkedRoot));
    expect(Array.from(attestation?.expectedMerkleRoot ?? [])).not.toEqual(Array.from(unchunkedRoot));
  });
});
