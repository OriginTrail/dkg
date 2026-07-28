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
// Deliberately NOT the author: the publisher is a distinct identity in the returned
// evidence, so reusing the author here would let an author/publisher swap pass unnoticed.
const PUBLISHER = `0x${'22'.repeat(20)}` as Hex;

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

/**
 * `getDKGKnowledgeAssetsAddress` is OPTIONAL on the ChainAdapter contract, and the
 * graph-local path must neither require nor consult it — the contract address is only
 * needed to build the canonical receipt form. Returns a seeded chain whose resolver
 * throws if called, plus the call counter, so a test can prove non-invocation rather
 * than merely tolerate absence.
 */
function chainThatRejectsContractLookup(): { chain: MockChainAdapter; calls: () => number } {
  const chain = seededChain();
  let calls = 0;
  (chain as unknown as { getDKGKnowledgeAssetsAddress: () => Promise<string> })
    .getDKGKnowledgeAssetsAddress = () => {
      calls += 1;
      throw new Error('the graph-local path must not resolve the DKGKnowledgeAssets address');
    };
  return { chain, calls: () => calls };
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
    // The normalized identity is the canonical graph-local UAL — the same value a normal
    // named-KA publish records and what gets stamped as publishedUal / drives materialization.
    expect(result.localUal).toBe(GRAPH_LOCAL_UAL);
    expect(result.txHash).toBe(TX_HASH);
    expect(result.receiptBlockNumber).toBe(77);
    // Author and publisher are distinct identities and must not be transposed.
    expect(result.transaction).toEqual({
      merkleRoot: SEAL_MERKLE_ROOT,
      authorAddress: ethers.getAddress(AUTHOR),
      publisherAddress: ethers.getAddress(PUBLISHER),
      blockHash: BLOCK_HASH,
      txIndex: 4,
    });
    // Not superseded (the seeded chain's latest root equals the seal), so the
    // materialized version is the recovered transaction's own block and identities.
    expect(result.materialization).toEqual({
      merkleRoot: SEAL_MERKLE_ROOT,
      authorAddress: ethers.getAddress(AUTHOR),
      publisherAddress: ethers.getAddress(PUBLISHER),
      versionBlock: 77,
      superseded: false,
    });
  });

  it('still accepts the canonical contract/packed-ID receipt UAL and normalizes to graph-local', async () => {
    const result = await normalizeRecoveredNamedKaPublish({
      request: baseRequest(),
      job: broadcastJob(),
      recovery: recoveryEvidence(CONTRACT_RECEIPT_UAL),
      chain: seededChain(),
    });

    // The contract/packed wire form is accepted at the cross-check, but the normalized
    // identity is still the canonical graph-local UAL — never the raw resolver shape.
    expect(result.reservedKaId).toBe(RESERVED_KA_ID);
    expect(result.localUal).toBe(GRAPH_LOCAL_UAL);
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

  it('resolves the graph-local UAL without requiring the optional contract-address resolver', async () => {
    // The graph-local form is the production shape, and it is self-sufficient: the
    // DKGKnowledgeAssets address is only needed to build the canonical receipt form.
    // Pins that contract — a regression hoisting the lookup above the representation
    // branch would fail here even though every other positive case would still pass.
    const { chain, calls } = chainThatRejectsContractLookup();
    const result = await normalizeRecoveredNamedKaPublish({
      request: baseRequest(),
      job: broadcastJob(),
      recovery: recoveryEvidence(GRAPH_LOCAL_UAL),
      chain,
    });

    expect(result.localUal).toBe(GRAPH_LOCAL_UAL);
    expect(calls()).toBe(0);
  });

  it('still requires the contract-address resolver to accept the contract/packed form', async () => {
    // The mirror of the case above: the receipt form cannot be validated without the
    // contract address, so it must fail closed rather than be waved through.
    const { chain, calls } = chainThatRejectsContractLookup();
    await expect(
      normalizeRecoveredNamedKaPublish({
        request: baseRequest(),
        job: broadcastJob(),
        recovery: recoveryEvidence(CONTRACT_RECEIPT_UAL),
        chain,
      }),
    ).rejects.toMatchObject({
      code: 'KA_VM_RECOVERY_INCONSISTENT',
      message: expect.stringMatching(/could not resolve the canonical receipt UAL/),
    });
    expect(calls()).toBe(1);
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

// Request-side rows mutate `request.kaUal`, from which `localUal` is DERIVED. Feeding the
// canonical UAL as the resolver's returned value would make such a row fail at the
// representation cross-check instead of at the guard it is named for — leaving the guard
// mutation-blind (deletable with the suite green). So each request-side row returns the SAME
// mutated UAL: the cross-check then agrees, and only the named guard can reject.
const WRONG_CHAIN_UAL = `did:dkg:evm:9999/${AUTHOR}/${KA_NUMBER}`;
const WRONG_AUTHOR_UAL = `did:dkg:${CHAIN_ID}/0x${'11'.repeat(20)}/${KA_NUMBER}`;
const WRONG_NUMBER_UAL = `did:dkg:${CHAIN_ID}/${AUTHOR}/7`;

// Declarative boundary matrix: each row names the one invalid condition, supplies only what it
// mutates, and pins the guard that must reject it via `expected`. `job` and a freshly seeded
// non-superseded `chain` are constant.
const REJECT_CASES: ReadonlyArray<{
  readonly name: string;
  readonly expected: RegExp;
  readonly request?: KnowledgeAssetVmPublishRequest;
  readonly recovery: AsyncKnowledgeAssetVmPublishRecoveryEvidence;
}> = [
  {
    name: 'returned UAL is neither the receipt nor the graph-local form',
    expected: /does not match the graph-local UAL/,
    recovery: recoveryEvidence(`did:dkg:${CHAIN_ID}/${AUTHOR}/999`),
  },
  {
    name: 'returned contract-form UAL has the wrong contract address',
    expected: /does not match the graph-local UAL/,
    recovery: recoveryEvidence(
      buildKnowledgeAssetUal(CHAIN_ID, ethers.getAddress(`0x${'99'.repeat(20)}`), RESERVED_KA_ID),
    ),
  },
  {
    name: 'returned UAL is on the wrong chain',
    expected: /does not match the graph-local UAL/,
    recovery: recoveryEvidence(WRONG_CHAIN_UAL),
  },
  {
    name: 'queued graph UAL is bound to a different chain',
    expected: /queued graph UAL is not bound to the recovery chain/,
    request: baseRequest({ kaUal: WRONG_CHAIN_UAL }),
    recovery: recoveryEvidence(WRONG_CHAIN_UAL),
  },
  {
    name: 'queued graph UAL author does not match the reserved KA id',
    expected: /does not identify reserved KA id/,
    request: baseRequest({ kaUal: WRONG_AUTHOR_UAL }),
    recovery: recoveryEvidence(WRONG_AUTHOR_UAL),
  },
  {
    name: 'queued graph UAL KA number does not match the reserved KA id',
    expected: /does not identify reserved KA id/,
    request: baseRequest({ kaUal: WRONG_NUMBER_UAL }),
    recovery: recoveryEvidence(WRONG_NUMBER_UAL),
  },
  {
    name: 'reserved KA id author bits do not match the sealed author',
    expected: /author bits do not match the signed author address/,
    // The seal names a different author than the packed reserved id encodes.
    request: baseRequest({
      seal: { ...baseRequest().seal, authorAddress: `0x${'33'.repeat(20)}` as Hex },
    }),
    recovery: recoveryEvidence(GRAPH_LOCAL_UAL),
  },
  {
    name: 'returned singleton range does not equal the reserved KA id',
    expected: /does not match reserved KA id/,
    recovery: recoveryEvidence(GRAPH_LOCAL_UAL, {
      endKAId: (RESERVED_KA_ID + 1n).toString() as BigIntString,
    }),
  },
  {
    name: 'inclusion tx hash does not match the queued broadcast tx',
    expected: /does not match queued tx/,
    recovery: recoveryEvidence(GRAPH_LOCAL_UAL, {
      inclusion: { txHash: `0x${'ef'.repeat(32)}` as Hex, blockNumber: 77, blockHash: BLOCK_HASH },
    }),
  },
  {
    name: 'canonical block hash is malformed',
    expected: /did not return a valid canonical block hash/,
    recovery: recoveryEvidence(GRAPH_LOCAL_UAL, {
      inclusion: { txHash: TX_HASH, blockNumber: 77, blockHash: '0xnotahash' as Hex },
    }),
  },
  {
    name: 'proof merkle root does not match the queued seal',
    expected: /does not match queued seal/,
    recovery: recoveryEvidence(GRAPH_LOCAL_UAL, {
      publishProof: { merkleRoot: `0x${'ba'.repeat(32)}` as Hex, authorAddress: AUTHOR, txIndex: 4 },
    }),
  },
  {
    name: 'transaction index is not a valid non-negative integer',
    expected: /did not return a valid transaction index/,
    recovery: recoveryEvidence(GRAPH_LOCAL_UAL, {
      publishProof: { merkleRoot: SEAL_MERKLE_ROOT, authorAddress: AUTHOR, txIndex: -1 },
    }),
  },
  {
    name: 'transaction author does not match the sealed author',
    expected: /does not match sealed author/,
    recovery: recoveryEvidence(GRAPH_LOCAL_UAL, {
      publishProof: { merkleRoot: SEAL_MERKLE_ROOT, authorAddress: `0x${'11'.repeat(20)}` as Hex, txIndex: 4 },
    }),
  },
  {
    name: 'returned publisher address is missing',
    expected: /did not return a valid publisher address/,
    recovery: recoveryEvidence(GRAPH_LOCAL_UAL, { omitPublisher: true }),
  },
];

describe('normalizeRecoveredNamedKaPublish — fail-closed boundary (GH#1966)', () => {
  it.each(REJECT_CASES)('rejects when the $name', async ({ request, recovery, expected }) => {
    await expect(
      normalizeRecoveredNamedKaPublish({
        request: request ?? baseRequest(),
        job: broadcastJob(),
        recovery,
        chain: seededChain(),
      }),
    ).rejects.toMatchObject({ ...REJECTS, message: expect.stringMatching(expected) });
  });
});

// NOTE: the superseded-version branch (getLatestMerkleRoot != proof root) needs
// getBlockNumber, which MockChainAdapter does not implement — it is covered by
// the real-Hardhat e2e (e2e-memory-layers.test.ts). This suite intentionally
// keeps every KA non-superseded via seededChain().
