import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { EventLog } from 'ethers';
import hre, { ethers } from 'hardhat';

import parameters from '../../deployments/parameters.json';
import {
  Hub,
  RandomSamplingStorage,
  Chronos,
  KnowledgeCollectionStorage,
  RandomSampling,
} from '../../typechain';
import { RandomSamplingLib } from '../../typechain/contracts/storage/RandomSamplingStorage';

const HUNDRED_ETH = ethers.parseEther('100');

// Helper functions for random sampling
async function createMockChallenge(
  randomSampling: RandomSampling,
  knowledgeCollectionStorage: KnowledgeCollectionStorage,
  chronos: Chronos,
): Promise<RandomSamplingLib.ChallengeStruct> {
  const currentEpoch = await chronos.getCurrentEpoch();
  await randomSampling.updateAndGetActiveProofPeriodStartBlock();
  const { activeProofPeriodStartBlock } =
    await randomSampling.getActiveProofPeriodStatus();
  const proofingPeriodDuration =
    await randomSampling.getActiveProofingPeriodDurationInBlocks();

  return {
    knowledgeCollectionId: 1n,
    chunkId: 1n,
    knowledgeCollectionStorageContract:
      await knowledgeCollectionStorage.getAddress(),
    epoch: currentEpoch,
    activeProofPeriodStartBlock,
    proofingPeriodDurationInBlocks: proofingPeriodDuration,
    solved: false,
  };
}

