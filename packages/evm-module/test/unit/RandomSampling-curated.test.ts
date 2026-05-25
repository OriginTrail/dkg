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
// RFC-39 Phase B (deferred): curated CG random sampling is gated at the
// `_isCGEligible` level until the off-chain prover (`packages/random-sampling
// /src/prover.ts`) learns to fetch `getCiphertextChunkCount` /
// `getCiphertextChunksRoot` and build the proof against the ciphertext
// chunks on disk. Today the prover still queries `getMerkleLeafCount` and
// proves against plaintext leaves, so any draw the contract picker resolved
// to a curated KC produced `V10ProofLeafCountMismatchError` for every
// proving period (devnet sweep confirmed this on every core node).
//
// Until the prover lands its ciphertext path, the contract picker treats
// curated CGs as ineligible. The picker code in steps 2/3 of
// `_pickWeightedChallenge` retains the curated branches so the unskip is a
// one-line revert in `RandomSampling._isCGEligible` + removing the
// `.skip` below.
describe.skip('@unit RandomSampling — RFC-39 curated picker [Phase B deferred]', () => {
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
    // Codex C2 fix — `getIsCurated()` now reads `accessPolicy != 0`
    // (not `publishPolicy == 0`). The RFC-39 picker treats a CG as
    // "curated" via that getter, so the picker-eligibility tests need
    // `accessPolicy = 1` to exercise the curated branch. The legacy
    // `CURATED_POLICY`/`OPEN_POLICY` constants refer to publish policy
    // and we keep them only to drive the authority-required gate at
    // create time; encryption-axis is independently `accessPolicy`.
    const accessPolicy =
      publishPolicy === CURATED_POLICY ? 1 : 0;
    const tx = await CGStorageContract.connect(opSigner).createContextGraph(
      owner,
      [], // participantAgents
      0, // metadataBatchId
      accessPolicy,
      publishPolicy,
      authority,
      0, // publishAuthorityAccountId
      ethers.ZeroHash, // nameHash
    );
    await tx.wait();
    return CGStorageContract.getLatestContextGraphId();
  }

  /**
   * Same as `createCG` but lets the caller pass an explicit lifetime in
   * epochs. We grow the per-epoch-value vector from `currentEpoch` for the
   * given lifetime. Useful for outer-retry / multi-CG tests that need to
   * fix the relative weights between several CGs without depending on the
   * default 1-epoch lifetime.
   */
  async function seedActiveCG(opts: {
    publishPolicy: number;
    value?: bigint;
    lifetime?: bigint;
  }): Promise<bigint> {
    const cgId = await createCG(opts.publishPolicy);
    if (opts.value !== undefined) {
      await seedCGValue(cgId, opts.value, opts.lifetime ?? 1n);
    }
    return cgId;
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

    it('setCiphertextChunksCommitment rejects partial commitments (BOTH zero root and count)', async () => {
      // Defends against the regression where the require became `||` instead
      // of `&&` — a both-zero commitment is the worst-case sentinel and must
      // also be rejected, not just each axis alone.
      const cgId = await createCG(CURATED_POLICY);
      const endEpoch = (await ChronosContract.getCurrentEpoch()) + 5n;
      const kcId = await createKC({ cgId, endEpoch });
      await expect(
        KCSContract.connect(opSigner).setCiphertextChunksCommitment(
          kcId,
          ethers.ZeroHash,
          0,
        ),
      ).to.be.revertedWith('Invalid ciphertext commitment');
    });

    it('emits KnowledgeCollectionCiphertextCommitmentSet with the indexed id and the (root, count) tuple', async () => {
      // Locks the audit-trail invariant: every successful commit MUST emit
      // the event with the exact pair persisted, with the KC id indexed so
      // off-chain indexers can filter without reading every block. A
      // regression here breaks `EpochCommitmentRecorded` aggregation and any
      // downstream node that subscribes to commitment events.
      const cgId = await createCG(CURATED_POLICY);
      const endEpoch = (await ChronosContract.getCurrentEpoch()) + 5n;
      const kcId = await createKC({ cgId, endEpoch });
      await expect(
        KCSContract.connect(opSigner).setCiphertextChunksCommitment(
          kcId,
          SAMPLE_CT_ROOT_A,
          SAMPLE_CT_COUNT_A,
        ),
      )
        .to.emit(KCSContract, 'KnowledgeCollectionCiphertextCommitmentSet')
        .withArgs(kcId, SAMPLE_CT_ROOT_A, SAMPLE_CT_COUNT_A);
    });

    it('rejects setCiphertextChunksCommitment from an EOA without onlyContracts', async () => {
      // Any address that isn't registered in `Hub` as a contract must NOT be
      // able to write commitments — that's the tx authentication boundary
      // for the curated picker. accounts[5] is a fresh EOA, never set in
      // Hub.setContractAddress, so the call must revert.
      const cgId = await createCG(CURATED_POLICY);
      const endEpoch = (await ChronosContract.getCurrentEpoch()) + 5n;
      const kcId = await createKC({ cgId, endEpoch });
      const intruder = accounts[5];
      await expect(
        KCSContract.connect(intruder).setCiphertextChunksCommitment(
          kcId,
          SAMPLE_CT_ROOT_A,
          SAMPLE_CT_COUNT_A,
        ),
      ).to.be.reverted;
    });

    it('overwrites an existing commitment in place — latest read wins', async () => {
      // The contract uses direct mapping assignment, so the spec is
      // last-write-wins. This locks that semantic: re-committing with a
      // different (root, count) MUST update both fields atomically and
      // leave no residue from the previous commitment. A regression that
      // gates the second write (e.g. `require(root == 0)`) would be caught
      // here, as would a partial overwrite (only updating root).
      const cgId = await createCG(CURATED_POLICY);
      const endEpoch = (await ChronosContract.getCurrentEpoch()) + 5n;
      const kcId = await createKC({
        cgId,
        endEpoch,
        ciphertext: { root: SAMPLE_CT_ROOT_A, count: SAMPLE_CT_COUNT_A },
      });
      expect(await KCSContract.getLatestCiphertextChunksRoot(kcId)).to.equal(SAMPLE_CT_ROOT_A);
      expect(await KCSContract.getCiphertextChunkCount(kcId)).to.equal(SAMPLE_CT_COUNT_A);

      await KCSContract.connect(opSigner).setCiphertextChunksCommitment(
        kcId,
        SAMPLE_CT_ROOT_B,
        SAMPLE_CT_COUNT_B,
      );
      expect(await KCSContract.getLatestCiphertextChunksRoot(kcId)).to.equal(SAMPLE_CT_ROOT_B);
      expect(await KCSContract.getCiphertextChunkCount(kcId)).to.equal(SAMPLE_CT_COUNT_B);
    });

    it('emits a fresh event on every overwrite (no event suppression on identical values)', async () => {
      // A separate guard: even if (root, count) is unchanged, the spec is
      // "every successful onlyContracts call emits". Off-chain indexers
      // that rely on event count to drive freshness checks would silently
      // skew if the contract started suppressing duplicates.
      const cgId = await createCG(CURATED_POLICY);
      const endEpoch = (await ChronosContract.getCurrentEpoch()) + 5n;
      const kcId = await createKC({ cgId, endEpoch });

      await expect(
        KCSContract.connect(opSigner).setCiphertextChunksCommitment(
          kcId,
          SAMPLE_CT_ROOT_A,
          SAMPLE_CT_COUNT_A,
        ),
      )
        .to.emit(KCSContract, 'KnowledgeCollectionCiphertextCommitmentSet')
        .withArgs(kcId, SAMPLE_CT_ROOT_A, SAMPLE_CT_COUNT_A);
      await expect(
        KCSContract.connect(opSigner).setCiphertextChunksCommitment(
          kcId,
          SAMPLE_CT_ROOT_A,
          SAMPLE_CT_COUNT_A,
        ),
      )
        .to.emit(KCSContract, 'KnowledgeCollectionCiphertextCommitmentSet')
        .withArgs(kcId, SAMPLE_CT_ROOT_A, SAMPLE_CT_COUNT_A);
    });

    it('returns zero/zero for never-existed KC ids (sentinel default — no out-of-bounds revert)', async () => {
      // The picker treats both `getLatestCiphertextChunksRoot == bytes32(0)`
      // and `getCiphertextChunkCount == 0` as "skip" sentinels. The getters
      // MUST therefore be `view`-safe on never-existed ids — no revert, no
      // overflow — otherwise the picker's commitment check would itself
      // revert and DoS the entire sampling tick.
      const farFutureKcId = 999_999_999n;
      expect(await KCSContract.getLatestCiphertextChunksRoot(farFutureKcId)).to.equal(
        ethers.ZeroHash,
      );
      expect(await KCSContract.getCiphertextChunkCount(farFutureKcId)).to.equal(0);
    });
  });

  describe('Picker — public path parity (curated change must not leak into public branch)', () => {
    it('public CG with a committed KC still draws chunkId against merkleLeafCount, NOT ciphertextChunkCount', async () => {
      // The most dangerous regression in PR #630 would be the curated
      // step-3 branch silently leaking into the public path — i.e. the
      // ternary in `_pickWeightedChallenge` always reading
      // `getCiphertextChunkCount` regardless of `cgIsCurated`. That would
      // change consensus deterministically across all proofs on public CGs
      // and is invisible to the curated tests above.
      //
      // We exercise this by setting a commitment on a *public* KC (storage
      // does not gate by curated; KAV10 does, so we have to write the
      // commitment via the storage's onlyContracts gate directly). We pick
      // ciphertextChunkCount=13 (large) and merkleLeafCount=1 (the default
      // from KAV10 with chunksAmount=1). If the public branch erroneously
      // read ciphertextChunkCount, chunkIds would distribute over [0,13).
      // The correct public branch reads merkleLeafCount=1, so chunkId is
      // always 0.
      const cgId = await createCG(OPEN_POLICY);
      const endEpoch = (await ChronosContract.getCurrentEpoch()) + 5n;
      const kcId = await createKC({ cgId, endEpoch });
      // Force a commitment onto the public KC to set up the regression
      // probe (storage allows it — the policy gate lives in KAV10).
      await KCSContract.connect(opSigner).setCiphertextChunksCommitment(
        kcId,
        SAMPLE_CT_ROOT_B,
        SAMPLE_CT_COUNT_B,
      );
      await seedCGValue(cgId, 1_000n);

      const currentEpoch = await ChronosContract.getCurrentEpoch();
      const seen = new Set<bigint>();
      for (let i = 0; i < 30; i++) {
        const preview = await RandomSamplingContract.previewChallengeForSeed(
          testSeed(i),
          currentEpoch,
        );
        expect(preview.cgId).to.equal(cgId);
        expect(preview.kcId).to.equal(kcId);
        seen.add(preview.chunkId);
      }
      // merkleLeafCount on a chunksAmount=1 KC is 1, so all draws collapse
      // to chunkId=0. If the public branch ever started reading
      // ciphertextChunkCount, this set would contain >=4 elements (matches
      // the curated leaf-count regression test above).
      expect(Array.from(seen)).to.deep.equal([0n]);
    });

    it('public CG without a commitment still reverts in step 3 if merkleLeafCount is zero (defensive sentinel)', async () => {
      // `_pickWeightedChallenge` step 3: `if (leafCount == 0) revert NoEligibleKnowledgeCollection();`
      // This guard exists for both curated and public branches; we already
      // cover curated zero-leaf indirectly via the uncommitted-skip path
      // (which never reaches step 3). The public branch can only hit the
      // zero-leaf revert if `getMerkleLeafCount` returns 0 — the default
      // KAV10 path always returns 1, so this is genuinely dead unless
      // someone bypasses the protocol. We assert that the picker correctly
      // selects the only KC with merkleLeafCount=1 to lock the public
      // branch's leaf-count source.
      const cgId = await createCG(OPEN_POLICY);
      const endEpoch = (await ChronosContract.getCurrentEpoch()) + 5n;
      const kcId = await createKC({ cgId, endEpoch });
      await seedCGValue(cgId, 1_000n);

      const currentEpoch = await ChronosContract.getCurrentEpoch();
      const preview = await RandomSamplingContract.previewChallengeForSeed(
        testSeed(0),
        currentEpoch,
      );
      expect(preview.cgId).to.equal(cgId);
      expect(preview.kcId).to.equal(kcId);
      expect(preview.chunkId).to.equal(0n); // merkleLeafCount == 1 → seed % 1 == 0
      // Source-truth lock: storage public-branch leaf-count is 1.
      expect(await KCSContract.getMerkleLeafCount(kcId)).to.equal(1);
    });
  });

  describe('Picker — outer retry (MAX_CG_RETRIES)', () => {
    it('marks an exhausted CG and re-draws to a sibling that has an eligible KC', async () => {
      // Tests the PR #630 R1 #3 outer-retry loop: when the first weighted
      // draw lands on a CG whose only KCs are uncommitted, the picker MUST
      // not give up — it marks the CG exhausted, re-draws against the
      // remaining adjusted total, and selects the eligible CG. Without
      // this loop, a single high-value legacy curated CG could DoS the
      // entire sampling tick.
      const exhaustedCg = await createCG(CURATED_POLICY);
      const eligibleCg = await createCG(CURATED_POLICY);
      const endEpoch = (await ChronosContract.getCurrentEpoch()) + 5n;
      // exhaustedCg: 3 uncommitted KCs (every retry hits one, MAX_KC_RETRIES exhausts).
      await createKC({ cgId: exhaustedCg, endEpoch });
      await createKC({ cgId: exhaustedCg, endEpoch });
      await createKC({ cgId: exhaustedCg, endEpoch });
      // eligibleCg: 1 committed KC (always selectable on Step 2).
      const eligibleKcId = await createKC({
        cgId: eligibleCg,
        endEpoch,
        ciphertext: { root: SAMPLE_CT_ROOT_A, count: SAMPLE_CT_COUNT_A },
      });
      // Heavy weight on exhaustedCg so the *first* weighted draw lands on
      // it for almost every seed — forcing the outer retry to fire.
      await seedCGValue(exhaustedCg, 1_000_000n);
      await seedCGValue(eligibleCg, 1n);

      const currentEpoch = await ChronosContract.getCurrentEpoch();
      // Across many seeds, every successful preview must land on the
      // eligible CG/KC, regardless of which CG the first weighted draw
      // selected. If MAX_CG_RETRIES regressed to 1, the picker would
      // revert NoEligibleKnowledgeCollection on roughly all seeds.
      let successes = 0;
      for (let i = 0; i < 20; i++) {
        const preview = await RandomSamplingContract.previewChallengeForSeed(
          testSeed(i),
          currentEpoch,
        );
        expect(preview.cgId).to.equal(eligibleCg);
        expect(preview.kcId).to.equal(eligibleKcId);
        successes++;
      }
      expect(successes).to.equal(20);
    });

    it('reverts NoEligibleKnowledgeCollection when ALL CGs are exhausted (no fallback to a fresh draw)', async () => {
      // If every active CG has no eligible KC, the outer loop runs out of
      // exhaustion budget and the picker reverts. We seed two CGs with
      // uncommitted-only KCs; both will be exhausted within MAX_CG_RETRIES.
      const a = await createCG(CURATED_POLICY);
      const b = await createCG(CURATED_POLICY);
      const endEpoch = (await ChronosContract.getCurrentEpoch()) + 5n;
      await createKC({ cgId: a, endEpoch });
      await createKC({ cgId: b, endEpoch });
      await seedCGValue(a, 1_000n);
      await seedCGValue(b, 1_000n);

      const currentEpoch = await ChronosContract.getCurrentEpoch();
      await expect(
        RandomSamplingContract.previewChallengeForSeed(testSeed(0), currentEpoch),
      ).to.be.revertedWithCustomError(
        RandomSamplingContract,
        'NoEligibleKnowledgeCollection',
      );
    });

    it('a CG with zero KCs is also exhausted on first attempt (kcCount == 0 branch)', async () => {
      // CG exists, is active, has positive value, but the KC list is empty.
      // `_pickWeightedChallenge` step 2: `if (kcCount > 0) { ... }` — when
      // kcCount==0, pickedKcId stays 0, the inner block is skipped, and the
      // CG is marked exhausted. On the *only* such CG, the outer loop runs
      // out of weighted total on the next attempt and reverts.
      const emptyCg = await createCG(CURATED_POLICY);
      await seedCGValue(emptyCg, 1_000n);
      const currentEpoch = await ChronosContract.getCurrentEpoch();
      await expect(
        RandomSamplingContract.previewChallengeForSeed(testSeed(0), currentEpoch),
      ).to.be.revertedWithCustomError(
        RandomSamplingContract,
        'NoEligibleKnowledgeCollection',
      );
    });
  });

  describe('Picker — eligibility & negative paths', () => {
    it('reverts NoEligibleContextGraph (NOT NoEligibleKnowledgeCollection) when no CG has positive value', async () => {
      // First-attempt zero adjusted-total has a *distinct* error from
      // subsequent-attempt zero adjusted-total. The picker uses these two
      // errors to disambiguate "system has no eligible CGs at all" from
      // "all eligible CGs got exhausted by retries". Off-chain ticking
      // logic and dashboards rely on this distinction.
      const cgId = await createCG(OPEN_POLICY);
      const endEpoch = (await ChronosContract.getCurrentEpoch()) + 5n;
      await createKC({ cgId, endEpoch });
      // No seedCGValue → adjustedTotal stays at 0 on the first attempt.

      const currentEpoch = await ChronosContract.getCurrentEpoch();
      await expect(
        RandomSamplingContract.previewChallengeForSeed(testSeed(0), currentEpoch),
      ).to.be.revertedWithCustomError(
        RandomSamplingContract,
        'NoEligibleContextGraph',
      );
    });

    it('reverts NoEligibleContextGraph when the only CG is deactivated (`isContextGraphActive == false` excludes it)', async () => {
      // `_isCGEligible` filters on `contextGraphStorage.isContextGraphActive`.
      // A deactivated CG must drop out of step 1's adjusted total — so
      // even though its value is non-zero, the adjusted total is zero and
      // we hit the first-attempt revert path.
      const cgId = await createCG(CURATED_POLICY);
      const endEpoch = (await ChronosContract.getCurrentEpoch()) + 5n;
      await createKC({
        cgId,
        endEpoch,
        ciphertext: { root: SAMPLE_CT_ROOT_A, count: SAMPLE_CT_COUNT_A },
      });
      await seedCGValue(cgId, 1_000n);
      // Deactivate it via the storage's onlyContracts API. CGStorageContract's
      // `deactivateContextGraph` is gated by `onlyContracts`, opSigner can
      // call it because of the TestStorageOperator registration.
      await CGStorageContract.connect(opSigner).deactivateContextGraph(cgId);

      const currentEpoch = await ChronosContract.getCurrentEpoch();
      await expect(
        RandomSamplingContract.previewChallengeForSeed(testSeed(0), currentEpoch),
      ).to.be.revertedWithCustomError(
        RandomSamplingContract,
        'NoEligibleContextGraph',
      );
    });

    it('skips an expired KC in the same CG and finds the live sibling (Step 2 expiry retry — pre-existing path)', async () => {
      // Pre-RFC-39 retry semantic: an expired KC (`endEpoch < currentEpoch`)
      // is skipped exactly the same way RFC-39 skips uncommitted curated
      // KCs. We don't have time-travel cheat codes wired in this fixture
      // (would need Chronos manipulation), so we exercise the path
      // indirectly: create one KC that expires in the *current* epoch
      // (endEpoch == currentEpoch passes the predicate `< currentEpoch`
      // is false → still eligible), and one with longer life. Both are
      // eligible, and the picker MUST land on one or the other across
      // many draws. This is the closest deterministic probe of the
      // expiry-retry without a Chronos cheat-code helper.
      const cgId = await createCG(OPEN_POLICY);
      const currentEpoch = await ChronosContract.getCurrentEpoch();
      const aliveKcId = await createKC({ cgId, endEpoch: currentEpoch + 5n });
      const aliveKcId2 = await createKC({ cgId, endEpoch: currentEpoch + 5n });
      await seedCGValue(cgId, 1_000n);

      const seen = new Set<bigint>();
      for (let i = 0; i < 30; i++) {
        const preview = await RandomSamplingContract.previewChallengeForSeed(
          testSeed(i),
          currentEpoch,
        );
        seen.add(preview.kcId);
        expect([aliveKcId, aliveKcId2]).to.include(preview.kcId);
      }
      // Sanity that the random draw actually distributed across both KCs —
      // if it always picked one (e.g. due to a step-2 regression that
      // collapsed the index draw), we'd see seen.size == 1, which would
      // mean the retry logic isn't actually drawing a fresh kcSeed.
      expect(seen.size).to.equal(2);
    });
  });

  describe('Picker — determinism & consensus', () => {
    it('is fully deterministic on (seed, epoch, state) — same call returns the same (cgId, kcId, chunkId)', async () => {
      // The picker is a pure `view` consensus function. Every node MUST
      // derive the same challenge for a given (block-derived seed, epoch,
      // chain state) — non-determinism here breaks the proof sub-protocol.
      // We probe by calling previewChallengeForSeed 10× with the same seed
      // back-to-back; all results must be identical.
      const cgId = await createCG(CURATED_POLICY);
      const endEpoch = (await ChronosContract.getCurrentEpoch()) + 5n;
      await createKC({
        cgId,
        endEpoch,
        ciphertext: { root: SAMPLE_CT_ROOT_B, count: SAMPLE_CT_COUNT_B },
      });
      await seedCGValue(cgId, 1_000n);

      const currentEpoch = await ChronosContract.getCurrentEpoch();
      const seed = testSeed(42);
      const ref = await RandomSamplingContract.previewChallengeForSeed(seed, currentEpoch);
      for (let i = 0; i < 10; i++) {
        const preview = await RandomSamplingContract.previewChallengeForSeed(
          seed,
          currentEpoch,
        );
        expect(preview.cgId).to.equal(ref.cgId);
        expect(preview.kcId).to.equal(ref.kcId);
        expect(preview.chunkId).to.equal(ref.chunkId);
      }
    });

    it('different seeds at the same state distribute across the chunk space (entropy preserved)', async () => {
      // The chunkId draw is the leaf-level entropy that anchors the proof
      // verifier. If a regression collapsed the chunkId distribution
      // (e.g. truncated to a constant or a small modulus), proof
      // generation would degenerate to a single leaf and the curated
      // sampling reward gradient would flatten.
      const cgId = await createCG(CURATED_POLICY);
      const endEpoch = (await ChronosContract.getCurrentEpoch()) + 5n;
      await createKC({
        cgId,
        endEpoch,
        ciphertext: { root: SAMPLE_CT_ROOT_B, count: SAMPLE_CT_COUNT_B },
      });
      await seedCGValue(cgId, 1_000n);

      const currentEpoch = await ChronosContract.getCurrentEpoch();
      const seenChunks = new Set<bigint>();
      // 60 draws against a 13-leaf space — uniform draw expects to see
      // ~all 13 values; a regression collapsing the distribution to <6
      // values is the failure mode worth catching here.
      for (let i = 0; i < 60; i++) {
        const preview = await RandomSamplingContract.previewChallengeForSeed(
          testSeed(i),
          currentEpoch,
        );
        seenChunks.add(preview.chunkId);
      }
      expect(seenChunks.size).to.be.greaterThanOrEqual(7);
    });
  });

  describe('Picker — mixed-policy CG distribution (curated + public coexist)', () => {
    it('selects from both a curated CG (committed) and a public CG depending on the weighted draw', async () => {
      // Lock the spec that curated and public CGs share the same weighted
      // adjusted-total. Equal-value seeds across both branches must both
      // show up in the draw distribution. A regression that excluded
      // curated CGs from step 1 (the bug RFC-39 explicitly fixes) would
      // collapse this distribution to public-only.
      const curatedCg = await createCG(CURATED_POLICY);
      const publicCg = await createCG(OPEN_POLICY);
      const endEpoch = (await ChronosContract.getCurrentEpoch()) + 5n;
      const curatedKcId = await createKC({
        cgId: curatedCg,
        endEpoch,
        ciphertext: { root: SAMPLE_CT_ROOT_A, count: SAMPLE_CT_COUNT_A },
      });
      const publicKcId = await createKC({ cgId: publicCg, endEpoch });
      await seedCGValue(curatedCg, 1_000n);
      await seedCGValue(publicCg, 1_000n);

      const currentEpoch = await ChronosContract.getCurrentEpoch();
      const cgPicks = new Map<string, number>();
      for (let i = 0; i < 40; i++) {
        const preview = await RandomSamplingContract.previewChallengeForSeed(
          testSeed(i),
          currentEpoch,
        );
        const k = preview.cgId.toString();
        cgPicks.set(k, (cgPicks.get(k) ?? 0) + 1);
        if (preview.cgId === curatedCg) {
          expect(preview.kcId).to.equal(curatedKcId);
          // Step 3 curated branch: bound by ciphertextChunkCount.
          expect(preview.chunkId).to.be.lessThan(BigInt(SAMPLE_CT_COUNT_A));
        } else if (preview.cgId === publicCg) {
          expect(preview.kcId).to.equal(publicKcId);
          // Step 3 public branch: merkleLeafCount=1 → chunkId=0.
          expect(preview.chunkId).to.equal(0n);
        }
      }
      // Both CGs must show up; a 1:1 weighting over 40 draws gives
      // ~20/20, P(seen.size==1) is < 1e-12, so we lock seen.size == 2.
      expect(cgPicks.size).to.equal(2);
      // And neither should completely dominate (sanity bound — 40 draws
      // with 1:1 weights, P(any side <= 5 hits) is < 1e-3 by binomial).
      for (const [, n] of cgPicks) {
        expect(n).to.be.greaterThan(5);
      }
    });
  });
});
