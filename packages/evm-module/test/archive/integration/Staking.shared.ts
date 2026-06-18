import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { time } from '@nomicfoundation/hardhat-network-helpers';
// @ts-expect-error: No type definitions available for assertion-tools
import { kcTools } from 'assertion-tools';
import { expect } from 'chai';
import hre, { ethers } from 'hardhat';

import {
  Hub,
  Token,
  Chronos,
  StakingStorage,
  RandomSamplingStorage,
  ParametersStorage,
  ProfileStorage,
  EpochStorage,
  DelegatorsInfo,
  Ask,
  Staking,
  StakingKPI,
  RandomSampling,
  Profile,
  KnowledgeCollection,
  AskStorage,
} from '../../typechain';
import { createKnowledgeCollection } from '../helpers/kc-helpers';
import { sqrt } from '../helpers/math-helpers';
import { createProfile } from '../helpers/profile-helpers';

// Sample data for KC
const quads = [
  '<urn:us-cities:info:new-york> <http://schema.org/area> "468.9 sq mi" .',
  '<urn:us-cities:info:new-york> <http://schema.org/name> "New York" .',
  '<urn:us-cities:info:new-york> <http://schema.org/population> "8,336,817" .',
  '<urn:us-cities:info:new-york> <http://schema.org/state> "New York" .',
  '<urn:us-cities:info:new-york> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://schema.org/City> .',
  '<uuid:a1a241ad-9f62-4dcc-94b6-f59b299dee0a> <https://ontology.origintrail.io/dkg/1.0#privateMerkleRoot> "0xaac2a420672a1eb77506c544ff01beed2be58c0ee3576fe037c846f97481cefd" .',
  '<https://ontology.origintrail.io/dkg/1.0#metadata-hash:0x5cb6421dd41c7a62a84c223779303919e7293753d8a1f6f49da2e598013fe652> <https://ontology.origintrail.io/dkg/1.0#representsPrivateResource> <uuid:396b91f8-977b-4f5d-8658-bc4bc195ba3c> .',
  '<https://ontology.origintrail.io/dkg/1.0#metadata-hash:0x6a2292b30c844d2f8f2910bf11770496a3a79d5a6726d1b2fd3ddd18e09b5850> <https://ontology.origintrail.io/dkg/1.0#representsPrivateResource> <uuid:7eab0ccb-dd6c-4f81-a342-3c22e6276ec5> .',
  '<https://ontology.origintrail.io/dkg/1.0#metadata-hash:0xc1f682b783b1b93c9d5386eb1730c9647cf4b55925ec24f5e949e7457ba7bfac> <https://ontology.origintrail.io/dkg/1.0#representsPrivateResource> <uuid:8b843b0c-33d8-4546-9a6d-207fd22c793c> .',
  // Add more quads to ensure we have enough chunks
  ...Array(1000).fill(
    '<urn:fake:quad> <urn:fake:predicate> <urn:fake:object> .',
  ),
];
const merkleRoot = kcTools.calculateMerkleRoot(quads, 32);

const toTRAC = (x: string | number) => ethers.parseUnits(x.toString(), 18);

// ================================================================================================================
// HELPER FUNCTIONS: Extract common functionality for better readability and reusability
// ================================================================================================================

type TestContracts = {
  hub: Hub;
  token: Token;
  chronos: Chronos;
  stakingStorage: StakingStorage;
  randomSamplingStorage: RandomSamplingStorage;
  parametersStorage: ParametersStorage;
  profileStorage: ProfileStorage;
  epochStorage: EpochStorage;
  delegatorsInfo: DelegatorsInfo;
  staking: Staking;
  stakingKPI: StakingKPI;
  profile: Profile;
  randomSampling: RandomSampling;
  kc: KnowledgeCollection;
  askStorage: AskStorage;
  ask: Ask;
};

type TestAccounts = {
  owner: SignerWithAddress;
  node1: { operational: SignerWithAddress; admin: SignerWithAddress };
  node2: { operational: SignerWithAddress; admin: SignerWithAddress };
  delegator1: SignerWithAddress;
  delegator2: SignerWithAddress;
  delegator3: SignerWithAddress;
  kcCreator: SignerWithAddress;
  receiver1: { operational: SignerWithAddress; admin: SignerWithAddress };
  receiver2: { operational: SignerWithAddress; admin: SignerWithAddress };
  receiver3: { operational: SignerWithAddress; admin: SignerWithAddress };
};

