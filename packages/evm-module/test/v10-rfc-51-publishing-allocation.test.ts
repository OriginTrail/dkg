import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  Hub,
  Token,
  Chronos,
  Profile,
  StakingV10,
  DKGStakingConvictionNFT,
  KnowledgeAssetsLifecycle,
  EpochStorage,
  ContextGraphs,
  ContextGraphStorage,
  DKGPublishingConvictionNFT,
  PublishingConviction,
  RandomSampling,
  ConvictionStakingStorage,
  ParametersStorage,
  ProfileStorage,
  AskStorage,
  DKGKnowledgeAssets,
} from '../typechain';
import { sqrt } from './helpers/math-helpers';
import { createProfile } from './helpers/profile-helpers';
import {
  getDefaultPublishingNode,
  getDefaultReceivingNodes,
  getDefaultKACreator,
} from './helpers/setup-helpers';
import {
  buildPublishParams,
  buildUpdateParams,
  packReservedKaId,
  DEFAULT_CHAIN_ID,
} from './helpers/v10-ka-helpers';

// OT-RFC-51 "Publishing Allocation" — first-pass happy-path coverage.
//
// Asserts the three behaviours the RFC introduced:
//   (a) `createAccount(committedTRAC, primaryNode)` prorate-seeds the
//       committed TRAC as per-epoch publishing allocation onto `primaryNode`;
//       the per-epoch allocations sum to `committedTRAC` across the lock.
//   (b) `setPrimaryNode(accountId, node2)` moves the FUTURE epochs' allocation
//       from the old node to the new one while every epoch's K_total
//       (`getEpochPublishingAllocation`) is byte-identical (net-zero move).
//   (c) a V10 publish no longer credits per-node publishing allocation (K_n)
//       — realized publishing is "off" as a feed for the scoring factor.
//
// The fixture mirrors `v10-e2e-conviction.test.ts` (the only V10-native
// conviction+publish integration test) so node registration + staking +
// publish all go through the existing turnkey helpers.
type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  Token: Token;
  Chronos: Chronos;
  Profile: Profile;
  StakingV10: StakingV10;
  StakingNFT: DKGStakingConvictionNFT;
  KnowledgeAssetsLifecycle: KnowledgeAssetsLifecycle;
  EpochStorage: EpochStorage;
  ContextGraphs: ContextGraphs;
  ContextGraphStorage: ContextGraphStorage;
  PublishingConvictionNFT: DKGPublishingConvictionNFT;
  PublishingConviction: PublishingConviction;
  RandomSampling: RandomSampling;
  ConvictionStakingStorage: ConvictionStakingStorage;
  ParametersStorage: ParametersStorage;
  ProfileStorage: ProfileStorage;
  AskStorage: AskStorage;
  DKGKnowledgeAssets: DKGKnowledgeAssets;
};

const SCALE18 = 10n ** 18n;

/**
 * JS mirror of `RandomSampling._calculateNodeScore`. Computes the expected
 * 18-decimal node score from the SAME on-chain inputs the contract reads, so
 * the test asserts the live scoring path rather than a hand-rolled constant:
 *
 *   nodeScore(t) = S(t) * (c + 0.86 * P(t) + 0.60 * A(t) * P(t))
 *
 * with the OT-RFC-51 single-current-epoch publishing-allocation window:
 *   S(t) = sqrt(min(effStake, stakeCap) / stakeCap)          (sublinear stake)
 *   P(t) = K_n / K_total   over the CURRENT EPOCH ONLY        (RFC-51 §4 / D1)
 *   A(t) = 1 - |ask - networkPrice| / networkPrice           (ask alignment)
 *   c    = 0.002 (STAKE_BASELINE_COEFFICIENT)
 *
 * All operations mirror the contract's integer order-of-operations exactly
 * (including OZ Math.sqrt's round-down via the Babylonian `sqrt` helper) so
 * the expected value is byte-identical to the on-chain result.
 */
async function expectedNodeScore(
  identityId: bigint,
  deps: {
    ConvictionStakingStorage: ConvictionStakingStorage;
    ParametersStorage: ParametersStorage;
    ProfileStorage: ProfileStorage;
    AskStorage: AskStorage;
    EpochStorage: EpochStorage;
    Chronos: Chronos;
  },
): Promise<{ score: bigint; stakeFactor: bigint; inner: bigint; p: bigint }> {
  const currentEpoch = await deps.Chronos.getCurrentEpoch();

  // 1. Stake factor S(t) = sqrt(min(effStake, stakeCap) / stakeCap)
  const effStake = await deps.ConvictionStakingStorage.getNodeEffectiveStake(
    identityId,
  );
  const stakeCap = BigInt(await deps.ParametersStorage.maximumStake());
  const capped = effStake > stakeCap ? stakeCap : effStake;
  const stakeRatio18 = (capped * SCALE18) / stakeCap;
  const stakeFactor18 = sqrt(stakeRatio18 * SCALE18);

  // 2. Publishing factor P(t) = K_n / K_total over the current epoch only.
  const nodeKV = BigInt(
    await deps.EpochStorage.getNodeEpochPublishingAllocation(
      identityId,
      currentEpoch,
    ),
  );
  const totalKV = BigInt(
    await deps.EpochStorage.getEpochPublishingAllocation(currentEpoch),
  );
  const publishingFactor18 = totalKV > 0n ? (nodeKV * SCALE18) / totalKV : 0n;

  // 3. Ask alignment factor A(t).
  const nodeAsk = BigInt(await deps.ProfileStorage.getAsk(identityId));
  const networkPrice = BigInt(await deps.AskStorage.getPricePerKbEpoch());
  let askAlignmentFactor18 = 0n;
  if (networkPrice > 0n) {
    const deviation =
      nodeAsk > networkPrice ? nodeAsk - networkPrice : networkPrice - nodeAsk;
    const deviationRatio18 = (deviation * SCALE18) / networkPrice;
    askAlignmentFactor18 =
      deviationRatio18 >= SCALE18 ? 0n : SCALE18 - deviationRatio18;
  }

  const baselineComponent18 = (2n * SCALE18) / 1000n;
  const publishingComponent18 = (86n * publishingFactor18) / 100n;
  const askPublishingComponent18 =
    (60n * askAlignmentFactor18 * publishingFactor18) / (100n * SCALE18);

  const inner18 =
    baselineComponent18 + publishingComponent18 + askPublishingComponent18;
  const score18 = (stakeFactor18 * inner18) / SCALE18;
  return {
    score: score18,
    stakeFactor: stakeFactor18,
    inner: inner18,
    p: publishingFactor18,
  };
}

/**
 * JS mirror of `PublishingConviction._scheduleFor` + `_amountForEpoch` — the
 * single source of truth for the per-epoch publishing-allocation seed schedule.
 *
 * Reproduces the contract's integer order-of-operations EXACTLY so each epoch's
 * expected allocation is byte-identical:
 *   - partial creation epoch (anchorEpoch)        -> ranges[0].tokenAmount
 *   - each full epoch [anchor+1 .. anchor+N-1]     -> committedTRAC / N
 *   - dust-corrected final epoch (anchor+N)        -> ranges[2].tokenAmount
 * where N = lockDurationEpochs and `timeRemainingInCurrentEpoch` is derived from
 * the STORED account fields (`timestampForEpoch(anchor+1) - createdAtTimestamp`),
 * matching `_scheduleFor` — not a live `timeUntilNextEpoch` read.
 *
 * Returns a map epoch -> expected amount for [anchor, anchor + N]; epochs with a
 * zero amount are still present (value 0n).
 */
