import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  Chronos,
  ContextGraphStorage,
  ContextGraphValueStorage,
  Hub,
  KnowledgeCollectionStorage,
  RandomSampling,
} from '../../typechain';

/**
 * RFC-39 Phase A.5 — `RandomSampling` curated-CG picker.
 *
 * Locks the picker behaviour changes:
 *
 *   - `_isCGEligible` no longer excludes curated CGs (they reach step 2).
 *   - Step 2 (KC selection) skips curated KCs without a
 *     `(ciphertextChunksRoot, ciphertextChunkCount)` commitment using the
 *     same retry-loop pattern as expired KCs.
 *   - Step 3 (leaf index) branches: curated CGs draw against
 *     `ciphertextChunkCount`, public CGs unchanged
 *     (`merkleLeafCount`).
 *
 * Dedicated test file (separate from `RandomSampling.test.ts`) so the
 * contract PR doesn't conflict with PR #595 / PR #610 which are both
 * modifying the legacy Phase-10 suite. Submit-proof end-to-end coverage
 * (which requires the full node-identity + challenge + proof fixture) is
 * intentionally kept in the legacy file alongside the public path; this
 * file exercises picker behaviour via the read-only
 * `previewChallengeForSeed` helper so the curated branch is testable
 * without a full proof-period dance.
 */
