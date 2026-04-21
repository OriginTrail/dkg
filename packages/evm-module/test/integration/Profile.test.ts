/* eslint-disable @typescript-eslint/no-unused-expressions */

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { time } from '@nomicfoundation/hardhat-network-helpers';
// @ts-expect-error – assertion-tools nema definicije tipova
import { kcTools } from 'assertion-tools';
import { expect } from 'chai';
import hre, { deployments } from 'hardhat';

import {
  Token,
  Profile,
  ProfileStorage,
  Staking,
  Chronos,
  RandomSamplingStorage,
  EpochStorage,
  KnowledgeCollection,
  Hub,
  StakingStorage,
  RandomSampling,
  Ask,
  AskStorage,
  ParametersStorage,
  DelegatorsInfo,
  ShardingTable,
} from '../../typechain';
import { createKnowledgeCollection } from '../helpers/kc-helpers';
import { createProfile } from '../helpers/profile-helpers';

/* ────────────────────────── helpers ────────────────────────── */

const toTRAC = (x: number) => hre.ethers.parseEther(x.toString());

// Sample data for KC (copied from full scenario)
const quads = [
  '<urn:us-cities:info:new-york> <http://schema.org/area> "468.9 sq mi" .',
  '<urn:us-cities:info:new-york> <http://schema.org/name> "New York" .',
  '<urn:us-cities:info:new-york> <http://schema.org/population> "8,336,817" .',
  '<urn:us-cities:info:new-york> <http://schema.org/state> "New York" .',
  '<urn:us-cities:info:new-york> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://schema.org/City> .',
  // Add more quads to ensure we have enough chunks
  ...Array(1000).fill(
    '<urn:fake:quad> <urn:fake:predicate> <urn:fake:object> .',
  ),
];

// Helper function to ensure node has chunks and submit proof
async function ensureNodeHasChunksThisEpoch(
  nodeId: number,
  node: { operational: SignerWithAddress; admin: SignerWithAddress },
  contracts: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  accounts: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  receivingNodes: {
    operational: SignerWithAddress;
    admin: SignerWithAddress;
  }[],
  receivingNodesIdentityIds: number[],
  chunkSize: number,
): Promise<void> {
  const produced =
    await contracts.epochStorage.getNodeCurrentEpochProducedKnowledgeValue(
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

    const merkleRoot = kcTools.calculateMerkleRoot(quads, 32);

    await createKnowledgeCollection(
      node.operational, // signer = node.operational
      node, // publisher-node
      Number(nodeId),
      receivingNodes,
      receivingNodesIdentityIds,
      { KnowledgeCollection: contracts.kc, Token: contracts.token },
      merkleRoot,
      `ensure-chunks-${Date.now()}`,
      1, // knowledgeAssetsAmount
      chunkSize, // byteSize - must be >= CHUNK_BYTE_SIZE to avoid division by zero
      1, // epochs
      toTRAC(1),
    );

    await contracts.randomSampling.updateAndGetActiveProofPeriodStartBlock();
  }
}