async function expectedSeedSchedule(
  committedTRAC: bigint,
  anchorEpoch: bigint,
  lockDurationEpochs: bigint,
  createdAtTimestamp: bigint,
  Chronos_: Chronos,
): Promise<Map<bigint, bigint>> {
  const epochLength = BigInt(await Chronos_.epochLength());
  const nextEpochStart = BigInt(
    await Chronos_.timestampForEpoch(anchorEpoch + 1n),
  );
  const timeRemainingInCurrentEpoch =
    nextEpochStart > createdAtTimestamp
      ? nextEpochStart - createdAtTimestamp
      : 0n;

  // prorateActiveSink, mirrored exactly (see PublishingMathLib.prorateActiveSink).
  const N = lockDurationEpochs;
  const baseTokensPerFullEpoch = committedTRAC / N;
  const currentEpochAllocation =
    (baseTokensPerFullEpoch * timeRemainingInCurrentEpoch) / epochLength;
  let finalEpochAllocation = baseTokensPerFullEpoch - currentEpochAllocation;
  const numberOfFullEpochs = N - 1n;
  const totalTokensForFullEpochs = baseTokensPerFullEpoch * numberOfFullEpochs;
  const totalAllocated =
    currentEpochAllocation + totalTokensForFullEpochs + finalEpochAllocation;
  if (totalAllocated < committedTRAC) {
    finalEpochAllocation += committedTRAC - totalAllocated;
  }

  // _amountForEpoch mapping (partial-first / each-full / dust-corrected-final).
  const schedule = new Map<bigint, bigint>();
  const lastEpoch = anchorEpoch + N;
  for (let e = anchorEpoch; e <= lastEpoch; e++) {
    let amount = 0n;
    if (e === anchorEpoch) {
      amount = currentEpochAllocation; // ranges[0]
    } else if (e >= anchorEpoch + 1n && e <= anchorEpoch + numberOfFullEpochs) {
      amount = baseTokensPerFullEpoch; // each full epoch (= committedTRAC / N)
    } else if (e === lastEpoch) {
      amount = finalEpochAllocation; // ranges[2], dust-corrected
    }
    schedule.set(e, amount);
  }
  return schedule;
}

async function deployFixture(): Promise<Fixture> {
  await hre.deployments.fixture([
    'Token',
    'AskStorage',
    'EpochStorage',
    'Chronos',
    'Profile',
    'Identity',
    'KnowledgeAssetsLifecycle',
    'ContextGraphStorage',
    'ContextGraphs',
    'ContextGraphValueStorage',
    'DKGPublishingConvictionNFT',
    'DKGStakingConvictionNFT',
    'StakingV10',
    // RandomSampling transitively pulls in RandomSamplingStorage,
    // ProfileStorage, AskStorage, ParametersStorage and
    // ConvictionStakingStorage — everything `calculateNodeScore` reads.
    'RandomSampling',
  ]);

  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  await Hub.setContractAddress('HubOwner', accounts[0].address);

  return {
    accounts,
    Hub,
    Token: await hre.ethers.getContract<Token>('Token'),
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    Profile: await hre.ethers.getContract<Profile>('Profile'),
    StakingV10: await hre.ethers.getContract<StakingV10>('StakingV10'),
    StakingNFT: await hre.ethers.getContract<DKGStakingConvictionNFT>(
      'DKGStakingConvictionNFT',
    ),
    KnowledgeAssetsLifecycle: await hre.ethers.getContract<KnowledgeAssetsLifecycle>(
      'KnowledgeAssetsLifecycle',
    ),
    EpochStorage: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
    ContextGraphs: await hre.ethers.getContract<ContextGraphs>('ContextGraphs'),
    ContextGraphStorage: await hre.ethers.getContract<ContextGraphStorage>(
      'ContextGraphStorage',
    ),
    PublishingConvictionNFT: await hre.ethers.getContract<DKGPublishingConvictionNFT>(
      'DKGPublishingConvictionNFT',
    ),
    PublishingConviction: await hre.ethers.getContract<PublishingConviction>(
      'PublishingConviction',
    ),
    RandomSampling: await hre.ethers.getContract<RandomSampling>('RandomSampling'),
    ConvictionStakingStorage: await hre.ethers.getContract<ConvictionStakingStorage>(
      'ConvictionStakingStorage',
    ),
    ParametersStorage: await hre.ethers.getContract<ParametersStorage>(
      'ParametersStorage',
    ),
    ProfileStorage: await hre.ethers.getContract<ProfileStorage>('ProfileStorage'),
    AskStorage: await hre.ethers.getContract<AskStorage>('AskStorage'),
    DKGKnowledgeAssets: await hre.ethers.getContract<DKGKnowledgeAssets>(
      'DKGKnowledgeAssets',
    ),
  };
}