/**
 * Calculate expected node score manually to verify contract calculation
 * Implements anti-sybil multiplicative formula:
 *
 * Formula: nodeScore(t) = S(t) * (c + 0.86 * P(t) + 0.60 * A(t) * P(t))
 *
 * Where:
 * - S(t) = sqrt(nodeStake / stakeCap) - sublinear stake scaling
 * - P(t) = K_n / K_total - publishing share over 4 epochs
 * - A(t) = 1 - |nodeAsk - networkPrice| / networkPrice - ask alignment
 * - c = 0.002 (STAKE_BASELINE_COEFFICIENT) - small baseline so non-publishers
 *   still receive minimal rewards proportional to stake
 */
async function calculateExpectedNodeScore(
  nodeId: bigint,
  contracts: TestContracts,
): Promise<bigint> {
  const SCALE18 = ethers.parseUnits('1', 18);

  // Get current epoch
  const currentEpoch = await contracts.chronos.getCurrentEpoch();

  // 1. Stake Factor S(t) = sqrt(nodeStake / stakeCap) - sublinear scaling (RFC-26 Section 4.1)
  const stakeCap = await contracts.parametersStorage.maximumStake();
  let nodeStake = await contracts.stakingStorage.getNodeStake(nodeId);
  nodeStake = nodeStake > stakeCap ? stakeCap : nodeStake;

  const stakeRatio18 = (nodeStake * SCALE18) / stakeCap;
  const stakeFactor18 = sqrt(stakeRatio18 * SCALE18);

  // 2. Publishing Factor P(t) = K_n / K_total for the CURRENT epoch only.
  // OT-RFC-51: RandomSampling._calculateNodeScore now reads K_n / K_total
  // from `currentEpoch` exclusively (no 4-epoch lookback window). Mirror that
  // single-epoch read here so the expected score matches the contract.
  const nodeKnowledgeValue =
    await contracts.epochStorage.getNodeEpochPublishingAllocation(
      nodeId,
      currentEpoch,
    );
  const totalKnowledgeValue =
    await contracts.epochStorage.getEpochPublishingAllocation(currentEpoch);
  const publishingFactor18 =
    totalKnowledgeValue > 0n
      ? (nodeKnowledgeValue * SCALE18) / totalKnowledgeValue
      : 0n;

  // 3. Ask Alignment Factor A(t) = 1 - |nodeAsk - networkPrice| / networkPrice (RFC-26 Section 4.3)
  const nodeAsk = await contracts.profileStorage.getAsk(nodeId);
  const networkPrice = await contracts.askStorage.getPricePerKbEpoch();
  let askAlignmentFactor18 = 0n;
  if (networkPrice > 0n) {
    const deviation =
      nodeAsk > networkPrice ? nodeAsk - networkPrice : networkPrice - nodeAsk;
    const deviationRatio18 = (deviation * SCALE18) / networkPrice;
    askAlignmentFactor18 =
      deviationRatio18 >= SCALE18 ? 0n : SCALE18 - deviationRatio18;
  }

  // nodeScore(t) = S(t) * (c + 0.86 * P(t) + 0.60 * A(t) * P(t))
  // c = 0.002 = 2/1000
  const baselineComponent18 = (2n * SCALE18) / 1000n;
  const publishingComponent18 = (86n * publishingFactor18) / 100n;
  const askPublishingComponent18 =
    (60n * askAlignmentFactor18 * publishingFactor18) / (100n * SCALE18);

  const innerScore18 = baselineComponent18 + publishingComponent18 + askPublishingComponent18;
  return (stakeFactor18 * innerScore18) / SCALE18;
}

/**
 * Calculate expected delegator score earned during a period
 */
function calculateExpectedDelegatorScore(
  delegatorStake: bigint,
  nodeScorePerStake: bigint,
  delegatorLastSettledNodeScorePerStake: bigint,
): bigint {
  const diff = nodeScorePerStake - delegatorLastSettledNodeScorePerStake;
  const SCALE18 = ethers.parseUnits('1', 18);
  return (delegatorStake * diff) / SCALE18;
}

