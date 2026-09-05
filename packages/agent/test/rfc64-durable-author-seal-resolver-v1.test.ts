import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  buildAssertionSealQuads,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  type ContextGraphIdV1,
} from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';

import { resolveDurableGraphScopedAuthorSealCandidateV1 } from
  '../src/durable-author-seal-resolver-v1.js';

const WALLET = new ethers.Wallet(`0x${'66'.repeat(32)}`);
const CHECKSUMMED_AUTHOR = WALLET.address;
const LOWERCASE_AUTHOR = CHECKSUMMED_AUTHOR.toLowerCase();
const CONTEXT_GRAPH_ID = 'resolver-case' as ContextGraphIdV1;
const ASSERTION_COORDINATE = 'asset';
const META_GRAPH = contextGraphMetaUri(CONTEXT_GRAPH_ID);
const KA_NUMBER = 7n;

function sealQuads(authorSpelling: string): Quad[] {
  const assertionUri = contextGraphAssertionUri(
    CONTEXT_GRAPH_ID,
    authorSpelling,
    ASSERTION_COORDINATE,
  );
  return buildAssertionSealQuads({
    assertionUri,
    metaGraph: META_GRAPH,
    merkleRoot: new Uint8Array(32).fill(0xab),
    authorAddress: CHECKSUMMED_AUTHOR,
    authorAttestationR: new Uint8Array(32).fill(0x11),
    authorAttestationVS: new Uint8Array(32).fill(0x22),
    authorSchemeVersion: 1,
    chainId: 20430n,
    kav10Address: '0x1234567890123456789012345678901234567890',
    reservedKaId: (BigInt(LOWERCASE_AUTHOR) << 96n) | KA_NUMBER,
    finalizedAtIso: '2026-09-01T00:00:00.000Z',
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: `did:dkg:20430/${LOWERCASE_AUTHOR}/${KA_NUMBER}`,
    assertionVersion: 1n,
    publicTripleCount: 1,
    privateTripleCount: 0,
  }) as Quad[];
}

function storeReturning(quads: readonly Quad[]): TripleStore {
  return {
    query: vi.fn(async () => ({ type: 'quads' as const, quads })),
  } as unknown as TripleStore;
}

function resolve(quads: readonly Quad[]) {
  return resolveDurableGraphScopedAuthorSealCandidateV1({
    store: storeReturning(quads),
    contextGraphId: CONTEXT_GRAPH_ID,
    agentAddress: LOWERCASE_AUTHOR,
    assertionCoordinate: ASSERTION_COORDINATE,
    source: 'test.rfc64.durable-author-seal-resolver',
  });
}

describe('RFC-64 durable author seal resolver', () => {
  it.each([
    ['lowercase', LOWERCASE_AUTHOR],
    ['checksummed', CHECKSUMMED_AUTHOR],
  ])('accepts one valid %s assertion subject', async (_label, authorSpelling) => {
    const candidate = await resolve(sealQuads(authorSpelling));
    expect(candidate?.coordinate.agentAddress).toBe(authorSpelling);
    expect(candidate?.seal.authorAddress).toBe(CHECKSUMMED_AUTHOR);
  });

  it('fails closed when both equivalent case-sensitive subjects are valid', async () => {
    await expect(resolve([
      ...sealQuads(LOWERCASE_AUTHOR),
      ...sealQuads(CHECKSUMMED_AUTHOR),
    ])).rejects.toThrow('durable assertion has ambiguous author seal subjects');
  });
});