describe('@integration OT-RFC-51 Publishing Allocation', function () {
  // The fixture deploys the full V10 stack (Profile/Identity/CG/conviction/
  // staking) and the test runs a complete publish flow; under load this far
  // exceeds Mocha's 40s default. `hardhat.node.config.ts` (used by the repo's
  // run-tests.js) does not raise the timeout, so set it per-suite here.
  this.timeout(600000);

  const COMMITTED_TRAC = ethers.parseEther('50000'); // 20% discount tier
  const MIN_STAKE = ethers.parseEther('50000');

  let accounts: SignerWithAddress[];
  let Token: Token;
  let Chronos: Chronos;
  let ProfileContract: Profile;
  let StakingV10Contract: StakingV10;
  let StakingNFT: DKGStakingConvictionNFT;
  let KAV10: KnowledgeAssetsLifecycle;
  let NFT: DKGPublishingConvictionNFT;
  let CGFacade: ContextGraphs;
  let CGS: ContextGraphStorage;
  let EpochStorageContract: EpochStorage;
  let RandomSamplingContract: RandomSampling;
  let CSS: ConvictionStakingStorage;
  let ParametersStorageContract: ParametersStorage;
  let ProfileStorageContract: ProfileStorage;
  let AskStorageContract: AskStorage;
  let LogicContract: PublishingConviction;
  let DKGKnowledgeAssetsContract: DKGKnowledgeAssets;
  let kav10Address: string;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    const f = await loadFixture(deployFixture);
    accounts = f.accounts;
    Token = f.Token;
    Chronos = f.Chronos;
    ProfileContract = f.Profile;
    StakingV10Contract = f.StakingV10;
    StakingNFT = f.StakingNFT;
    KAV10 = f.KnowledgeAssetsLifecycle;
    NFT = f.PublishingConvictionNFT;
    CGFacade = f.ContextGraphs;
    CGS = f.ContextGraphStorage;
    EpochStorageContract = f.EpochStorage;
    RandomSamplingContract = f.RandomSampling;
    CSS = f.ConvictionStakingStorage;
    ParametersStorageContract = f.ParametersStorage;
    ProfileStorageContract = f.ProfileStorage;
    AskStorageContract = f.AskStorage;
    LogicContract = f.PublishingConviction;
    DKGKnowledgeAssetsContract = f.DKGKnowledgeAssets;
    kav10Address = await KAV10.getAddress();
  });

  const stakeV10 = async (
    staker: SignerWithAddress,
    identityId: number,
    amount: bigint,
  ) => {
    await Token.mint(staker.address, amount);
    await Token.connect(staker).approve(
      await StakingV10Contract.getAddress(),
      amount,
    );
    await StakingNFT.connect(staker).createConviction(identityId, amount, 1);
  };

  it('(a) seeds per-epoch publishing allocation summing to committedTRAC; (b) setPrimaryNode moves future epochs net-zero on K_total; (c) realized publish does not credit K_n', async () => {
    // ---- Node setup: real, staked nodes in the sharding table ----
    // node1 = publishingNode; node2 = a separate dedicated node (accounts[7]/[8])
    // so it never overlaps the publish ACK-quorum receiving set.
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts);
    const node2Accounts = { admin: accounts[7], operational: accounts[8] };

    const { identityId: node1Id } = await createProfile(ProfileContract, publishingNode);
    const receiverProfiles = [];
    for (let i = 0; i < receivingNodes.length; i++) {
      receiverProfiles.push(await createProfile(ProfileContract, receivingNodes[i]));
    }
    const receiverIdentityIds = receiverProfiles.map((p) => p.identityId);
    const { identityId: node2Id } = await createProfile(ProfileContract, node2Accounts);

    await stakeV10(publishingNode.operational, node1Id, MIN_STAKE);
    for (let i = 0; i < receivingNodes.length; i++) {
      await stakeV10(receivingNodes[i].operational, receiverProfiles[i].identityId, MIN_STAKE);
    }
    await stakeV10(node2Accounts.operational, node2Id, MIN_STAKE);

    // ========================================================================
    // (a) createAccount with a real primary node seeds publishing allocation
    // ========================================================================
    const creator = getDefaultKACreator(accounts);
    await Token.connect(accounts[0]).transfer(creator.address, COMMITTED_TRAC);
    await Token.connect(creator).approve(await NFT.getAddress(), COMMITTED_TRAC);

    await NFT.connect(creator).createAccount(COMMITTED_TRAC, node1Id);
    const accountId = await NFT.totalSupply();
    expect(accountId).to.equal(1n);

    const acct = await NFT.accounts(accountId);
    const createdAtEpoch = acct[1]; // index 1 = createdAtEpoch
    const lockDurationEpochs = BigInt(acct[5]); // index 5
    // RFC-51 fields appended to the Account tuple.
    expect(acct[9]).to.equal(BigInt(node1Id)); // primaryNode
    expect(acct[10]).to.equal(createdAtEpoch); // lastPrimaryNodeChangeEpoch

    // The schedule credits epochs [createdAtEpoch, createdAtEpoch + N].
    const firstEpoch = createdAtEpoch;
    const lastEpoch = createdAtEpoch + lockDurationEpochs;

    let seededSum = 0n;
    const node1Before: bigint[] = [];
    const totalBefore: bigint[] = [];
    for (let e = firstEpoch; e <= lastEpoch; e++) {
      const nodeKV = await EpochStorageContract.getNodeEpochPublishingAllocation(node1Id, e);
      const totalKV = await EpochStorageContract.getEpochPublishingAllocation(e);
      node1Before.push(nodeKV);
      totalBefore.push(totalKV);
      seededSum += nodeKV;
      // node1 is the only contributor, so K_total == node1's allocation.
      expect(totalKV).to.equal(nodeKV);
    }
    // The seeded total over the lock equals committedTRAC exactly.
    expect(seededSum).to.equal(COMMITTED_TRAC);

    // node2 has no allocation yet.
    for (let e = firstEpoch; e <= lastEpoch; e++) {
      expect(await EpochStorageContract.getNodeEpochPublishingAllocation(node2Id, e)).to.equal(0n);
    }

    // ========================================================================
    // (b) setPrimaryNode moves FUTURE epochs net-zero on K_total
    // ========================================================================
    // Advance ~one full chain epoch so the once-per-epoch rate limit passes
    // (lastPrimaryNodeChangeEpoch was set to createdAtEpoch at creation).
    const epochLength = await Chronos.epochLength();
    await time.increase(epochLength);

    const currentEpoch = await Chronos.getCurrentEpoch();
    expect(currentEpoch).to.be.gt(createdAtEpoch); // rate limit will pass

    await NFT.connect(creator).setPrimaryNode(accountId, node2Id);

    const acctAfter = await NFT.accounts(accountId);
    expect(acctAfter[9]).to.equal(BigInt(node2Id)); // primaryNode updated
    expect(acctAfter[10]).to.equal(currentEpoch); // change epoch cursor updated

    // Only future epochs (e >= currentEpoch + 1) move to node2; current/past
    // epochs stay credited to node1. K_total is unchanged for EVERY epoch.
    for (let i = 0; i < node1Before.length; i++) {
      const e = firstEpoch + BigInt(i);
      const node1Now = await EpochStorageContract.getNodeEpochPublishingAllocation(node1Id, e);
      const node2Now = await EpochStorageContract.getNodeEpochPublishingAllocation(node2Id, e);
      const totalNow = await EpochStorageContract.getEpochPublishingAllocation(e);

      // K_total (denominator) is net-zero across the move.
      expect(totalNow).to.equal(totalBefore[i]);

      if (e >= currentEpoch + 1n) {
        // Moved: node1 -> node2, byte-for-byte.
        expect(node1Now).to.equal(0n);
        expect(node2Now).to.equal(node1Before[i]);
      } else {
        // Stayed on node1 (current + past epochs untouched).
        expect(node1Now).to.equal(node1Before[i]);
        expect(node2Now).to.equal(0n);
      }
    }
    // At least one epoch must have actually moved, else the test is vacuous.
    const someFutureEpoch = currentEpoch + 1n;
    expect(someFutureEpoch).to.be.lte(lastEpoch);

    // ========================================================================
    // (c) realized publish does NOT credit K_n (allocation feed is off)
    // ========================================================================
    // Register the creator as its own publishing agent and create an open CG.
    await NFT.connect(creator).registerAgent(accountId, creator.address);
    expect(await NFT.agentToAccountId(creator.address)).to.equal(accountId);

    await CGFacade.connect(creator).createContextGraph(
      [],
      0,
      0,
      1, // open publish policy
      ethers.ZeroAddress,
      0,
      ethers.ZeroHash,
    );
    const cgId = await CGS.getLatestContextGraphId();

    // PCA discount branch requires publishEpochs == lockDurationEpochs.
    const epochsForPublish = Number(lockDurationEpochs);
    const tokenAmount = ethers.parseEther('1000');
    const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('rfc51-merkle'));
    const reservedKaId = packReservedKaId(creator.address, 1);

    // Snapshot per-node allocation for BOTH nodes across all credited epochs
    // just before the publish — realized publishing must not move any of them.
    const pubEpoch = await Chronos.getCurrentEpoch();
    const n1PrePublish: Record<string, bigint> = {};
    const n2PrePublish: Record<string, bigint> = {};
    for (let e = firstEpoch; e <= lastEpoch + 2n; e++) {
      n1PrePublish[e.toString()] = await EpochStorageContract.getNodeEpochPublishingAllocation(node1Id, e);
      n2PrePublish[e.toString()] = await EpochStorageContract.getNodeEpochPublishingAllocation(node2Id, e);
    }

    const p = await buildPublishParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address,
      receivingNodes,
      publisherIdentityId: node1Id,
      receiverIdentityIds,
      author: creator,
      contextGraphId: cgId,
      merkleRoot,
      knowledgeAssetsAmount: 1,
      byteSize: 1000,
      epochs: epochsForPublish,
      tokenAmount,
      isImmutable: false,
      publishOperationId: 'rfc51-op',
      reservedKaId,
    });

    const tx = await KAV10.connect(creator).publish(p);
    const receipt = await tx.wait();
    expect(receipt!.status).to.equal(1);

    // The publish names node1 as publisherNodeIdentityId, but RFC-51 removed
    // the realized-publishing K_n credit. Every per-node allocation is
    // unchanged from the pre-publish snapshot for both nodes.
    for (let e = firstEpoch; e <= lastEpoch + 2n; e++) {
      expect(
        await EpochStorageContract.getNodeEpochPublishingAllocation(node1Id, e),
        `node1 allocation at epoch ${e} must be unchanged by publish`,
      ).to.equal(n1PrePublish[e.toString()]);
      expect(
        await EpochStorageContract.getNodeEpochPublishingAllocation(node2Id, e),
        `node2 allocation at epoch ${e} must be unchanged by publish`,
      ).to.equal(n2PrePublish[e.toString()]);
    }
    // Specifically, the publish epoch's node1 allocation gained nothing.
    expect(
      await EpochStorageContract.getNodeEpochPublishingAllocation(node1Id, pubEpoch),
    ).to.equal(n1PrePublish[pubEpoch.toString()]);
  });

  // ==========================================================================
  // (d) NODE SCORE: publishing allocation drives RandomSampling node score
  // ==========================================================================
  // This is the one RFC-51 behaviour with no other RUNNING test. The V8-flow
  // `test/integration/RandomSampling.test.ts` suite is `describe.skip`-ped
  // (tombstone: V8 staking pipeline incompatible with V10 CSS scoring), so the
  // allocation -> P(t) -> score path is exercised here against live contracts.
  //
  // Setup primitive shared by the score cases: three V10 nodes with EQUAL
  // effective stake (same MIN_STAKE, same lock tier 1) so S(t) is identical and
  // factors out of every ratio. Returns their identityIds.
  const setupThreeEqualStakeNodes = async () => {
    const nodeA = { admin: accounts[1], operational: accounts[2] };
    const nodeB = { admin: accounts[3], operational: accounts[4] };
    const nodeC = { admin: accounts[5], operational: accounts[6] };

    const { identityId: aId } = await createProfile(ProfileContract, nodeA);
    const { identityId: bId } = await createProfile(ProfileContract, nodeB);
    const { identityId: cId } = await createProfile(ProfileContract, nodeC);

    await stakeV10(nodeA.operational, aId, MIN_STAKE);
    await stakeV10(nodeB.operational, bId, MIN_STAKE);
    await stakeV10(nodeC.operational, cId, MIN_STAKE);

    // Equal stake + equal tier => equal effective stake (read at the same
    // block.timestamp via the contract's simulated settle). Assert it, since a
    // zero effective stake here would make every downstream score 0 and the
    // task's blocker condition would apply.
    const effA = await CSS.getNodeEffectiveStake(aId);
    const effB = await CSS.getNodeEffectiveStake(bId);
    const effC = await CSS.getNodeEffectiveStake(cId);
    expect(effA).to.be.gt(0n);
    expect(effA).to.equal(effB);
    expect(effB).to.equal(effC);

    return { aId: BigInt(aId), bId: BigInt(bId), cId: BigInt(cId) };
  };

  const scoreDeps = () => ({
    ConvictionStakingStorage: CSS,
    ParametersStorage: ParametersStorageContract,
    ProfileStorage: ProfileStorageContract,
    AskStorage: AskStorageContract,
    EpochStorage: EpochStorageContract,
    Chronos,
  });

  it('(d.1) allocation drives calculateNodeScore: equal stake, 3:1 seeded allocation => scoreA > scoreB and each matches the (c + 0.86*P) formula', async () => {
    const { aId, bId } = await setupThreeEqualStakeNodes();

    // Seed a 3:1 publishing allocation into the CURRENT epoch directly (the
    // onlyContracts gate accepts hub.owner() = accounts[0]). The current epoch
    // must be read AFTER staking — staking advances block.timestamp but not the
    // epoch boundary.
    const epoch = await Chronos.getCurrentEpoch();
    const K_A = ethers.parseEther('30000');
    const K_B = ethers.parseEther('10000');
    await EpochStorageContract.connect(accounts[0]).addEpochPublishingAllocation(
      aId,
      epoch,
      K_A,
    );
    await EpochStorageContract.connect(accounts[0]).addEpochPublishingAllocation(
      bId,
      epoch,
      K_B,
    );

    // Control the denominator: with a fresh fixture and only these two seeds,
    // K_total for the epoch is exactly K_A + K_B.
    const kTotal = BigInt(
      await EpochStorageContract.getEpochPublishingAllocation(epoch),
    );
    expect(kTotal).to.equal(K_A + K_B);
    expect(
      BigInt(
        await EpochStorageContract.getNodeEpochPublishingAllocation(aId, epoch),
      ),
    ).to.equal(K_A);
    expect(
      BigInt(
        await EpochStorageContract.getNodeEpochPublishingAllocation(bId, epoch),
      ),
    ).to.equal(K_B);

    // Live on-chain scores.
    const scoreA = await RandomSamplingContract.calculateNodeScore(aId);
    const scoreB = await RandomSamplingContract.calculateNodeScore(bId);

    // Allocation must make nodeA's score strictly greater than nodeB's.
    expect(scoreA).to.be.gt(scoreB);
    expect(scoreA).to.be.gt(0n);
    expect(scoreB).to.be.gt(0n);

    // Each live score must equal the value derived from the SAME inputs the
    // contract reads (mirrors `_calculateNodeScore` exactly => byte-identical).
    const expA = await expectedNodeScore(aId, scoreDeps());
    const expB = await expectedNodeScore(bId, scoreDeps());
    expect(scoreA).to.equal(expA.score);
    expect(scoreB).to.equal(expB.score);

    // P(t) ratio: nodeA holds 3/4 of K_total, nodeB holds 1/4.
    expect(expA.p).to.equal((3n * SCALE18) / 4n); // 0.75e18
    expect(expB.p).to.equal((1n * SCALE18) / 4n); // 0.25e18

    // Inner term = c + 0.86 * P(t) (A(t)=0 here: ask=0 => deviation >= 1 or
    // networkPrice=0). Equal stake => stakeFactor identical => the score ratio
    // equals the inner ratio. The baseline c shifts the ratio strictly BELOW
    // the raw 3:1 P ratio (~2.98:1), proving c participates, not just P.
    expect(expA.stakeFactor).to.equal(expB.stakeFactor);
    const baseline18 = (2n * SCALE18) / 1000n; // c = 0.002e18
    expect(expA.inner).to.equal(baseline18 + (86n * expA.p) / 100n);
    expect(expB.inner).to.equal(baseline18 + (86n * expB.p) / 100n);

    // Score ratio (scaled by SCALE18) tracks the inner ratio (equal stake
    // factors out) and sits strictly below the raw 3:1 — i.e. the baseline c in
    // (c + 0.86*P) genuinely shapes it. The score ratio is computed from two
    // separately floored on-chain scores, so it matches the inner ratio only up
    // to a few wei of fixed-point rounding (assert ~equal within a tight bound,
    // not byte-exact — the per-node `score == expected` checks above are the
    // byte-exact ones).
    const scoreRatio18 = (scoreA * SCALE18) / scoreB;
    const innerRatio18 = (expA.inner * SCALE18) / expB.inner;
    const ratioDelta =
      scoreRatio18 > innerRatio18
        ? scoreRatio18 - innerRatio18
        : innerRatio18 - scoreRatio18;
    expect(ratioDelta).to.be.lt(1000n); // < 1e-15 of the ratio
    expect(scoreRatio18).to.be.lt(3n * SCALE18); // strictly under 3:1
    expect(scoreRatio18).to.be.gt((29n * SCALE18) / 10n); // ~2.98 > 2.9
  });

  it('(d.2) a staked node with ZERO allocation has P(t)=0 => inner score ~= baseline c only, far below an allocated peer', async () => {
    const { aId, cId } = await setupThreeEqualStakeNodes();

    // Seed allocation ONLY to nodeA. nodeC gets nothing => P_C = 0. Crucially
    // K_total > 0 (from nodeA), so this is the real divisor case, not the
    // degenerate `totalKV == 0` short-circuit.
    const epoch = await Chronos.getCurrentEpoch();
    const K_A = ethers.parseEther('40000');
    await EpochStorageContract.connect(accounts[0]).addEpochPublishingAllocation(
      aId,
      epoch,
      K_A,
    );
    expect(
      BigInt(await EpochStorageContract.getEpochPublishingAllocation(epoch)),
    ).to.equal(K_A);
    expect(
      BigInt(
        await EpochStorageContract.getNodeEpochPublishingAllocation(cId, epoch),
      ),
    ).to.equal(0n);

    const scoreA = await RandomSamplingContract.calculateNodeScore(aId);
    const scoreC = await RandomSamplingContract.calculateNodeScore(cId);

    const expA = await expectedNodeScore(aId, scoreDeps());
    const expC = await expectedNodeScore(cId, scoreDeps());

    // Live scores match the formula.
    expect(scoreA).to.equal(expA.score);
    expect(scoreC).to.equal(expC.score);

    // nodeC's P(t) is exactly 0; its inner term is the bare baseline c=0.002e18.
    const baseline18 = (2n * SCALE18) / 1000n;
    expect(expC.p).to.equal(0n);
    expect(expC.inner).to.equal(baseline18);

    // nodeA (P=1, sole allocator) inner = c + 0.86 => ~431x the zero-alloc node.
    expect(expA.p).to.equal(SCALE18);
    expect(expA.inner).to.equal(baseline18 + (86n * SCALE18) / 100n);
    expect(scoreA).to.be.gt(scoreC);
    // Concretely "much smaller": zero-alloc score is < 1% of the allocated one.
    expect(scoreC * 100n).to.be.lt(scoreA);
  });

  it('(d.3) setPrimaryNode shifts the FUTURE-epoch score: after moving allocation A->B and advancing one epoch, calculateNodeScore favors nodeB', async () => {
    // Use the real PCA path (createAccount -> setPrimaryNode) so the on-chain
    // move mutator is what drives the score change, not a direct seed.
    const { aId, bId } = await setupThreeEqualStakeNodes();

    const creator = getDefaultKACreator(accounts);
    await Token.connect(accounts[0]).transfer(creator.address, COMMITTED_TRAC);
    await Token.connect(creator).approve(await NFT.getAddress(), COMMITTED_TRAC);

    // Seed all future epochs' allocation onto nodeA via a real PCA.
    await NFT.connect(creator).createAccount(COMMITTED_TRAC, Number(aId));
    const accountId = await NFT.totalSupply();
    const acct = await NFT.accounts(accountId);
    const createdAtEpoch = acct[1];
    const lockDurationEpochs = BigInt(acct[5]);
    const lastEpoch = createdAtEpoch + lockDurationEpochs;

    // Before the move: at the current epoch nodeA is the sole allocator, so it
    // outscores nodeB (which has equal stake but zero allocation).
    {
      const epochNow = await Chronos.getCurrentEpoch();
      expect(
        BigInt(
          await EpochStorageContract.getNodeEpochPublishingAllocation(
            aId,
            epochNow,
          ),
        ),
      ).to.be.gt(0n);
      const sA = await RandomSamplingContract.calculateNodeScore(aId);
      const sB = await RandomSamplingContract.calculateNodeScore(bId);
      expect(sA).to.be.gt(sB);
    }

    // Advance one full chain epoch so the once-per-epoch rate limit clears and
    // we land on a FUTURE epoch (>= changeEpoch + 1) that the move retargets.
    const epochLength = await Chronos.epochLength();
    await time.increase(epochLength);
    const moveEpoch = await Chronos.getCurrentEpoch();
    expect(moveEpoch).to.be.gt(createdAtEpoch);

    // Move FUTURE epochs' allocation from nodeA to nodeB.
    await NFT.connect(creator).setPrimaryNode(accountId, Number(bId));
    expect((await NFT.accounts(accountId))[9]).to.equal(bId); // primaryNode = B

    // The move retargets epochs >= moveEpoch + 1. Advance into one of those so
    // the CURRENT-epoch score read (which is all calculateNodeScore inspects)
    // sees nodeB holding the allocation. Guard the fixture has room to advance.
    expect(moveEpoch + 1n).to.be.lte(lastEpoch);
    await time.increase(epochLength);
    const futureEpoch = await Chronos.getCurrentEpoch();
    expect(futureEpoch).to.be.gte(moveEpoch + 1n);

    // In this future epoch the allocation now sits on nodeB, not nodeA.
    expect(
      BigInt(
        await EpochStorageContract.getNodeEpochPublishingAllocation(
          aId,
          futureEpoch,
        ),
      ),
    ).to.equal(0n);
    expect(
      BigInt(
        await EpochStorageContract.getNodeEpochPublishingAllocation(
          bId,
          futureEpoch,
        ),
      ),
    ).to.be.gt(0n);

    // Effective stake is still equal across one epoch (boost has not expired),
    // so the score flip is purely from the allocation move, not from S(t).
    const effA = await CSS.getNodeEffectiveStake(aId);
    const effB = await CSS.getNodeEffectiveStake(bId);
    expect(effA).to.be.gt(0n);
    expect(effA).to.equal(effB);

    // The score now favors nodeB: the move shifted the live score, not just the
    // stored accumulator.
    const scoreA = await RandomSamplingContract.calculateNodeScore(aId);
    const scoreB = await RandomSamplingContract.calculateNodeScore(bId);
    expect(scoreB).to.be.gt(scoreA);

    // And both match the formula on these post-move inputs.
    const expA = await expectedNodeScore(aId, scoreDeps());
    const expB = await expectedNodeScore(bId, scoreDeps());
    expect(scoreA).to.equal(expA.score);
    expect(scoreB).to.equal(expB.score);
    // nodeA is now the zero-allocation node => inner = baseline c only.
    const baseline18 = (2n * SCALE18) / 1000n;
    expect(expA.inner).to.equal(baseline18);
    expect(expB.p).to.be.gt(0n);
  });

  // ==========================================================================
  // Shared setup for the publish/update + access-control cases below: real,
  // staked publishing + receiving nodes, a dedicated node2, plus a PCA owned by
  // `creator` with `node1` as the designated primary node and `creator`
  // registered as its own publishing agent over an open CG. Mirrors the
  // (a)/(b)/(c) setup so the publish quorum + conviction-funded path all work.
  // ==========================================================================
  const setupPcaAndPublishCG = async () => {
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts);
    const node2Accounts = { admin: accounts[7], operational: accounts[8] };

    const { identityId: node1Id } = await createProfile(
      ProfileContract,
      publishingNode,
    );
    const receiverProfiles = [];
    for (let i = 0; i < receivingNodes.length; i++) {
      receiverProfiles.push(
        await createProfile(ProfileContract, receivingNodes[i]),
      );
    }
    const receiverIdentityIds = receiverProfiles.map((p) => p.identityId);
    const { identityId: node2Id } = await createProfile(
      ProfileContract,
      node2Accounts,
    );

    await stakeV10(publishingNode.operational, node1Id, MIN_STAKE);
    for (let i = 0; i < receivingNodes.length; i++) {
      await stakeV10(
        receivingNodes[i].operational,
        receiverProfiles[i].identityId,
        MIN_STAKE,
      );
    }
    await stakeV10(node2Accounts.operational, node2Id, MIN_STAKE);

    const creator = getDefaultKACreator(accounts);
    await Token.connect(accounts[0]).transfer(creator.address, COMMITTED_TRAC);
    await Token.connect(creator).approve(await NFT.getAddress(), COMMITTED_TRAC);

    await NFT.connect(creator).createAccount(COMMITTED_TRAC, node1Id);
    const accountId = await NFT.totalSupply();
    const acct = await NFT.accounts(accountId);
    const createdAtEpoch = acct[1];
    const lockDurationEpochs = BigInt(acct[5]);

    await NFT.connect(creator).registerAgent(accountId, creator.address);

    await CGFacade.connect(creator).createContextGraph(
      [],
      0,
      0,
      1, // open publish policy
      ethers.ZeroAddress,
      0,
      ethers.ZeroHash,
    );
    const cgId = await CGS.getLatestContextGraphId();

    return {
      publishingNode,
      receivingNodes,
      receiverIdentityIds,
      node1Id,
      node2Id,
      creator,
      accountId,
      acct,
      createdAtEpoch,
      lockDurationEpochs,
      cgId,
    };
  };

  // ==========================================================================
  // TASK 2(a) — the UPDATE path also realizes-off: KAV10.update() with
  // deltaTokenAmount > 0 and publisherNodeIdentityId = node1Id must NOT credit
  // any per-node publishing allocation (the removed credit was reachable via
  // _executeUpdateCore's value-delta section, formerly
  // addEpochProducedKnowledgeValue(publisherNodeIdentityId, ...)).
  // ==========================================================================
  it('(a.update) KAV10.update() with deltaTokenAmount>0 does not credit per-node publishing allocation (realized publishing off on the update path)', async () => {
    const s = await setupPcaAndPublishCG();

    const epochsForPublish = Number(s.lockDurationEpochs);
    const initialTokenAmount = ethers.parseEther('1000');
    const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('rfc51-upd-publish'));
    const reservedKaId = packReservedKaId(s.creator.address, 1);

    const p = await buildPublishParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address,
      receivingNodes: s.receivingNodes,
      publisherIdentityId: s.node1Id,
      receiverIdentityIds: s.receiverIdentityIds,
      author: s.creator,
      contextGraphId: s.cgId,
      merkleRoot,
      knowledgeAssetsAmount: 1,
      byteSize: 1000,
      epochs: epochsForPublish,
      tokenAmount: initialTokenAmount,
      isImmutable: false,
      publishOperationId: 'rfc51-upd-publish-op',
      reservedKaId,
    });
    await (await KAV10.connect(s.creator).publish(p)).wait();

    const kaId = BigInt(reservedKaId);
    const firstEpoch = s.createdAtEpoch;
    const lastEpoch = s.createdAtEpoch + s.lockDurationEpochs;

    // Snapshot per-node allocation for BOTH nodes across the full credited
    // window (plus a couple of trailing epochs) just before the update.
    const n1PreUpdate: Record<string, bigint> = {};
    const n2PreUpdate: Record<string, bigint> = {};
    for (let e = firstEpoch; e <= lastEpoch + 2n; e++) {
      n1PreUpdate[e.toString()] =
        await EpochStorageContract.getNodeEpochPublishingAllocation(s.node1Id, e);
      n2PreUpdate[e.toString()] =
        await EpochStorageContract.getNodeEpochPublishingAllocation(s.node2Id, e);
    }

    // A paid update: newTokenAmount > current => deltaTokenAmount > 0. Names
    // node1 as publisherNodeIdentityId. The conviction window may already be
    // partially drawn by the publish; the update is allowed to fall through to
    // direct spend — either payment path runs _executeUpdateCore's value-delta
    // section, which is where the removed K_n credit lived.
    await Token.connect(accounts[0]).transfer(
      s.creator.address,
      ethers.parseEther('1000'),
    );
    await Token.connect(s.creator).approve(
      kav10Address,
      ethers.parseEther('1000'),
    );

    const up = await buildUpdateParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address,
      receivingNodes: s.receivingNodes,
      publisherIdentityId: s.node1Id,
      receiverIdentityIds: s.receiverIdentityIds,
      contextGraphId: s.cgId,
      id: kaId,
      preUpdateMerkleRootCount: 1n,
      newMerkleRoot: ethers.keccak256(ethers.toUtf8Bytes('rfc51-upd-new-root')),
      newByteSize: 1000n,
      newTokenAmount: initialTokenAmount + ethers.parseEther('500'),
      mintKnowledgeAssetsAmount: 0n,
      knowledgeAssetsToBurn: [],
      updateOperationId: 'rfc51-upd-op',
      author: s.creator,
    });

    const tx = await KAV10.connect(s.creator).update(up);
    const receipt = await tx.wait();
    expect(receipt!.status).to.equal(1);

    // The update carried a positive delta and named node1, but RFC-51 removed
    // the realized-publishing K_n credit on the update path too. Every per-node
    // allocation is byte-identical to the pre-update snapshot for both nodes.
    for (let e = firstEpoch; e <= lastEpoch + 2n; e++) {
      expect(
        await EpochStorageContract.getNodeEpochPublishingAllocation(s.node1Id, e),
        `node1 allocation at epoch ${e} must be unchanged by update`,
      ).to.equal(n1PreUpdate[e.toString()]);
      expect(
        await EpochStorageContract.getNodeEpochPublishingAllocation(s.node2Id, e),
        `node2 allocation at epoch ${e} must be unchanged by update`,
      ).to.equal(n2PreUpdate[e.toString()]);
    }
  });

  // ==========================================================================
  // TASK 1 — blocker revert coverage (verifies commit 717b83ba0).
  //   - NFT.setPrimaryNode(accountId, 0) reverts ZeroPrimaryNode (wrapper guard)
  //   - direct PublishingConviction.setPrimaryNode(accountId, 0) from the NFT
  //     context reverts ZeroPrimaryNode (logic-contract guard), reached by
  //     impersonating the registered NFT after the rate-limit epoch has cleared
  //   - the legitimate createAccount(0) -> setPrimaryNode(realNode) late-
  //     designation (oldNode==0 add-branch) still seeds correctly
  // ==========================================================================
  it('(task1) setPrimaryNode(_, 0) reverts ZeroPrimaryNode on both the NFT wrapper and the logic contract; late designation from primaryNode==0 still seeds', async () => {
    const nodeA = { admin: accounts[1], operational: accounts[2] };
    const { identityId: nodeAId } = await createProfile(ProfileContract, nodeA);
    await stakeV10(nodeA.operational, nodeAId, MIN_STAKE);

    const creator = getDefaultKACreator(accounts);
    await Token.connect(accounts[0]).transfer(creator.address, COMMITTED_TRAC);
    await Token.connect(creator).approve(await NFT.getAddress(), COMMITTED_TRAC);

    // PCA created with primaryNode == 0 (the legitimate never-seeded sentinel).
    await NFT.connect(creator).createAccount(COMMITTED_TRAC, 0);
    const accountId = await NFT.totalSupply();
    const acct0 = await NFT.accounts(accountId);
    expect(acct0[9]).to.equal(0n); // primaryNode == 0
    const createdAtEpoch = acct0[1];
    const lockDurationEpochs = BigInt(acct0[5]);
    const createdAtTimestamp = acct0[3];

    // primaryNode == 0 => nothing seeded onto any node yet.
    const lastEpoch = createdAtEpoch + lockDurationEpochs;
    for (let e = createdAtEpoch; e <= lastEpoch; e++) {
      expect(
        await EpochStorageContract.getNodeEpochPublishingAllocation(nodeAId, e),
      ).to.equal(0n);
      expect(await EpochStorageContract.getEpochPublishingAllocation(e)).to.equal(
        0n,
      );
    }

    // --- Wrapper guard: NFT.setPrimaryNode(accountId, 0) reverts. ---
    await expect(
      NFT.connect(creator).setPrimaryNode(accountId, 0),
    ).to.be.revertedWithCustomError(NFT, 'ZeroPrimaryNode');

    // Advance one full chain epoch so the once-per-epoch rate limit clears
    // (lastPrimaryNodeChangeEpoch was set to createdAtEpoch at creation). The
    // rate-limit check runs BEFORE the newNode==0 check in the logic contract,
    // so without this advance the direct call would revert RateLimited first.
    const epochLength = await Chronos.epochLength();
    await time.increase(epochLength);

    // --- Logic-contract guard: a direct PublishingConviction.setPrimaryNode(
    //     accountId, 0) from the NFT context reverts ZeroPrimaryNode. The logic
    //     entry point is onlyConvictionNFT, so impersonate the Hub-registered
    //     NFT address to reach it directly (the wrapper would otherwise short-
    //     circuit a 0 before forwarding). ---
    const nftAddress = await NFT.getAddress();
    await hre.network.provider.send('hardhat_setBalance', [
      nftAddress,
      '0x56BC75E2D63100000', // 100 ETH
    ]);
    const nftSigner = await hre.ethers.getImpersonatedSigner(nftAddress);
    await expect(
      LogicContract.connect(nftSigner).setPrimaryNode(accountId, 0),
    ).to.be.revertedWithCustomError(LogicContract, 'ZeroPrimaryNode');
    await hre.network.provider.send('hardhat_stopImpersonatingAccount', [
      nftAddress,
    ]);

    // --- Legitimate late designation: setPrimaryNode(realNode) takes the
    //     oldNode==0 add-branch and seeds the future epochs onto nodeA. ---
    const changeEpoch = await Chronos.getCurrentEpoch();
    await NFT.connect(creator).setPrimaryNode(accountId, nodeAId);
    const acct1 = await NFT.accounts(accountId);
    expect(acct1[9]).to.equal(BigInt(nodeAId)); // primaryNode updated
    expect(acct1[10]).to.equal(changeEpoch); // change-epoch cursor updated

    // The add-branch only credits FUTURE epochs (e >= changeEpoch + 1) within
    // the lock. Expected per-epoch amounts come from the SAME stored-field
    // schedule the contract uses (anchored at createdAtEpoch).
    const schedule = await expectedSeedSchedule(
      COMMITTED_TRAC,
      createdAtEpoch,
      lockDurationEpochs,
      createdAtTimestamp,
      Chronos,
    );
    let seededSum = 0n;
    for (let e = createdAtEpoch; e <= lastEpoch; e++) {
      const nodeNow = await EpochStorageContract.getNodeEpochPublishingAllocation(
        nodeAId,
        e,
      );
      const totalNow = await EpochStorageContract.getEpochPublishingAllocation(e);
      if (e >= changeEpoch + 1n) {
        // Future epoch: seeded onto nodeA via the add-branch.
        expect(nodeNow).to.equal(schedule.get(e));
      } else {
        // Current/past epoch: nothing was ever seeded (created with node==0).
        expect(nodeNow).to.equal(0n);
      }
      // nodeA is the sole contributor, so K_total == nodeA's allocation.
      expect(totalNow).to.equal(nodeNow);
      seededSum += nodeNow;
    }
    // At least one future epoch was seeded (test is not vacuous).
    expect(seededSum).to.be.gt(0n);
    // And every credited epoch matched the canonical schedule, so the late-
    // designation add-branch is byte-identical to the create-time seed for the
    // epochs it touches.
    expect(changeEpoch + 1n).to.be.lte(lastEpoch);
  });

  // ==========================================================================
  // TASK 2(b) — access-control / guard reverts.
  // ==========================================================================
  it('(b) access-control reverts: rate limit, non-existent node, onlyConvictionNFT, NotAccountOwner, EpochStorage onlyContracts', async () => {
    const nodeA = { admin: accounts[1], operational: accounts[2] };
    const nodeB = { admin: accounts[3], operational: accounts[4] };
    const { identityId: nodeAId } = await createProfile(ProfileContract, nodeA);
    const { identityId: nodeBId } = await createProfile(ProfileContract, nodeB);
    await stakeV10(nodeA.operational, nodeAId, MIN_STAKE);
    await stakeV10(nodeB.operational, nodeBId, MIN_STAKE);

    const creator = getDefaultKACreator(accounts);
    await Token.connect(accounts[0]).transfer(creator.address, COMMITTED_TRAC);
    await Token.connect(creator).approve(await NFT.getAddress(), COMMITTED_TRAC);
    await NFT.connect(creator).createAccount(COMMITTED_TRAC, nodeAId);
    const accountId = await NFT.totalSupply();

    // --- PrimaryNodeChangeRateLimited: a second setPrimaryNode in the same
    //     epoch as a prior change. Advance one epoch first so the first
    //     setPrimaryNode succeeds (createAccount stamped the change epoch);
    //     the immediate second call in that same epoch then trips the limit. ---
    const epochLength = await Chronos.epochLength();
    await time.increase(epochLength);
    await NFT.connect(creator).setPrimaryNode(accountId, nodeBId); // succeeds
    await expect(
      NFT.connect(creator).setPrimaryNode(accountId, nodeAId),
    ).to.be.revertedWithCustomError(
      LogicContract,
      'PrimaryNodeChangeRateLimited',
    );

    // --- PrimaryNodeNotInShardingTable: setPrimaryNode to a non-existent node.
    //     Advance an epoch so the rate limit does not mask this revert. ---
    await time.increase(epochLength);
    const bogusNodeId = 999999;
    await expect(
      NFT.connect(creator).setPrimaryNode(accountId, bogusNodeId),
    ).to.be.revertedWithCustomError(
      LogicContract,
      'PrimaryNodeNotInShardingTable',
    );

    // --- PrimaryNodeUnchanged: a no-op re-designation to the CURRENT node
    //     (primaryNode is nodeBId here; still this epoch — the prior reverts
    //     consumed no change slot). ---
    await expect(
      NFT.connect(creator).setPrimaryNode(accountId, nodeBId),
    ).to.be.revertedWithCustomError(LogicContract, 'PrimaryNodeUnchanged');

    // --- PrimaryNodeNotInShardingTable: createAccount with a non-existent
    //     primary node. ---
    const creator2 = accounts[10];
    await Token.connect(accounts[0]).transfer(creator2.address, COMMITTED_TRAC);
    await Token.connect(creator2).approve(await NFT.getAddress(), COMMITTED_TRAC);
    await expect(
      NFT.connect(creator2).createAccount(COMMITTED_TRAC, bogusNodeId),
    ).to.be.revertedWithCustomError(
      LogicContract,
      'PrimaryNodeNotInShardingTable',
    );

    // --- OnlyConvictionNFT: a direct (non-NFT) EOA call to the logic
    //     contract's createAccount / setPrimaryNode. ---
    await expect(
      LogicContract.connect(creator).createAccount(
        creator.address,
        accountId,
        COMMITTED_TRAC,
        nodeAId,
      ),
    ).to.be.revertedWithCustomError(LogicContract, 'OnlyConvictionNFT');
    await expect(
      LogicContract.connect(creator).setPrimaryNode(accountId, nodeAId),
    ).to.be.revertedWithCustomError(LogicContract, 'OnlyConvictionNFT');

    // --- NotAccountOwner: NFT.setPrimaryNode from a non-owner signer. ---
    await expect(
      NFT.connect(accounts[11]).setPrimaryNode(accountId, nodeBId),
    ).to.be.revertedWithCustomError(NFT, 'NotAccountOwner');

    // --- EpochStorage.moveEpochPublishingAllocation from an unauthorized EOA.
    //     `onlyContracts` accepts the hub owner (accounts[0]) and Hub-registered
    //     contracts, so use a plain non-owner EOA to actually trip the gate. ---
    await expect(
      EpochStorageContract.connect(accounts[12]).moveEpochPublishingAllocation(
        nodeAId,
        nodeBId,
        await Chronos.getCurrentEpoch(),
        1n,
      ),
    ).to.be.revertedWithCustomError(EpochStorageContract, 'UnauthorizedAccess');
  });

  // ==========================================================================
  // TASK 2(c) — per-epoch proration is asserted individually for EACH seeded
  // epoch (partial-first / each-full / dust-corrected-final), for BOTH a
  // boundary-aligned mint and a mid-epoch mint, so a total-conserving
  // mis-distribution cannot pass (the existing (a) test only checks the
  // lifetime sum).
  // ==========================================================================
  const assertSeedSchedule = async (
    nodeId: number,
    acct: Awaited<ReturnType<DKGPublishingConvictionNFT['accounts']['staticCall']>>,
  ) => {
    const committedTRAC = acct[0];
    const createdAtEpoch = acct[1];
    const createdAtTimestamp = acct[3];
    const lockDurationEpochs = BigInt(acct[5]);
    const lastEpoch = createdAtEpoch + lockDurationEpochs;

    const schedule = await expectedSeedSchedule(
      committedTRAC,
      createdAtEpoch,
      lockDurationEpochs,
      createdAtTimestamp,
      Chronos,
    );

    // Assert EACH epoch's seeded value individually against the canonical
    // schedule — not just the lifetime sum.
    let sum = 0n;
    let nonZeroFullEpochs = 0;
    const baseTokensPerFullEpoch = committedTRAC / lockDurationEpochs;
    for (let e = createdAtEpoch; e <= lastEpoch; e++) {
      const onChain =
        await EpochStorageContract.getNodeEpochPublishingAllocation(nodeId, e);
      const expected = schedule.get(e) ?? 0n;
      expect(onChain, `seeded amount at epoch ${e}`).to.equal(expected);
      // K_total == node's allocation (sole contributor on a fresh fixture).
      expect(
        await EpochStorageContract.getEpochPublishingAllocation(e),
      ).to.equal(onChain);
      sum += onChain;
      // Count the interior full epochs that carry the exact per-full amount.
      if (
        e >= createdAtEpoch + 1n &&
        e <= createdAtEpoch + (lockDurationEpochs - 1n)
      ) {
        expect(onChain, `full epoch ${e} == committedTRAC / N`).to.equal(
          baseTokensPerFullEpoch,
        );
        if (onChain > 0n) nonZeroFullEpochs++;
      }
    }
    // Conservation still holds across the lock.
    expect(sum).to.equal(committedTRAC);
    // The schedule genuinely spans full epochs (not a degenerate single-epoch
    // case), so the per-epoch checks above are load-bearing.
    expect(nonZeroFullEpochs).to.be.gt(0);
    return { createdAtTimestamp, lockDurationEpochs };
  };

  it('(c.proration) seeds each epoch per the canonical schedule — boundary-aligned mint (start of epoch): partial-first == a full slice, every full epoch==committedTRAC/N, dust-corrected final', async () => {
    const nodeA = { admin: accounts[1], operational: accounts[2] };
    const { identityId: nodeAId } = await createProfile(ProfileContract, nodeA);
    await stakeV10(nodeA.operational, nodeAId, MIN_STAKE);

    const creator = getDefaultKACreator(accounts);
    await Token.connect(accounts[0]).transfer(creator.address, COMMITTED_TRAC);
    await Token.connect(creator).approve(await NFT.getAddress(), COMMITTED_TRAC);

    // Align the mint to a chain-epoch boundary: jump to (just after) the start
    // of the next epoch so timeRemainingInCurrentEpoch ~= epochLength and the
    // partial-first allocation equals a FULL per-epoch slice (ranges[0] ==
    // baseTokensPerFullEpoch). This is the start-of-epoch boundary case; the
    // mid-epoch case below exercises a strict-fraction partial-first.
    const timeUntilNext = await Chronos.timeUntilNextEpoch();
    await time.increase(timeUntilNext);

    await NFT.connect(creator).createAccount(COMMITTED_TRAC, nodeAId);
    const accountId = await NFT.totalSupply();
    const acct = await NFT.accounts(accountId);

    const { createdAtTimestamp } = await assertSeedSchedule(nodeAId, acct);
    // Sanity: this really was (near) a boundary mint — the time the account had
    // left in its creation epoch is the full epoch length (or all-but-a-block).
    const epochLength = BigInt(await Chronos.epochLength());
    const nextEpochStart = BigInt(
      await Chronos.timestampForEpoch(BigInt(acct[1]) + 1n),
    );
    const remaining = nextEpochStart - BigInt(createdAtTimestamp);
    expect(remaining).to.be.gt((epochLength * 99n) / 100n);
  });

  it('(c.proration) seeds each epoch per the canonical schedule — mid-epoch mint: nonzero partial-first, every full epoch==committedTRAC/N, dust-corrected final', async () => {
    const nodeA = { admin: accounts[1], operational: accounts[2] };
    const { identityId: nodeAId } = await createProfile(ProfileContract, nodeA);
    await stakeV10(nodeA.operational, nodeAId, MIN_STAKE);

    const creator = getDefaultKACreator(accounts);
    await Token.connect(accounts[0]).transfer(creator.address, COMMITTED_TRAC);
    await Token.connect(creator).approve(await NFT.getAddress(), COMMITTED_TRAC);

    // Land mid-epoch: advance to ~40% into the current epoch so
    // timeRemainingInCurrentEpoch is a strict, non-trivial fraction of the
    // epoch length => a nonzero partial-first allocation strictly below a full
    // per-epoch slice.
    const epochLength = BigInt(await Chronos.epochLength());
    const timeUntilNext = BigInt(await Chronos.timeUntilNextEpoch());
    // Move so that ~40% of the epoch remains after the mint.
    const advanceBy = timeUntilNext - (epochLength * 40n) / 100n;
    if (advanceBy > 0n) {
      await time.increase(advanceBy);
    }

    await NFT.connect(creator).createAccount(COMMITTED_TRAC, nodeAId);
    const accountId = await NFT.totalSupply();
    const acct = await NFT.accounts(accountId);

    const createdAtEpoch = acct[1];
    const lockDurationEpochs = BigInt(acct[5]);
    const baseTokensPerFullEpoch = COMMITTED_TRAC / lockDurationEpochs;

    const { createdAtTimestamp } = await assertSeedSchedule(nodeAId, acct);

    // The partial-first allocation must be a STRICT fraction: > 0 and < a full
    // per-epoch slice (proving the mint really landed mid-epoch and the
    // per-epoch assertions are non-degenerate).
    const partialFirst =
      await EpochStorageContract.getNodeEpochPublishingAllocation(
        nodeAId,
        createdAtEpoch,
      );
    expect(partialFirst).to.be.gt(0n);
    expect(partialFirst).to.be.lt(baseTokensPerFullEpoch);

    // And the dust-corrected final epoch absorbs the complementary remainder:
    // partial-first + final == one full per-epoch slice (+ any rounding dust),
    // i.e. final == baseTokensPerFullEpoch - partialFirst + dust.
    const finalEpoch = createdAtEpoch + lockDurationEpochs;
    const finalAmount =
      await EpochStorageContract.getNodeEpochPublishingAllocation(
        nodeAId,
        finalEpoch,
      );
    const dust = COMMITTED_TRAC - baseTokensPerFullEpoch * lockDurationEpochs;
    expect(finalAmount).to.equal(
      baseTokensPerFullEpoch - partialFirst + dust,
    );
    expect(createdAtTimestamp).to.be.gt(0n);
  });
});
