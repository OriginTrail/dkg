import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  buildAssertionSealQuads,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  contextGraphPrivateUri,
  contextGraphSubGraphPrivateUri,
  type ContextGraphIdV1,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';

import {
  resolveArchivedGraphScopedAuthorSealCandidateV1,
  resolveDurableGraphScopedAuthorSealCandidateV1,
} from '../src/durable-author-seal-resolver-v1.js';

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

describe('RFC-64 archived author seal resolver', () => {
  /** The seal as a pull-from leaves it: its predicates under the archive subject, in the private partition. */
  function archivedSealQuads(authorSpelling: string, subGraphName?: string): Quad[] {
    const assertionUri = contextGraphAssertionUri(
      CONTEXT_GRAPH_ID,
      authorSpelling,
      ASSERTION_COORDINATE,
      subGraphName,
    );
    const graph = subGraphName === undefined
      ? contextGraphPrivateUri(CONTEXT_GRAPH_ID)
      : contextGraphSubGraphPrivateUri(CONTEXT_GRAPH_ID, subGraphName);
    return sealQuads(authorSpelling).map((quad) => ({
      ...quad,
      subject: `${assertionUri}/_recovery_seal`,
      graph,
    }));
  }

  async function resolveArchived(quads: readonly Quad[], subGraphName?: string) {
    const store = new OxigraphStore();
    if (quads.length > 0) await store.insert([...quads]);
    return resolveArchivedGraphScopedAuthorSealCandidateV1({
      store,
      contextGraphId: CONTEXT_GRAPH_ID,
      agentAddress: LOWERCASE_AUTHOR,
      assertionCoordinate: ASSERTION_COORDINATE,
      ...(subGraphName === undefined ? {} : { subGraphName }),
      source: 'test.rfc64.durable-author-seal-resolver',
    });
  }

  it.each([
    ['lowercase', LOWERCASE_AUTHOR],
    ['checksummed', CHECKSUMMED_AUTHOR],
  ])('reads the seal archived under one valid %s assertion subject', async (_label, authorSpelling) => {
    const candidate = await resolveArchived(archivedSealQuads(authorSpelling));
    // The candidate is the assertion's seal, not the archive subject's.
    expect(candidate?.coordinate).toMatchObject({ agentAddress: authorSpelling, name: ASSERTION_COORDINATE });
    expect(candidate?.seal).toMatchObject({
      authorAddress: CHECKSUMMED_AUTHOR,
      kaUal: `did:dkg:20430/${LOWERCASE_AUTHOR}/${KA_NUMBER}`,
      assertionVersion: '1',
    });
  });

  it('reads the archive of a sub-graph assertion from that sub-graph\'s private partition', async () => {
    const candidate = await resolveArchived(archivedSealQuads(LOWERCASE_AUTHOR, 'notes'), 'notes');
    expect(candidate?.coordinate).toMatchObject({
      scope: `${CONTEXT_GRAPH_ID}/notes`,
      agentAddress: LOWERCASE_AUTHOR,
      name: ASSERTION_COORDINATE,
    });
    // The root partition holds nothing for it.
    await expect(resolveArchived(archivedSealQuads(LOWERCASE_AUTHOR), 'notes')).resolves.toBeUndefined();
  });

  it('answers nothing when no seal was archived, whatever the active subject holds', async () => {
    await expect(resolveArchived([])).resolves.toBeUndefined();
    // An active seal lives in the meta graph and is not an archive.
    await expect(resolveArchived(sealQuads(LOWERCASE_AUTHOR))).resolves.toBeUndefined();
    // Neither is a seal archived for a sub-graph partition when the root one is asked for.
    await expect(resolveArchived(archivedSealQuads(LOWERCASE_AUTHOR, 'notes'))).resolves.toBeUndefined();
  });

  it('fails closed when both equivalent case-sensitive archives are valid', async () => {
    await expect(resolveArchived([
      ...archivedSealQuads(LOWERCASE_AUTHOR),
      ...archivedSealQuads(CHECKSUMMED_AUTHOR),
    ])).rejects.toThrow('durable assertion has ambiguous archived author seal subjects');
  });

  it('ignores an archive that is not a complete seal', async () => {
    const torn = archivedSealQuads(LOWERCASE_AUTHOR).slice(0, 3);
    await expect(resolveArchived(torn)).resolves.toBeUndefined();
  });
});