// Helper function to advance to next proofing period
async function advanceToNextProofingPeriod(
  contracts: any, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<void> {
  const proofingPeriodDuration =
    await contracts.randomSampling.getActiveProofingPeriodDurationInBlocks();
  const { activeProofPeriodStartBlock, isValid } =
    await contracts.randomSampling.getActiveProofPeriodStatus();
  if (isValid) {
    // Find out how many blocks are left in the current proofing period
    const blocksLeft =
      Number(activeProofPeriodStartBlock) +
      Number(proofingPeriodDuration) -
      Number(await hre.network.provider.send('eth_blockNumber')) +
      1;
    for (let i = 0; i < blocksLeft; i++) {
      await hre.network.provider.send('evm_mine');
    }
  }
  await contracts.randomSampling.updateAndGetActiveProofPeriodStartBlock();
}

// Helper function to submit proof and log scores
async function submitProofAndLogScore(
  nodeId: number,
  nodeAccount: { operational: SignerWithAddress; admin: SignerWithAddress },
  contracts: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  epoch: bigint,
) {
  // Get score before proof
  const scoreBefore = await contracts.randomSamplingStorage.getNodeEpochScore(
    epoch,
    nodeId,
  );

  // Create challenge and submit proof
  await contracts.randomSampling
    .connect(nodeAccount.operational)
    .createChallenge();
  const challenge =
    await contracts.randomSamplingStorage.getNodeChallenge(nodeId);

  // Calculate merkle proof for the challenge
  const chunks = kcTools.splitIntoChunks(quads, 32);
  const chunkId = Number(challenge[1]);
  const { proof } = kcTools.calculateMerkleProof(quads, 32, chunkId);

  await contracts.randomSampling
    .connect(nodeAccount.operational)
    .submitProof(chunks[chunkId], proof);

  // Get score after proof
  const scoreAfter = await contracts.randomSamplingStorage.getNodeEpochScore(
    epoch,
    nodeId,
  );
  const scorePerStake =
    await contracts.randomSamplingStorage.getNodeEpochScorePerStake(
      epoch,
      nodeId,
    );

  return { scoreBefore, scoreAfter, scorePerStake };
}

/* ───────────────────── fixture: build initial state ───────────────────── */

export async function buildInitialRewardsState() {
  hre.helpers.resetDeploymentsJson();
  await hre.deployments.fixture();

  const signers = await hre.ethers.getSigners();

  const contracts = {
    hub: await hre.ethers.getContract<Hub>('Hub'),
    token: await hre.ethers.getContract<Token>('Token'),
    chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    profile: await hre.ethers.getContract<Profile>('Profile'),
    staking: await hre.ethers.getContract<Staking>('Staking'),
    stakingStorage:
      await hre.ethers.getContract<StakingStorage>('StakingStorage'),
    delegatorsInfo:
      await hre.ethers.getContract<DelegatorsInfo>('DelegatorsInfo'),
    randomSamplingStorage: await hre.ethers.getContract<RandomSamplingStorage>(
      'RandomSamplingStorage',
    ),
    randomSampling:
      await hre.ethers.getContract<RandomSampling>('RandomSampling'),
    epochStorage: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
    kc: await hre.ethers.getContract<KnowledgeCollection>(
      'KnowledgeCollection',
    ),
    ask: await hre.ethers.getContract<Ask>('Ask'),
    askStorage: await hre.ethers.getContract<AskStorage>('AskStorage'),
    parametersStorage:
      await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
    profileStorage:
      await hre.ethers.getContract<ProfileStorage>('ProfileStorage'),
    shardingTable: await hre.ethers.getContract<ShardingTable>('ShardingTable'),
  };

  // Get chunk size to avoid division by zero in challenge generation
  const chunkSize = Number(
    await contracts.randomSamplingStorage.CHUNK_BYTE_SIZE(),
  );

  const accounts = {
    owner: signers[0],
    // 4 nodes with separate operational and admin wallets
    node1: { operational: signers[1], admin: signers[2] },
    node2: { operational: signers[3], admin: signers[4] },
    node3: { operational: signers[5], admin: signers[6] },
    node4: { operational: signers[7], admin: signers[8] },
    // 12 delegators now (need more for the new distribution)
    delegators: signers.slice(10, 22),
    kcCreator: signers[9],
  };

  // Create receiving nodes arrays for proof submissions (all nodes)
  const receivingNodes = [
    accounts.node1,
    accounts.node2,
    accounts.node3,
    accounts.node4,
  ];
  const receivingNodesIdentityIds: number[] = [];

  await contracts.hub.setContractAddress('HubOwner', accounts.owner.address);
  // Phase 10 — opt this fixture into the auto-bridge in `kc-helpers.ts`. The
  // helper reads `Hub.getContractAddress("TestStorageOperator")` and, when
  // present, transparently registers each freshly-published KC into a default
  // open Context Graph and seeds its per-epoch value so the new
  // `RandomSampling.createChallenge` picker has eligible state to draw from.
  // signers[150] is well above any test-account index in this file.
  await contracts.hub.setContractAddress(
    'TestStorageOperator',
    signers[150].address,
  );

  // Initialize ask system to prevent division by zero
  await contracts.parametersStorage.setMinimumStake(toTRAC(100));
  await contracts.parametersStorage
    .connect(accounts.owner)
    .setOperatorFeeUpdateDelay(0);

  // Mint tokens for all delegators
  for (const delegator of accounts.delegators) {
    await contracts.token.mint(delegator.address, toTRAC(1_000_000));
  }
  await contracts.token.mint(accounts.kcCreator.address, toTRAC(1_000_000));

  // Create node profiles
  const { identityId: node1Id } = await createProfile(
    contracts.profile,
    accounts.node1,
  );
  const { identityId: node2Id } = await createProfile(
    contracts.profile,
    accounts.node2,
  );
  const { identityId: node3Id } = await createProfile(
    contracts.profile,
    accounts.node3,
  );
  const { identityId: node4Id } = await createProfile(
    contracts.profile,
    accounts.node4,
  );

  // @ts-expect-error – intentional direct insertNode for test setup
  await contracts.shardingTable.connect(accounts.owner).insertNode(node1Id);
  // @ts-expect-error – intentional direct insertNode for test setup
  await contracts.shardingTable.connect(accounts.owner).insertNode(node2Id);
  // @ts-expect-error – intentional direct insertNode for test setup
  await contracts.shardingTable.connect(accounts.owner).insertNode(node3Id);
  // @ts-expect-error – intentional direct insertNode for test setup
  await contracts.shardingTable.connect(accounts.owner).insertNode(node4Id);

  // Set operator fees to 10%
  await contracts.profile
    .connect(accounts.node1.admin)
    .updateOperatorFee(node1Id, 1000);
  await contracts.profile
    .connect(accounts.node2.admin)
    .updateOperatorFee(node2Id, 1000);
  await contracts.profile
    .connect(accounts.node3.admin)
    .updateOperatorFee(node3Id, 1000);
  await contracts.profile
    .connect(accounts.node4.admin)
    .updateOperatorFee(node4Id, 1000);

  // Populate receiving nodes identity IDs
  receivingNodesIdentityIds.push(node1Id, node2Id, node3Id, node4Id);

  // Initialize ask system for nodes
  const nodeAsk = hre.ethers.parseUnits('0.2', 18);
  await contracts.profile
    .connect(accounts.node1.operational)
    .updateAsk(node1Id, nodeAsk);
  await contracts.profile
    .connect(accounts.node2.operational)
    .updateAsk(node2Id, nodeAsk);
  await contracts.profile
    .connect(accounts.node3.operational)
    .updateAsk(node3Id, nodeAsk);
  await contracts.profile
    .connect(accounts.node4.operational)
    .updateAsk(node4Id, nodeAsk);
  await contracts.ask.connect(accounts.owner).recalculateActiveSet();

  const nodes = [
    {
      identityId: node1Id,
      operational: accounts.node1.operational,
      admin: accounts.node1.admin,
    },
    {
      identityId: node2Id,
      operational: accounts.node2.operational,
      admin: accounts.node2.admin,
    },
    {
      identityId: node3Id,
      operational: accounts.node3.operational,
      admin: accounts.node3.admin,
    },
    {
      identityId: node4Id,
      operational: accounts.node4.operational,
      admin: accounts.node4.admin,
    },
  ];

  // Jump to clean epoch start
  const timeUntilNextEpoch = await contracts.chronos.timeUntilNextEpoch();
  await time.increase(timeUntilNextEpoch + 1n);

  // Fast-forward to epoch-2
  while ((await contracts.chronos.getCurrentEpoch()) < 2n) {
    await time.increase((await contracts.chronos.timeUntilNextEpoch()) + 1n);
  }

  // Create identical reward pools for epoch-2 (each node publishes same amount)
  const kcTokenAmount = toTRAC(250); // Split total among 4 nodes
  const numberOfEpochs = 5;
  // @ts-expect-error – dynamic import JS biblioteke bez tipova
  const { kcTools } = await import('assertion-tools');
  const merkleRoot = kcTools.calculateMerkleRoot(quads, 32);

  // Create identical KC for each node to ensure equal publishing values
  for (let i = 0; i < nodes.length; i++) {
    const publisherNode = nodes[i];
    const otherNodes = nodes.filter((_, idx) => idx !== i);
    const otherNodeIds = otherNodes.map((n) => n.identityId);

    await createKnowledgeCollection(
      accounts.kcCreator,
      publisherNode,
      publisherNode.identityId,
      otherNodes,
      otherNodeIds,
      { KnowledgeCollection: contracts.kc, Token: contracts.token },
      merkleRoot,
      `epoch-2-node-${i + 1}-kc`,
      3, // Same knowledge assets amount for all
      chunkSize * 3, // Same byte size for all
      numberOfEpochs,
      kcTokenAmount, // Same token amount for all
    );
  }

  // EPOCH-2 STAKES:
  // Node-1: D1→10k, D2→20k
  // Node-2: D3→10k, D4→20k (same pattern as Node-1)
  console.log(
    '\n╔══════════════════════════════════════════════════════════════════════════════════╗',
  );
  console.log(
    '║                                EPOCH-2 STAKING                                  ║',
  );
  console.log(
    '╠══════════════════════════════════════════════════════════════════════════════════╣',
  );

  // Node-1 delegators
  await contracts.token
    .connect(accounts.delegators[0])
    .approve(await contracts.staking.getAddress(), toTRAC(10_000));
  await contracts.staking
    .connect(accounts.delegators[0])
    .stake(node1Id, toTRAC(10_000));
  console.log(
    '║  📍 D1  →  10,000 TRAC  →  Node-1                                               ║',
  );

  await contracts.token
    .connect(accounts.delegators[1])
    .approve(await contracts.staking.getAddress(), toTRAC(20_000));
  await contracts.staking
    .connect(accounts.delegators[1])
    .stake(node1Id, toTRAC(20_000));
  console.log(
    '║  📍 D2  →  20,000 TRAC  →  Node-1                                               ║',
  );

  // Node-2 delegators (same pattern)
  await contracts.token
    .connect(accounts.delegators[2])
    .approve(await contracts.staking.getAddress(), toTRAC(10_000));
  await contracts.staking
    .connect(accounts.delegators[2])
    .stake(node2Id, toTRAC(10_000));
  console.log(
    '║  📍 D3  →  10,000 TRAC  →  Node-2                                               ║',
  );

  await contracts.token
    .connect(accounts.delegators[3])
    .approve(await contracts.staking.getAddress(), toTRAC(20_000));
  await contracts.staking
    .connect(accounts.delegators[3])
    .stake(node2Id, toTRAC(20_000));
  console.log(
    '║  📍 D4  →  20,000 TRAC  →  Node-2                                               ║',
  );
  console.log(
    '╚══════════════════════════════════════════════════════════════════════════════════╝',
  );

  // Submit proofs at end of epoch-2
  await advanceToNextProofingPeriod(contracts);

  // All nodes already have equal KC chunks from the identical KC creation above
  // No need for ensureNodeHasChunksThisEpoch() since each node published identical KC

  console.log('\n🔬 EPOCH-2 PROOFS SUBMITTED:');
  const node1Proof2 = await submitProofAndLogScore(
    node1Id,
    accounts.node1,
    contracts,
    2n,
  );
  console.log(
    `   ✅ Node-1: Score ${node1Proof2.scoreBefore} → ${node1Proof2.scoreAfter} (gain: ${node1Proof2.scoreAfter - node1Proof2.scoreBefore})`,
  );

  const node2Proof2 = await submitProofAndLogScore(
    node2Id,
    accounts.node2,
    contracts,
    2n,
  );
  console.log(
    `   ✅ Node-2: Score ${node2Proof2.scoreBefore} → ${node2Proof2.scoreAfter} (gain: ${node2Proof2.scoreAfter - node2Proof2.scoreBefore})`,
  );

  const node3Proof2 = await submitProofAndLogScore(
    node3Id,
    accounts.node3,
    contracts,
    2n,
  );
  console.log(
    `   ✅ Node-3: Score ${node3Proof2.scoreBefore} → ${node3Proof2.scoreAfter} (gain: ${node3Proof2.scoreAfter - node3Proof2.scoreBefore})`,
  );

  const node4Proof2 = await submitProofAndLogScore(
    node4Id,
    accounts.node4,
    contracts,
    2n,
  );
  console.log(
    `   ✅ Node-4: Score ${node4Proof2.scoreBefore} → ${node4Proof2.scoreAfter} (gain: ${node4Proof2.scoreAfter - node4Proof2.scoreBefore})`,
  );

  // → EPOCH-3
  await time.increase((await contracts.chronos.timeUntilNextEpoch()) + 1n);

  // Create identical reward pools for epoch-3 (each node publishes same amount)
  const kcTokenAmountEpoch3 = toTRAC(100); // Split total among 4 nodes
  const numberOfEpochsEpoch3 = 1;

  // Create identical KC for each node to ensure equal publishing values
  for (let i = 0; i < nodes.length; i++) {
    const publisherNode = nodes[i];
    const otherNodes = nodes.filter((_, idx) => idx !== i);
    const otherNodeIds = otherNodes.map((n) => n.identityId);

    await createKnowledgeCollection(
      accounts.kcCreator,
      publisherNode,
      publisherNode.identityId,
      otherNodes,
      otherNodeIds,
      { KnowledgeCollection: contracts.kc, Token: contracts.token },
      merkleRoot,
      `epoch-3-node-${i + 1}-kc`,
      1, // Same knowledge assets amount for all
      chunkSize * 5, // Same byte size for all
      numberOfEpochsEpoch3,
      kcTokenAmountEpoch3, // Same token amount for all
    );
  }

  // EPOCH-3 STAKES:
  // Node-1: D5→30k, D6→40k, D7→50k
  // Node-2: D8→30k, D9→40k, D10→50k (same pattern as Node-1)
  // Node-3: D11→60k, D12→50k (original Node-2 pattern from your request)
  console.log(
    '\n╔══════════════════════════════════════════════════════════════════════════════════╗',
  );
  console.log(
    '║                                EPOCH-3 STAKING                                  ║',
  );
  console.log(
    '╠══════════════════════════════════════════════════════════════════════════════════╣',
  );

  // Node-1 additional delegators
  await contracts.token
    .connect(accounts.delegators[4])
    .approve(await contracts.staking.getAddress(), toTRAC(30_000));
  await contracts.staking
    .connect(accounts.delegators[4])
    .stake(node1Id, toTRAC(30_000));
  console.log(
    '║  📍 D5  →  30,000 TRAC  →  Node-1                                               ║',
  );

  await contracts.token
    .connect(accounts.delegators[5])
    .approve(await contracts.staking.getAddress(), toTRAC(40_000));
  await contracts.staking
    .connect(accounts.delegators[5])
    .stake(node1Id, toTRAC(40_000));
  console.log(
    '║  📍 D6  →  40,000 TRAC  →  Node-1                                               ║',
  );

  await contracts.token
    .connect(accounts.delegators[6])
    .approve(await contracts.staking.getAddress(), toTRAC(50_000));
  await contracts.staking
    .connect(accounts.delegators[6])
    .stake(node1Id, toTRAC(50_000));
  console.log(
    '║  📍 D7  →  50,000 TRAC  →  Node-1                                               ║',
  );

  // Node-2 additional delegators (same pattern as Node-1)
  await contracts.token
    .connect(accounts.delegators[7])
    .approve(await contracts.staking.getAddress(), toTRAC(30_000));
  await contracts.staking
    .connect(accounts.delegators[7])
    .stake(node2Id, toTRAC(30_000));
  console.log(
    '║  📍 D8  →  30,000 TRAC  →  Node-2                                               ║',
  );

  await contracts.token
    .connect(accounts.delegators[8])
    .approve(await contracts.staking.getAddress(), toTRAC(40_000));
  await contracts.staking
    .connect(accounts.delegators[8])
    .stake(node2Id, toTRAC(40_000));
  console.log(
    '║  📍 D9  →  40,000 TRAC  →  Node-2                                               ║',
  );

  await contracts.token
    .connect(accounts.delegators[9])
    .approve(await contracts.staking.getAddress(), toTRAC(50_000));
  await contracts.staking
    .connect(accounts.delegators[9])
    .stake(node2Id, toTRAC(50_000));
  console.log(
    '║  📍 D10 →  50,000 TRAC  →  Node-2                                               ║',
  );

  // Node-3 delegators (your original Node-2 pattern)
  await contracts.token
    .connect(accounts.delegators[10])
    .approve(await contracts.staking.getAddress(), toTRAC(60_000));
  await contracts.staking
    .connect(accounts.delegators[10])
    .stake(node3Id, toTRAC(60_000));
  console.log(
    '║  📍 D11 →  60,000 TRAC  →  Node-3                                               ║',
  );

  await contracts.token
    .connect(accounts.delegators[11])
    .approve(await contracts.staking.getAddress(), toTRAC(50_000));
  await contracts.staking
    .connect(accounts.delegators[11])
    .stake(node3Id, toTRAC(50_000));
  console.log(
    '║  📍 D12 →  50,000 TRAC  →  Node-3                                               ║',
  );
  console.log(
    '╚══════════════════════════════════════════════════════════════════════════════════╝',
  );

  // Submit proofs at end of epoch-3
  await advanceToNextProofingPeriod(contracts);

  // All nodes already have equal KC chunks from the identical KC creation above
  // No need for ensureNodeHasChunksThisEpoch() since each node published identical KC

  console.log('\n🔬 EPOCH-3 PROOFS SUBMITTED:');
  const node1Proof3 = await submitProofAndLogScore(
    node1Id,
    accounts.node1,
    contracts,
    3n,
  );
  console.log(
    `   ✅ Node-1: Score ${node1Proof3.scoreBefore} → ${node1Proof3.scoreAfter} (gain: ${node1Proof3.scoreAfter - node1Proof3.scoreBefore})`,
  );

  const node2Proof3 = await submitProofAndLogScore(
    node2Id,
    accounts.node2,
    contracts,
    3n,
  );
  console.log(
    `   ✅ Node-2: Score ${node2Proof3.scoreBefore} → ${node2Proof3.scoreAfter} (gain: ${node2Proof3.scoreAfter - node2Proof3.scoreBefore})`,
  );

  const node3Proof3 = await submitProofAndLogScore(
    node3Id,
    accounts.node3,
    contracts,
    3n,
  );
  console.log(
    `   ✅ Node-3: Score ${node3Proof3.scoreBefore} → ${node3Proof3.scoreAfter} (gain: ${node3Proof3.scoreAfter - node3Proof3.scoreBefore})`,
  );

  const node4Proof3 = await submitProofAndLogScore(
    node4Id,
    accounts.node4,
    contracts,
    3n,
  );
  console.log(
    `   ✅ Node-4: Score ${node4Proof3.scoreBefore} → ${node4Proof3.scoreAfter} (gain: ${node4Proof3.scoreAfter - node4Proof3.scoreBefore})`,
  );

  // → EPOCH-4 (to finalize epoch-3)
  await time.increase((await contracts.chronos.timeUntilNextEpoch()) + 1n);

  // Create KC to finalize epoch-3 (this is crucial for epoch finalization!)
  await createKnowledgeCollection(
    accounts.kcCreator,
    accounts.node4,
    node4Id,
    [accounts.node1, accounts.node2, accounts.node3],
    [node1Id, node2Id, node3Id],
    { KnowledgeCollection: contracts.kc, Token: contracts.token },
    merkleRoot, // Use consistent merkleRoot from quads
    'finalize-epoch-3',
    10,
    chunkSize * 20, // byteSize - use multiple of chunkSize
    10,
    toTRAC(50_000),
  );

  // Submit proofs at end of epoch-4
  await advanceToNextProofingPeriod(contracts);

  // Ensure all nodes have chunks before submitting proofs for epoch-4
  await ensureNodeHasChunksThisEpoch(
    node1Id,
    accounts.node1,
    contracts,
    accounts,
    receivingNodes,
    receivingNodesIdentityIds,
    chunkSize,
  );
  await ensureNodeHasChunksThisEpoch(
    node2Id,
    accounts.node2,
    contracts,
    accounts,
    receivingNodes,
    receivingNodesIdentityIds,
    chunkSize,
  );
  await ensureNodeHasChunksThisEpoch(
    node3Id,
    accounts.node3,
    contracts,
    accounts,
    receivingNodes,
    receivingNodesIdentityIds,
    chunkSize,
  );
  await ensureNodeHasChunksThisEpoch(
    node4Id,
    accounts.node4,
    contracts,
    accounts,
    receivingNodes,
    receivingNodesIdentityIds,
    chunkSize,
  );

  console.log('\n🔬 EPOCH-4 PROOFS SUBMITTED:');
  const node1Proof4 = await submitProofAndLogScore(
    node1Id,
    accounts.node1,
    contracts,
    4n,
  );
  console.log(
    `   ✅ Node-1: Score ${node1Proof4.scoreBefore} → ${node1Proof4.scoreAfter} (gain: ${node1Proof4.scoreAfter - node1Proof4.scoreBefore})`,
  );

  const node2Proof4 = await submitProofAndLogScore(
    node2Id,
    accounts.node2,
    contracts,
    4n,
  );
  console.log(
    `   ✅ Node-2: Score ${node2Proof4.scoreBefore} → ${node2Proof4.scoreAfter} (gain: ${node2Proof4.scoreAfter - node2Proof4.scoreBefore})`,
  );

  const node3Proof4 = await submitProofAndLogScore(
    node3Id,
    accounts.node3,
    contracts,
    4n,
  );
  console.log(
    `   ✅ Node-3: Score ${node3Proof4.scoreBefore} → ${node3Proof4.scoreAfter} (gain: ${node3Proof4.scoreAfter - node3Proof4.scoreBefore})`,
  );

  const node4Proof4 = await submitProofAndLogScore(
    node4Id,
    accounts.node4,
    contracts,
    4n,
  );
  console.log(
    `   ✅ Node-4: Score ${node4Proof4.scoreBefore} → ${node4Proof4.scoreAfter} (gain: ${node4Proof4.scoreAfter - node4Proof4.scoreBefore})`,
  );

  // → EPOCH-5
  await time.increase((await contracts.chronos.timeUntilNextEpoch()) + 1n);

  // Create KC for epoch-5 to ensure there's activity
  await createKnowledgeCollection(
    accounts.kcCreator,
    accounts.node1,
    node1Id,
    [accounts.node2, accounts.node3, accounts.node4],
    [node2Id, node3Id, node4Id],
    { KnowledgeCollection: contracts.kc, Token: contracts.token },
    merkleRoot, // Use consistent merkleRoot from quads
    'epoch-5-no-proofs',
    5,
    chunkSize * 15, // byteSize - use multiple of chunkSize
    3,
    toTRAC(2_000),
  );

  // EPOCH-5 STAKES:
  // Add delegator 13 and 14 with 35k TRAC each
  console.log(
    '\n╔══════════════════════════════════════════════════════════════════════════════════╗',
  );
  console.log(
    '║                                EPOCH-5 STAKING                                  ║',
  );
  console.log(
    '╠══════════════════════════════════════════════════════════════════════════════════╣',
  );

  // Need to add more delegators to accounts since we only had 12 before
  if (accounts.delegators.length < 14) {
    const additionalDelegators = signers.slice(22, 24); // Get signers 22 and 23 for D13 and D14
    accounts.delegators.push(...additionalDelegators);

    // Mint tokens for new delegators
    for (const delegator of additionalDelegators) {
      await contracts.token.mint(delegator.address, toTRAC(1_000_000));
    }
  }

  // D13 stakes 35k to Node-1
  await contracts.token
    .connect(accounts.delegators[12])
    .approve(await contracts.staking.getAddress(), toTRAC(35_000));
  await contracts.staking
    .connect(accounts.delegators[12])
    .stake(node1Id, toTRAC(35_000));
  console.log(
    '║  📍 D13 →  35,000 TRAC  →  Node-1                                               ║',
  );

  // D14 stakes 35k to Node-2
  await contracts.token
    .connect(accounts.delegators[13])
    .approve(await contracts.staking.getAddress(), toTRAC(35_000));
  await contracts.staking
    .connect(accounts.delegators[13])
    .stake(node2Id, toTRAC(35_000));
  console.log(
    '║  📍 D14 →  35,000 TRAC  →  Node-2                                               ║',
  );
  console.log(
    '╚══════════════════════════════════════════════════════════════════════════════════╝',
  );

  console.log('\n🚫 EPOCH-5: NO PROOFS SUBMITTED');

  // → EPOCH-6 (to finalize epoch-5)
  await time.increase((await contracts.chronos.timeUntilNextEpoch()) + 1n);

  // Create KC for epoch-6 to finalize epoch-5
  await createKnowledgeCollection(
    accounts.kcCreator,
    accounts.node3,
    node3Id,
    [accounts.node1, accounts.node2, accounts.node4],
    [node1Id, node2Id, node4Id],
    { KnowledgeCollection: contracts.kc, Token: contracts.token },
    merkleRoot, // Use consistent merkleRoot from quads
    'finalize-epoch-5',
    8,
    chunkSize * 25, // byteSize - use multiple of chunkSize
    5,
    toTRAC(10_000),
  );

  console.log('\n🚫 EPOCH-6: NO PROOFS SUBMITTED');

  // → EPOCH-7 (to finalize epoch-6)
  await time.increase((await contracts.chronos.timeUntilNextEpoch()) + 1n);

  // Create KC for epoch-7 to finalize epoch-6
  await createKnowledgeCollection(
    accounts.kcCreator,
    accounts.node4,
    node4Id,
    [accounts.node1, accounts.node2, accounts.node3],
    [node1Id, node2Id, node3Id],
    { KnowledgeCollection: contracts.kc, Token: contracts.token },
    merkleRoot, // Use consistent merkleRoot from quads
    'finalize-epoch-6',
    12,
    chunkSize * 30, // byteSize - use multiple of chunkSize
    8,
    toTRAC(15_000),
  );

  console.log('\n📝 EPOCH-7: System ready for comprehensive testing');

  // Print detailed snapshot
  console.log('\n');
  console.log(
    '═══════════════════════════════════════════════════════════════════════════════════════════════',
  );
  console.log(
    '                                 🎯 FINAL SYSTEM STATE 🎯                                      ',
  );
  console.log(
    '═══════════════════════════════════════════════════════════════════════════════════════════════',
  );

  const currentEpoch = await contracts.chronos.getCurrentEpoch();
  const lastFinalizedEpoch = await contracts.epochStorage.lastFinalizedEpoch(1);
  console.log(
    `📅 Current Epoch: ${currentEpoch} | Last Finalized: ${lastFinalizedEpoch}`,
  );
  console.log('');

  console.log(
    '┌─────────────────────────────────────────────────────────────────────────────────────────────┐',
  );
  console.log(
    '│                                     📊 STAKING TIMELINE                                     │',
  );
  console.log(
    '├─────────────────────────────────────────────────────────────────────────────────────────────┤',
  );
  console.log(
    '│  EPOCH-2: D1→10k, D2→20k (Node-1)  │  D3→10k, D4→20k (Node-2)  │  All nodes proofs    │',
  );
  console.log(
    '│  EPOCH-3: D5→30k, D6→40k, D7→50k (Node-1)  │  D8→30k, D9→40k, D10→50k (Node-2)         │',
  );
  console.log(
    '│           D11→60k, D12→50k (Node-3)  │  All nodes submitted proofs                     │',
  );
  console.log(
    '│  EPOCH-4: All nodes submitted proofs                                                     │',
  );
  console.log(
    '│  EPOCH-5: D13→35k (Node-1)  │  D14→35k (Node-2)  │  NO PROOFS SUBMITTED               │',
  );
  console.log(
    '│  EPOCH-6: NO PROOFS SUBMITTED (finalization epoch for epoch-5)                          │',
  );
  console.log(
    '│  EPOCH-7: Current epoch (finalization epoch for epoch-6)                                │',
  );
  console.log(
    '└─────────────────────────────────────────────────────────────────────────────────────────────┘',
  );
  console.log('');

  for (const [i, node] of nodes.entries()) {
    const totalStake = await contracts.stakingStorage.getNodeStake(
      node.identityId,
    );
    const nodeScore2 = await contracts.randomSamplingStorage.getNodeEpochScore(
      2n,
      node.identityId,
    );
    const nodeScore3 = await contracts.randomSamplingStorage.getNodeEpochScore(
      3n,
      node.identityId,
    );
    const nodeScore4 = await contracts.randomSamplingStorage.getNodeEpochScore(
      4n,
      node.identityId,
    );
    const nodeScore5 = await contracts.randomSamplingStorage.getNodeEpochScore(
      5n,
      node.identityId,
    );

    console.log(`🚀 Node-${i + 1} (ID: ${node.identityId})`);
    console.log(
      `   💰 Total Stake: ${hre.ethers.formatUnits(totalStake, 18)} TRAC | 🎯 Operator Fee: 10%`,
    );
    console.log(
      `   📊 Scores → E2: ${nodeScore2} | E3: ${nodeScore3} | E4: ${nodeScore4} | E5: ${nodeScore5}`,
    );

    const delegatorStakes = [];
    for (let d = 0; d < accounts.delegators.length; d++) {
      const key = hre.ethers.keccak256(
        hre.ethers.solidityPacked(
          ['address'],
          [accounts.delegators[d].address],
        ),
      );
      const stake = await contracts.stakingStorage.getDelegatorStakeBase(
        node.identityId,
        key,
      );
      if (stake > 0n) {
        delegatorStakes.push(`D${d + 1}: ${hre.ethers.formatUnits(stake, 18)}`);
      }
    }

    if (delegatorStakes.length > 0) {
      console.log(`   👥 Delegators: ${delegatorStakes.join(' | ')}`);
    }
    console.log('');
  }

  console.log(
    '═══════════════════════════════════════════════════════════════════════════════════════════════\n',
  );

  // Return environment for tests
  return {
    Token: contracts.token,
    Profile: contracts.profile,
    ProfileStorage: contracts.profileStorage,
    Staking: contracts.staking,
    StakingStorage: contracts.stakingStorage,
    DelegatorsInfo: contracts.delegatorsInfo,
    Chronos: contracts.chronos,
    RandomSamplingStorage: contracts.randomSamplingStorage,
    EpochStorage: contracts.epochStorage,
    KC: contracts.kc,
    delegators: accounts.delegators,
    nodes,
    receivingNodes,
    receivingNodesIdentityIds,
    accounts,
  };
}

const fixtureInitialRewardsState = deployments.createFixture(
  buildInitialRewardsState,
);

/* ───────────────────────────── tests ───────────────────────────── */

describe('Profile Contract', () => {
  describe('Operator Fee Management', () => {
    let fixtures: Awaited<ReturnType<typeof buildInitialRewardsState>>;
    let node1: {
      identityId: number;
      operational: SignerWithAddress;
      admin: SignerWithAddress;
    };
    const newFee = 2000; // 20%

    beforeEach(async function () {
      this.timeout(400000);
      fixtures = await fixtureInitialRewardsState();
      node1 = fixtures.nodes[0];
    });

    it('should REVERT fee update if previous epoch rewards are not claimed', async () => {
      const { Profile, accounts } = fixtures;
      // At the start, current epoch is 7. The check is for epoch 6.
      // Rewards for epoch 6 have not been claimed yet, so this must revert.
      await expect(
        Profile.connect(accounts.node1.admin).updateOperatorFee(
          node1.identityId,
          newFee,
        ),
      ).to.be.revertedWith(
        'Cannot update operatorFee if operatorFee has not been calculated and claimed for previous epochs',
      );
    });

    it('should REVERT fee update if rewards for older, but not the previous, epoch are claimed', async () => {
      const { Staking, Profile, accounts, delegators } = fixtures;
      const delegatorForNode1 = delegators[0]; // D1

      // Claim rewards for some older epochs (e.g., 2, 3, 4).
      // This will not satisfy the condition for epoch 6.
      //
      // Only tolerate "nothing to claim" style reverts — any other failure
      // (e.g. order-violation, unauthorised signer) should surface instead of
      // being silently swallowed. Catches regression where a real bug in
      // claimDelegatorRewards hides behind an empty catch.
      for (const epoch of [2, 3, 4]) {
        try {
          await Staking.connect(delegatorForNode1).claimDelegatorRewards(
            node1.identityId,
            epoch,
            delegatorForNode1.address,
          );
        } catch (err: unknown) {
          const msg = String((err as { message?: string })?.message ?? err);
          if (!/nothing to claim|NoRewards|zero amount|already claimed|no rewards/i.test(msg)) {
            throw err;
          }
        }
      }

      // We are still in epoch 7, and rewards for epoch 6 are still not claimed.
      // The check should still fail.
      await expect(
        Profile.connect(accounts.node1.admin).updateOperatorFee(
          node1.identityId,
          newFee,
        ),
      ).to.be.revertedWith(
        'Cannot update operatorFee if operatorFee has not been calculated and claimed for previous epochs',
      );
    });

    it('should handle the full operator fee update lifecycle correctly', async () => {
      const { Staking, Profile, ProfileStorage, delegators } = fixtures;

      const newFee = 2000; // 20%
      const d1 = delegators[0];
      const d2 = delegators[1];

      // STEP 1: Claim required epochs to enable fee updates
      const claims = [
        { delegator: d1, epoch: 2 },
        { delegator: d1, epoch: 3 },
        { delegator: d2, epoch: 2 },
        { delegator: d2, epoch: 3 },
        { delegator: d2, epoch: 4 },
        { delegator: d1, epoch: 4 },
        { delegator: d1, epoch: 5 },
        { delegator: d1, epoch: 6 },
      ];

      for (const claim of claims) {
        try {
          await Staking.connect(claim.delegator).claimDelegatorRewards(
            node1.identityId,
            claim.epoch,
            claim.delegator.address,
          );
        } catch (err: unknown) {
          // Accept only the benign "nothing to claim" case; other errors
          // must surface. Catches regression where an unrelated revert is
          // silently swallowed and the subsequent fee-update assertions
          // falsely pass.
          const msg = String((err as { message?: string })?.message ?? err);
          if (!/nothing to claim|NoRewards|zero amount|already claimed|no rewards/i.test(msg)) {
            throw err;
          }
        }
      }

      // STEP 2: Update operator fee and read when it should become effective
      const oldFee = await ProfileStorage.getOperatorFee(node1.identityId);
      const updateTime = await time.latest();

      await Profile.connect(node1.admin).updateOperatorFee(
        node1.identityId,
        newFee,
      );

      const pendingUpdate = await ProfileStorage.getLatestOperatorFee(
        node1.identityId,
      );
      const effectiveTime = pendingUpdate.effectiveDate;

      console.log('=== SIMPLE FEE UPDATE TEST ===');
      console.log(`Update set at: ${updateTime}`);
      console.log(`Should become effective at: ${effectiveTime}`);
      console.log(
        `Time until effective: ${Number(effectiveTime) - updateTime} seconds`,
      );

      // STEP 3: Verify fee is NOT active before effective time
      const currentFeeBeforeEffective = await ProfileStorage.getOperatorFee(
        node1.identityId,
      );
      expect(currentFeeBeforeEffective).to.equal(oldFee);
      console.log(`✓ Fee is still old (${oldFee}) before effective time`);

      // STEP 4: Advance time to exactly when it should become effective
      await time.increaseTo(effectiveTime + 1n);
      const checkTime = await time.latest();

      // STEP 5: Verify fee is now active
      const currentFeeAfterEffective = await ProfileStorage.getOperatorFee(
        node1.identityId,
      );
      expect(currentFeeAfterEffective).to.equal(newFee);
      console.log(
        `✓ Fee is now new (${currentFeeAfterEffective}) at effective time`,
      );
      console.log(
        `  Checked at time: ${checkTime} (effective was: ${effectiveTime})`,
      );
    });

    it('should allow replacing pending operator fee before it becomes active', async () => {
      const { Staking, Profile, ProfileStorage, Chronos, delegators } =
        fixtures;

      const firstFee = 2000; // 20%
      const secondFee = 3000; // 30%
      const d1 = delegators[0];
      const d2 = delegators[1];

      // STEP 1: Claim required epochs
      const currentEpoch = await Chronos.getCurrentEpoch();
      if (currentEpoch > 1) {
        const claims = [];
        const currentEpochNum = Number(currentEpoch);
        for (let epoch = 2; epoch <= currentEpochNum - 1; epoch++) {
          claims.push({ delegator: d1, epoch });
          if (epoch <= 4) {
            claims.push({ delegator: d2, epoch });
          }
        }

        for (const claim of claims) {
          try {
            await Staking.connect(claim.delegator).claimDelegatorRewards(
              node1.identityId,
              claim.epoch,
              claim.delegator.address,
            );
          } catch (err: unknown) {
            // Same tightening as above: only swallow the benign
            // "nothing to claim" case so real regressions surface.
            const msg = String((err as { message?: string })?.message ?? err);
            if (!/nothing to claim|NoRewards|zero amount|already claimed|no rewards/i.test(msg)) {
              throw err;
            }
          }
        }
      }

      // STEP 2: Set first fee and read when it should be effective
      const originalFee = await ProfileStorage.getOperatorFee(node1.identityId);
      const firstUpdateTime = await time.latest();

      await Profile.connect(node1.admin).updateOperatorFee(
        node1.identityId,
        firstFee,
      );

      let pendingUpdate = await ProfileStorage.getLatestOperatorFee(
        node1.identityId,
      );
      const firstEffectiveTime = pendingUpdate.effectiveDate;

      console.log('=== FEE REPLACEMENT TEST ===');
      console.log(`First update set at: ${firstUpdateTime}`);
      console.log(`First update should be effective at: ${firstEffectiveTime}`);

      // STEP 3: Wait some time but not until effective, then replace with second fee
      const epochLength = await Chronos.epochLength();
      await time.increase(epochLength / 2n + 1n);

      const secondUpdateTime = await time.latest();
      await Profile.connect(node1.admin).updateOperatorFee(
        node1.identityId,
        secondFee,
      );

      pendingUpdate = await ProfileStorage.getLatestOperatorFee(
        node1.identityId,
      );
      const secondEffectiveTime = pendingUpdate.effectiveDate;

      console.log(`Second update set at: ${secondUpdateTime}`);
      console.log(
        `Second update should be effective at: ${secondEffectiveTime}`,
      );
      console.log(
        `Second effective time is later: ${secondEffectiveTime > firstEffectiveTime}`,
      );

      // STEP 4: Verify fee is still original before second effective time
      const beforeCheckTime = await time.latest();
      const feeBeforeSecondEffective = await ProfileStorage.getOperatorFee(
        node1.identityId,
      );
      expect(feeBeforeSecondEffective).to.equal(originalFee);
      console.log(
        `✓ Fee is still original (${originalFee}) before second effective time`,
      );
      console.log(
        `  Checked at time: ${beforeCheckTime} (second effective is: ${secondEffectiveTime})`,
      );

      // STEP 5: Advance time to when second fee should be effective
      await time.increaseTo(secondEffectiveTime + 1n);
      const afterCheckTime = await time.latest();

      // STEP 6: Verify second fee is now active (first fee was replaced)
      const finalFee = await ProfileStorage.getOperatorFee(node1.identityId);
      expect(finalFee).to.equal(secondFee);
      console.log(
        `✓ Fee is now second fee (${finalFee}) - first fee was successfully replaced`,
      );
      console.log(
        `  Checked at time: ${afterCheckTime} (second effective was: ${secondEffectiveTime})`,
      );
    });

    it('should correctly manage storage, flags, and events during fee updates', async () => {
      const { Staking, Profile, ProfileStorage, accounts, delegators } =
        fixtures;
      const node1 = fixtures.nodes[0];
      const admin = accounts.node1.admin;
      const fee1 = 1500; // 15%
      const fee2 = 2500; // 25%

      // Claim rewards to enable fee updates
      await hre.ethers.provider.send('evm_setAutomine', [false]);
      for (let epoch = 2; epoch <= 6; epoch++) {
        for (const delegator of delegators) {
          await Staking.connect(delegator).claimDelegatorRewards(
            node1.identityId,
            epoch,
            delegator.address,
          );
        }
      }
      await hre.ethers.provider.send('evm_mine');
      await hre.ethers.provider.send('evm_setAutomine', [true]);

      // 1. Initial State Check
      const initialLength = await ProfileStorage.getOperatorFeesLength(
        node1.identityId,
      );
      expect(await ProfileStorage.isOperatorFeeChangePending(node1.identityId))
        .to.be.false;

      // 2. First Update (ADD)
      const tx1 = await Profile.connect(admin).updateOperatorFee(
        node1.identityId,
        fee1,
      );
      const pendingUpdate1 = await ProfileStorage.getLatestOperatorFee(
        node1.identityId,
      );
      await expect(tx1)
        .to.emit(ProfileStorage, 'OperatorFeeAdded')
        .withArgs(node1.identityId, fee1, pendingUpdate1.effectiveDate);
      expect(
        await ProfileStorage.getOperatorFeesLength(node1.identityId),
      ).to.equal(initialLength + 1n);
      expect(await ProfileStorage.isOperatorFeeChangePending(node1.identityId))
        .to.be.true;

      // 3. Second Update (REPLACE)
      const tx2 = await Profile.connect(admin).updateOperatorFee(
        node1.identityId,
        fee2,
      );
      const pendingUpdate2 = await ProfileStorage.getLatestOperatorFee(
        node1.identityId,
      );
      await expect(tx2)
        .to.emit(ProfileStorage, 'OperatorFeesReplaced')
        .withArgs(
          node1.identityId,
          fee1, // oldFeePercentage
          fee2, // newFeePercentage
          pendingUpdate2.effectiveDate,
        );
      expect(
        await ProfileStorage.getOperatorFeesLength(node1.identityId),
      ).to.equal(
        initialLength + 1n, // Length should not change
      );
      expect(await ProfileStorage.isOperatorFeeChangePending(node1.identityId))
        .to.be.true; // Still pending

      // 4. Finalize and check flag
      await time.increaseTo(pendingUpdate2.effectiveDate + 1n);
      await ProfileStorage.getOperatorFee(node1.identityId); // This call finalizes the fee
      expect(await ProfileStorage.isOperatorFeeChangePending(node1.identityId))
        .to.be.false;
    });

    it('should not apply the new fee exactly at the effective time boundary', async () => {
      const { Staking, Profile, ProfileStorage, accounts, delegators } =
        fixtures;
      const node1 = fixtures.nodes[0];
      const newFee = 5000; // 50%

      // Claim all rewards to enable the fee update
      await hre.ethers.provider.send('evm_setAutomine', [false]);
      for (let epoch = 2; epoch <= 6; epoch++) {
        for (const delegator of delegators) {
          await Staking.connect(delegator).claimDelegatorRewards(
            node1.identityId,
            epoch,
            delegator.address,
          );
        }
      }
      await hre.ethers.provider.send('evm_mine');
      await hre.ethers.provider.send('evm_setAutomine', [true]);

      // Update the fee and get its effective time
      const oldFee = await ProfileStorage.getOperatorFee(node1.identityId);
      await Profile.connect(accounts.node1.admin).updateOperatorFee(
        node1.identityId,
        newFee,
      );
      const pendingUpdate = await ProfileStorage.getLatestOperatorFee(
        node1.identityId,
      );
      const effectiveTime = pendingUpdate.effectiveDate;

      // Advance time to EXACTLY the boundary
      await time.increaseTo(effectiveTime);

      // Check the fee - it should still be the OLD one because of the '>' check
      const feeOnBoundary = await ProfileStorage.getOperatorFee(
        node1.identityId,
      );
      expect(feeOnBoundary).to.equal(oldFee);

      // Advance time by one more second to cross the boundary
      await time.increase(1);

      // Check the fee again - it should now be the NEW one
      const feeAfterBoundary = await ProfileStorage.getOperatorFee(
        node1.identityId,
      );
      expect(feeAfterBoundary).to.equal(newFee);
    });

    describe('Access Control and Identity Validation', () => {
      it('should REVERT if a non-admin tries to update the operator fee', async () => {
        const { Profile, accounts, nodes } = fixtures;
        const node1 = nodes[0];
        const nonAdmin = accounts.node2.admin; // Not the admin for node1
        const newFee = 1500; // 15%

        await expect(
          Profile.connect(nonAdmin).updateOperatorFee(node1.identityId, newFee),
        ).to.be.revertedWithCustomError(Profile, 'OnlyProfileAdminFunction');
      });

      it('should REVERT if the operational wallet of the same identity tries to update the fee', async () => {
        const { Profile, accounts, nodes } = fixtures;
        const node1 = nodes[0];
        const operational = accounts.node1.operational; // Correct identity, wrong key
        const newFee = 1500; // 15%

        await expect(
          Profile.connect(operational).updateOperatorFee(
            node1.identityId,
            newFee,
          ),
        ).to.be.revertedWithCustomError(Profile, 'OnlyProfileAdminFunction');
      });
    });

    describe('Operator Fee Validation', () => {
      beforeEach(async function () {
        this.timeout(400000);

        // We need to claim rewards for all previous epochs (2-6) for node 1
        // before we can update the operator fee.
        const { Staking, delegators } = fixtures;

        // Disable automining to bundle claims and speed up the process
        await hre.ethers.provider.send('evm_setAutomine', [false]);

        for (let epoch = 2; epoch <= 6; epoch++) {
          for (const delegator of delegators) {
            // No need for try-catch, just send the transactions
            await Staking.connect(delegator).claimDelegatorRewards(
              node1.identityId,
              epoch,
              delegator.address,
            );
          }
        }
        // Mine all the pending transactions in one block
        await hre.ethers.provider.send('evm_mine');

        // Re-enable automining for the actual tests
        await hre.ethers.provider.send('evm_setAutomine', [true]);
      });

      it('should allow a valid admin to update the operator fee', async () => {
        const { Profile, accounts } = fixtures;
        const admin = accounts.node1.admin;
        const newFee = 1500; // 15%

        await expect(
          Profile.connect(admin).updateOperatorFee(node1.identityId, newFee),
        ).to.not.be.reverted;
      });

      it('should REVERT if the fee is set above the maximum (100%)', async () => {
        const { Profile, accounts } = fixtures;
        const admin = accounts.node1.admin;
        const invalidFee = 10001; // > 100%

        await expect(
          Profile.connect(admin).updateOperatorFee(
            node1.identityId,
            invalidFee,
          ),
        ).to.be.revertedWithCustomError(Profile, 'InvalidOperatorFee');
      });
    });
  });

  describe('Edge Case Fee Scenarios', () => {
    describe('When in Epoch 1', () => {
      const fixtureEpoch1 = deployments.createFixture(async () => {
        await hre.deployments.fixture([
          'Chronos',
          'Profile',
          'ParametersStorage',
        ]);
        const signers = await hre.ethers.getSigners();
        const contracts = {
          profile: await hre.ethers.getContract<Profile>('Profile'),
          chronos: await hre.ethers.getContract<Chronos>('Chronos'),
          parametersStorage:
            await hre.ethers.getContract<ParametersStorage>(
              'ParametersStorage',
            ),
        };
        const accounts = {
          node1: { operational: signers[1], admin: signers[2] },
        };

        await contracts.parametersStorage
          .connect(signers[0])
          .setOperatorFeeUpdateDelay(0);

        const { identityId } = await createProfile(
          contracts.profile,
          accounts.node1,
        );

        // Fast-forward to epoch-1 if we are in epoch 0
        if ((await contracts.chronos.getCurrentEpoch()) < 1n) {
          await time.increase(
            (await contracts.chronos.timeUntilNextEpoch()) + 1n,
          );
        }
        return { ...contracts, ...accounts, identityId };
      });

      it('should allow fee update without checking previous epochs', async () => {
        const { profile, chronos, node1, identityId } = await fixtureEpoch1();

        expect(await chronos.getCurrentEpoch()).to.equal(1n);

        // The check for previous epoch claims should not apply in epoch 1
        await expect(
          profile.connect(node1.admin).updateOperatorFee(identityId, 1000), // 10%
        ).to.not.be.reverted;
      });
    });

    describe('When using a large (negative-like) fee value', () => {
      let fixtures: Awaited<ReturnType<typeof buildInitialRewardsState>>;

      beforeEach(async function () {
        this.timeout(400000);
        fixtures = await fixtureInitialRewardsState();
        const { Staking, delegators, nodes } = fixtures;
        const node1 = nodes[0];

        // Claim rewards to allow fee updates in this describe block
        await hre.ethers.provider.send('evm_setAutomine', [false]);
        for (let epoch = 2; epoch <= 6; epoch++) {
          for (const delegator of delegators) {
            await Staking.connect(delegator).claimDelegatorRewards(
              node1.identityId,
              epoch,
              delegator.address,
            );
          }
        }
        await hre.ethers.provider.send('evm_mine');
        await hre.ethers.provider.send('evm_setAutomine', [true]);
      });

      it('should REVERT, as it exceeds the maximum fee', async () => {
        const { Profile, accounts, nodes } = fixtures;
        const node1 = nodes[0];
        const admin = accounts.node1.admin;

        // A negative number will cause an error in ethers.js before the transaction is sent.
        // We test with a very large uint16 value instead, which should be caught by the > 100% check.
        const invalidFee = 65535; // Max uint16

        await expect(
          Profile.connect(admin).updateOperatorFee(
            node1.identityId,
            invalidFee,
          ),
        ).to.be.revertedWithCustomError(Profile, 'InvalidOperatorFee');
      });
    });
  });
});
