import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  Token,
  Profile,
  Staking,
  StakingStorage,
  Chronos,
  RandomSamplingStorage,
  RandomSampling,
  EpochStorage,
  KnowledgeCollection,
  Hub,
  Ask,
  AskStorage,
  ParametersStorage,
  ProfileStorage,
  DelegatorsInfo,
  ShardingTable,
  ConvictionStaking,
  ConvictionStakeStorage,
} from '../../typechain';
import { createKnowledgeCollection } from '../helpers/kc-helpers';
import { createProfile } from '../helpers/profile-helpers';
import { NodeAccounts } from '../helpers/types';

const toTRAC = (x: number) => hre.ethers.parseEther(x.toString());

const quads = [
  '<urn:test:s> <urn:test:p> <urn:test:o> .',
  ...Array(1000).fill(
    '<urn:fake:quad> <urn:fake:predicate> <urn:fake:object> .',
  ),
];

async function advanceToNextProofingPeriod(contracts: {
  randomSampling: RandomSampling;
}): Promise<void> {
  const dur =
    await contracts.randomSampling.getActiveProofingPeriodDurationInBlocks();
  const { activeProofPeriodStartBlock, isValid } =
    await contracts.randomSampling.getActiveProofPeriodStatus();
  if (isValid) {
    const blocksLeft =
      Number(activeProofPeriodStartBlock) +
      Number(dur) -
      Number(await hre.network.provider.send('eth_blockNumber')) +
      1;
    for (let i = 0; i < blocksLeft; i++) {
      await hre.network.provider.send('evm_mine');
    }
  }
  await contracts.randomSampling.updateAndGetActiveProofPeriodStartBlock();
}

