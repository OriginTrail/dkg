import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  MockChainAdapter,
  buildKnowledgeAssetUal,
} from '@origintrail-official/dkg-chain';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  createGraphKnowledgeAssetScope,
} from '@origintrail-official/dkg-core';
import type {
  AsyncKnowledgeAssetVmPublishRecoveryEvidence,
  KnowledgeAssetVmPublishRequest,
  LiftJobBroadcastMetadata,
} from '@origintrail-official/dkg-publisher';
import { normalizeRecoveredNamedKaPublish } from '../src/named-ka-publish-recovery.js';

// Regression suite for GH#1966: a confirmed named-KA publish must recover even
// when the recovery resolver returns the GRAPH-LOCAL UAL (author + low-96 KA
// number) instead of the canonical contract/packed-id receipt UAL. For
// graph-scoped named KAs the production CLI resolver deliberately overrides
// finalization.ual = request.kaUal (graph-local) — the user-facing identity —
// so the validator must accept that representation as well as the contract form.
//
// The validator only ever runs for graph-scoped requests (kaUal + assertionVersion
// present), so every case here is graph-scoped. These are the two proven-equivalent
// representations of the SAME reserved packed KA id; any other UAL must fail closed.

type Hex = `0x${string}`;
type BigIntString = `${bigint}`;

// `evm:31337` so the mock's chainId equals the kaUal chain segment (the validator
// rejects at the localScope.chainId check otherwise — a false failure on both commits).
const CHAIN_ID = 'evm:31337';
// The GH#1966 incident author — a leading-zero-byte address, which also exercises
// the unpackKnowledgeAssetId `padStart(40, '0')` path.
const AUTHOR = '0x00a9d0dcab936a418ffebc734476c91d4027d359' as Hex;
const KA_NUMBER = 402n;
const RESERVED_KA_ID = (BigInt(ethers.getAddress(AUTHOR)) << 96n) | KA_NUMBER;
const GRAPH_LOCAL_UAL = `did:dkg:${CHAIN_ID}/${AUTHOR}/${KA_NUMBER}`;
const ASSERTION_VERSION = '1';
const SEAL_MERKLE_ROOT = `0x${'12'.repeat(32)}` as Hex;
const TX_HASH = `0x${'ab'.repeat(32)}` as Hex;
const BLOCK_HASH = `0x${'cd'.repeat(32)}` as Hex;
const PUBLISHER = AUTHOR;

// MockChainAdapter.getDKGKnowledgeAssetsAddress() is a fixed constant.
const KNOWLEDGE_ASSETS_ADDRESS = ethers.getAddress(
  '0x000000000000000000000000000000000000c10a',
);
const CONTRACT_RECEIPT_UAL = buildKnowledgeAssetUal(
  CHAIN_ID,
  KNOWLEDGE_ASSETS_ADDRESS,
  RESERVED_KA_ID,
);

/**
 * A fresh mock whose latest merkle root for the reserved KA equals the seal
 * root, so the recovered version is NOT superseded. getLatestMerkleRoot() is
 * called OUTSIDE the validator's try/catch and throws `Mock: unknown kaId`
 * for an unseeded id, so this seeding is mandatory for the positive cases.
 */
function seededChain(): MockChainAdapter {
  const chain = new MockChainAdapter(CHAIN_ID);
  chain.__registerKC({
    kaId: RESERVED_KA_ID,
    contextGraphId: 1n,
    merkleRootHex: SEAL_MERKLE_ROOT,
    chunks: [],
  });
  return chain;
}

function baseRequest(
  overrides: Partial<KnowledgeAssetVmPublishRequest> = {},
): KnowledgeAssetVmPublishRequest {
  return {
    contextGraphId: '1',
    name: 'campaign-v2-3p95mib-ka-018',
    shareOperationId: 'share-op-1966',
    roots: [],
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: GRAPH_LOCAL_UAL,
    assertionVersion: ASSERTION_VERSION,
    publicTripleCount: 1,
    privateTripleCount: 0,
    seal: {
      merkleRoot: SEAL_MERKLE_ROOT,
      authorAddress: AUTHOR,
      signature: { r: `0x${'34'.repeat(32)}` as Hex, vs: `0x${'56'.repeat(32)}` as Hex },
      schemeVersion: 1,
      reservedKaId: RESERVED_KA_ID.toString() as BigIntString,
    },
    sealChainId: '31337',
    sealKav10Address: `0x${'44'.repeat(20)}` as Hex,
    sealFinalizedAtIso: '2026-01-01T00:00:00.000Z',
    sealMerkleRoot: SEAL_MERKLE_ROOT,
    intentKey: `sha256:${'ab'.repeat(32)}`,
    kaNumber: KA_NUMBER.toString(),
    ...overrides,
  };
}

// The normalizer only reads job.broadcast; its input type is the narrow structural
// shape, so this fixture is a real contract guard (no cast) rather than a faked job.
function broadcastJob(): { broadcast: LiftJobBroadcastMetadata } {
  return {
    broadcast: { txHash: TX_HASH, walletId: 'wallet-1', merkleRoot: SEAL_MERKLE_ROOT },
  };
}