async function epochRewardsPoolPrecisionLoss(
  contracts: TestContracts,
  claimEpoch: bigint,
  netNodeRewards: bigint,
  expectedRewardsPool: bigint,
): Promise<void> {
  const epochRewardsPool = await contracts.epochStorage.getEpochPool(
    1,
    claimEpoch,
  );
  console.log(
    `    ✅ Epoch rewards pool: ${ethers.formatUnits(epochRewardsPool, 18)} TRAC`,
  );
  expect(epochRewardsPool).to.equal(netNodeRewards);
  console.log(
    `    ✅ Expected rewards pool: ${ethers.formatUnits(expectedRewardsPool, 18)} TRAC`,
  );
  console.log(
    `    ⚠️ [Epoch ${claimEpoch}] Precision loss: ${ethers.formatUnits(
      epochRewardsPool - expectedRewardsPool,
      18,
    )} TRAC`,
  );
  expect(epochRewardsPool).to.be.closeTo(
    expectedRewardsPool,
    ethers.parseUnits('0.0000002', 18),
  );
}

/**
 * Submit a proof for a node and verify the score calculation
 */
async function submitProofAndVerifyScore(
  nodeId: bigint,
  node: { operational: SignerWithAddress; admin: SignerWithAddress },
  contracts: TestContracts,
  epoch: bigint,
  expectedTotalStake: bigint,
): Promise<{ nodeScore: bigint; nodeScorePerStake: bigint }> {
  console.log(`    📋 Submitting proof for node ${nodeId}...`);

  // Get scores before proof submission
  const nodeScoreBeforeProofSubmission =
    await contracts.randomSamplingStorage.getNodeEpochScore(epoch, nodeId);
  const nodeScorePerStakeBeforeProofSubmission =
    await contracts.randomSamplingStorage.getNodeEpochScorePerStake(
      epoch,
      nodeId,
    );

  // Create challenge
  await contracts.randomSampling.connect(node.operational).createChallenge();
  const challenge =
    await contracts.randomSamplingStorage.getNodeChallenge(nodeId);

  // Generate and submit proof
  const chunks = kcTools.splitIntoChunks(quads, 32);
  const chunkId = Number(challenge[1]);
  const { proof } = kcTools.calculateMerkleProof(quads, 32, chunkId);
  await contracts.randomSampling
    .connect(node.operational)
    .submitProof(chunks[chunkId], proof);

  // Get actual score from contract
  const nodeScoreAfterProofSubmission =
    await contracts.randomSamplingStorage.getNodeEpochScore(epoch, nodeId);
  const nodeScorePerStake =
    await contracts.randomSamplingStorage.getNodeEpochScorePerStake(
      epoch,
      nodeId,
    );

  // Calculate expected scores
  const nodeScoreIncrement = await calculateExpectedNodeScore(
    nodeId,
    contracts,
  );
  console.log(`    ✅ Node score expected increment: ${nodeScoreIncrement}`);
  const expectedNodeScore = nodeScoreBeforeProofSubmission + nodeScoreIncrement;
  console.log(
    `    ✅ Expected node score: ${nodeScoreBeforeProofSubmission} + ${nodeScoreIncrement} = ${expectedNodeScore}, actual ${nodeScoreAfterProofSubmission}`,
  );
  // Verify scores match
  expect(nodeScoreAfterProofSubmission).to.be.gt(
    0,
    'Node score should be positive',
  );
  expect(nodeScoreAfterProofSubmission).to.be.equal(expectedNodeScore);

  const nodeScorePerStakeIncrement =
    (nodeScoreIncrement * ethers.parseUnits('1', 18)) / expectedTotalStake;
  console.log(
    `    ✅ Node score per stake expected increment: ${nodeScorePerStakeIncrement}`,
  );
  const expectedNodeScorePerStake =
    nodeScorePerStakeBeforeProofSubmission + nodeScorePerStakeIncrement;
  console.log(
    `    ✅ Node score per stake: expected ${nodeScorePerStakeBeforeProofSubmission} + ${nodeScorePerStakeIncrement} = ${expectedNodeScorePerStake}, actual ${nodeScorePerStake}`,
  );
  expect(nodeScorePerStake).to.be.gt(
    0,
    'Node score per stake should be positive',
  );
  expect(nodeScorePerStake).to.be.equal(expectedNodeScorePerStake);

  return {
    nodeScore: nodeScoreAfterProofSubmission,
    nodeScorePerStake: nodeScorePerStake,
  };
}

