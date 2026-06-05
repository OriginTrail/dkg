import {
  time,
  kcTools,
  expect,
  hre,
  ethers,
  createKnowledgeCollection,
  createProfile,
  quads,
  merkleRoot,
  toTRAC,
  calculateExpectedDelegatorScore,
  epochRewardsPoolPrecisionLoss,
  submitProofAndVerifyScore,
  advanceToNextProofingPeriod,
  ensureNodeHasChunksThisEpoch,
  setupTestEnvironment,
  type TestAccounts,
  type TestContracts,
  type SignerWithAddress,
} from './Staking.shared';

describe.skip(`Delegator Scoring (OBSOLETE: V8 rewards pipeline)`, function () {

    let accounts: TestAccounts;

    let contracts: TestContracts;

    let nodeIds: { node1Id: bigint; node2Id: bigint };

    let node1Id: bigint;

    let d1Key: string, d2Key: string;

    let epoch1: bigint;
   // eslint-disable-line @typescript-eslint/no-unused-vars
    let receivingNodes: {
      operational: SignerWithAddress;
      admin: SignerWithAddress;
    }[];

    let receivingNodesIdentityIds: number[];


    beforeEach(async function () {
      // Setup test environment
      const setup = await setupTestEnvironment();
      accounts = setup.accounts;
      contracts = setup.contracts;
      nodeIds = setup.nodeIds;
      node1Id = nodeIds.node1Id;

      epoch1 = await contracts.chronos.getCurrentEpoch();

      // Create delegator keys for state verification
      d1Key = ethers.keccak256(
        ethers.solidityPacked(['address'], [accounts.delegator1.address]),
      );
      d2Key = ethers.keccak256(
        ethers.solidityPacked(['address'], [accounts.delegator2.address]),
      );

      // Setup receiving nodes for KC creation
      receivingNodes = [
        accounts.receiver1,
        accounts.receiver2,
        accounts.receiver3,
      ];
      receivingNodesIdentityIds = [];
      for (const recNode of receivingNodes) {
        const { identityId } = await createProfile(contracts.profile, recNode);
        receivingNodesIdentityIds.push(Number(identityId));
      }

      // Initialize ask system properly to prevent division by zero
      // Stake some tokens to node1 to make it eligible for ask setting
      await contracts.token
        .connect(accounts.node1.operational)
        .approve(await contracts.staking.getAddress(), toTRAC(100));
      await contracts.staking
        .connect(accounts.node1.operational)
        .stake(node1Id, toTRAC(100));

      // Set ask price to establish bounds
      const nodeAsk = ethers.parseUnits('0.1', 18);
      await contracts.profile
        .connect(accounts.node1.operational)
        .updateAsk(node1Id, nodeAsk);
      await contracts.ask.connect(accounts.owner).recalculateActiveSet();

      // Create knowledge collection for reward pool
      const kcTokenAmount = toTRAC(10_000);
      const numberOfEpochs = 5;
      await createKnowledgeCollection(
        accounts.kcCreator,
        accounts.node1,
        Number(node1Id),
        receivingNodes,
        receivingNodesIdentityIds,
        { KnowledgeCollection: contracts.kc, Token: contracts.token },
        merkleRoot,
        'delegator-scoring-test',
        10,
        1000,
        numberOfEpochs,
        kcTokenAmount,
      );
    });

  describe('Suite 5: Rolling Rewards & Fee Mechanics', function () {


          it('5C - Double-claim guard', async function () {
            console.log('\n🚫 TEST 5C: Double-claim guard');

            const startEpoch = await contracts.chronos.getCurrentEpoch();

            // Step 1: Stake and submit proof
            const stake = toTRAC(120);
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), stake);
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(node1Id, stake);

            // Submit proof
            await contracts.randomSampling.updateAndGetActiveProofPeriodStartBlock();
            await contracts.randomSampling
              .connect(accounts.node1.operational)
              .createChallenge();
            const challenge =
              await contracts.randomSamplingStorage.getNodeChallenge(node1Id);
            const chunks = kcTools.splitIntoChunks(quads, 32);
            const chunkId = Number(challenge[1]);
            const { proof } = kcTools.calculateMerkleProof(quads, 32, chunkId);
            await contracts.randomSampling
              .connect(accounts.node1.operational)
              .submitProof(chunks[chunkId], proof);

            console.log(`    📋 Proof submitted for epoch ${startEpoch}`);

            // Step 2: Advance to next epoch to make rewards claimable
            const timeUntilNext = await contracts.chronos.timeUntilNextEpoch();
            await time.increase(timeUntilNext + 1n);
            await createKnowledgeCollection(
              accounts.kcCreator,
              accounts.node1,
              Number(node1Id),
              receivingNodes,
              receivingNodesIdentityIds,
              { KnowledgeCollection: contracts.kc, Token: contracts.token },
              merkleRoot,
              'double-claim-epoch',
              1,
              1000,
              1,
              toTRAC(1),
            );

            // Step 3: Claim epoch E successfully
            const stakeBaseBefore =
              await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d1Key);

            await contracts.staking
              .connect(accounts.delegator1)
              .claimDelegatorRewards(
                node1Id,
                startEpoch,
                accounts.delegator1.address,
              );

            const stakeBaseAfterClaim =
              await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d1Key);
            const rewardClaimed = stakeBaseAfterClaim - stakeBaseBefore;

            console.log(
              `    ✅ First claim successful: ${ethers.formatUnits(rewardClaimed, 18)} TRAC`,
            );

            // Step 4: Attempt second claim for same epoch (should revert)
            // **DELEGATOR SCORING ASSERTIONS**
            await expect(
              contracts.staking
                .connect(accounts.delegator1)
                .claimDelegatorRewards(
                  node1Id,
                  startEpoch,
                  accounts.delegator1.address,
                ),
            ).to.be.revertedWith('Already claimed all finalised epochs');

            // Verify stake base is unchanged after failed double claim
            const stakeBaseAfterRevert =
              await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d1Key);

            expect(stakeBaseAfterRevert).to.equal(
              stakeBaseAfterClaim,
              'Stake base should be unchanged after failed double claim',
            );

            console.log(
              `    ✅ Second claim properly reverted: "Already claimed all finalised epochs"`,
            );
            console.log(
              `    ✅ Stake base unchanged: ${ethers.formatUnits(stakeBaseAfterRevert, 18)} TRAC`,
            );
            console.log(`    ✅ Double-claim protection works correctly`);
          });
    });
});
