/**
 * End-to-end Random Sampling test against MockChainAdapter.
 *
 * This is the **off-chain pipeline** parity test. It pins the seam
 * between three packages:
 *
 *   dkg-publisher  →  generateKCMetadata + generateConfirmedMetadata
 *   dkg-storage    →  OxigraphStore (real triple store)
 *   dkg-random-sampling  →  extractor + builder + prover orchestrator
 *
 * If `dkg-publisher` ever drifts on a predicate name (e.g. renames
 * `dkg:batchId` to `dkg:onChainId`), this test fails loudly and the
 * extractor doesn't silently skip every period in production.
 *
 * The test uses the real metadata generators from `dkg-publisher`,
 * laid out into a real `OxigraphStore`, and drives a real
 * `RandomSamplingProver` end-to-end against the in-memory
 * `MockChainAdapter` — whose `submitProof` actually verifies the
 * submitted leaf matches the registered chunk hex. So a
 * pass here means the prover would also pass the mock's chunk
 * comparison (which mirrors what `_verifyV10MerkleProof` enforces
 * on-chain).
 *
 * Hardhat-backed e2e (real `RandomSampling.sol`) is intentionally
 * separate — see TODO `p6-hardhat-e2e`. Two layers, two costs:
 * this test runs in <1s and never flakes; the Hardhat one catches
 * Solidity-side regressions but is heavier.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  V10MerkleTree,
  hashTripleV10,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  generateConfirmedFullMetadata,
  type KCMetadata,
  type KAMetadata,
  type OnChainProvenance,
} from '@origintrail-official/dkg-publisher';
import { InMemoryProverWal, RandomSamplingProver } from '../src/index.js';

const PUBLISHER_PRIV = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // hardhat test key #1

describe('Random Sampling E2E (MockChainAdapter)', () => {
  let store: OxigraphStore;
  let chain: MockChainAdapter;
  let identityId: bigint;

  beforeEach(async () => {
    store = new OxigraphStore();
    chain = new MockChainAdapter({
      operationalKey: PUBLISHER_PRIV,
    });
    identityId = await chain.ensureProfile({ nodeName: 'rs-e2e-core' });
  });

  it('publishes a KC, registers the chain commitment, and the prover submits a valid proof', async () => {
    // 1. Build the public quads the publisher would have produced
    //    from a knowledge asset. Three triples about a single root
    //    entity — small enough that V10 sort+dedupe doesn't change
    //    leaf ordering, big enough to exercise non-trivial proofs.
    const ROOT = 'urn:experiment:wsd';
    const publishQuads: Array<{ subject: string; predicate: string; object: string }> = [
      { subject: ROOT, predicate: 'http://schema.org/name', object: '"Word Sense Disambiguation"' },
      { subject: ROOT, predicate: 'urn:exp:val_bpb', object: '"1.36"' },
      { subject: ROOT, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'urn:exp:Experiment' },
    ];

    // 2. Compute V10 leaves + merkle root + leafCount (publisher does
    //    this exact computation in `computeFlatKCRootV10`).
    const rawLeaves = publishQuads.map((q) => hashTripleV10(q.subject, q.predicate, q.object));
    const tree = new V10MerkleTree(rawLeaves);
    const merkleRoot = tree.root;
    const merkleLeafCount = tree.leafCount;

    // 3. Decide identifiers. In a real publish flow the chain mints
    //    the kcId and assigns the cgId; in the test we pick them.
    const kcId = 7n;
    const cgId = 11n;
    const cgIdStr = cgId.toString();
    const ual = `did:dkg:hardhat:31337/${ethers.computeAddress(PUBLISHER_PRIV).toLowerCase()}/${kcId}`;

    // 4. Register the KC on the mock chain. Chunks are the canonical
    //    sorted+deduped leaves at each leafIndex, hex-encoded — same
    //    set the on-chain `_verifyV10MerkleProof` would accept.
    const chunks = Array.from({ length: merkleLeafCount }, (_, idx) => ({
      chunkId: BigInt(idx),
      chunk: ethers.hexlify(tree.leafAt(idx)),
    }));
    chain.__registerKC({
      kcId,
      contextGraphId: cgId,
      merkleRootHex: ethers.hexlify(merkleRoot),
      merkleLeafCount,
      chunks,
    });

    // 5. Lay out the local triple store the way the publisher's
    //    confirmed-publish phase does. Public triples → CG data
    //    graph; KC + KA metadata + chain provenance → CG _meta.
    //
    //    The agent's V10 publish path *remaps* the default
    //    `<NAME>` / `<NAME>/_meta` URIs to `<NAME>/context/<cgId>` /
    //    `.../_meta` after on-chain confirmation (see
    //    `dkg-publisher.ts` lines 747-771). The extractor follows
    //    that remap, so we mirror it here. We also seed the
    //    ontology-graph cgId→cgName mapping the extractor uses.
    const cgName = `cg-${cgIdStr}`;
    const cgUri = `did:dkg:context-graph:${cgName}`;
    await store.insert([
      {
        subject: cgUri,
        predicate: 'https://dkg.network/ontology#ParanetOnChainId',
        object: `"${cgIdStr}"`,
        graph: 'did:dkg:context-graph:ontology',
      },
    ]);
    const dataGraph = `${cgUri}/context/${cgIdStr}`;
    const dataQuads: Quad[] = publishQuads.map((q) => ({ ...q, graph: dataGraph }));
    await store.insert(dataQuads);

    const kcMeta: KCMetadata = {
      ual,
      // Pass `<NAME>/context/<cgId>` so the helper's
      // `did:dkg:context-graph:<id>/_meta` template lands at the
      // post-remap URI the extractor reads.
      contextGraphId: `${cgName}/context/${cgIdStr}`,
      merkleRoot,
      kaCount: 1,
      publisherPeerId: 'mock-peer-id',
      accessPolicy: 'public',
      timestamp: new Date(),
    };
    const kaMeta: KAMetadata = {
      rootEntity: ROOT,
      kcUal: ual,
      tokenId: 1n,
      publicTripleCount: publishQuads.length,
      privateTripleCount: 0,
    };
    const provenance: OnChainProvenance = {
      txHash: '0x' + 'a'.repeat(64),
      blockNumber: 1,
      blockTimestamp: Math.floor(Date.now() / 1000),
      publisherAddress: ethers.computeAddress(PUBLISHER_PRIV),
      batchId: kcId,
      chainId: '31337',
    };
    const metaQuads = generateConfirmedFullMetadata(kcMeta, [kaMeta], provenance);
    await store.insert(metaQuads);

    // 6. Run the prover orchestrator end-to-end. No timer — we
    //    drive `tick()` directly so the assertions see the outcome.
    const wal = new InMemoryProverWal();
    const prover = new RandomSamplingProver({
      chain: chain as never, // type-narrow: MockChainAdapter satisfies all RS methods
      store,
      identityId,
      wal,
    });

    const outcome = await prover.tick();
    expect(outcome).toMatchObject({
      kind: 'submitted',
      kcId,
      cgId,
    });

    // 7. WAL trail records every transition, terminating in `submitted`.
    const trail = (await wal.readAll()).map((e) => e.status);
    expect(trail).toEqual(['challenge', 'extracted', 'built', 'submitted']);

    // 8. Calling `tick()` again is idempotent: chain reports the
    //    challenge as solved, prover skips without re-submitting.
    const second = await prover.tick();
    expect(second).toEqual({ kind: 'already-solved' });

    await prover.close();
  });

  it('skips the period silently when no KCs are registered (NoEligibleContextGraphError)', async () => {
    const wal = new InMemoryProverWal();
    const prover = new RandomSamplingProver({
      chain: chain as never,
      store,
      identityId,
      wal,
    });
    const outcome = await prover.tick();
    expect(outcome).toEqual({ kind: 'no-challenge', reason: 'no-eligible-cg' });
    await prover.close();
  });
});