/**
 * Advance to next proofing period by mining blocks
 */
async function advanceToNextProofingPeriod(
  contracts: TestContracts,
): Promise<void> {
  const proofingPeriodDuration =
    await contracts.randomSamplingStorage.getLatestProofingPeriodDurationInBlocks();
  const activeProofPeriodStartBlock =
    await contracts.randomSamplingStorage.getActiveProofPeriodStartBlock();

  // Find out how many blocks are left in the current proofing period
  const currentBlock = Number(
    await hre.network.provider.send('eth_blockNumber'),
  );
  const blocksLeft =
    Number(activeProofPeriodStartBlock) +
    Number(proofingPeriodDuration) -
    currentBlock +
    1;

  for (let i = 0; i < blocksLeft; i++) {
    await hre.network.provider.send('evm_mine');
  }

  await contracts.randomSampling.updateAndGetActiveProofPeriodStartBlock();
}

async function ensureNodeHasChunksThisEpoch(
  nodeId: bigint,
  node: { operational: SignerWithAddress; admin: SignerWithAddress },
  contracts: TestContracts,
  accounts: TestAccounts,
  receivingNodes: {
    operational: SignerWithAddress;
    admin: SignerWithAddress;
  }[],
  receivingNodesIdentityIds: number[],
  chunkSize: number,
): Promise<void> {
  const produced =
    await contracts.epochStorage.getNodeCurrentEpochPublishingAllocation(
      nodeId,
    );

  if (produced === 0n) {
    if (
      !receivingNodes.some(
        (r) => r.operational.address === node.operational.address,
      )
    ) {
      receivingNodes.unshift(node);
      receivingNodesIdentityIds.unshift(Number(nodeId));
    }

    await createKnowledgeCollection(
      node.operational, // signer = node.operational
      node, // publisher-node
      Number(nodeId),
      receivingNodes,
      receivingNodesIdentityIds,
      { KnowledgeCollection: contracts.kc, Token: contracts.token },
      merkleRoot,
      `ensure-chunks-${Date.now()}`,
      1, // holders
      chunkSize, // byteSize - must be >= CHUNK_BYTE_SIZE to avoid division by zero
      1, // replicas
      toTRAC(1),
    );

    await contracts.randomSampling.updateAndGetActiveProofPeriodStartBlock();
  }
}

/**
 * Setup initial test environment with accounts and contracts
 */