// Typed optional tweaks (no Partial-over-required spread) so the fixture satisfies
// AsyncKnowledgeAssetVmPublishRecoveryEvidence without a cast.
function recoveryEvidence(
  ual: string,
  opts: {
    endKAId?: BigIntString;
    omitPublisher?: boolean;
    inclusion?: AsyncKnowledgeAssetVmPublishRecoveryEvidence['inclusion'];
    publishProof?: AsyncKnowledgeAssetVmPublishRecoveryEvidence['publishProof'];
  } = {},
): AsyncKnowledgeAssetVmPublishRecoveryEvidence {
  return {
    inclusion: opts.inclusion ?? {
      txHash: TX_HASH,
      blockNumber: 77,
      blockHash: BLOCK_HASH,
      blockTimestamp: 1_700_000_077,
    },
    finalization: {
      mode: 'published',
      txHash: TX_HASH,
      ual,
      batchId: RESERVED_KA_ID.toString() as BigIntString,
      startKAId: RESERVED_KA_ID.toString() as BigIntString,
      endKAId: opts.endKAId ?? (RESERVED_KA_ID.toString() as BigIntString),
      publisherAddress: opts.omitPublisher ? undefined : PUBLISHER,
    },
    publishProof: opts.publishProof ?? { merkleRoot: SEAL_MERKLE_ROOT, authorAddress: AUTHOR, txIndex: 4 },
  };
}

const REJECTS = { code: 'KA_VM_RECOVERY_INCONSISTENT' };

describe('normalizeRecoveredNamedKaPublish — accepted representations (GH#1966)', () => {
  it('accepts the graph-local UAL the production resolver returns (regression)', async () => {
    // On the buggy commit this throws KA_VM_RECOVERY_INCONSISTENT at the
    // `ual !== expectedReceiptUal` check; with the fix it resolves.
    const result = await normalizeRecoveredNamedKaPublish({
      request: baseRequest(),
      job: broadcastJob(),
      recovery: recoveryEvidence(GRAPH_LOCAL_UAL),
      chain: seededChain(),
    });

    expect(result.reservedKaId).toBe(RESERVED_KA_ID);
    expect(result.localUal).toBe(GRAPH_LOCAL_UAL);
    // publishedUal carries the resolver-returned form (graph-local here) — the same
    // identity a normal named-KA publish records.
    expect(result.publishedUal).toBe(GRAPH_LOCAL_UAL);
    expect(result.txHash).toBe(TX_HASH);
    expect(result.materialization.superseded).toBe(false);
  });

  it('still accepts the canonical contract/packed-ID receipt UAL', async () => {
    const result = await normalizeRecoveredNamedKaPublish({
      request: baseRequest(),
      job: broadcastJob(),
      recovery: recoveryEvidence(CONTRACT_RECEIPT_UAL),
      chain: seededChain(),
    });

    expect(result.localUal).toBe(GRAPH_LOCAL_UAL);
    expect(result.publishedUal).toBe(CONTRACT_RECEIPT_UAL);
  });

  it('accepts a graph-local UAL whose author is checksummed (case-insensitive)', async () => {
    const checksummedUal = `did:dkg:${CHAIN_ID}/${ethers.getAddress(AUTHOR)}/${KA_NUMBER}`;
    expect(checksummedUal).not.toBe(GRAPH_LOCAL_UAL); // differs only by case
    const result = await normalizeRecoveredNamedKaPublish({
      request: baseRequest(),
      job: broadcastJob(),
      recovery: recoveryEvidence(checksummedUal),
      chain: seededChain(),
    });
    expect(result.localUal).toBe(GRAPH_LOCAL_UAL);
  });

  it('resolver-preserved kaUal canonicalizes to the validator-derived localUal (seam guard)', () => {
    // The resolver passes finalization.ual = request.kaUal verbatim; the validator
    // derives localUal = createGraphKnowledgeAssetScope(request.kaUal).ual. This
    // asserts the two halves agree by construction (the only bridge across the
    // resolver -> validator seam that no single test exercises end-to-end).
    const scope = createGraphKnowledgeAssetScope(GRAPH_LOCAL_UAL, ASSERTION_VERSION);
    expect(scope.ual.toLowerCase()).toBe(GRAPH_LOCAL_UAL.toLowerCase());
  });
});