type RandomStorageFixture = {
  accounts: SignerWithAddress[];
  RandomSamplingStorage: RandomSamplingStorage;
  Hub: Hub;
  Chronos: Chronos;
  RandomSampling: RandomSampling;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function impersonateAndFund(contract: any) {
  await hre.network.provider.request({
    method: 'hardhat_impersonateAccount',
    params: [await contract.getAddress()],
  });

  await hre.network.provider.send('hardhat_setBalance', [
    await contract.getAddress(),
    `0x${HUNDRED_ETH.toString(16)}`,
  ]);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function stopImpersonate(contract: any) {
  await hre.network.provider.request({
    method: 'hardhat_stopImpersonatingAccount',
    params: [await contract.getAddress()],
  });
}

describe('@unit RandomSamplingStorage', function () {
  let Hub: Hub;
  let RandomSamplingStorage: RandomSamplingStorage;
  let RandomSampling: RandomSampling;
  let Chronos: Chronos;
  let KnowledgeCollectionStorage: KnowledgeCollectionStorage;
  let MockChallenge: RandomSamplingLib.ChallengeStruct;
  let accounts: SignerWithAddress[];

  const proofingPeriodDurationInBlocks =
    parameters.development.RandomSamplingStorage.hardhat
      .proofingPeriodDurationInBlocks;
  const w1 = parameters.development.RandomSamplingStorage.hardhat.W1;
  const w2 = parameters.development.RandomSamplingStorage.hardhat.W2;

  async function deployRandomSamplingFixture(): Promise<RandomStorageFixture> {
    await hre.deployments.fixture([
      'Token',
      'KnowledgeCollectionStorage',
      'KnowledgeCollection',
      'RandomSamplingStorage',
      'RandomSampling',
      'ShardingTableStorage',
      'EpochStorage',
      'Profile',
    ]);

    Hub = await hre.ethers.getContract<Hub>('Hub');
    accounts = await ethers.getSigners();
    Chronos = await hre.ethers.getContract<Chronos>('Chronos');

    // Use the deployed RandomSamplingStorage instance instead of creating a new one
    RandomSamplingStorage = await hre.ethers.getContract<RandomSamplingStorage>(
      'RandomSamplingStorage',
    );

    RandomSampling =
      await hre.ethers.getContract<RandomSampling>('RandomSampling');
    KnowledgeCollectionStorage =
      await hre.ethers.getContract<KnowledgeCollectionStorage>(
        'KnowledgeCollectionStorage',
      );

    await RandomSamplingStorage.initialize();
    await RandomSampling.initialize();

    return {
      accounts,
      RandomSamplingStorage,
      Hub,
      Chronos,
      RandomSampling,
    };
  }

  // async function updateAndGetActiveProofPeriod() {
  //   const tx =
  //     await RandomSamplingStorage.updateAndGetActiveProofPeriodStartBlock();
  //   await tx.wait();
  //   return await RandomSamplingStorage.getActiveProofPeriodStatus();
  // }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({ RandomSamplingStorage, Chronos, RandomSampling } = await loadFixture(
      deployRandomSamplingFixture,
    ));

    MockChallenge = await createMockChallenge(
      RandomSampling,
      KnowledgeCollectionStorage,
      Chronos,
    );
  });

  describe('constructor', () => {
    it('Should set correct initial values', async () => {
      // Check initial values set in constructor
      expect(await RandomSamplingStorage.hub()).to.equal(Hub.target);
      expect(
        await RandomSamplingStorage.getLatestProofingPeriodDurationInBlocks(),
      ).to.equal(proofingPeriodDurationInBlocks);
      expect(await RandomSamplingStorage.w1()).to.equal(w1);
      expect(await RandomSamplingStorage.w2()).to.equal(w2);
    });

    it('Should revert if proofingPeriodDurationInBlocks is 0', async () => {
      const RandomSamplingStorageFactory = await hre.ethers.getContractFactory(
        'RandomSamplingStorage',
      );
      await expect(
        RandomSamplingStorageFactory.deploy(Hub.target, 0, w1, w2),
      ).to.be.revertedWith(
        'Proofing period duration in blocks must be greater than 0',
      );
    });
  });

  describe('setW1() and W1 getter', () => {
    it('Should update W1 correctly and revert for non-owners', async () => {
      // Test successful update by owner
      const newW1 = hre.ethers.parseUnits('2', 18);
      const oldW1 = await RandomSamplingStorage.w1();

      const tx = await RandomSamplingStorage.setW1(newW1);
      await tx.wait();

      await expect(tx)
        .to.emit(RandomSamplingStorage, 'W1Set')
        .withArgs(oldW1, newW1);

      // Test getW1() function
      expect(await RandomSamplingStorage.getW1()).to.equal(newW1);

      // // TODO: Fails because the hubOwner is not a multisig, but an individual account
      // // Test revert for non-owner
      // await expect(RandomSamplingStorage.connect(accounts[1]).setW1(newW1))
      //   .to.be.revertedWithCustomError(RandomSampling, 'UnauthorizedAccess')
      //   .withArgs('Only Hub Owner');
    });
  });

  describe('setW2() and W2 getter', () => {
    it('Should update W2 correctly and revert for non-owners', async () => {
      // Test successful update by owner
      const newW2 = hre.ethers.parseUnits('3', 18);
      const oldW2 = await RandomSamplingStorage.w2();

      const tx = await RandomSamplingStorage.setW2(newW2);
      await tx.wait();

      await expect(tx)
        .to.emit(RandomSamplingStorage, 'W2Set')
        .withArgs(oldW2, newW2);

      // Test getW2() function
      expect(await RandomSamplingStorage.getW2()).to.equal(newW2);

      // TODO: This test fails because the hubOwner is not a multisig, but an individual account
      // await expect(RandomSamplingStorage.connect(accounts[1]).setW2(newW2))
      //   .to.be.revertedWithCustomError(RandomSampling, 'UnauthorizedAccess')
      //   .withArgs('Only Hub Owner');
    });
  });

  describe('Scoring System', () => {
    it('Should increment and get epoch node valid proofs count', async () => {
      const nodeId = 1n;
      const currentEpoch = await Chronos.getCurrentEpoch();
      const epochLength = await Chronos.epochLength();

      // Test initial state
      const initialCount =
        await RandomSamplingStorage.getEpochNodeValidProofsCount(
          currentEpoch,
          nodeId,
        );
      expect(initialCount).to.equal(0n, 'Should start with 0 proofs');

      // Test incrementing in current epoch
      await RandomSamplingStorage.incrementEpochNodeValidProofsCount(
        currentEpoch,
        nodeId,
      );
      const countAfterIncrement =
        await RandomSamplingStorage.getEpochNodeValidProofsCount(
          currentEpoch,
          nodeId,
        );
      expect(countAfterIncrement).to.equal(1n, 'Should increment to 1');

      // Test multiple increments
      await RandomSamplingStorage.incrementEpochNodeValidProofsCount(
        currentEpoch,
        nodeId,
      );
      const countAfterMultiple =
        await RandomSamplingStorage.getEpochNodeValidProofsCount(
          currentEpoch,
          nodeId,
        );
      expect(countAfterMultiple).to.equal(2n, 'Should increment to 2');

      // Move to next epoch properly
      await time.increase(Number(epochLength));
      const nextEpoch = await Chronos.getCurrentEpoch();
      expect(nextEpoch).to.equal(currentEpoch + 1n, 'Should be in next epoch');

      // Test in next epoch
      await RandomSamplingStorage.incrementEpochNodeValidProofsCount(
        nextEpoch,
        nodeId,
      );
      const nextEpochCount =
        await RandomSamplingStorage.getEpochNodeValidProofsCount(
          nextEpoch,
          nodeId,
        );
      expect(nextEpochCount).to.equal(1n, 'Should start at 1 in new epoch');
      expect(
        await RandomSamplingStorage.getEpochNodeValidProofsCount(
          currentEpoch,
          nodeId,
        ),
      ).to.equal(2n, 'Previous epoch count should remain unchanged');
    });

    it('Should add to node score and get node score', async () => {
      const nodeIds = [1n, 2n, 3n];
      const currentEpoch = await Chronos.getCurrentEpoch();
      const proofPeriodIndex = 1n;

      // Test initial state for all nodes
      for (const nodeId of nodeIds) {
        expect(
          await RandomSamplingStorage.getNodeEpochProofPeriodScore(
            nodeId,
            currentEpoch,
            proofPeriodIndex,
          ),
        ).to.equal(0n, `Node ${nodeId} should start with 0 score`);
      }

      // Add scores to different nodes
      const scores = [100n, 200n, 300n];

      for (let i = 0; i < nodeIds.length; i++) {
        const nodeId = nodeIds[i];
        const score = scores[i];

        // Add score to node
        await RandomSamplingStorage.addToNodeEpochProofPeriodScore(
          currentEpoch,
          proofPeriodIndex,
          nodeId,
          score,
        );

        // Verify individual node score
        const nodeScore =
          await RandomSamplingStorage.getNodeEpochProofPeriodScore(
            nodeId,
            currentEpoch,
            proofPeriodIndex,
          );
        expect(nodeScore).to.equal(
          score,
          `Node ${nodeId} should have score ${score}`,
        );
      }

      // Test adding more score to existing node
      const additionalScore = 50n;
      await RandomSamplingStorage.addToNodeEpochProofPeriodScore(
        currentEpoch,
        proofPeriodIndex,
        nodeIds[0],
        additionalScore,
      );

      // Verify updated individual score
      const updatedNodeScore =
        await RandomSamplingStorage.getNodeEpochProofPeriodScore(
          nodeIds[0],
          currentEpoch,
          proofPeriodIndex,
        );
      expect(updatedNodeScore).to.equal(
        scores[0] + additionalScore,
        'Node score should be updated with additional score',
      );
    });

    it('Should accumulate delegator scores correctly', async () => {
      const publishingNodeIdentityId = 1n;
      const signer = await ethers.getSigner(accounts[0].address);
      const currentEpoch = await Chronos.getCurrentEpoch();
      const delegatorKey = ethers.encodeBytes32String('delegator1');
      const score = 100n;

      // Test initial state
      expect(
        await RandomSamplingStorage.getEpochNodeDelegatorScore(
          currentEpoch,
          publishingNodeIdentityId,
          delegatorKey,
        ),
      ).to.equal(0n);

      // Add score and verify accumulation
      await RandomSamplingStorage.connect(signer).addToEpochNodeDelegatorScore(
        currentEpoch,
        publishingNodeIdentityId,
        delegatorKey,
        score,
      );
      expect(
        await RandomSamplingStorage.getEpochNodeDelegatorScore(
          currentEpoch,
          publishingNodeIdentityId,
          delegatorKey,
        ),
      ).to.equal(score);

      // Add more score and verify accumulation
      await RandomSamplingStorage.connect(signer).addToEpochNodeDelegatorScore(
        currentEpoch,
        publishingNodeIdentityId,
        delegatorKey,
        score,
      );
      expect(
        await RandomSamplingStorage.getEpochNodeDelegatorScore(
          currentEpoch,
          publishingNodeIdentityId,
          delegatorKey,
        ),
      ).to.equal(score * 2n);
    });

    it('Should add to and get nodeEpochScorePerStake correctly and emit event', async () => {
      const nodeId = 1n;
      const currentEpoch = await Chronos.getCurrentEpoch();
      const scorePerStakeToAdd = 500n;
      const expectedTotalScorePerStake = 500n;

      // Initial state
      expect(
        await RandomSamplingStorage.getNodeEpochScorePerStake(
          currentEpoch,
          nodeId,
        ),
      ).to.equal(0n, 'Initial nodeEpochScorePerStake should be 0');

      // Add scorePerStake and check event
      await expect(
        RandomSamplingStorage.addToNodeEpochScorePerStake(
          currentEpoch,
          nodeId,
          scorePerStakeToAdd,
        ),
      )
        .to.emit(RandomSamplingStorage, 'NodeEpochScorePerStakeAdded')
        .withArgs(
          currentEpoch,
          nodeId,
          scorePerStakeToAdd,
          expectedTotalScorePerStake,
        );

      // Verify stored value
      expect(
        await RandomSamplingStorage.getNodeEpochScorePerStake(
          currentEpoch,
          nodeId,
        ),
      ).to.equal(
        expectedTotalScorePerStake,
        `nodeEpochScorePerStake should be ${expectedTotalScorePerStake}`,
      );

      // Add more and verify accumulation
      const anotherScorePerStakeToAdd = 300n;
      const newExpectedTotalScorePerStake =
        expectedTotalScorePerStake + anotherScorePerStakeToAdd;
      await expect(
        RandomSamplingStorage.addToNodeEpochScorePerStake(
          currentEpoch,
          nodeId,
          anotherScorePerStakeToAdd,
        ),
      )
        .to.emit(RandomSamplingStorage, 'NodeEpochScorePerStakeAdded')
        .withArgs(
          currentEpoch,
          nodeId,
          anotherScorePerStakeToAdd,
          newExpectedTotalScorePerStake,
        );

      expect(
        await RandomSamplingStorage.getNodeEpochScorePerStake(
          currentEpoch,
          nodeId,
        ),
      ).to.equal(
        newExpectedTotalScorePerStake,
        `nodeEpochScorePerStake should be ${newExpectedTotalScorePerStake}`,
      );

      // Test different node
      const anotherNodeId = 2n;
      await expect(
        RandomSamplingStorage.addToNodeEpochScorePerStake(
          currentEpoch,
          anotherNodeId,
          scorePerStakeToAdd,
        ),
      )
        .to.emit(RandomSamplingStorage, 'NodeEpochScorePerStakeAdded')
        .withArgs(
          currentEpoch,
          anotherNodeId,
          scorePerStakeToAdd,
          scorePerStakeToAdd,
        );
      expect(
        await RandomSamplingStorage.getNodeEpochScorePerStake(
          currentEpoch,
          anotherNodeId,
        ),
      ).to.equal(scorePerStakeToAdd);

      // Test different epoch
      await time.increase(Number(await Chronos.epochLength()));
      const nextEpoch = await Chronos.getCurrentEpoch();
      await expect(
        RandomSamplingStorage.addToNodeEpochScorePerStake(
          nextEpoch,
          nodeId,
          scorePerStakeToAdd,
        ),
      )
        .to.emit(RandomSamplingStorage, 'NodeEpochScorePerStakeAdded')
        .withArgs(
          nextEpoch,
          nodeId,
          scorePerStakeToAdd,
          expectedTotalScorePerStake,
        );
      expect(
        await RandomSamplingStorage.getNodeEpochScorePerStake(
          nextEpoch,
          nodeId,
        ),
      ).to.equal(scorePerStakeToAdd);
    });
  });

  describe('Initialization', () => {
    it('Should have correct name and version', async () => {
      expect(await RandomSamplingStorage.name()).to.equal(
        'RandomSamplingStorage',
      );
      expect(await RandomSamplingStorage.version()).to.equal('3.0.0');
    });

    it('Should set the initial parameters correctly', async function () {
      const proofingPeriod =
        await RandomSamplingStorage.proofingPeriodDurations(0);
      expect(proofingPeriod.durationInBlocks).to.equal(
        proofingPeriodDurationInBlocks,
      );
      const currentEpochTx = await Chronos.getCurrentEpoch();
      const currentEpoch = BigInt(currentEpochTx.toString());
      expect(proofingPeriod.effectiveEpoch).to.equal(currentEpoch);
    });

    it('Should set correct Chronos reference and epoch on initialize', async () => {
      const currentEpoch = await Chronos.getCurrentEpoch();
      await RandomSamplingStorage.initialize();
      const proofingPeriod =
        await RandomSamplingStorage.proofingPeriodDurations(0);
      expect(proofingPeriod.effectiveEpoch).to.equal(currentEpoch);
    });

    it('Should set correct initial values', async () => {
      const currentEpoch = await Chronos.getCurrentEpoch();

      // Deploy a new instance to check initial values before initialization
      const RandomSamplingStorageFactory = await hre.ethers.getContractFactory(
        'RandomSamplingStorage',
      );
      const newRandomSamplingStorage =
        await RandomSamplingStorageFactory.deploy(
          Hub.target,
          proofingPeriodDurationInBlocks,
          w1,
          w2,
        );

      // Check initial proofing period duration
      const initialDuration =
        await newRandomSamplingStorage.proofingPeriodDurations(0);
      expect(initialDuration.durationInBlocks).to.equal(
        proofingPeriodDurationInBlocks,
      );
      expect(initialDuration.effectiveEpoch).to.equal(currentEpoch);
    });

    it('Should update effectiveEpoch to current epoch after initialize', async () => {
      const currentEpoch = await Chronos.getCurrentEpoch();
      await RandomSamplingStorage.initialize();
      const initialDuration =
        await RandomSamplingStorage.proofingPeriodDurations(0);
      expect(initialDuration.effectiveEpoch).to.equal(currentEpoch);
    });

    it('Should set correct CHUNK_BYTE_SIZE constant', async () => {
      expect(await RandomSamplingStorage.CHUNK_BYTE_SIZE()).to.equal(32);
    });
  });

  describe('Access Control', () => {
    beforeEach(async () => {
      // Register RandomSampling in Hub so it can call onlyContracts methods
      const currentRandomSampling =
        await Hub.getContractAddress('RandomSampling');
      if (currentRandomSampling !== (await RandomSampling.getAddress())) {
        await Hub.connect(accounts[0]).setContractAddress(
          'RandomSampling',
          await RandomSampling.getAddress(),
        );
      }
    });

    it('Should revert contact call if not called by Hub', async () => {
      await expect(RandomSamplingStorage.connect(accounts[1]).initialize())
        .to.be.revertedWithCustomError(
          RandomSamplingStorage,
          'UnauthorizedAccess',
        )
        .withArgs('Only Hub');
    });

    it('Should revert contact call on onlyContract modifiers', async () => {
      await expect(
        RandomSamplingStorage.connect(
          accounts[1],
        ).replacePendingProofingPeriodDuration(0, 0),
      )
        .to.be.revertedWithCustomError(
          RandomSamplingStorage,
          'UnauthorizedAccess',
        )
        .withArgs('Only Contracts in Hub');

      await expect(
        RandomSamplingStorage.connect(accounts[1]).addProofingPeriodDuration(
          0,
          0,
        ),
      )
        .to.be.revertedWithCustomError(
          RandomSamplingStorage,
          'UnauthorizedAccess',
        )
        .withArgs('Only Contracts in Hub');

      await expect(
        RandomSamplingStorage.connect(accounts[1]).setNodeChallenge(
          0,
          MockChallenge,
        ),
      )
        .to.be.revertedWithCustomError(
          RandomSamplingStorage,
          'UnauthorizedAccess',
        )
        .withArgs('Only Contracts in Hub');

      await expect(
        RandomSamplingStorage.connect(
          accounts[1],
        ).incrementEpochNodeValidProofsCount(0, 0),
      )
        .to.be.revertedWithCustomError(
          RandomSamplingStorage,
          'UnauthorizedAccess',
        )
        .withArgs('Only Contracts in Hub');

      await expect(
        RandomSamplingStorage.connect(
          accounts[1],
        ).addToNodeEpochProofPeriodScore(0, 0, 0, 0),
      )
        .to.be.revertedWithCustomError(
          RandomSamplingStorage,
          'UnauthorizedAccess',
        )
        .withArgs('Only Contracts in Hub');

      await expect(
        RandomSamplingStorage.connect(accounts[1]).addToNodeEpochScorePerStake(
          0,
          0,
          0,
        ),
      )
        .to.be.revertedWithCustomError(
          RandomSamplingStorage,
          'UnauthorizedAccess',
        )
        .withArgs('Only Contracts in Hub');

      await expect(
        RandomSamplingStorage.connect(
          accounts[1],
        ).setDelegatorLastSettledNodeEpochScorePerStake(
          0,
          0,
          ethers.encodeBytes32String('0'),
          0,
        ),
      )
        .to.be.revertedWithCustomError(
          RandomSamplingStorage,
          'UnauthorizedAccess',
        )
        .withArgs('Only Contracts in Hub');
    });

    it('Should allow access when called by Hub', async () => {
      await expect(RandomSamplingStorage.connect(accounts[0]).initialize()).to
        .not.be.reverted;

      await expect(RandomSamplingStorage.connect(accounts[1]).initialize()).to
        .be.reverted;

      // Test contract-only functions with RandomSampling
      await impersonateAndFund(RandomSampling);
      const rsSigner = await ethers.getSigner(
        await RandomSampling.getAddress(),
      );

      await expect(
        RandomSamplingStorage.connect(rsSigner).setNodeChallenge(
          0,
          MockChallenge,
        ),
      ).to.not.be.reverted;

      await expect(
        RandomSamplingStorage.connect(
          rsSigner,
        ).replacePendingProofingPeriodDuration(0, 0),
      ).to.not.be.reverted;

      await expect(
        RandomSamplingStorage.connect(rsSigner).addProofingPeriodDuration(0, 0),
      ).to.not.be.reverted;

      await expect(
        RandomSamplingStorage.connect(
          rsSigner,
        ).incrementEpochNodeValidProofsCount(1, 1),
      ).to.not.be.reverted;

      await expect(
        RandomSamplingStorage.connect(rsSigner).addToNodeEpochProofPeriodScore(
          1,
          1,
          1,
          1000,
        ),
      ).to.not.be.reverted;

      await expect(
        RandomSamplingStorage.connect(rsSigner).addToNodeEpochScorePerStake(
          1,
          1,
          1000,
        ),
      ).to.not.be.reverted;

      await expect(
        RandomSamplingStorage.connect(
          rsSigner,
        ).setDelegatorLastSettledNodeEpochScorePerStake(
          1,
          1,
          ethers.encodeBytes32String('test'),
          1000,
        ),
      ).to.not.be.reverted;

      await stopImpersonate(RandomSampling);
    });

    it('Should allow access when called by registered contract', async () => {
      // Test contract-only functions with RandomSampling
      await impersonateAndFund(RandomSampling);
      const rsSigner = await ethers.getSigner(
        await RandomSampling.getAddress(),
      );

      await expect(
        RandomSamplingStorage.connect(
          rsSigner,
        ).replacePendingProofingPeriodDuration(1000, 1),
      ).to.not.be.reverted;

      await expect(
        RandomSamplingStorage.connect(rsSigner).addProofingPeriodDuration(
          1000,
          1,
        ),
      ).to.not.be.reverted;

      await expect(
        RandomSamplingStorage.connect(rsSigner).setNodeChallenge(
          1,
          MockChallenge,
        ),
      ).to.not.be.reverted;

      await expect(
        RandomSamplingStorage.connect(
          rsSigner,
        ).incrementEpochNodeValidProofsCount(1, 1),
      ).to.not.be.reverted;

      await expect(
        RandomSamplingStorage.connect(rsSigner).addToNodeEpochProofPeriodScore(
          1,
          1,
          1,
          1000,
        ),
      ).to.not.be.reverted;

      await expect(
        RandomSamplingStorage.connect(rsSigner).addToNodeEpochScorePerStake(
          1,
          1,
          1000,
        ),
      ).to.not.be.reverted;

      await expect(
        RandomSamplingStorage.connect(
          rsSigner,
        ).setDelegatorLastSettledNodeEpochScorePerStake(
          1,
          1,
          ethers.encodeBytes32String('test'),
          1000,
        ),
      ).to.not.be.reverted;

      await stopImpersonate(RandomSampling);
    });
  });

  describe('Challenge Handling', () => {
    it('Should set and get challenge correctly', async () => {
      const publishingNodeIdentityId = 1n;

      const signer = await ethers.getSigner(accounts[0].address);
      await RandomSamplingStorage.connect(signer).setNodeChallenge(
        publishingNodeIdentityId,
        MockChallenge,
      );

      const challenge = await RandomSamplingStorage.getNodeChallenge(
        publishingNodeIdentityId,
      );

      expect(challenge.knowledgeCollectionId).to.be.equal(
        MockChallenge.knowledgeCollectionId,
      );
      expect(challenge.chunkId).to.be.equal(MockChallenge.chunkId);
      expect(challenge.epoch).to.be.equal(MockChallenge.epoch);
      expect(challenge.proofingPeriodDurationInBlocks).to.be.equal(
        MockChallenge.proofingPeriodDurationInBlocks,
      );
      expect(challenge.activeProofPeriodStartBlock).to.be.equal(
        MockChallenge.activeProofPeriodStartBlock,
      );
      expect(challenge.proofingPeriodDurationInBlocks).to.be.equal(
        MockChallenge.proofingPeriodDurationInBlocks,
      );
      expect(challenge.solved).to.be.equal(MockChallenge.solved);
    });

    it('Should handle multiple challenges and updates correctly', async () => {
      const publishingNodeIdentityId = 1n;

      const signer = await ethers.getSigner(accounts[0].address);

      // Test initial state
      const initialChallenge = await RandomSamplingStorage.getNodeChallenge(
        publishingNodeIdentityId,
      );
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(initialChallenge.solved).to.be.false;
      expect(initialChallenge.knowledgeCollectionId).to.be.equal(0n);

      // Set first challenge
      await RandomSamplingStorage.connect(signer).setNodeChallenge(
        publishingNodeIdentityId,
        MockChallenge,
      );

      // Verify first challenge
      const firstChallenge = await RandomSamplingStorage.getNodeChallenge(
        publishingNodeIdentityId,
      );
      expect(firstChallenge.knowledgeCollectionId).to.be.equal(
        MockChallenge.knowledgeCollectionId,
      );
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(firstChallenge.solved).to.be.equal(MockChallenge.solved);

      // Create and set second challenge
      const secondChallenge = {
        ...MockChallenge,
        knowledgeCollectionId: BigInt(MockChallenge.knowledgeCollectionId) + 1n,
        solved: true,
      };
      await RandomSamplingStorage.connect(signer).setNodeChallenge(
        publishingNodeIdentityId,
        secondChallenge,
      );

      // Verify second challenge overwrote first
      const finalChallenge = await RandomSamplingStorage.getNodeChallenge(
        publishingNodeIdentityId,
      );
      expect(finalChallenge.knowledgeCollectionId).to.be.equal(
        secondChallenge.knowledgeCollectionId,
      );
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(finalChallenge.solved).to.be.true;
      expect(finalChallenge.chunkId).to.be.equal(secondChallenge.chunkId);
    });
  });

  describe('Proofing Period Duration Management', () => {
    it('Should correctly track pending proofing period duration', async () => {
      const currentEpoch = await Chronos.getCurrentEpoch();

      // Initially should be false
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(await RandomSampling.isPendingProofingPeriodDuration()).to.be
        .false;

      // Add a new duration
      await RandomSamplingStorage.addProofingPeriodDuration(
        1000,
        currentEpoch + 1n,
      );
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(await RandomSampling.isPendingProofingPeriodDuration()).to.be.true;

      // Replace pending duration
      await RandomSamplingStorage.replacePendingProofingPeriodDuration(
        2000,
        currentEpoch + 1n,
      );
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(await RandomSampling.isPendingProofingPeriodDuration()).to.be.true;

      // Move to next epoch
      await time.increase(Number(await Chronos.epochLength()));
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(await RandomSampling.isPendingProofingPeriodDuration()).to.be
        .false;
    });

    it('Should handle multiple proofing period durations correctly', async () => {
      const currentEpoch = await Chronos.getCurrentEpoch();

      // Add multiple durations
      const durations = [1000, 2000, 3000];
      for (let i = 0; i < durations.length; i++) {
        await RandomSamplingStorage.addProofingPeriodDuration(
          durations[i],
          currentEpoch + BigInt(i + 1),
        );
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        expect(await RandomSampling.isPendingProofingPeriodDuration()).to.be
          .true;
      }

      // Verify durations are set correctly
      for (let i = 0; i < durations.length; i++) {
        const epoch = currentEpoch + BigInt(i + 1);
        const duration =
          await RandomSamplingStorage.getEpochProofingPeriodDurationInBlocks(
            epoch,
          );
        expect(duration).to.equal(BigInt(durations[i]));
      }
    });

    it('Should replace pending duration correctly', async () => {
      const currentEpoch = await Chronos.getCurrentEpoch();

      // Add initial duration
      await RandomSamplingStorage.addProofingPeriodDuration(
        1000,
        currentEpoch + 1n,
      );
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(await RandomSampling.isPendingProofingPeriodDuration()).to.be.true;

      // Replace with new duration
      const newDuration = 2000;
      await RandomSamplingStorage.replacePendingProofingPeriodDuration(
        newDuration,
        currentEpoch + 1n,
      );

      // Verify new duration is set
      const duration =
        await RandomSamplingStorage.getEpochProofingPeriodDurationInBlocks(
          currentEpoch + 1n,
        );
      expect(duration).to.equal(BigInt(newDuration));
    });

    it('Should emit ProofingPeriodDurationAdded event with correct parameters', async () => {
      const newDuration = 1000;
      const effectiveEpoch = (await Chronos.getCurrentEpoch()) + 1n;

      // Add new proofing period duration and capture the event
      const tx = await RandomSamplingStorage.addProofingPeriodDuration(
        newDuration,
        effectiveEpoch,
      );
      const receipt = await tx.wait();

      // Find the ProofingPeriodDurationAdded event
      const event = receipt?.logs.find(
        (log) =>
          (log as EventLog).fragment?.name === 'ProofingPeriodDurationAdded',
      ) as EventLog;

      // Verify event parameters
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(event).to.not.be.undefined;
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(event?.args).to.not.be.undefined;
      expect(event?.args[0]).to.equal(newDuration);
      expect(event?.args[1]).to.equal(effectiveEpoch);
    });

    it('Should emit PendingProofingPeriodDurationReplaced event with correct parameters', async () => {
      const oldDuration = 1000;
      const newDuration = 2000;
      const effectiveEpoch = (await Chronos.getCurrentEpoch()) + 1n;

      // First add a duration
      await RandomSamplingStorage.addProofingPeriodDuration(
        oldDuration,
        effectiveEpoch,
      );

      // Then replace it and capture the event
      const tx =
        await RandomSamplingStorage.replacePendingProofingPeriodDuration(
          newDuration,
          effectiveEpoch,
        );
      const receipt = await tx.wait();

      // Find the PendingProofingPeriodDurationReplaced event
      const event = receipt?.logs.find(
        (log) =>
          (log as EventLog).fragment?.name ===
          'PendingProofingPeriodDurationReplaced',
      ) as EventLog;

      // Verify event parameters
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(event).to.not.be.undefined;
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(event?.args).to.not.be.undefined;
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(event?.args[0]).to.equal(oldDuration);
      expect(event?.args[1]).to.equal(newDuration);
      expect(event?.args[2]).to.equal(effectiveEpoch);
    });
  });

  describe('Active Proof Period Management', () => {
    it('Should set and get active proof period start block correctly and emit event', async () => {
      const newActiveProofPeriodStartBlock = 12345n;

      // Impersonate RandomSampling contract to call onlyContracts function
      await impersonateAndFund(RandomSampling);
      const rsSigner = await ethers.getSigner(
        await RandomSampling.getAddress(),
      );

      // Set active proof period start block and check event
      await expect(
        RandomSamplingStorage.connect(rsSigner).setActiveProofPeriodStartBlock(
          newActiveProofPeriodStartBlock,
        ),
      )
        .to.emit(RandomSamplingStorage, 'ActiveProofPeriodStartBlockSet')
        .withArgs(newActiveProofPeriodStartBlock);

      // Verify stored value
      expect(
        await RandomSamplingStorage.getActiveProofPeriodStartBlock(),
      ).to.equal(
        newActiveProofPeriodStartBlock,
        `Active proof period start block should be ${newActiveProofPeriodStartBlock}`,
      );

      // Test updating to new value
      const anotherBlockNumber = 67890n;
      await expect(
        RandomSamplingStorage.connect(rsSigner).setActiveProofPeriodStartBlock(
          anotherBlockNumber,
        ),
      )
        .to.emit(RandomSamplingStorage, 'ActiveProofPeriodStartBlockSet')
        .withArgs(anotherBlockNumber);

      expect(
        await RandomSamplingStorage.getActiveProofPeriodStartBlock(),
      ).to.equal(
        anotherBlockNumber,
        `Active proof period start block should be updated to ${anotherBlockNumber}`,
      );

      await stopImpersonate(RandomSampling);
    });

    it('Should revert if not called by contracts', async () => {
      await expect(
        RandomSamplingStorage.connect(
          accounts[1],
        ).setActiveProofPeriodStartBlock(123),
      )
        .to.be.revertedWithCustomError(
          RandomSamplingStorage,
          'UnauthorizedAccess',
        )
        .withArgs('Only Contracts in Hub');
    });
  });

  describe('Proofing Period Duration Helper Functions', () => {
    beforeEach(async () => {
      // Add some test durations
      await impersonateAndFund(RandomSampling);
      const rsSigner = await ethers.getSigner(
        await RandomSampling.getAddress(),
      );

      const currentEpoch = await Chronos.getCurrentEpoch();
      await RandomSamplingStorage.connect(rsSigner).addProofingPeriodDuration(
        1000,
        currentEpoch + 1n,
      );
      await RandomSamplingStorage.connect(rsSigner).addProofingPeriodDuration(
        2000,
        currentEpoch + 2n,
      );

      await stopImpersonate(RandomSampling);
    });

    it('Should return correct proofing period durations length', async () => {
      // Should have initial duration + 2 added durations = 3 total
      expect(
        await RandomSamplingStorage.getProofingPeriodDurationsLength(),
      ).to.equal(3);
    });

    it('Should return latest proofing period duration effective epoch', async () => {
      const currentEpoch = await Chronos.getCurrentEpoch();
      expect(
        await RandomSamplingStorage.getLatestProofingPeriodDurationEffectiveEpoch(),
      ).to.equal(currentEpoch + 2n);
    });

    it('Should return latest proofing period duration in blocks', async () => {
      expect(
        await RandomSamplingStorage.getLatestProofingPeriodDurationInBlocks(),
      ).to.equal(2000);
    });

    it('Should return proofing period duration from specific index', async () => {
      const currentEpoch = await Chronos.getCurrentEpoch();

      // Test index 0 (initial duration)
      const duration0 =
        await RandomSamplingStorage.getProofingPeriodDurationFromIndex(0);
      expect(duration0.durationInBlocks).to.equal(
        proofingPeriodDurationInBlocks,
      );
      expect(duration0.effectiveEpoch).to.equal(currentEpoch);

      // Test index 1 (first added duration)
      const duration1 =
        await RandomSamplingStorage.getProofingPeriodDurationFromIndex(1);
      expect(duration1.durationInBlocks).to.equal(1000);
      expect(duration1.effectiveEpoch).to.equal(currentEpoch + 1n);

      // Test index 2 (second added duration)
      const duration2 =
        await RandomSamplingStorage.getProofingPeriodDurationFromIndex(2);
      expect(duration2.durationInBlocks).to.equal(2000);
      expect(duration2.effectiveEpoch).to.equal(currentEpoch + 2n);
    });

    it('Should revert when accessing invalid index', async () => {
      const length =
        await RandomSamplingStorage.getProofingPeriodDurationsLength();
      // Pin Solidity panic 0x32 (array out-of-bounds). Catching
      // any-revert here would also accept a silent ACL misfire or a
      // wrong-contract stub; panic code 0x32 specifically proves the
      // bounds check itself fired.
      await expect(
        RandomSamplingStorage.getProofingPeriodDurationFromIndex(length),
      ).to.be.revertedWithPanic(0x32);
    });
  });

  describe('Node Epoch Valid Proofs Count Management', () => {
    it('Should set epoch node valid proofs count and emit event', async () => {
      const nodeId = 1n;
      const currentEpoch = await Chronos.getCurrentEpoch();
      const countToSet = 5n;

      // Impersonate RandomSampling contract
      await impersonateAndFund(RandomSampling);
      const rsSigner = await ethers.getSigner(
        await RandomSampling.getAddress(),
      );

      // Set count and check event
      await expect(
        RandomSamplingStorage.connect(rsSigner).setEpochNodeValidProofsCount(
          currentEpoch,
          nodeId,
          countToSet,
        ),
      )
        .to.emit(RandomSamplingStorage, 'EpochNodeValidProofsCountSet')
        .withArgs(currentEpoch, nodeId, countToSet);

      // Verify stored value
      expect(
        await RandomSamplingStorage.getEpochNodeValidProofsCount(
          currentEpoch,
          nodeId,
        ),
      ).to.equal(countToSet);

      // Test overwriting
      const newCount = 10n;
      await expect(
        RandomSamplingStorage.connect(rsSigner).setEpochNodeValidProofsCount(
          currentEpoch,
          nodeId,
          newCount,
        ),
      )
        .to.emit(RandomSamplingStorage, 'EpochNodeValidProofsCountSet')
        .withArgs(currentEpoch, nodeId, newCount);

      expect(
        await RandomSamplingStorage.getEpochNodeValidProofsCount(
          currentEpoch,
          nodeId,
        ),
      ).to.equal(newCount);

      await stopImpersonate(RandomSampling);
    });
  });

  describe('Node Epoch Score Management', () => {
    it('Should add to node epoch score and emit event', async () => {
      const nodeId = 1n;
      const currentEpoch = await Chronos.getCurrentEpoch();
      const scoreToAdd = 1000n;
      const expectedTotalScore = 1000n;

      // Impersonate RandomSampling contract
      await impersonateAndFund(RandomSampling);
      const rsSigner = await ethers.getSigner(
        await RandomSampling.getAddress(),
      );

      // Initial state
      expect(
        await RandomSamplingStorage.getNodeEpochScore(currentEpoch, nodeId),
      ).to.equal(0n);

      // Add score and check event
      await expect(
        RandomSamplingStorage.connect(rsSigner).addToNodeEpochScore(
          currentEpoch,
          nodeId,
          scoreToAdd,
        ),
      )
        .to.emit(RandomSamplingStorage, 'NodeEpochScoreAdded')
        .withArgs(currentEpoch, nodeId, scoreToAdd, expectedTotalScore);

      // Verify stored value
      expect(
        await RandomSamplingStorage.getNodeEpochScore(currentEpoch, nodeId),
      ).to.equal(expectedTotalScore);

      // Add more score and verify accumulation
      const anotherScore = 500n;
      const newExpectedTotal = expectedTotalScore + anotherScore;
      await expect(
        RandomSamplingStorage.connect(rsSigner).addToNodeEpochScore(
          currentEpoch,
          nodeId,
          anotherScore,
        ),
      )
        .to.emit(RandomSamplingStorage, 'NodeEpochScoreAdded')
        .withArgs(currentEpoch, nodeId, anotherScore, newExpectedTotal);

      expect(
        await RandomSamplingStorage.getNodeEpochScore(currentEpoch, nodeId),
      ).to.equal(newExpectedTotal);

      await stopImpersonate(RandomSampling);
    });

    it('Should set node epoch score and emit event', async () => {
      const nodeId = 1n;
      const currentEpoch = await Chronos.getCurrentEpoch();
      const scoreToSet = 2500n;

      // Impersonate RandomSampling contract
      await impersonateAndFund(RandomSampling);
      const rsSigner = await ethers.getSigner(
        await RandomSampling.getAddress(),
      );

      // Set score and check event
      await expect(
        RandomSamplingStorage.connect(rsSigner).setNodeEpochScore(
          currentEpoch,
          nodeId,
          scoreToSet,
        ),
      )
        .to.emit(RandomSamplingStorage, 'NodeEpochScoreSet')
        .withArgs(currentEpoch, nodeId, scoreToSet);

      // Verify stored value
      expect(
        await RandomSamplingStorage.getNodeEpochScore(currentEpoch, nodeId),
      ).to.equal(scoreToSet);

      // Test overwriting
      const newScore = 3000n;
      await expect(
        RandomSamplingStorage.connect(rsSigner).setNodeEpochScore(
          currentEpoch,
          nodeId,
          newScore,
        ),
      )
        .to.emit(RandomSamplingStorage, 'NodeEpochScoreSet')
        .withArgs(currentEpoch, nodeId, newScore);

      expect(
        await RandomSamplingStorage.getNodeEpochScore(currentEpoch, nodeId),
      ).to.equal(newScore);

      await stopImpersonate(RandomSampling);
    });
  });

  describe('All Nodes Epoch Score Management', () => {
    it('Should add to all nodes epoch score and emit event', async () => {
      const currentEpoch = await Chronos.getCurrentEpoch();
      const scoreToAdd = 5000n;
      const expectedTotalScore = 5000n;

      // Impersonate RandomSampling contract
      await impersonateAndFund(RandomSampling);
      const rsSigner = await ethers.getSigner(
        await RandomSampling.getAddress(),
      );

      // Initial state
      expect(
        await RandomSamplingStorage.getAllNodesEpochScore(currentEpoch),
      ).to.equal(0n);

      // Add score and check event
      await expect(
        RandomSamplingStorage.connect(rsSigner).addToAllNodesEpochScore(
          currentEpoch,
          scoreToAdd,
        ),
      )
        .to.emit(RandomSamplingStorage, 'AllNodesEpochScoreAdded')
        .withArgs(currentEpoch, scoreToAdd, expectedTotalScore);

      // Verify stored value
      expect(
        await RandomSamplingStorage.getAllNodesEpochScore(currentEpoch),
      ).to.equal(expectedTotalScore);

      // Add more score and verify accumulation
      const anotherScore = 2000n;
      const newExpectedTotal = expectedTotalScore + anotherScore;
      await expect(
        RandomSamplingStorage.connect(rsSigner).addToAllNodesEpochScore(
          currentEpoch,
          anotherScore,
        ),
      )
        .to.emit(RandomSamplingStorage, 'AllNodesEpochScoreAdded')
        .withArgs(currentEpoch, anotherScore, newExpectedTotal);

      expect(
        await RandomSamplingStorage.getAllNodesEpochScore(currentEpoch),
      ).to.equal(newExpectedTotal);

      await stopImpersonate(RandomSampling);
    });

    it('Should set all nodes epoch score and emit event', async () => {
      const currentEpoch = await Chronos.getCurrentEpoch();
      const scoreToSet = 10000n;

      // Impersonate RandomSampling contract
      await impersonateAndFund(RandomSampling);
      const rsSigner = await ethers.getSigner(
        await RandomSampling.getAddress(),
      );

      // Set score and check event
      await expect(
        RandomSamplingStorage.connect(rsSigner).setAllNodesEpochScore(
          currentEpoch,
          scoreToSet,
        ),
      )
        .to.emit(RandomSamplingStorage, 'AllNodesEpochScoreSet')
        .withArgs(currentEpoch, scoreToSet);

      // Verify stored value
      expect(
        await RandomSamplingStorage.getAllNodesEpochScore(currentEpoch),
      ).to.equal(scoreToSet);

      // Test overwriting
      const newScore = 15000n;
      await expect(
        RandomSamplingStorage.connect(rsSigner).setAllNodesEpochScore(
          currentEpoch,
          newScore,
        ),
      )
        .to.emit(RandomSamplingStorage, 'AllNodesEpochScoreSet')
        .withArgs(currentEpoch, newScore);

      expect(
        await RandomSamplingStorage.getAllNodesEpochScore(currentEpoch),
      ).to.equal(newScore);

      await stopImpersonate(RandomSampling);
    });
  });

  describe('Node Epoch Proof Period Score Setting', () => {
    it('Should set node epoch proof period score and emit event', async () => {
      const nodeId = 1n;
      const currentEpoch = await Chronos.getCurrentEpoch();
      const proofPeriodStartBlock = 100n;
      const scoreToSet = 3500n;

      // Impersonate RandomSampling contract
      await impersonateAndFund(RandomSampling);
      const rsSigner = await ethers.getSigner(
        await RandomSampling.getAddress(),
      );

      // Set score and check event
      await expect(
        RandomSamplingStorage.connect(rsSigner).setNodeEpochProofPeriodScore(
          currentEpoch,
          proofPeriodStartBlock,
          nodeId,
          scoreToSet,
        ),
      )
        .to.emit(RandomSamplingStorage, 'NodeEpochProofPeriodScoreSet')
        .withArgs(currentEpoch, proofPeriodStartBlock, nodeId, scoreToSet);

      // Verify stored value
      expect(
        await RandomSamplingStorage.getNodeEpochProofPeriodScore(
          nodeId,
          currentEpoch,
          proofPeriodStartBlock,
        ),
      ).to.equal(scoreToSet);

      // Test overwriting
      const newScore = 4000n;
      await expect(
        RandomSamplingStorage.connect(rsSigner).setNodeEpochProofPeriodScore(
          currentEpoch,
          proofPeriodStartBlock,
          nodeId,
          newScore,
        ),
      )
        .to.emit(RandomSamplingStorage, 'NodeEpochProofPeriodScoreSet')
        .withArgs(currentEpoch, proofPeriodStartBlock, nodeId, newScore);

      expect(
        await RandomSamplingStorage.getNodeEpochProofPeriodScore(
          nodeId,
          currentEpoch,
          proofPeriodStartBlock,
        ),
      ).to.equal(newScore);

      await stopImpersonate(RandomSampling);
    });
  });

  describe('Epoch Node Delegator Score Management', () => {
    it('Should set epoch node delegator score and emit event', async () => {
      const nodeId = 1n;
      const currentEpoch = await Chronos.getCurrentEpoch();
      const delegatorKey = ethers.encodeBytes32String('delegatorTest');
      const scoreToSet = 750n;

      // Impersonate RandomSampling contract
      await impersonateAndFund(RandomSampling);
      const rsSigner = await ethers.getSigner(
        await RandomSampling.getAddress(),
      );

      // Set score and check event
      await expect(
        RandomSamplingStorage.connect(rsSigner).setEpochNodeDelegatorScore(
          currentEpoch,
          nodeId,
          delegatorKey,
          scoreToSet,
        ),
      )
        .to.emit(RandomSamplingStorage, 'EpochNodeDelegatorScoreSet')
        .withArgs(currentEpoch, nodeId, delegatorKey, scoreToSet);

      // Verify stored value
      expect(
        await RandomSamplingStorage.getEpochNodeDelegatorScore(
          currentEpoch,
          nodeId,
          delegatorKey,
        ),
      ).to.equal(scoreToSet);

      // Test overwriting
      const newScore = 1200n;
      await expect(
        RandomSamplingStorage.connect(rsSigner).setEpochNodeDelegatorScore(
          currentEpoch,
          nodeId,
          delegatorKey,
          newScore,
        ),
      )
        .to.emit(RandomSamplingStorage, 'EpochNodeDelegatorScoreSet')
        .withArgs(currentEpoch, nodeId, delegatorKey, newScore);

      expect(
        await RandomSamplingStorage.getEpochNodeDelegatorScore(
          currentEpoch,
          nodeId,
          delegatorKey,
        ),
      ).to.equal(newScore);

      await stopImpersonate(RandomSampling);
    });
  });

  describe('Node Epoch Score Per Stake Setting', () => {
    it('Should set node epoch score per stake and emit event', async () => {
      const nodeId = 1n;
      const currentEpoch = await Chronos.getCurrentEpoch();
      const scorePerStakeToSet = 25000n;

      // Impersonate RandomSampling contract
      await impersonateAndFund(RandomSampling);
      const rsSigner = await ethers.getSigner(
        await RandomSampling.getAddress(),
      );

      // Set score per stake and check event
      await expect(
        RandomSamplingStorage.connect(rsSigner).setNodeEpochScorePerStake(
          currentEpoch,
          nodeId,
          scorePerStakeToSet,
        ),
      )
        .to.emit(RandomSamplingStorage, 'NodeEpochScorePerStakeSet')
        .withArgs(currentEpoch, nodeId, scorePerStakeToSet);

      // Verify stored value
      expect(
        await RandomSamplingStorage.getNodeEpochScorePerStake(
          currentEpoch,
          nodeId,
        ),
      ).to.equal(scorePerStakeToSet);

      // Test overwriting
      const newScorePerStake = 35000n;
      await expect(
        RandomSamplingStorage.connect(rsSigner).setNodeEpochScorePerStake(
          currentEpoch,
          nodeId,
          newScorePerStake,
        ),
      )
        .to.emit(RandomSamplingStorage, 'NodeEpochScorePerStakeSet')
        .withArgs(currentEpoch, nodeId, newScorePerStake);

      expect(
        await RandomSamplingStorage.getNodeEpochScorePerStake(
          currentEpoch,
          nodeId,
        ),
      ).to.equal(newScorePerStake);

      await stopImpersonate(RandomSampling);
    });
  });

  describe('Delegator Last Settled Node Epoch Score Per Stake Management', () => {
    it('Should set and get delegatorLastSettledNodeEpochScorePerStake correctly and emit event', async () => {
      const nodeId = 1n;
      const delegatorKey = ethers.encodeBytes32String('delegatorTest');
      const currentEpoch = await Chronos.getCurrentEpoch();
      const scorePerStakeToSet = 12345n;

      // Impersonate RandomSampling contract
      await impersonateAndFund(RandomSampling);
      const rsSigner = await ethers.getSigner(
        await RandomSampling.getAddress(),
      );

      // Initial state
      expect(
        await RandomSamplingStorage.getDelegatorLastSettledNodeEpochScorePerStake(
          currentEpoch,
          nodeId,
          delegatorKey,
        ),
      ).to.equal(
        0n,
        'Initial delegatorLastSettledNodeEpochScorePerStake should be 0',
      );

      // Set score per stake and check event
      await expect(
        RandomSamplingStorage.connect(
          rsSigner,
        ).setDelegatorLastSettledNodeEpochScorePerStake(
          currentEpoch,
          nodeId,
          delegatorKey,
          scorePerStakeToSet,
        ),
      )
        .to.emit(
          RandomSamplingStorage,
          'DelegatorLastSettledNodeEpochScorePerStakeSet',
        )
        .withArgs(currentEpoch, nodeId, delegatorKey, scorePerStakeToSet);

      // Verify stored value
      expect(
        await RandomSamplingStorage.getDelegatorLastSettledNodeEpochScorePerStake(
          currentEpoch,
          nodeId,
          delegatorKey,
        ),
      ).to.equal(
        scorePerStakeToSet,
        `delegatorLastSettledNodeEpochScorePerStake should be ${scorePerStakeToSet}`,
      );

      // Test overwriting
      const newScorePerStake = 54321n;
      await expect(
        RandomSamplingStorage.connect(
          rsSigner,
        ).setDelegatorLastSettledNodeEpochScorePerStake(
          currentEpoch,
          nodeId,
          delegatorKey,
          newScorePerStake,
        ),
      )
        .to.emit(
          RandomSamplingStorage,
          'DelegatorLastSettledNodeEpochScorePerStakeSet',
        )
        .withArgs(currentEpoch, nodeId, delegatorKey, newScorePerStake);

      expect(
        await RandomSamplingStorage.getDelegatorLastSettledNodeEpochScorePerStake(
          currentEpoch,
          nodeId,
          delegatorKey,
        ),
      ).to.equal(
        newScorePerStake,
        `delegatorLastSettledNodeEpochScorePerStake should be ${newScorePerStake} after overwrite`,
      );

      // Test different delegator key
      const anotherDelegatorKey = ethers.encodeBytes32String('delegatorTest2');
      await expect(
        RandomSamplingStorage.connect(
          rsSigner,
        ).setDelegatorLastSettledNodeEpochScorePerStake(
          currentEpoch,
          nodeId,
          anotherDelegatorKey,
          scorePerStakeToSet,
        ),
      )
        .to.emit(
          RandomSamplingStorage,
          'DelegatorLastSettledNodeEpochScorePerStakeSet',
        )
        .withArgs(
          currentEpoch,
          nodeId,
          anotherDelegatorKey,
          scorePerStakeToSet,
        );

      expect(
        await RandomSamplingStorage.getDelegatorLastSettledNodeEpochScorePerStake(
          currentEpoch,
          nodeId,
          anotherDelegatorKey,
        ),
      ).to.equal(scorePerStakeToSet);

      // Test different node
      const anotherNodeId = 2n;
      await expect(
        RandomSamplingStorage.connect(
          rsSigner,
        ).setDelegatorLastSettledNodeEpochScorePerStake(
          currentEpoch,
          anotherNodeId,
          delegatorKey,
          scorePerStakeToSet,
        ),
      )
        .to.emit(
          RandomSamplingStorage,
          'DelegatorLastSettledNodeEpochScorePerStakeSet',
        )
        .withArgs(
          currentEpoch,
          anotherNodeId,
          delegatorKey,
          scorePerStakeToSet,
        );

      expect(
        await RandomSamplingStorage.getDelegatorLastSettledNodeEpochScorePerStake(
          currentEpoch,
          anotherNodeId,
          delegatorKey,
        ),
      ).to.equal(scorePerStakeToSet);

      // Test different epoch
      await time.increase(Number(await Chronos.epochLength()));
      const nextEpoch = await Chronos.getCurrentEpoch();
      await expect(
        RandomSamplingStorage.connect(
          rsSigner,
        ).setDelegatorLastSettledNodeEpochScorePerStake(
          nextEpoch,
          nodeId,
          delegatorKey,
          scorePerStakeToSet,
        ),
      )
        .to.emit(
          RandomSamplingStorage,
          'DelegatorLastSettledNodeEpochScorePerStakeSet',
        )
        .withArgs(nextEpoch, nodeId, delegatorKey, scorePerStakeToSet);

      expect(
        await RandomSamplingStorage.getDelegatorLastSettledNodeEpochScorePerStake(
          nextEpoch,
          nodeId,
          delegatorKey,
        ),
      ).to.equal(scorePerStakeToSet);

      await stopImpersonate(RandomSampling);
    });

    it('Should maintain separate delegator last settled values for different combinations', async () => {
      const nodeIds = [1n, 2n];
      const delegatorKeys = [
        ethers.encodeBytes32String('delegator1'),
        ethers.encodeBytes32String('delegator2'),
      ];
      const currentEpoch = await Chronos.getCurrentEpoch();
      const baseScorePerStake = 1000n;

      // Impersonate RandomSampling contract
      await impersonateAndFund(RandomSampling);
      const rsSigner = await ethers.getSigner(
        await RandomSampling.getAddress(),
      );

      // Set different values for each combination
      let expectedValue = baseScorePerStake;
      for (let i = 0; i < nodeIds.length; i++) {
        for (let j = 0; j < delegatorKeys.length; j++) {
          const nodeId = nodeIds[i];
          const delegatorKey = delegatorKeys[j];
          expectedValue += BigInt(i * 10 + j);

          await RandomSamplingStorage.connect(
            rsSigner,
          ).setDelegatorLastSettledNodeEpochScorePerStake(
            currentEpoch,
            nodeId,
            delegatorKey,
            expectedValue,
          );

          // Verify the value was set correctly
          expect(
            await RandomSamplingStorage.getDelegatorLastSettledNodeEpochScorePerStake(
              currentEpoch,
              nodeId,
              delegatorKey,
            ),
          ).to.equal(
            expectedValue,
            `Value should be ${expectedValue} for node ${nodeId} and delegator ${j}`,
          );
        }
      }

      // Verify all values are still correctly stored
      expectedValue = baseScorePerStake;
      for (let i = 0; i < nodeIds.length; i++) {
        for (let j = 0; j < delegatorKeys.length; j++) {
          const nodeId = nodeIds[i];
          const delegatorKey = delegatorKeys[j];
          expectedValue += BigInt(i * 10 + j);

          expect(
            await RandomSamplingStorage.getDelegatorLastSettledNodeEpochScorePerStake(
              currentEpoch,
              nodeId,
              delegatorKey,
            ),
          ).to.equal(
            expectedValue,
            `Final verification: Value should be ${expectedValue} for node ${nodeId} and delegator ${j}`,
          );
        }
      }

      await stopImpersonate(RandomSampling);
    });

    it('Should revert when not called by contracts', async () => {
      const currentEpoch = await Chronos.getCurrentEpoch();
      const nodeId = 1n;
      const delegatorKey = ethers.encodeBytes32String('test');

      await expect(
        RandomSamplingStorage.connect(
          accounts[1],
        ).setDelegatorLastSettledNodeEpochScorePerStake(
          currentEpoch,
          nodeId,
          delegatorKey,
          1000,
        ),
      )
        .to.be.revertedWithCustomError(
          RandomSamplingStorage,
          'UnauthorizedAccess',
        )
        .withArgs('Only Contracts in Hub');
    });
  });

  describe('Enhanced Access Control Tests', () => {
    it('Should revert all new setter functions when not called by contracts', async () => {
      const currentEpoch = await Chronos.getCurrentEpoch();
      const nodeId = 1n;
      const delegatorKey = ethers.encodeBytes32String('test');

      // Test all new setter functions for proper access control
      await expect(
        RandomSamplingStorage.connect(accounts[1]).setEpochNodeValidProofsCount(
          currentEpoch,
          nodeId,
          5,
        ),
      )
        .to.be.revertedWithCustomError(
          RandomSamplingStorage,
          'UnauthorizedAccess',
        )
        .withArgs('Only Contracts in Hub');

      await expect(
        RandomSamplingStorage.connect(accounts[1]).addToNodeEpochScore(
          currentEpoch,
          nodeId,
          1000,
        ),
      )
        .to.be.revertedWithCustomError(
          RandomSamplingStorage,
          'UnauthorizedAccess',
        )
        .withArgs('Only Contracts in Hub');

      await expect(
        RandomSamplingStorage.connect(accounts[1]).setNodeEpochScore(
          currentEpoch,
          nodeId,
          1000,
        ),
      )
        .to.be.revertedWithCustomError(
          RandomSamplingStorage,
          'UnauthorizedAccess',
        )
        .withArgs('Only Contracts in Hub');

      await expect(
        RandomSamplingStorage.connect(accounts[1]).addToAllNodesEpochScore(
          currentEpoch,
          1000,
        ),
      )
        .to.be.revertedWithCustomError(
          RandomSamplingStorage,
          'UnauthorizedAccess',
        )
        .withArgs('Only Contracts in Hub');

      await expect(
        RandomSamplingStorage.connect(accounts[1]).setAllNodesEpochScore(
          currentEpoch,
          1000,
        ),
      )
        .to.be.revertedWithCustomError(
          RandomSamplingStorage,
          'UnauthorizedAccess',
        )
        .withArgs('Only Contracts in Hub');

      await expect(
        RandomSamplingStorage.connect(accounts[1]).setNodeEpochProofPeriodScore(
          currentEpoch,
          100,
          nodeId,
          1000,
        ),
      )
        .to.be.revertedWithCustomError(
          RandomSamplingStorage,
          'UnauthorizedAccess',
        )
        .withArgs('Only Contracts in Hub');

      await expect(
        RandomSamplingStorage.connect(accounts[1]).setEpochNodeDelegatorScore(
          currentEpoch,
          nodeId,
          delegatorKey,
          1000,
        ),
      )
        .to.be.revertedWithCustomError(
          RandomSamplingStorage,
          'UnauthorizedAccess',
        )
        .withArgs('Only Contracts in Hub');

      await expect(
        RandomSamplingStorage.connect(accounts[1]).setNodeEpochScorePerStake(
          currentEpoch,
          nodeId,
          1000,
        ),
      )
        .to.be.revertedWithCustomError(
          RandomSamplingStorage,
          'UnauthorizedAccess',
        )
        .withArgs('Only Contracts in Hub');

      await expect(
        RandomSamplingStorage.connect(
          accounts[1],
        ).setDelegatorLastSettledNodeEpochScorePerStake(
          currentEpoch,
          nodeId,
          delegatorKey,
          1000,
        ),
      )
        .to.be.revertedWithCustomError(
          RandomSamplingStorage,
          'UnauthorizedAccess',
        )
        .withArgs('Only Contracts in Hub');
    });
  });

  describe('Missing Event Assertions (Adder/Setter Helpers)', () => {
    let rsSigner: SignerWithAddress;
    const nodeId = 1n;
    const delegatorKey = ethers.encodeBytes32String('delegatorEvent');

    beforeEach(async () => {
      // Impersonate RandomSampling (registered in Hub) for onlyContracts funcs
      await impersonateAndFund(RandomSampling);
      rsSigner = await ethers.getSigner(await RandomSampling.getAddress());
    });

    afterEach(async () => {
      await stopImpersonate(RandomSampling);
    });

    it('emits NodeChallengeSet when a challenge is stored', async () => {
      await expect(
        RandomSamplingStorage.connect(rsSigner).setNodeChallenge(
          nodeId,
          MockChallenge,
        ),
      )
        .to.emit(RandomSamplingStorage, 'NodeChallengeSet')
        .withArgs(nodeId, Object.values(MockChallenge)); // Struct is indexed as tuple
    });

    it('emits EpochNodeValidProofsCountIncremented on increment', async () => {
      const currentEpoch = await Chronos.getCurrentEpoch();
      await expect(
        RandomSamplingStorage.connect(
          rsSigner,
        ).incrementEpochNodeValidProofsCount(currentEpoch, nodeId),
      )
        .to.emit(RandomSamplingStorage, 'EpochNodeValidProofsCountIncremented')
        .withArgs(currentEpoch, nodeId, 1n);
    });

    it('emits NodeEpochProofPeriodScoreAdded', async () => {
      const currentEpoch = await Chronos.getCurrentEpoch();
      const proofPeriodStartBlock = 777n;
      const score = 1234n;

      await expect(
        RandomSamplingStorage.connect(rsSigner).addToNodeEpochProofPeriodScore(
          currentEpoch,
          proofPeriodStartBlock,
          nodeId,
          score,
        ),
      )
        .to.emit(RandomSamplingStorage, 'NodeEpochProofPeriodScoreAdded')
        .withArgs(
          currentEpoch,
          proofPeriodStartBlock,
          nodeId,
          score,
          score, // total after first add
        );
    });

    it('emits EpochNodeDelegatorScoreAdded when delegator score is accumulated', async () => {
      const currentEpoch = await Chronos.getCurrentEpoch();
      const score = 555n;

      await expect(
        RandomSamplingStorage.connect(rsSigner).addToEpochNodeDelegatorScore(
          currentEpoch,
          nodeId,
          delegatorKey,
          score,
        ),
      )
        .to.emit(RandomSamplingStorage, 'EpochNodeDelegatorScoreAdded')
        .withArgs(
          currentEpoch,
          nodeId,
          delegatorKey,
          score,
          score, // first accumulation
        );
    });
  });

  describe('getEpochProofingPeriodDurationInBlocks() Edge-Case Reverts', () => {
    it('reverts when epoch precedes the earliest effectiveEpoch', async () => {
      // Advance Chronos one epoch so the earliest effectiveEpoch will be > 0
      await time.increase(Number(await Chronos.epochLength()));

      // Deploy a fresh storage instance *after* epoch advanced
      const RSFactory = await hre.ethers.getContractFactory(
        'RandomSamplingStorage',
      );
      const freshStorage = await RSFactory.deploy(
        Hub.target,
        proofingPeriodDurationInBlocks,
        w1,
        w2,
      );

      // Earliest effectiveEpoch is now 1; querying 0 must revert
      await expect(
        freshStorage.getEpochProofingPeriodDurationInBlocks(0n),
      ).to.be.revertedWith('No applicable duration found');
    });
  });

  describe('Cross-Function Integration Tests', () => {
    it('Should handle complex scoring scenarios with multiple functions', async () => {
      const nodeId = 1n;
      const currentEpoch = await Chronos.getCurrentEpoch();
      const proofPeriodStartBlock = 200n;
      const delegatorKey = ethers.encodeBytes32String('integrationTest');

      // Impersonate RandomSampling contract
      await impersonateAndFund(RandomSampling);
      const rsSigner = await ethers.getSigner(
        await RandomSampling.getAddress(),
      );

      // Set up a complete scoring scenario
      // 1. Set valid proofs count
      await RandomSamplingStorage.connect(
        rsSigner,
      ).setEpochNodeValidProofsCount(currentEpoch, nodeId, 10);

      // 2. Add node epoch score
      await RandomSamplingStorage.connect(rsSigner).addToNodeEpochScore(
        currentEpoch,
        nodeId,
        5000,
      );

      // 3. Add to all nodes score
      await RandomSamplingStorage.connect(rsSigner).addToAllNodesEpochScore(
        currentEpoch,
        5000,
      );

      // 4. Set proof period specific score
      await RandomSamplingStorage.connect(
        rsSigner,
      ).setNodeEpochProofPeriodScore(
        currentEpoch,
        proofPeriodStartBlock,
        nodeId,
        2000,
      );

      // 5. Set delegator score
      await RandomSamplingStorage.connect(rsSigner).setEpochNodeDelegatorScore(
        currentEpoch,
        nodeId,
        delegatorKey,
        1500,
      );

      // 6. Set score per stake
      await RandomSamplingStorage.connect(rsSigner).setNodeEpochScorePerStake(
        currentEpoch,
        nodeId,
        50000,
      );

      // Verify all values are set correctly
      expect(
        await RandomSamplingStorage.getEpochNodeValidProofsCount(
          currentEpoch,
          nodeId,
        ),
      ).to.equal(10);
      expect(
        await RandomSamplingStorage.getNodeEpochScore(currentEpoch, nodeId),
      ).to.equal(5000);
      expect(
        await RandomSamplingStorage.getAllNodesEpochScore(currentEpoch),
      ).to.equal(5000);
      expect(
        await RandomSamplingStorage.getNodeEpochProofPeriodScore(
          nodeId,
          currentEpoch,
          proofPeriodStartBlock,
        ),
      ).to.equal(2000);
      expect(
        await RandomSamplingStorage.getEpochNodeDelegatorScore(
          currentEpoch,
          nodeId,
          delegatorKey,
        ),
      ).to.equal(1500);
      expect(
        await RandomSamplingStorage.getNodeEpochScorePerStake(
          currentEpoch,
          nodeId,
        ),
      ).to.equal(50000);

      await stopImpersonate(RandomSampling);
    });
  });
});
