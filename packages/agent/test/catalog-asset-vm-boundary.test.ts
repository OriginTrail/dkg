import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryLayer, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri,
  type AuthorCatalogScopeV1,
  type AssertionCoordinateV1,
} from '@origintrail-official/dkg-core';
import { generateGraphKnowledgeAssetMetadata } from '@origintrail-official/dkg-publisher';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { assertCatalogAssetVmBoundaryV1 } from '../src/internal/catalog-asset-revision.js';
import { AUTHOR, CONTEXT_GRAPH_ID, NETWORK_ID, authorSealV1 } from './support/rfc64-local-catalog-repair-fixture.js';

const scope = { networkId: NETWORK_ID, contextGraphId: CONTEXT_GRAPH_ID,
  governanceChainId: null, governanceContractAddress: null, ownershipTransitionDigest: null,
  subGraphName: null, authorAddress: AUTHOR, era: '0', bucketCount: '1',
} as AuthorCatalogScopeV1;
const stores: OxigraphStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });

async function fixture(version = '1') {
  const store = new OxigraphStore(); stores.push(store);
  const seal = await authorSealV1(1n, version);
  const asset = { assertionCoordinate: 'revision' as AssertionCoordinateV1, seal, projectionBytes: new Uint8Array() };
  const check = (required = false) => assertCatalogAssetVmBoundaryV1(store, scope, asset, required);
  const confirmed = async (changes: Record<string, unknown> = {}) => {
    const assertionVersion = String(changes.assertionVersion ?? version);
    const metadata = generateGraphKnowledgeAssetMetadata({ contextGraphId: CONTEXT_GRAPH_ID,
      ual: seal.kaUal, merkleRoot: ethers.getBytes(seal.assertionMerkleRoot),
      publisherPeerId: 'confirmed', accessPolicy: 'public', allowedPeers: [],
      timestamp: new Date(seal.assertionFinalizedAt), assertionVersion, authorAddress: AUTHOR,
      publicTripleCount: Number(seal.publicTripleCount), privateTripleCount: 0,
      assertionGraph: knowledgeAssetLayerGraphUri(CONTEXT_GRAPH_ID, MemoryLayer.VerifiableMemory,
        createGraphKnowledgeAssetScope(seal.kaUal, assertionVersion)), ...changes,
    }, { status: 'confirmed', confirmation: { kind: 'finalized-materialization', provenance: {
      batchId: BigInt(seal.reservedKaId), materializedVersion: { blockNumber: 124, txIndex: 0 },
    } } });
    await store.insert(metadata);
  };
  return { store, asset, check, confirmed };
}

describe('catalog VM content boundary', () => {
  it('permits an unpublished inventory draft, but absence cannot authorize a confirmed same-version replacement', async () => {
    const f = await fixture();
    await expect(f.check()).resolves.toBeUndefined();
    await expect(f.check(true)).rejects.toMatchObject({ kind: 'version_conflict' });
  });

  it('permits the exact confirmed content including a same-version replacement', async () => {
    const f = await fixture(); await f.confirmed();
    await expect(f.check(true)).resolves.toBeUndefined();
  });

  it.each([
    { merkleRoot: new Uint8Array(32) }, { publicTripleCount: 3 },
    { privateTripleCount: 1, privateMerkleRoot: new Uint8Array(32) },
  ])('rejects contradictory confirmed content %j', async changes => {
    const f = await fixture(); await f.confirmed(changes);
    await expect(f.check()).rejects.toThrow();
    await expect(f.check(true)).rejects.toThrow();
  });

  it('allows a later unpublished draft but never restores an older version over VM', async () => {
    const later = await fixture('2'); await later.confirmed({ assertionVersion: '1' });
    await expect(later.check()).resolves.toBeUndefined();
    await expect(later.check(true)).rejects.toMatchObject({ kind: 'version_conflict' });
    const older = await fixture('1'); await older.confirmed({ assertionVersion: '2' });
    await expect(older.check()).rejects.toMatchObject({ kind: 'version_conflict' });
  });

  it('does not turn a failed metadata read into absence', async () => {
    const f = await fixture(), unavailable = new Error('store unavailable');
    vi.spyOn(f.store, 'query').mockRejectedValue(unavailable);
    await expect(f.check()).rejects.toBe(unavailable);
  });

  it('fails closed on contradictory metadata instead of treating it as an unpublished draft', async () => {
    const f = await fixture(); await f.confirmed();
    await f.store.insert([{ graph: `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_meta`,
      subject: f.asset.seal.kaUal, predicate: 'http://dkg.io/ontology/merkleRoot', object: '"another-root"' }]);
    await expect(f.check()).rejects.toThrow('ambiguous VM metadata');
  });
});