describe('normalizeRecoveredNamedKaPublish — fail-closed boundary (GH#1966)', () => {
  it('rejects a returned UAL that is neither the receipt nor the graph-local form', async () => {
    const wrongNumberUal = `did:dkg:${CHAIN_ID}/${AUTHOR}/999`;
    await expect(
      normalizeRecoveredNamedKaPublish({
        request: baseRequest(),
        job: broadcastJob(),
        recovery: recoveryEvidence(wrongNumberUal),
        chain: seededChain(),
      }),
    ).rejects.toMatchObject(REJECTS);
  });

  it('rejects a returned contract-form UAL with the wrong contract address', async () => {
    const wrongContractUal = buildKnowledgeAssetUal(
      CHAIN_ID,
      ethers.getAddress(`0x${'99'.repeat(20)}`),
      RESERVED_KA_ID,
    );
    await expect(
      normalizeRecoveredNamedKaPublish({
        request: baseRequest(),
        job: broadcastJob(),
        recovery: recoveryEvidence(wrongContractUal),
        chain: seededChain(),
      }),
    ).rejects.toMatchObject(REJECTS);
  });

  it('rejects a returned UAL on the wrong chain', async () => {
    const wrongChainUal = `did:dkg:evm:9999/${AUTHOR}/${KA_NUMBER}`;
    await expect(
      normalizeRecoveredNamedKaPublish({
        request: baseRequest(),
        job: broadcastJob(),
        recovery: recoveryEvidence(wrongChainUal),
        chain: seededChain(),
      }),
    ).rejects.toMatchObject(REJECTS);
  });

  it('rejects when the queued graph UAL is bound to a different chain', async () => {
    await expect(
      normalizeRecoveredNamedKaPublish({
        request: baseRequest({ kaUal: `did:dkg:evm:9999/${AUTHOR}/${KA_NUMBER}` }),
        job: broadcastJob(),
        recovery: recoveryEvidence(GRAPH_LOCAL_UAL),
        chain: seededChain(),
      }),
    ).rejects.toMatchObject(REJECTS);
  });

  it('rejects when the queued graph UAL author does not match the reserved KA id', async () => {
    const otherAuthor = `0x${'11'.repeat(20)}` as Hex;
    await expect(
      normalizeRecoveredNamedKaPublish({
        request: baseRequest({ kaUal: `did:dkg:${CHAIN_ID}/${otherAuthor}/${KA_NUMBER}` }),
        job: broadcastJob(),
        recovery: recoveryEvidence(GRAPH_LOCAL_UAL),
        chain: seededChain(),
      }),
    ).rejects.toMatchObject(REJECTS);
  });

  it('rejects when the queued graph UAL KA number does not match the reserved KA id', async () => {
    await expect(
      normalizeRecoveredNamedKaPublish({
        request: baseRequest({ kaUal: `did:dkg:${CHAIN_ID}/${AUTHOR}/7` }),
        job: broadcastJob(),
        recovery: recoveryEvidence(GRAPH_LOCAL_UAL),
        chain: seededChain(),
      }),
    ).rejects.toMatchObject(REJECTS);
  });

  it('rejects when the returned singleton range does not equal the reserved KA id', async () => {
    await expect(
      normalizeRecoveredNamedKaPublish({
        request: baseRequest(),
        job: broadcastJob(),
        recovery: recoveryEvidence(GRAPH_LOCAL_UAL, {
          endKAId: (RESERVED_KA_ID + 1n).toString() as BigIntString,
        }),
        chain: seededChain(),
      }),
    ).rejects.toMatchObject(REJECTS);
  });

  it('rejects when the inclusion tx hash does not match the queued broadcast tx', async () => {
    await expect(
      normalizeRecoveredNamedKaPublish({
        request: baseRequest(),
        job: broadcastJob(),
        recovery: recoveryEvidence(GRAPH_LOCAL_UAL, {
          inclusion: {
            txHash: `0x${'ef'.repeat(32)}` as Hex,
            blockNumber: 77,
            blockHash: BLOCK_HASH,
          },
        }),
        chain: seededChain(),
      }),
    ).rejects.toMatchObject(REJECTS);
  });

  it('rejects when the proof merkle root does not match the queued seal', async () => {
    await expect(
      normalizeRecoveredNamedKaPublish({
        request: baseRequest(),
        job: broadcastJob(),
        recovery: recoveryEvidence(GRAPH_LOCAL_UAL, {
          publishProof: {
            merkleRoot: `0x${'ba'.repeat(32)}` as Hex,
            authorAddress: AUTHOR,
            txIndex: 4,
          },
        }),
        chain: seededChain(),
      }),
    ).rejects.toMatchObject(REJECTS);
  });

  it('rejects when the transaction author does not match the sealed author', async () => {
    await expect(
      normalizeRecoveredNamedKaPublish({
        request: baseRequest(),
        job: broadcastJob(),
        recovery: recoveryEvidence(GRAPH_LOCAL_UAL, {
          publishProof: {
            merkleRoot: SEAL_MERKLE_ROOT,
            authorAddress: `0x${'11'.repeat(20)}` as Hex,
            txIndex: 4,
          },
        }),
        chain: seededChain(),
      }),
    ).rejects.toMatchObject(REJECTS);
  });

  it('rejects when the returned publisher address is missing', async () => {
    await expect(
      normalizeRecoveredNamedKaPublish({
        request: baseRequest(),
        job: broadcastJob(),
        recovery: recoveryEvidence(GRAPH_LOCAL_UAL, { omitPublisher: true }),
        chain: seededChain(),
      }),
    ).rejects.toMatchObject(REJECTS);
  });
});

// NOTE: the superseded-version branch (getLatestMerkleRoot != proof root) needs
// getBlockNumber, which MockChainAdapter does not implement — it is covered by
// the real-Hardhat e2e (e2e-memory-layers.test.ts). This suite intentionally
// keeps every KA non-superseded via seededChain().