describe('@unit RandomSampling — RFC-39 curated picker', () => {
  const CURATED_POLICY = 0;
  const OPEN_POLICY = 1;
  const TEST_KC_BYTE_SIZE = 128n;
  const SAMPLE_CT_ROOT_A = ethers.keccak256(ethers.toUtf8Bytes('rs-curated-ct-A'));
  const SAMPLE_CT_ROOT_B = ethers.keccak256(ethers.toUtf8Bytes('rs-curated-ct-B'));
  const SAMPLE_CT_COUNT_A = 5;
  const SAMPLE_CT_COUNT_B = 13;

  let accounts: SignerWithAddress[];
  let HubContract: Hub;
  let RandomSamplingContract: RandomSampling;
  let ChronosContract: Chronos;
  let KCSContract: KnowledgeCollectionStorage;
  let CGStorageContract: ContextGraphStorage;
  let CGValueStorage: ContextGraphValueStorage;

  /** Hub sentinel — registered as a "contract" in the fixture so it can
   *  bypass the production facades and call `onlyContracts` setters on
   *  storage contracts directly. */
  let opSigner: SignerWithAddress;

  async function deployFixture() {
    await hre.deployments.fixture([
      'Token',
      'Hub',
      'ParametersStorage',
      'WhitelistStorage',
      'IdentityStorage',
      'ShardingTableStorage',
      'StakingStorage',
      'ProfileStorage',
      'Chronos',
      'EpochStorage',
      'KnowledgeCollectionStorage',
      'AskStorage',
      'DelegatorsInfo',
      'RandomSamplingStorage',
      'ContextGraphValueStorage',
      'ContextGraphStorage',
      'RandomSampling',
      'Profile',
    ]);
    const signers = await hre.ethers.getSigners();
    const Hub = await hre.ethers.getContract<Hub>('Hub');
    await Hub.setContractAddress('HubOwner', signers[0].address);
    // Same opSigner registration pattern as the legacy Phase-10 suite —
    // grants accounts[19] the right to call `onlyContracts` methods on
    // storage contracts directly (createContextGraph, createKnowledgeCollection,
    // setCiphertextChunksCommitment, etc).
    await Hub.setContractAddress('TestStorageOperator', signers[19].address);

    return {
      accounts: signers,
      HubContract: Hub,
      RandomSamplingContract: await hre.ethers.getContract<RandomSampling>('RandomSampling'),
      ChronosContract: await hre.ethers.getContract<Chronos>('Chronos'),
      KCSContract: await hre.ethers.getContract<KnowledgeCollectionStorage>(
        'KnowledgeCollectionStorage',
      ),
      CGStorageContract: await hre.ethers.getContract<ContextGraphStorage>(
        'ContextGraphStorage',
      ),
      CGValueStorage: await hre.ethers.getContract<ContextGraphValueStorage>(
        'ContextGraphValueStorage',
      ),
    };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    const f = await loadFixture(deployFixture);
    accounts = f.accounts;
    HubContract = f.HubContract;
    RandomSamplingContract = f.RandomSamplingContract;
    ChronosContract = f.ChronosContract;
    KCSContract = f.KCSContract;
    CGStorageContract = f.CGStorageContract;
    CGValueStorage = f.CGValueStorage;
    opSigner = accounts[19];
  });

  async function createCG(publishPolicy: number): Promise<bigint> {
    const owner = accounts[1].address;
    const authority =
      publishPolicy === CURATED_POLICY ? accounts[2].address : ethers.ZeroAddress;
    const tx = await CGStorageContract.connect(opSigner).createContextGraph(
      owner,
      [],
      0,
      0,
      publishPolicy,
      authority,
      0,
      ethers.ZeroHash,
    );
    await tx.wait();
    return CGStorageContract.getLatestContextGraphId();
  }

  /**
   * Seed a KC directly on KnowledgeCollectionStorage and register it to the
   * given CG. Returns the new KC id.
   *
   * For curated CGs, pass `ciphertext` to also call
   * `setCiphertextChunksCommitment` — the picker only treats the KC as
   * eligible in the curated draw when a commitment exists.
   */
  async function createKC(args: {
    cgId: bigint;
    endEpoch: bigint;
    ciphertext?: { root: string; count: number };
  }): Promise<bigint> {
    const currentEpoch = await ChronosContract.getCurrentEpoch();
    const createTx = await KCSContract.connect(opSigner).createKnowledgeCollection(
      opSigner.address,
      ethers.ZeroAddress,
      'rfc39-curated-test-op',
      ethers.keccak256(
        ethers.toUtf8Bytes(
          `rfc39-curated-kc-${args.cgId}-${Date.now()}-${Math.random()}`,
        ),
      ),
      1,
      TEST_KC_BYTE_SIZE,
      currentEpoch,
      args.endEpoch,
      0,
      false,
      1,
    );
    const receipt = await createTx.wait();
    const iface = KCSContract.interface;
    const topic = iface.getEvent('KnowledgeCollectionCreated')!.topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === topic);
    if (!log) {
      throw new Error('KnowledgeCollectionCreated event not found');
    }
    const parsed = iface.parseLog(log as unknown as {
      topics: string[];
      data: string;
    })!;
    const kcId = parsed.args[0] as bigint;
    await CGStorageContract.connect(opSigner).registerKCToContextGraph(
      args.cgId,
      kcId,
    );
    if (args.ciphertext) {
      await KCSContract.connect(opSigner).setCiphertextChunksCommitment(
        kcId,
        args.ciphertext.root,
        args.ciphertext.count,
      );
    }
    return kcId;
  }

  async function seedCGValue(cgId: bigint, value: bigint, lifetime = 1n) {
    const currentEpoch = await ChronosContract.getCurrentEpoch();
    await CGValueStorage.connect(opSigner).addCGValueForEpochRange(
      cgId,
      currentEpoch,
      lifetime,
      value,
    );
  }

  function testSeed(i: number): string {
    return ethers.keccak256(
      ethers.solidityPacked(['string', 'uint256'], ['rfc39-curated-draw-', i]),
    );
  }

  describe('Picker — curated CG eligibility', () => {
    it('selects a curated CG with a committed KC (CG-level filter no longer excludes curated)', async () => {
      const cgId = await createCG(CURATED_POLICY);
      const endEpoch = (await ChronosContract.getCurrentEpoch()) + 5n;
      const kcId = await createKC({
        cgId,
        endEpoch,
        ciphertext: { root: SAMPLE_CT_ROOT_A, count: SAMPLE_CT_COUNT_A },
      });
      await seedCGValue(cgId, 1_000n);

      const currentEpoch = await ChronosContract.getCurrentEpoch();
      for (let i = 0; i < 10; i++) {
        const preview = await RandomSamplingContract.previewChallengeForSeed(
          testSeed(i),
          currentEpoch,
        );
        expect(preview.cgId).to.equal(cgId);
        expect(preview.kcId).to.equal(kcId);
        // Step 3 uses ciphertextChunkCount for curated CGs.
        expect(preview.chunkId).to.be.lessThan(BigInt(SAMPLE_CT_COUNT_A));
      }
    });

    it('chunkId is drawn against ciphertextChunkCount, not merkleLeafCount, on a curated KC', async () => {
      // Verify the step-3 leaf-space split by setting a ciphertextChunkCount
      // that is much larger than the KC's merkleLeafCount (1, set in
      // createKC above). If the picker were still reading merkleLeafCount,
      // chunkId would always be 0 — `seed % 1 == 0`. With the curated
      // branch reading ciphertextChunkCount=13, chunkIds across 30 draws
      // should cover several distinct values in [0, 13).
      const cgId = await createCG(CURATED_POLICY);
      const endEpoch = (await ChronosContract.getCurrentEpoch()) + 5n;
      await createKC({
        cgId,
        endEpoch,
        ciphertext: { root: SAMPLE_CT_ROOT_B, count: SAMPLE_CT_COUNT_B },
      });
      await seedCGValue(cgId, 1_000n);

      const currentEpoch = await ChronosContract.getCurrentEpoch();
      const seen = new Set<bigint>();
      for (let i = 0; i < 30; i++) {
        const preview = await RandomSamplingContract.previewChallengeForSeed(
          testSeed(i),
          currentEpoch,
        );
        expect(preview.chunkId).to.be.lessThan(BigInt(SAMPLE_CT_COUNT_B));
        seen.add(preview.chunkId);
      }
      // Sanity: 30 draws against a 13-leaf space should hit at least 4
      // distinct values. A regression to merkleLeafCount=1 would collapse
      // this set to {0}, which is the exact failure we're guarding against.
      expect(seen.size).to.be.greaterThanOrEqual(4);
    });
  });

  describe('Picker — KC-level commitment filter', () => {
    it('skips curated KCs without a commitment and selects only the committed sibling', async () => {
      const cgId = await createCG(CURATED_POLICY);
      const endEpoch = (await ChronosContract.getCurrentEpoch()) + 5n;
      // Two KCs in the same curated CG: one without commitment (legacy /
      // pre-LU-11), one with. The picker should skip the legacy KC every
      // time and consistently return the committed one.
      await createKC({ cgId, endEpoch }); // legacyKcId — no commitment
      const committedKcId = await createKC({
        cgId,
        endEpoch,
        ciphertext: { root: SAMPLE_CT_ROOT_A, count: SAMPLE_CT_COUNT_A },
      });
      await seedCGValue(cgId, 1_000n);

      const currentEpoch = await ChronosContract.getCurrentEpoch();
      // 30 draws — every successful draw must land on the committed KC.
      // MAX_KC_RETRIES is 10, so a draw that hits the legacy KC on every
      // attempt would revert. With 2 KCs, the probability of 10 consecutive
      // hits on the same KC is 1/2^10 ~ 0.1%, so across 30 draws we expect
      // ~zero reverts in practice but tolerate one defensively.
      let successes = 0;
      for (let i = 0; i < 30; i++) {
        try {
          const preview = await RandomSamplingContract.previewChallengeForSeed(
            testSeed(i),
            currentEpoch,
          );
          expect(preview.kcId).to.equal(committedKcId);
          successes++;
        } catch {
          // Tolerated — see note above.
        }
      }
      expect(successes).to.be.greaterThanOrEqual(25);
    });

    it('reverts NoEligibleKnowledgeCollection on a single curated CG whose only KCs lack commitment', async () => {
      const cgId = await createCG(CURATED_POLICY);
      const endEpoch = (await ChronosContract.getCurrentEpoch()) + 5n;
      // Several KCs, none with commitment — every retry hits an
      // uncommitted KC, MAX_KC_RETRIES exhausts, picker reverts.
      await createKC({ cgId, endEpoch });
      await createKC({ cgId, endEpoch });
      await createKC({ cgId, endEpoch });
      await seedCGValue(cgId, 1_000n);

      const currentEpoch = await ChronosContract.getCurrentEpoch();
      await expect(
        RandomSamplingContract.previewChallengeForSeed(testSeed(0), currentEpoch),
      ).to.be.revertedWithCustomError(
        RandomSamplingContract,
        'NoEligibleKnowledgeCollection',
      );
    });
  });

  describe('Storage — direct getter parity', () => {
    it('reads back the persisted commitment via getLatestCiphertextChunksRoot / getCiphertextChunkCount', async () => {
      const cgId = await createCG(CURATED_POLICY);
      const endEpoch = (await ChronosContract.getCurrentEpoch()) + 5n;
      const kcId = await createKC({
        cgId,
        endEpoch,
        ciphertext: { root: SAMPLE_CT_ROOT_A, count: SAMPLE_CT_COUNT_A },
      });
      expect(await KCSContract.getLatestCiphertextChunksRoot(kcId)).to.equal(
        SAMPLE_CT_ROOT_A,
      );
      expect(await KCSContract.getCiphertextChunkCount(kcId)).to.equal(
        SAMPLE_CT_COUNT_A,
      );
    });

    it('returns zero for KCs that never received a commitment (legacy path sentinel)', async () => {
      const cgId = await createCG(OPEN_POLICY);
      const endEpoch = (await ChronosContract.getCurrentEpoch()) + 5n;
      const kcId = await createKC({ cgId, endEpoch });
      expect(await KCSContract.getLatestCiphertextChunksRoot(kcId)).to.equal(
        ethers.ZeroHash,
      );
      expect(await KCSContract.getCiphertextChunkCount(kcId)).to.equal(0);
    });

    it('setCiphertextChunksCommitment rejects partial commitments (zero root)', async () => {
      const cgId = await createCG(CURATED_POLICY);
      const endEpoch = (await ChronosContract.getCurrentEpoch()) + 5n;
      const kcId = await createKC({ cgId, endEpoch });
      await expect(
        KCSContract.connect(opSigner).setCiphertextChunksCommitment(
          kcId,
          ethers.ZeroHash,
          SAMPLE_CT_COUNT_A,
        ),
      ).to.be.revertedWith('Invalid ciphertext commitment');
    });

    it('setCiphertextChunksCommitment rejects partial commitments (zero count)', async () => {
      const cgId = await createCG(CURATED_POLICY);
      const endEpoch = (await ChronosContract.getCurrentEpoch()) + 5n;
      const kcId = await createKC({ cgId, endEpoch });
      await expect(
        KCSContract.connect(opSigner).setCiphertextChunksCommitment(
          kcId,
          SAMPLE_CT_ROOT_A,
          0,
        ),
      ).to.be.revertedWith('Invalid ciphertext commitment');
    });
  });
});