async function setupTestEnvironment(): Promise<{
  accounts: TestAccounts;
  contracts: TestContracts;
  nodeIds: { node1Id: bigint; node2Id: bigint };
  chunkSize: number;
}> {
  hre.helpers.resetDeploymentsJson();
  await hre.deployments.fixture();

  const signers = await hre.ethers.getSigners();
  const accounts: TestAccounts = {
    owner: signers[0],
    node1: { operational: signers[1], admin: signers[2] },
    node2: { operational: signers[3], admin: signers[4] },
    delegator1: signers[5],
    delegator2: signers[6],
    delegator3: signers[7],
    kcCreator: signers[8],
    receiver1: { operational: signers[9], admin: signers[10] },
    receiver2: { operational: signers[11], admin: signers[12] },
    receiver3: { operational: signers[13], admin: signers[14] },
  };

  const contracts: TestContracts = {
    hub: await hre.ethers.getContract<Hub>('Hub'),
    token: await hre.ethers.getContract<Token>('Token'),
    chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    stakingStorage:
      await hre.ethers.getContract<StakingStorage>('StakingStorage'),
    randomSamplingStorage: await hre.ethers.getContract<RandomSamplingStorage>(
      'RandomSamplingStorage',
    ),
    parametersStorage:
      await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
    profileStorage:
      await hre.ethers.getContract<ProfileStorage>('ProfileStorage'),
    epochStorage: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
    delegatorsInfo:
      await hre.ethers.getContract<DelegatorsInfo>('DelegatorsInfo'),
    staking: await hre.ethers.getContract<Staking>('Staking'),
    stakingKPI: await hre.ethers.getContract<StakingKPI>('StakingKPI'),
    profile: await hre.ethers.getContract<Profile>('Profile'),
    randomSampling:
      await hre.ethers.getContract<RandomSampling>('RandomSampling'),
    kc: await hre.ethers.getContract<KnowledgeCollection>(
      'KnowledgeCollection',
    ),
    askStorage: await hre.ethers.getContract<AskStorage>('AskStorage'),
    ask: await hre.ethers.getContract<Ask>('Ask'),
  };

  // Get chunk size to avoid division by zero in challenge generation
  const chunkSize = Number(
    await contracts.randomSamplingStorage.CHUNK_BYTE_SIZE(),
  );

  await contracts.hub.setContractAddress('HubOwner', accounts.owner.address);
  // Phase 10 — opt this fixture into the auto-bridge in `kc-helpers.ts`. The
  // helper reads `Hub.getContractAddress("TestStorageOperator")` and, when
  // present, transparently registers each freshly-published KC into a default
  // open Context Graph and seeds its per-epoch value so the new
  // `RandomSampling.createChallenge` picker has eligible state to draw from.
  // signers[150] is well above the highest test-account index in this file.
  await contracts.hub.setContractAddress(
    'TestStorageOperator',
    signers[150].address,
  );

  // Mint tokens for all participants
  for (const delegator of [
    accounts.delegator1,
    accounts.delegator2,
    accounts.delegator3,
  ]) {
    await contracts.token.mint(delegator.address, toTRAC(100_000));
  }
  // const d2Balance = await contracts.token.balanceOf(
  //   accounts.delegator2.address,
  // );
  /* console.log(
    `\n💰💰💰 INITIAL BALANCE 💰💰💰 Delegator2 balance after minting: ${ethers.formatUnits(
      d2Balance,
      await contracts.token.decimals(),
    )} TRAC\n`,
  ); */
  await contracts.token.mint(accounts.owner.address, toTRAC(1_000_000));
  await contracts.token.mint(
    accounts.node1.operational.address,
    toTRAC(1_000_000),
  );
  await contracts.token.mint(accounts.kcCreator.address, toTRAC(1_000_000));

  await contracts.parametersStorage
    .connect(accounts.owner) // HubOwner
    .setOperatorFeeUpdateDelay(0);

  // Create node profiles
  const { identityId: node1Id } = await createProfile(
    contracts.profile,
    accounts.node1,
  );
  const { identityId: node2Id } = await createProfile(
    contracts.profile,
    accounts.node2,
  );
  console.log(`\n📚 Node1 ID = ${node1Id}, operator fee=0`);
  await contracts.profile
    .connect(accounts.node1.admin)
    .updateOperatorFee(node1Id, 0); // 0 %

  expect(await contracts.profileStorage.getOperatorFee(node1Id)).to.equal(0);

  console.log(`\n📚 Node2 ID = ${node2Id}, operator fee=0`);
  await contracts.profile
    .connect(accounts.node2.admin)
    .updateOperatorFee(node2Id, 0); // 0 %

  expect(await contracts.profileStorage.getOperatorFee(node2Id)).to.equal(0);
  // Initialize ask system (required to prevent division by zero in RandomSampling)
  await contracts.parametersStorage.setMinimumStake(toTRAC(100));

  // Jump to clean epoch start
  const timeUntilNextEpoch = await contracts.chronos.timeUntilNextEpoch();
  await time.increase(timeUntilNextEpoch + 1n);

  return {
    accounts,
    contracts,
    nodeIds: { node1Id: BigInt(node1Id), node2Id: BigInt(node2Id) },
    chunkSize,
  };
}

export { time, kcTools, expect, hre, ethers, createKnowledgeCollection, createProfile, quads, merkleRoot, toTRAC };
export { calculateExpectedNodeScore, calculateExpectedDelegatorScore, epochRewardsPoolPrecisionLoss };
export { submitProofAndVerifyScore, advanceToNextProofingPeriod, ensureNodeHasChunksThisEpoch, setupTestEnvironment };

export type { SignerWithAddress, TestContracts, TestAccounts };
