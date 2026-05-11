/**
 * End-to-end Random Sampling test against a real Hardhat node with
 * deployed `RandomSampling.sol` + `KnowledgeAssetsV10.sol` contracts.
 *
 * Mirrors the off-chain e2e (`e2e-mock-chain.test.ts`) but swaps the
 * mock chain for a freshly-deployed Solidity stack:
 *
 *   1. publish a real KC into a real on-chain context graph (open
 *      publishPolicy — see comment below for why), paying real
 *      `tokenAmount` so `ContextGraphValueStorage` records a non-zero
 *      per-epoch value (precondition for `_pickWeightedChallenge`),
 *   2. lay out the same quads + publisher metadata into a real
 *      `OxigraphStore`,
 *   3. drive `RandomSamplingProver.tick()` against the real
 *      `EVMChainAdapter`,
 *   4. assert the on-chain `solved` flag flipped to `true`.
 *
 * Catches what the mock e2e can't:
 *   - ABI / storage-layout drift between `EVMChainAdapter` and the
 *     deployed contracts,
 *   - real Solidity-side `_verifyV10MerkleProof` semantics,
 *   - real revert paths (`NoEligibleContextGraph`, `MerkleRootMismatch`).
 *
 * Heavier than mock e2e (~3s incl. Hardhat startup amortised across
 * the file). Worth it — without this test, two real bugs would have
 * shipped: (a) `publishPolicy: 0` makes the CG curated and ineligible
 * for random sampling, (b) view-side `getActiveProofPeriodStatus` can
 * report `isValid: false` even though the next stateful call would
 * auto-rotate the period; the prover originally short-circuited on
 * that and stalled single-tenant deployments. Both bugs fixed; this
 * test green-lights the off-chain ↔ Solidity seam end-to-end.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ethers } from 'ethers';
import {
  V10MerkleTree,
  hashTripleV10,
  computePublishACKDigest,
  buildAuthorAttestationTypedData,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  generateConfirmedFullMetadata,
  type KCMetadata,
  type KAMetadata,
  type OnChainProvenance,
} from '@origintrail-official/dkg-publisher';
import {
  createEVMAdapter,
  getSharedContext,
  createProvider,
  takeSnapshot,
  revertSnapshot,
  HARDHAT_KEYS,
} from '../../chain/test/evm-test-context.js';
import {
  mintTokens,
  setMinimumRequiredSignatures,
  stakeAndSetAsk,
} from '../../chain/test/hardhat-harness.js';
import { InMemoryProverWal, RandomSamplingProver } from '../src/index.js';

const TEST_CHAIN_ID = 31337n;

describe('Random Sampling E2E (Hardhat)', () => {
  const ROOT = 'urn:experiment:wsd';
  const publishQuads = [
    { subject: ROOT, predicate: 'http://schema.org/name', object: '"Word Sense Disambiguation"' },
    { subject: ROOT, predicate: 'urn:exp:val_bpb', object: '"1.36"' },
    { subject: ROOT, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'urn:exp:Experiment' },
  ];

  // V10 leaf material the publisher's `computeFlatKCRootV10` would
  // produce for these quads (no private payload). Computed once and
  // shared with both the on-chain commit and the local store seed.
  const rawLeaves = publishQuads.map((q) =>
    hashTripleV10(q.subject, q.predicate, q.object),
  );
  const tree = new V10MerkleTree(rawLeaves);
  const merkleRoot = tree.root;
  const merkleLeafCount = tree.leafCount;

  let snapshotId: string;
  let kcId: bigint;
  let cgId: bigint;
  let kav10Address: string;

  beforeAll(async () => {
    snapshotId = await takeSnapshot();
    const ctx = getSharedContext();
    const provider = createProvider();

    // 1. Fund the publisher (CORE_OP) — `createKnowledgeAssetsV10`
    //    requires real TRAC to pay `tokenAmount`. Receivers get stake
    //    + ask through `stakeAndSetAsk` so they're in the sharding
    //    table (precondition for any of them to act as the prover).
    const coreOpWallet = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    await mintTokens(
      provider,
      ctx.hubAddress,
      HARDHAT_KEYS.DEPLOYER,
      coreOpWallet.address,
      ethers.parseEther('50000000'),
    );
    const recOpKeys = [HARDHAT_KEYS.REC1_OP, HARDHAT_KEYS.REC2_OP, HARDHAT_KEYS.REC3_OP];
    for (let i = 0; i < ctx.receiverIds.length; i++) {
      await stakeAndSetAsk(
        provider,
        ctx.hubAddress,
        HARDHAT_KEYS.DEPLOYER,
        recOpKeys[i]!,
        ctx.receiverIds[i]!,
      );
    }
    await setMinimumRequiredSignatures(provider, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER, 3);

    // 2. Create an on-chain context graph with all four nodes as
    //    participants. requiredSignatures=3 matches the receiver count.
    const publisherAdapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    kav10Address = await publisherAdapter.getKnowledgeAssetsV10Address();
    // publishPolicy: 1 (open) — required for the CG to be eligible
    // for random sampling. publishPolicy: 0 means "curated" and
    // RandomSampling._isCGEligible() filters those out at draw time.
    const cgResult = await publisherAdapter.createOnChainContextGraph({
      participantIdentityIds: [
        BigInt(ctx.coreProfileId),
        ...ctx.receiverIds.map((id) => BigInt(id)),
      ],
      requiredSignatures: 3,
      publishPolicy: 1,
    });
    if (!cgResult.success || cgResult.contextGraphId === 0n) {
      throw new Error(`Failed to create on-chain context graph: ${JSON.stringify(cgResult)}`);
    }
    cgId = cgResult.contextGraphId;

    // 3. Publish a real KC into that CG. Receiver wallets sign the
    //    9-field ACK digest (now includes merkleLeafCount); the
    //    publisher signs the root commitment. `epochs` and
    //    `tokenAmount` MUST be > 0 — that's what seeds
    //    ContextGraphValueStorage so the random sampler picks this CG.
    const publisherIdentityId = BigInt(ctx.coreProfileId);
    const byteSize = BigInt(publishQuads.length * 100);
    const epochs = 2n;
    const tokenAmount = await publisherAdapter.getRequiredPublishTokenAmount(byteSize, epochs);
    const ackSignatures = await Promise.all(
      recOpKeys.map(async (key, idx) => {
        const wallet = new ethers.Wallet(key);
        const digest = computePublishACKDigest(
          TEST_CHAIN_ID,
          kav10Address,
          cgId,
          merkleRoot,
          BigInt(publishQuads.length),
          byteSize,
          epochs,
          tokenAmount,
          BigInt(merkleLeafCount),
        );
        const sig = ethers.Signature.from(await wallet.signMessage(digest));
        return {
          identityId: BigInt(ctx.receiverIds[idx]!),
          r: ethers.getBytes(sig.r),
          vs: ethers.getBytes(sig.yParityAndS),
        };
      }),
    );
    const authorTyped = buildAuthorAttestationTypedData({
      chainId: TEST_CHAIN_ID,
      kav10Address,
      contextGraphId: cgId,
      merkleRoot,
      authorAddress: coreOpWallet.address,
    });
    const authorSig = ethers.Signature.from(
      await coreOpWallet.signTypedData(authorTyped.domain, authorTyped.types, authorTyped.message),
    );
    const publishResult = await publisherAdapter.createKnowledgeAssetsV10!({
      publishOperationId: 'rs-e2e-publish',
      contextGraphId: cgId,
      merkleRoot,
      knowledgeAssetsAmount: publishQuads.length,
      byteSize,
      epochs: Number(epochs),
      tokenAmount,
      isImmutable: false,
      merkleLeafCount,
      publisherNodeIdentityId: publisherIdentityId,
      author: {
        address: coreOpWallet.address,
        signature: {
          r: ethers.getBytes(authorSig.r),
          vs: ethers.getBytes(authorSig.yParityAndS),
        },
        schemeVersion: 1,
      },
      ackSignatures,
    });
    kcId = publishResult.batchId;
    if (kcId === 0n) {
      throw new Error('Publish succeeded but batchId is 0; ABI drift?');
    }
  });

  afterAll(async () => {
    if (snapshotId) await revertSnapshot(snapshotId);
  });

  it('drives the prover end-to-end against the real RandomSampling.sol', async () => {
    const ctx = getSharedContext();

    // The prover is REC1: it has a profile, is staked, and is in the
    // sharding table. The publisher (CORE_OP) is NOT a sharded node
    // here, which mirrors prod (publishers don't have to host).
    const proverAdapter = createEVMAdapter(HARDHAT_KEYS.REC1_OP);
    const proverIdentityId = BigInt(ctx.receiverIds[0]!);
    // Note: this test originally needed an explicit
    // `updateAndGetActiveProofPeriodStartBlock` rotation here — the
    // setup burns enough blocks during mint+stake+publish that
    // `block.number` exceeds `startBlock + 100` (Hardhat
    // proofingPeriodDurationInBlocks). The prover used to bail on the
    // resulting view-side `isValid: false`. That short-circuit was
    // removed (see prover.ts) — `createChallenge` auto-rotates, and
    // single-tenant testnets like this one no longer stall.

    // Lay the publisher's metadata into the local store the same way
    // the off-chain pipeline expects (data graph + _meta graph). We
    // mirror `e2e-mock-chain.test.ts` exactly — same fixture, real
    // chain.
    //
    // The agent's V10 publish path remaps post-confirmation to
    // `<NAME>/context/<cgId>/_meta`, and the extractor resolves
    // cgId → name via the `did:dkg:context-graph:ontology` graph.
    // We mirror that here so the extractor finds the KC.
    const store = new OxigraphStore();
    const cgIdStr = cgId.toString();
    // Use a v9-style `<owner_address>/<slug>` cgName to exercise the
    // FinalizationHandler ↔ kc-extractor seam end-to-end with the
    // namespacing pattern that real beacons register on testnet
    // (e.g. "0xb08…4794c/laptop-smoke"). A pre-PR-#377 build would
    // short-circuit here in `resolveContextGraphNameFromOnChainId`,
    // making `prover.tick()` return `kc-not-synced` instead of
    // `submitted` — exactly the failure mode that suppressed every
    // RS proof on testnet beacon-04 for 40+ minutes despite chain
    // challenges firing within seconds of each `Finalization: promoted
    // SWM snapshot` log line. The unit test in `kc-extractor.test.ts`
    // covers the resolver in isolation; this one pins the whole
    // chain-publish → local-store → prover-tick path.
    const cgName = `0xb08A0F66d5A225D57Dee5fFa6C442e4DC2a4794c/cg-${cgIdStr}`;
    const cgUri = `did:dkg:context-graph:${cgName}`;
    await store.insert([
      {
        subject: cgUri,
        predicate: 'https://dkg.network/ontology#ContextGraphOnChainId',
        object: `"${cgIdStr}"`,
        graph: 'did:dkg:context-graph:ontology',
      },
    ]);
    const dataGraph = `${cgUri}/context/${cgIdStr}`;
    const dataQuads: Quad[] = publishQuads.map((q) => ({ ...q, graph: dataGraph }));
    await store.insert(dataQuads);

    const ual = `did:dkg:hardhat:31337/${kav10Address.toLowerCase()}/${kcId}`;
    const kcMeta: KCMetadata = {
      ual,
      contextGraphId: `${cgName}/context/${cgIdStr}`,
      merkleRoot,
      kaCount: 1,
      publisherPeerId: 'rs-e2e-peer',
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
      txHash: '0x' + 'a'.repeat(64), // not exercised by extractor
      blockNumber: 1,
      blockTimestamp: Math.floor(Date.now() / 1000),
      publisherAddress: ethers.computeAddress(HARDHAT_KEYS.CORE_OP),
      batchId: kcId,
      chainId: '31337',
    };
    await store.insert(generateConfirmedFullMetadata(kcMeta, [kaMeta], provenance));

    const wal = new InMemoryProverWal();
    const prover = new RandomSamplingProver({
      chain: proverAdapter,
      store,
      identityId: proverIdentityId,
      wal,
    });

    try {
      const outcome = await prover.tick();

      // The prover should have created a challenge, extracted leaves,
      // built proof, and submitted. With only one CG holding non-zero
      // value and one KC inside it, the weighted draw is deterministic.
      expect(outcome.kind).toBe('submitted');
      if (outcome.kind === 'submitted') {
        expect(outcome.kcId).toBe(kcId);
        expect(outcome.cgId).toBe(cgId);
        expect(typeof outcome.txHash).toBe('string');
      }

      const trail = (await wal.readAll()).map((e) => e.status);
      expect(trail).toEqual(['challenge', 'extracted', 'built', 'submitted']);

      // On-chain solved flag flipped — confirms the Solidity verifier
      // accepted the leaf+proof we built off-chain.
      const challenge = await proverAdapter.getNodeChallenge!(proverIdentityId);
      expect(challenge?.solved).toBe(true);

      // Idempotency: a second tick within the same period sees the
      // solved flag and short-circuits.
      const second = await prover.tick();
      expect(second).toEqual({ kind: 'already-solved' });
    } finally {
      await prover.close();
      await store.close();
    }
  }, 90_000);
});
