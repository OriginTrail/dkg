import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  MockChainAdapter,
  type TxResult,
  type V10UpdateKAParams,
} from '@origintrail-official/dkg-chain';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { buildUpdateSeal, mockSealCtx } from './_helpers/seal.js';

// A definitive submit-time revert (KnowledgeAssetExpired / immutable / batch
// size) surfaces from KnowledgeAssetsLifecycle at update SUBMIT — never from
// the pre-staging ownerOf check — so update() must convert it to a failed
// result (not throw, not mutate). These cases can't be reached with the shared
// Hardhat harness without epoch time-travel, so drive the submit path with a
// MockChainAdapter that passes the pre-staging owner check and then rejects the
// broadcast. Mirrors the ProducerUpdateChain pattern in ka-graph-update-ack.

const PRODUCER = new ethers.Wallet(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const AUTHOR = PRODUCER.address;
const KA_ID = (BigInt(AUTHOR) << 96n) | 7n;
const CG_ID = '42';
const DATA_GRAPH = `did:dkg:context-graph:${CG_ID}`;

/** revert-shaped error whose `.name` `extractV10UpdateRejectionName` reads. */
function revertError(name: string): Error {
  return Object.assign(new Error(`execution reverted: ${name}`), {
    revert: { name },
  });
}

class SubmitRejectChain extends MockChainAdapter {
  constructor(private readonly rejectWith: string) {
    super('mock:31337', AUTHOR);
  }

  // Pre-staging owner check passes: the KA exists and the author owns it.
  override async getKnowledgeAssetOwner(kaId: bigint): Promise<string> {
    if (kaId === KA_ID) return ethers.getAddress(AUTHOR);
    return super.getKnowledgeAssetOwner(kaId);
  }

  // Definitive rejection at submit.
  override async updateKnowledgeCollectionV10(
    _params: V10UpdateKAParams,
  ): Promise<TxResult> {
    throw revertError(this.rejectWith);
  }
}

describe('publisher.update() definitive submit-rejection handling', () => {
  async function update(rejectWith: string) {
    const store = new OxigraphStore();
    const publisher = new DKGPublisher({
      store,
      chain: new SubmitRejectChain(rejectWith),
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
      publisherPrivateKey: PRODUCER.privateKey,
      publisherNodeIdentityId: 1n,
    });
    const quads: Quad[] = [
      { subject: 'urn:atomic', predicate: 'http://schema.org/name', object: '"v2"', graph: DATA_GRAPH },
    ];
    const precomputedUpdateAttestation = await buildUpdateSeal({
      kaId: KA_ID,
      quads,
      author: PRODUCER,
      ctx: mockSealCtx(),
    });
    return {
      store,
      result: () => publisher.update(KA_ID, {
        contextGraphId: CG_ID,
        quads,
        precomputedUpdateAttestation,
      }),
    };
  }

  it('maps KnowledgeAssetExpired at submit to a failed result without mutating the store', async () => {
    const { store, result } = await update('KnowledgeAssetExpired');
    const res = await result();
    expect(res.status).toBe('failed');
    expect(res.onChainResult).toBeUndefined();
    // No local write: the KA was rejected on chain, so nothing lands locally.
    const rows = await store.query(
      `SELECT ?o WHERE { GRAPH ?g { <urn:atomic> <http://schema.org/name> ?o } }`,
    );
    expect(rows.type === 'bindings' ? rows.bindings.length : -1).toBe(0);
  });

  it('maps CannotUpdateImmutableKnowledgeAsset at submit to a failed result', async () => {
    const { result } = await update('CannotUpdateImmutableKnowledgeAsset');
    const res = await result();
    expect(res.status).toBe('failed');
  });

  it('rethrows a non-definitive submit rejection (teeth: only the definitive set is failed-mapped)', async () => {
    const { result } = await update('SomeTransientChainHiccup');
    await expect(result()).rejects.toThrow(/SomeTransientChainHiccup/);
  });
});