describe('ConvictionStaking — stake -> proof -> score -> reward', function () {
  let contracts: {
    hub: Hub;
    token: Token;
    chronos: Chronos;
    profile: Profile;
    staking: Staking;
    stakingStorage: StakingStorage;
    delegatorsInfo: DelegatorsInfo;
    randomSamplingStorage: RandomSamplingStorage;
    randomSampling: RandomSampling;
    epochStorage: EpochStorage;
    kc: KnowledgeCollection;
    ask: Ask;
    askStorage: AskStorage;
    parametersStorage: ParametersStorage;
    profileStorage: ProfileStorage;
    shardingTable: ShardingTable;
    convictionStaking: ConvictionStaking;
    convictionStakeStorage: ConvictionStakeStorage;
  };
  let owner: SignerWithAddress;
  let node1: NodeAccounts;
  let node2: NodeAccounts;
  let node3: NodeAccounts;
  let delegator: SignerWithAddress;
  let node1Id: number;
  let node2Id: number;
  let node3Id: number;
  let chunkSize: number;
  let receivingNodes: NodeAccounts[];
  let receivingNodeIds: number[];

  before(async () => {
    hre.helpers.resetDeploymentsJson();
    await hre.deployments.fixture();

    const signers = await hre.ethers.getSigners();
    owner = signers[0];
    node1 = { operational: signers[1], admin: signers[2] };
    node2 = { operational: signers[3], admin: signers[4] };
    node3 = { operational: signers[5], admin: signers[6] };
    delegator = signers[10];

    contracts = {
      hub: await hre.ethers.getContract<Hub>('Hub'),
      token: await hre.ethers.getContract<Token>('Token'),
      chronos: await hre.ethers.getContract<Chronos>('Chronos'),
      profile: await hre.ethers.getContract<Profile>('Profile'),
      staking: await hre.ethers.getContract<Staking>('Staking'),
      stakingStorage:
        await hre.ethers.getContract<StakingStorage>('StakingStorage'),
      delegatorsInfo:
        await hre.ethers.getContract<DelegatorsInfo>('DelegatorsInfo'),
      randomSamplingStorage:
        await hre.ethers.getContract<RandomSamplingStorage>(
          'RandomSamplingStorage',
        ),
      randomSampling:
        await hre.ethers.getContract<RandomSampling>('RandomSampling'),
      epochStorage:
        await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
      kc: await hre.ethers.getContract<KnowledgeCollection>(
        'KnowledgeCollection',
      ),
      ask: await hre.ethers.getContract<Ask>('Ask'),
      askStorage: await hre.ethers.getContract<AskStorage>('AskStorage'),
      parametersStorage:
        await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
      profileStorage:
        await hre.ethers.getContract<ProfileStorage>('ProfileStorage'),
      shardingTable:
        await hre.ethers.getContract<ShardingTable>('ShardingTable'),
      convictionStaking:
        await hre.ethers.getContract<ConvictionStaking>('ConvictionStaking'),
      convictionStakeStorage:
        await hre.ethers.getContract<ConvictionStakeStorage>(
          'ConvictionStakeStorage',
        ),
    };

    chunkSize = Number(
      await contracts.randomSamplingStorage.CHUNK_BYTE_SIZE(),
    );

    await contracts.hub.setContractAddress('HubOwner', owner.address);
    await contracts.parametersStorage.setMinimumStake(toTRAC(100));
    await contracts.parametersStorage
      .connect(owner)
      .setOperatorFeeUpdateDelay(0);

    // Mint tokens
    await contracts.token.mint(delegator.address, toTRAC(1_000_000));
    await contracts.token.mint(owner.address, toTRAC(1_000_000));

    // Create 3 node profiles (KC creation requires min 3 receiving signatures)
    const p1 = await createProfile(contracts.profile, node1);
    const p2 = await createProfile(contracts.profile, node2);
    const p3 = await createProfile(contracts.profile, node3);
    node1Id = p1.identityId;
    node2Id = p2.identityId;
    node3Id = p3.identityId;

    // Add nodes to sharding table (required for KC assignment)
    // @ts-expect-error – hub owner direct insert for test setup
    await contracts.shardingTable.connect(owner).insertNode(node1Id);
    // @ts-expect-error – hub owner direct insert for test setup
    await contracts.shardingTable.connect(owner).insertNode(node2Id);
    // @ts-expect-error – hub owner direct insert for test setup
    await contracts.shardingTable.connect(owner).insertNode(node3Id);

    // Set node asks
    const nodeAsk = hre.ethers.parseUnits('0.2', 18);
    await contracts.profile
      .connect(node1.operational)
      .updateAsk(node1Id, nodeAsk);
    await contracts.profile
      .connect(node2.operational)
      .updateAsk(node2Id, nodeAsk);
    await contracts.profile
      .connect(node3.operational)
      .updateAsk(node3Id, nodeAsk);
    await contracts.ask.connect(owner).recalculateActiveSet();

    receivingNodes = [node1, node2, node3];
    receivingNodeIds = [node1Id, node2Id, node3Id];

    // Advance to epoch 2 (same pattern as StakingRewards.test.ts)
    const timeUntilNextEpoch = await contracts.chronos.timeUntilNextEpoch();
    await time.increase(timeUntilNextEpoch + 1n);
    while ((await contracts.chronos.getCurrentEpoch()) < 2n) {
      await time.increase(
        (await contracts.chronos.timeUntilNextEpoch()) + 1n,
      );
    }
  });

  it('should complete: stake via ConvictionStaking -> publish KC -> submit proof -> advance epoch -> claim rewards', async () => {
    const stakingEpoch = await contracts.chronos.getCurrentEpoch();

    // ── Step 1: Stake via ConvictionStaking in stakingEpoch ──
    const stakeAmount = toTRAC(50_000);
    await contracts.token
      .connect(delegator)
      .approve(await contracts.convictionStaking.getAddress(), stakeAmount);
    await contracts.convictionStaking
      .connect(delegator)
      .stake(node1Id, stakeAmount, 0);

    // Verify NFT minted
    expect(
      await contracts.convictionStaking.balanceOf(delegator.address),
    ).to.equal(1);

    // Verify delegator registered
    expect(
      await contracts.delegatorsInfo.isNodeDelegator(
        node1Id,
        delegator.address,
      ),
    ).to.equal(true);

    // Verify per-delegator stakeBase
    const delegatorKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [delegator.address]),
    );
    expect(
      await contracts.stakingStorage.getDelegatorStakeBase(
        node1Id,
        delegatorKey,
      ),
    ).to.equal(stakeAmount);

    // Verify effectiveNodeStake
    expect(
      await contracts.convictionStakeStorage.getEffectiveNodeStake(node1Id),
    ).to.equal(stakeAmount);

    // ── Step 2: Publish KC in same epoch ──
    // @ts-expect-error – dynamic CJS import
    const { kcTools } = await import('assertion-tools');
    const merkleRoot = kcTools.calculateMerkleRoot(quads, 32);

    await createKnowledgeCollection(
      owner,
      node1,
      node1Id,
      receivingNodes,
      receivingNodeIds,
      { KnowledgeCollection: contracts.kc, Token: contracts.token },
      merkleRoot,
      `conviction-test-kc-${Date.now()}`,
      3,
      chunkSize * 3,
      5,
      toTRAC(500),
    );

    // ── Step 3: Submit proof for node1 ──
    await advanceToNextProofingPeriod(contracts);

    await contracts.randomSampling
      .connect(node1.operational)
      .createChallenge();

    const challenge =
      await contracts.randomSamplingStorage.getNodeChallenge(node1Id);
    const chunks = kcTools.splitIntoChunks(quads, 32);
    const chunkId = Number(challenge[1]);
    const { proof } = kcTools.calculateMerkleProof(quads, 32, chunkId);

    await contracts.randomSampling
      .connect(node1.operational)
      .submitProof(chunks[chunkId], proof);

    // Verify node score was recorded
    const nodeScore = await contracts.randomSamplingStorage.getNodeEpochScore(
      stakingEpoch,
      node1Id,
    );
    expect(nodeScore).to.be.gt(0);

    // Verify scorePerStake was computed using effectiveNodeStake
    const scorePerStake =
      await contracts.randomSamplingStorage.getNodeEpochScorePerStake(
        stakingEpoch,
        node1Id,
      );
    expect(scorePerStake).to.be.gt(0);

    // ── Step 4: Advance epoch so stakingEpoch becomes claimable ──
    await time.increase(
      (await contracts.chronos.timeUntilNextEpoch()) + 1n,
    );
    const claimEpoch = await contracts.chronos.getCurrentEpoch();
    expect(claimEpoch).to.be.gt(stakingEpoch);

    // ── Step 5: Claim rewards via Staking.claimDelegatorRewards ──
    const stakeBaseBefore =
      await contracts.stakingStorage.getDelegatorStakeBase(
        node1Id,
        delegatorKey,
      );
    const effectiveBefore =
      await contracts.convictionStakeStorage.getEffectiveNodeStake(node1Id);

    await contracts.staking.claimDelegatorRewards(
      node1Id,
      stakingEpoch,
      delegator.address,
    );

    // Rewards should be restaked (stakeBase increased)
    const stakeBaseAfter =
      await contracts.stakingStorage.getDelegatorStakeBase(
        node1Id,
        delegatorKey,
      );
    expect(stakeBaseAfter).to.be.gt(stakeBaseBefore);

    // After claim restake: raw nodeStake increased, effective stays at original
    // RandomSampling uses max(effective, raw), so scoring picks up the restaked reward
    const effectiveAfter =
      await contracts.convictionStakeStorage.getEffectiveNodeStake(node1Id);
    const rawNodeStakeAfter = await contracts.stakingStorage.getNodeStake(
      node1Id,
    );
    const rewardAmount = stakeBaseAfter - stakeBaseBefore;

    // Effective didn't change (old Staking doesn't sync it)
    expect(effectiveAfter).to.equal(effectiveBefore);
    // Raw increased by the reward
    expect(rawNodeStakeAfter).to.equal(
      BigInt(stakeAmount) + rewardAmount,
    );
    // For tier 0: raw > effective after restake, so max(eff, raw) = raw — scoring is correct
    expect(rawNodeStakeAfter).to.be.gte(effectiveAfter);

    // Cumulative earned rewards tracked
    const cumulativeEarned =
      await contracts.stakingStorage.getDelegatorCumulativeEarnedRewards(
        node1Id,
        delegatorKey,
      );
    expect(cumulativeEarned).to.be.gt(0);
  });
});
