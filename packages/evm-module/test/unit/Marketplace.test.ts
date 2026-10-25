// =============================================================================
// OT-RFC-27 NeuroSymbolic Marketplace — contract-level settlement tests
// =============================================================================
//
// Covers the full Marketplace/MarketplaceStorage surface: fund → claim →
// finalize → reward happy path, pro-rata over-claim (floor semantics),
// replay / wrong-seller / expiry / unit-bound / non-core-node rejections,
// session-key rotation, pool rollover, λ_QIF edge values, and
// settlement-window gating.
//
// The authorization digest is recomputed here with
// `ethers.solidityPackedKeccak256` using the shared `DKG_MKT_AUTH_V1` spec
// (field order AND solidity types) and cross-checked against the contract's
// `computeAuthDigest` — this pins the byte-for-byte Solidity/TS contract
// that `packages/marketplace` mirrors.

import { randomBytes } from 'crypto';

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { Wallet } from 'ethers';
import hre from 'hardhat';

import { createProfile } from '../helpers/profile-helpers';
import {
  Chronos,
  ConvictionStakingStorage,
  DKGStakingConvictionNFT,
  Marketplace,
  MarketplaceStorage,
  ParametersStorage,
  Profile,
  ShardingTable,
  ShardingTableStorage,
  StakingV10,
  Token,
} from '../../typechain';

const SCALE18 = 10n ** 18n;
const AUTH_DOMAIN = 'DKG_MKT_AUTH_V1';

type Fixture = {
  accounts: SignerWithAddress[];
  Marketplace: Marketplace;
  MarketplaceStorage: MarketplaceStorage;
  Token: Token;
  Chronos: Chronos;
  Profile: Profile;
  ShardingTable: ShardingTable;
  ShardingTableStorage: ShardingTableStorage;
  ConvictionStakingStorage: ConvictionStakingStorage;
  ParametersStorage: ParametersStorage;
  NFT: DKGStakingConvictionNFT;
  StakingV10: StakingV10;
};

type AuthFields = {
  buyer: string;
  sellerIdentityId: bigint;
  offeringId: string;
  callId: string;
  epoch: bigint;
  maxUnits: bigint;
  askPerUnit: bigint;
  expiry: bigint;
};

// Floor integer sqrt (bigint) — mirrors OZ `Math.sqrt`.
function isqrt(n: bigint): bigint {
  if (n < 2n) {
    return n;
  }
  let x0 = n / 2n + 1n;
  let x1 = (x0 + n / x0) / 2n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + n / x0) / 2n;
  }
  return x0;
}

// TS mirror of `Marketplace.getStakeFactor18` (= RandomSampling step-1 math):
// S18 = sqrt(min(effStake, cap)·1e18/cap · 1e18).
function stakeFactor18(effectiveStake: bigint, stakeCap: bigint): bigint {
  const capped = effectiveStake > stakeCap ? stakeCap : effectiveStake;
  return isqrt(((capped * SCALE18) / stakeCap) * SCALE18);
}

describe('@unit Marketplace (OT-RFC-27)', () => {
  let accounts: SignerWithAddress[];
  let MarketplaceContract: Marketplace;
  let MarketplaceStorageContract: MarketplaceStorage;
  let TokenContract: Token;
  let ChronosContract: Chronos;
  let ProfileContract: Profile;
  let ShardingTableContract: ShardingTable;
  let ShardingTableStorageContract: ShardingTableStorage;
  let ConvictionStakingStorageContract: ConvictionStakingStorage;
  let ParametersStorageContract: ParametersStorage;
  let NFT: DKGStakingConvictionNFT;
  let StakingV10Contract: StakingV10;

  let chainId: bigint;
  let marketplaceAddress: string;
  let maximumStake: bigint;

  async function deployFixture(): Promise<Fixture> {
    await hre.deployments.fixture([
      'Marketplace',
      'Profile',
      'ShardingTable',
      'DKGStakingConvictionNFT',
    ]);

    return {
      accounts: await hre.ethers.getSigners(),
      Marketplace: await hre.ethers.getContract<Marketplace>('Marketplace'),
      MarketplaceStorage:
        await hre.ethers.getContract<MarketplaceStorage>('MarketplaceStorage'),
      Token: await hre.ethers.getContract<Token>('Token'),
      Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
      Profile: await hre.ethers.getContract<Profile>('Profile'),
      ShardingTable:
        await hre.ethers.getContract<ShardingTable>('ShardingTable'),
      ShardingTableStorage: await hre.ethers.getContract<ShardingTableStorage>(
        'ShardingTableStorage',
      ),
      ConvictionStakingStorage:
        await hre.ethers.getContract<ConvictionStakingStorage>(
          'ConvictionStakingStorage',
        ),
      ParametersStorage:
        await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
      NFT: await hre.ethers.getContract<DKGStakingConvictionNFT>(
        'DKGStakingConvictionNFT',
      ),
      StakingV10: await hre.ethers.getContract<StakingV10>('StakingV10'),
    };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      Marketplace: MarketplaceContract,
      MarketplaceStorage: MarketplaceStorageContract,
      Token: TokenContract,
      Chronos: ChronosContract,
      Profile: ProfileContract,
      ShardingTable: ShardingTableContract,
      ShardingTableStorage: ShardingTableStorageContract,
      ConvictionStakingStorage: ConvictionStakingStorageContract,
      ParametersStorage: ParametersStorageContract,
      NFT,
      StakingV10: StakingV10Contract,
    } = await loadFixture(deployFixture));

    chainId = (await hre.ethers.provider.getNetwork()).chainId;
    marketplaceAddress = await MarketplaceContract.getAddress();
    maximumStake = await ParametersStorageContract.maximumStake();
  });

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  // Session keys are plain throwaway secp256k1 keys (repo audit bans
  // Wallet.createRandom — raw randomBytes is the sanctioned pattern).
  const newSessionKey = () =>
    new Wallet('0x' + randomBytes(32).toString('hex'));

  // Core Node = profile + V10 conviction stake + sharding-table membership.
  // The 12-month tier carries a 6x conviction multiplier, so effective stake
  // (what the S18 stake factor reads) is 6·raw.
  const setupCoreNode = async (
    operationalIdx: number,
    adminIdx: number,
    rawStake: bigint,
    lockTier: number = 12,
  ) => {
    const node = {
      operational: accounts[operationalIdx],
      admin: accounts[adminIdx],
    };
    const { identityId } = await createProfile(ProfileContract, node);
    await TokenContract.connect(node.operational).approve(
      await StakingV10Contract.getAddress(),
      rawStake,
    );
    await NFT.connect(node.operational).createConviction(
      identityId,
      rawStake,
      lockTier,
    );
    // StakingV10 admits eligible nodes opportunistically; insert explicitly
    // when the raw stake is below `minimumStake` (hub owner passes
    // `onlyContracts`).
    if (!(await ShardingTableStorageContract.nodeExists(identityId))) {
      // `insertNode` is overloaded — name the uint72 variant explicitly.
      await ShardingTableContract.connect(accounts[0])['insertNode(uint72)'](
        identityId,
      );
    }
    return { node, identityId: BigInt(identityId) };
  };

  const fund = async (
    buyer: SignerWithAddress,
    amount: bigint,
    sessionKey: string,
    epoch: bigint,
  ) => {
    await TokenContract.connect(buyer).approve(marketplaceAddress, amount);
    return MarketplaceContract.connect(buyer).fundSubscription(
      amount,
      sessionKey,
      epoch,
    );
  };

  const computeAuthDigestTs = (fields: AuthFields): string =>
    hre.ethers.solidityPackedKeccak256(
      [
        'string',
        'uint256',
        'address',
        'address',
        'uint72',
        'bytes32',
        'bytes32',
        'uint256',
        'uint64',
        'uint96',
        'uint40',
      ],
      [
        AUTH_DOMAIN,
        chainId,
        marketplaceAddress,
        fields.buyer,
        fields.sellerIdentityId,
        fields.offeringId,
        fields.callId,
        fields.epoch,
        fields.maxUnits,
        fields.askPerUnit,
        fields.expiry,
      ],
    );

  const makeAuthFields = async (
    buyer: string,
    sellerIdentityId: bigint,
    epoch: bigint,
    overrides: Partial<AuthFields> = {},
  ): Promise<AuthFields> => ({
    buyer,
    sellerIdentityId,
    offeringId: hre.ethers.keccak256(hre.ethers.toUtf8Bytes('devnet-llm')),
    callId: '0x' + randomBytes(32).toString('hex'),
    epoch,
    maxUnits: 1_000n,
    askPerUnit: 10n ** 15n, // 0.001 TRAC per unit
    expiry: BigInt(await time.latest()) + 3_600n,
    ...overrides,
  });

  const signedClaim = async (
    sessionKey: Wallet,
    fields: AuthFields,
    servedUnits: bigint,
  ) => {
    const digest = computeAuthDigestTs(fields);
    const authSignature = await sessionKey.signMessage(
      hre.ethers.getBytes(digest),
    );
    return {
      digest,
      claim: {
        buyer: fields.buyer,
        epoch: fields.epoch,
        offeringId: fields.offeringId,
        callId: fields.callId,
        maxUnits: fields.maxUnits,
        askPerUnit: fields.askPerUnit,
        expiry: fields.expiry,
        servedUnits,
        resultCommitment: hre.ethers.sha256(
          hre.ethers.toUtf8Bytes(`result:${fields.callId}`),
        ),
        authSignature,
      },
    };
  };

  const warpPastDeadline = async (epoch: bigint) => {
    const deadline = await MarketplaceContract.settlementDeadline(epoch);
    await time.increaseTo(deadline + 1n);
  };

  // --------------------------------------------------------------------------
  // Parameters & deploy wiring
  // --------------------------------------------------------------------------

  it('deploys with documented parameter defaults (grace = epochLength/4)', async () => {
    const [lambdaQif18, settlementGraceSeconds, softCeilingBps, rewardCapMultiple] =
      await MarketplaceContract.getParams();
    expect(lambdaQif18).to.equal(4n * 10n ** 17n);
    expect(settlementGraceSeconds).to.equal(
      (await ChronosContract.epochLength()) / 4n,
    );
    expect(softCeilingBps).to.equal(9_500);
    expect(rewardCapMultiple).to.equal(10);
  });

  it('parameter setters are hub-owner gated and bounds-checked', async () => {
    await expect(
      MarketplaceStorageContract.connect(accounts[5]).setLambdaQif18(0),
    ).to.be.revertedWith('Only Hub Owner, Hub, or Multisig Owner can call');
    await expect(
      MarketplaceStorageContract.connect(accounts[5]).setRewardCapMultiple(0),
    ).to.be.revertedWith('Only Hub Owner, Hub, or Multisig Owner can call');
    await expect(
      MarketplaceStorageContract.connect(accounts[0]).setLambdaQif18(
        SCALE18 + 1n,
      ),
    ).to.be.revertedWithCustomError(
      MarketplaceStorageContract,
      'LambdaTooLarge',
    );
    await expect(
      MarketplaceStorageContract.connect(accounts[0]).setSoftCeilingBps(10_001),
    ).to.be.revertedWithCustomError(MarketplaceStorageContract, 'InvalidBps');

    await MarketplaceStorageContract.connect(accounts[0]).setLambdaQif18(
      SCALE18,
    );
    expect(await MarketplaceStorageContract.lambdaQif18()).to.equal(SCALE18);
  });

  // --------------------------------------------------------------------------
  // Funding & session keys
  // --------------------------------------------------------------------------

  it('fundSubscription: only current or next epoch; registers the session key', async () => {
    const buyer = accounts[10];
    const sessionKey = newSessionKey();
    const epoch = await ChronosContract.getCurrentEpoch();
    const amount = hre.ethers.parseEther('10');

    await TokenContract.connect(buyer).approve(marketplaceAddress, amount * 4n);
    await expect(
      MarketplaceContract.connect(buyer).fundSubscription(
        amount,
        sessionKey.address,
        epoch + 2n,
      ),
    ).to.be.revertedWithCustomError(
      MarketplaceContract,
      'InvalidSubscriptionEpoch',
    );
    await expect(
      MarketplaceContract.connect(buyer).fundSubscription(
        0,
        sessionKey.address,
        epoch,
      ),
    ).to.be.revertedWithCustomError(MarketplaceContract, 'ZeroTokenAmount');

    // Current epoch, fresh key.
    await expect(
      MarketplaceContract.connect(buyer).fundSubscription(
        amount,
        sessionKey.address,
        epoch,
      ),
    )
      .to.emit(MarketplaceContract, 'SessionKeyRotated')
      .withArgs(buyer.address, sessionKey.address)
      .and.to.emit(MarketplaceContract, 'SubscriptionFunded')
      .withArgs(buyer.address, epoch, amount, sessionKey.address);

    // Next epoch, keep the key (zero address).
    await MarketplaceContract.connect(buyer).fundSubscription(
      amount,
      hre.ethers.ZeroAddress,
      epoch + 1n,
    );

    const bucket = await MarketplaceContract.getBucket(buyer.address, epoch);
    expect(bucket.funded).to.equal(amount);
    expect(await MarketplaceStorageContract.epochPool(epoch)).to.equal(amount);
    expect(await MarketplaceStorageContract.openBuckets(epoch)).to.equal(1n);
    expect(await MarketplaceContract.activeSessionKey(buyer.address)).to.equal(
      sessionKey.address,
    );
    expect(await TokenContract.balanceOf(marketplaceAddress)).to.equal(
      amount * 2n,
    );

    // Top-up of an existing bucket does not double-count the open bucket.
    await MarketplaceContract.connect(buyer).fundSubscription(
      amount,
      hre.ethers.ZeroAddress,
      epoch,
    );
    expect(await MarketplaceStorageContract.openBuckets(epoch)).to.equal(1n);
    expect(
      (await MarketplaceContract.getBucket(buyer.address, epoch)).funded,
    ).to.equal(amount * 2n);
  });

  it('fundSubscription: zero key without a registered one is rejected; bindings are per-buyer', async () => {
    const buyer = accounts[10];
    const otherBuyer = accounts[11];
    const sessionKey = newSessionKey();
    const epoch = await ChronosContract.getCurrentEpoch();
    const amount = hre.ethers.parseEther('1');

    await TokenContract.connect(buyer).approve(marketplaceAddress, amount);
    await expect(
      MarketplaceContract.connect(buyer).fundSubscription(
        amount,
        hre.ethers.ZeroAddress,
        epoch,
      ),
    ).to.be.revertedWithCustomError(MarketplaceContract, 'NoActiveSessionKey');

    await fund(buyer, amount, sessionKey.address, epoch);

    // Bindings are scoped per buyer: another buyer binding the same key is
    // harmless (no global squatting/front-running surface), and each binding
    // only spends its own buckets.
    await TokenContract.connect(otherBuyer).approve(marketplaceAddress, amount);
    await MarketplaceContract.connect(otherBuyer).fundSubscription(
      amount,
      sessionKey.address,
      epoch,
    );
    expect(
      await MarketplaceContract.activeSessionKey(otherBuyer.address),
    ).to.equal(sessionKey.address);
    expect(
      await MarketplaceContract.isSessionKeyBound(
        buyer.address,
        sessionKey.address,
      ),
    ).to.equal(true);
    expect(
      await MarketplaceContract.isSessionKeyBound(
        otherBuyer.address,
        sessionKey.address,
      ),
    ).to.equal(true);
  });

  it('one session key shared by two buyers settles against both buckets', async () => {
    const { node, identityId } = await setupCoreNode(
      1,
      2,
      hre.ethers.parseEther('100000'),
    );
    const buyerA = accounts[10];
    const buyerB = accounts[11];
    const sharedKey = newSessionKey();
    const epoch = await ChronosContract.getCurrentEpoch();
    await fund(buyerA, hre.ethers.parseEther('5'), sharedKey.address, epoch);
    await fund(buyerB, hre.ethers.parseEther('5'), sharedKey.address, epoch);

    const fieldsA = await makeAuthFields(buyerA.address, identityId, epoch);
    const fieldsB = await makeAuthFields(buyerB.address, identityId, epoch);
    const { claim: claimA } = await signedClaim(sharedKey, fieldsA, 10n);
    const { claim: claimB } = await signedClaim(sharedKey, fieldsB, 20n);
    await MarketplaceContract.connect(node.operational).submitReceiptBatch([
      claimA,
      claimB,
    ]);
    expect(
      (await MarketplaceContract.getSellerClaim(buyerA.address, epoch, identityId))
        .claimed,
    ).to.equal(10n * fieldsA.askPerUnit);
    expect(
      (await MarketplaceContract.getSellerClaim(buyerB.address, epoch, identityId))
        .claimed,
    ).to.equal(20n * fieldsB.askPerUnit);
  });

  // --------------------------------------------------------------------------
  // Happy path: fund → claim → finalize → reward (digest cross-check)
  // --------------------------------------------------------------------------

  it('full flow: TS digest == Solidity digest, claims accrue with S18 at acceptance, single seller sweeps the pool', async () => {
    const { node, identityId } = await setupCoreNode(
      1,
      2,
      hre.ethers.parseEther('100000'),
    );
    const buyer = accounts[10];
    const sessionKey = newSessionKey();
    const epoch = await ChronosContract.getCurrentEpoch();
    const pool = hre.ethers.parseEther('10');
    await fund(buyer, pool, sessionKey.address, epoch);

    // --- Digest cross-check: the TS packed-keccak spec IS the contract's ---
    const fields = await makeAuthFields(buyer.address, identityId, epoch);
    const digestTs = computeAuthDigestTs(fields);
    expect(
      await MarketplaceContract.computeAuthDigest(
        fields.buyer,
        fields.sellerIdentityId,
        fields.offeringId,
        fields.callId,
        fields.epoch,
        fields.maxUnits,
        fields.askPerUnit,
        fields.expiry,
      ),
    ).to.equal(digestTs);

    // Stake factor mirror: 100k raw at the 12-month tier = 600k effective.
    const effectiveStake =
      await ConvictionStakingStorageContract.getNodeEffectiveStake(identityId);
    expect(effectiveStake).to.be.gt(0n);
    const s18 = stakeFactor18(effectiveStake, maximumStake);
    expect(await MarketplaceContract.getStakeFactor18(identityId)).to.equal(
      s18,
    );

    // --- Claim 1: signature over exactly the TS digest is accepted ---
    const served1 = 800n;
    const { digest, claim: claim1 } = await signedClaim(
      sessionKey,
      fields,
      served1,
    );
    expect(digest).to.equal(digestTs);
    const value1 = served1 * fields.askPerUnit;
    await expect(
      MarketplaceContract.connect(node.operational).submitReceiptBatch([
        claim1,
      ]),
    )
      .to.emit(MarketplaceContract, 'ReceiptClaimed')
      .withArgs(
        buyer.address,
        epoch,
        identityId,
        fields.offeringId,
        fields.callId,
        served1,
        value1,
        claim1.resultCommitment,
      );
    expect(await MarketplaceStorageContract.consumedAuth(digestTs)).to.equal(
      true,
    );

    // --- Claim 2 in a second batch ---
    const fields2 = await makeAuthFields(buyer.address, identityId, epoch);
    const served2 = 200n;
    const { claim: claim2 } = await signedClaim(sessionKey, fields2, served2);
    await MarketplaceContract.connect(node.operational).submitReceiptBatch([
      claim2,
    ]);
    const value2 = served2 * fields2.askPerUnit;

    const sellerClaim = await MarketplaceContract.getSellerClaim(
      buyer.address,
      epoch,
      identityId,
    );
    expect(sellerClaim.claimed).to.equal(value1 + value2);
    expect(sellerClaim.qiRaw).to.equal(
      (value1 * s18) / SCALE18 + (value2 * s18) / SCALE18,
    );
    expect(
      (await MarketplaceContract.getBucket(buyer.address, epoch)).totalClaimed,
    ).to.equal(value1 + value2);

    // --- Finalize (claims < funded → 1:1) ---
    await warpPastDeadline(epoch);
    await expect(MarketplaceContract.finalizeBucket(buyer.address, epoch, 0))
      .to.emit(MarketplaceContract, 'BucketFinalized')
      .withArgs(buyer.address, epoch, pool, value1 + value2, value1 + value2);

    const acct = await MarketplaceContract.getNodeEpochAccounting(
      epoch,
      identityId,
    );
    expect(acct.finalizedValue).to.equal(value1 + value2);
    expect(acct.totalFinalizedValue).to.equal(value1 + value2);
    expect(acct.qiScore).to.equal(sellerClaim.qiRaw);
    expect(acct.totalQiScore).to.equal(sellerClaim.qiRaw);
    expect(await MarketplaceStorageContract.openBuckets(epoch)).to.equal(0n);

    // --- Reward: sole claimant → QIF = (1−λ) + λ = 1 → whole pool ---
    expect(await MarketplaceContract.getQif18(epoch, identityId)).to.equal(
      SCALE18,
    );
    const balanceBefore = await TokenContract.balanceOf(
      node.operational.address,
    );
    await expect(
      MarketplaceContract.connect(node.operational).claimEpochReward(
        identityId,
        epoch,
      ),
    )
      .to.emit(MarketplaceContract, 'EpochRewardClaimed')
      .withArgs(epoch, identityId, node.operational.address, pool);
    expect(await TokenContract.balanceOf(node.operational.address)).to.equal(
      balanceBefore + pool,
    );

    await expect(
      MarketplaceContract.connect(node.operational).claimEpochReward(
        identityId,
        epoch,
      ),
    ).to.be.revertedWithCustomError(MarketplaceContract, 'RewardAlreadyClaimed');

    // A pool with finalized value cannot be rolled forward.
    await expect(
      MarketplaceContract.rollEpochPool(epoch),
    ).to.be.revertedWithCustomError(
      MarketplaceContract,
      'EpochHasFinalizedValue',
    );
  });

  // --------------------------------------------------------------------------
  // Pro-rata over-claim
  // --------------------------------------------------------------------------

  it('over-claimed bucket pro-rates with floor semantics; residue stays in the pool', async () => {
    const sellerA = await setupCoreNode(1, 2, hre.ethers.parseEther('100000'));
    const sellerB = await setupCoreNode(3, 4, hre.ethers.parseEther('200000'));
    const buyer = accounts[10];
    const sessionKey = newSessionKey();
    const epoch = await ChronosContract.getCurrentEpoch();
    const funded = hre.ethers.parseEther('1');
    await fund(buyer, funded, sessionKey.address, epoch);

    const s18A = stakeFactor18(
      await ConvictionStakingStorageContract.getNodeEffectiveStake(
        sellerA.identityId,
      ),
      maximumStake,
    );
    const s18B = stakeFactor18(
      await ConvictionStakingStorageContract.getNodeEffectiveStake(
        sellerB.identityId,
      ),
      maximumStake,
    );

    // A claims 1.0 TRAC, B claims 0.7 TRAC → 1.7 claimed vs 1.0 funded.
    const fieldsA = await makeAuthFields(
      buyer.address,
      sellerA.identityId,
      epoch,
    );
    const fieldsB = await makeAuthFields(
      buyer.address,
      sellerB.identityId,
      epoch,
    );
    const servedA = 1_000n;
    const servedB = 700n;
    const { claim: claimA } = await signedClaim(sessionKey, fieldsA, servedA);
    const { claim: claimB } = await signedClaim(sessionKey, fieldsB, servedB);
    await MarketplaceContract.connect(
      sellerA.node.operational,
    ).submitReceiptBatch([claimA]);
    await MarketplaceContract.connect(
      sellerB.node.operational,
    ).submitReceiptBatch([claimB]);

    const claimedA = servedA * fieldsA.askPerUnit;
    const claimedB = servedB * fieldsB.askPerUnit;
    const totalClaimed = claimedA + claimedB;
    expect(totalClaimed).to.be.gt(funded);

    await warpPastDeadline(epoch);
    await MarketplaceContract.finalizeBucket(buyer.address, epoch, 0);

    // TS mirror of the contract's floor math (no submission-order priority).
    const finalizedA = (claimedA * funded) / totalClaimed;
    const finalizedB = (claimedB * funded) / totalClaimed;
    const qiRawA = (claimedA * s18A) / SCALE18;
    const qiRawB = (claimedB * s18B) / SCALE18;
    const qiA = (qiRawA * finalizedA) / claimedA;
    const qiB = (qiRawB * finalizedB) / claimedB;

    const acctA = await MarketplaceContract.getNodeEpochAccounting(
      epoch,
      sellerA.identityId,
    );
    const acctB = await MarketplaceContract.getNodeEpochAccounting(
      epoch,
      sellerB.identityId,
    );
    expect(acctA.finalizedValue).to.equal(finalizedA);
    expect(acctB.finalizedValue).to.equal(finalizedB);
    expect(acctA.qiScore).to.equal(qiA);
    expect(acctB.qiScore).to.equal(qiB);

    // Floor residue: finalized total is capped by funding and the 1-wei
    // rounding residue stays in the (undiminished) epoch pool.
    const bucket = await MarketplaceContract.getBucket(buyer.address, epoch);
    expect(bucket.totalFinalized).to.equal(finalizedA + finalizedB);
    expect(bucket.totalFinalized).to.be.lte(funded);
    expect(finalizedA + finalizedB).to.be.lt(funded); // strict: floor residue
    expect(await MarketplaceStorageContract.epochPool(epoch)).to.equal(funded);

    // Rewards follow QIF over the FULL pool (default λ = 0.4).
    const lambda = await MarketplaceStorageContract.lambdaQif18();
    const totalR = finalizedA + finalizedB;
    const totalQ = qiA + qiB;
    const qifA = ((SCALE18 - lambda) * finalizedA) / totalR + (lambda * qiA) / totalQ;
    const rewardA = (funded * qifA) / SCALE18;
    expect(
      await MarketplaceContract.getQif18(epoch, sellerA.identityId),
    ).to.equal(qifA);

    const balanceBefore = await TokenContract.balanceOf(
      sellerA.node.operational.address,
    );
    await MarketplaceContract.connect(
      sellerA.node.operational,
    ).claimEpochReward(sellerA.identityId, epoch);
    expect(
      await TokenContract.balanceOf(sellerA.node.operational.address),
    ).to.equal(balanceBefore + rewardA);
  });

  // --------------------------------------------------------------------------
  // Paginated finalization
  // --------------------------------------------------------------------------

  it('paginated finalizeBucket over several sellers equals a one-shot finalize', async () => {
    const sellers = [
      await setupCoreNode(1, 2, hre.ethers.parseEther('100000')),
      await setupCoreNode(3, 4, hre.ethers.parseEther('200000')),
      await setupCoreNode(5, 6, hre.ethers.parseEther('300000')),
    ];
    const buyer = accounts[10];
    const sessionKey = newSessionKey();
    const epoch = await ChronosContract.getCurrentEpoch();
    const funded = hre.ethers.parseEther('1');
    await fund(buyer, funded, sessionKey.address, epoch);

    // Over-claim so pro-rating is exercised across pages: 0.5/0.7/0.9 TRAC.
    const claimed: bigint[] = [];
    for (const [i, seller] of sellers.entries()) {
      const fields = await makeAuthFields(
        buyer.address,
        seller.identityId,
        epoch,
      );
      const served = BigInt(500 + 200 * i);
      const { claim } = await signedClaim(sessionKey, fields, served);
      await MarketplaceContract.connect(
        seller.node.operational,
      ).submitReceiptBatch([claim]);
      claimed.push(served * fields.askPerUnit);
    }
    const totalClaimed = claimed.reduce((sum, value) => sum + value, 0n);
    expect(totalClaimed).to.be.gt(funded);

    await warpPastDeadline(epoch);

    // Page 1 (one seller): progress, not finalized, bucket still open.
    await expect(MarketplaceContract.finalizeBucket(buyer.address, epoch, 1))
      .to.emit(MarketplaceContract, 'BucketFinalizeProgress')
      .withArgs(buyer.address, epoch, 1, 3);
    expect(
      (await MarketplaceContract.getBucket(buyer.address, epoch)).finalized,
    ).to.equal(false);
    expect(await MarketplaceStorageContract.openBuckets(epoch)).to.equal(1n);
    expect(
      await MarketplaceStorageContract.finalizeCursor(buyer.address, epoch),
    ).to.equal(1n);
    await expect(
      MarketplaceContract.connect(
        sellers[0].node.operational,
      ).claimEpochReward(sellers[0].identityId, epoch),
    ).to.be.revertedWithCustomError(MarketplaceContract, 'OpenBucketsRemaining');

    // Page 2 (maxSellers larger than the remainder clamps to the end) emits
    // the terminal BucketFinalized with the full totals.
    const expectedFinalized = claimed.map(
      (value) => (value * funded) / totalClaimed,
    );
    const expectedTotal = expectedFinalized.reduce(
      (sum, value) => sum + value,
      0n,
    );
    await expect(MarketplaceContract.finalizeBucket(buyer.address, epoch, 5))
      .to.emit(MarketplaceContract, 'BucketFinalized')
      .withArgs(buyer.address, epoch, funded, totalClaimed, expectedTotal);
    await expect(
      MarketplaceContract.finalizeBucket(buyer.address, epoch, 1),
    ).to.be.revertedWithCustomError(
      MarketplaceContract,
      'BucketAlreadyFinalized',
    );

    // The paginated result is byte-identical to the one-shot floor math.
    const bucket = await MarketplaceContract.getBucket(buyer.address, epoch);
    expect(bucket.finalized).to.equal(true);
    expect(bucket.totalFinalized).to.equal(expectedTotal);
    expect(await MarketplaceStorageContract.openBuckets(epoch)).to.equal(0n);
    for (const [i, seller] of sellers.entries()) {
      const acct = await MarketplaceContract.getNodeEpochAccounting(
        epoch,
        seller.identityId,
      );
      expect(acct.finalizedValue).to.equal(expectedFinalized[i]);
    }
  });

  // --------------------------------------------------------------------------
  // Objective-fault rejections
  // --------------------------------------------------------------------------

  it('rejects replays: resubmission and duplicates within one batch', async () => {
    const { node, identityId } = await setupCoreNode(
      1,
      2,
      hre.ethers.parseEther('100000'),
    );
    const buyer = accounts[10];
    const sessionKey = newSessionKey();
    const epoch = await ChronosContract.getCurrentEpoch();
    await fund(buyer, hre.ethers.parseEther('10'), sessionKey.address, epoch);

    const fields = await makeAuthFields(buyer.address, identityId, epoch);
    const { claim } = await signedClaim(sessionKey, fields, 10n);

    await MarketplaceContract.connect(node.operational).submitReceiptBatch([
      claim,
    ]);
    await expect(
      MarketplaceContract.connect(node.operational).submitReceiptBatch([claim]),
    ).to.be.revertedWithCustomError(
      MarketplaceContract,
      'AuthorizationAlreadyConsumed',
    );

    // A duplicate inside one batch rejects the whole batch (nothing accrues).
    const fields2 = await makeAuthFields(buyer.address, identityId, epoch);
    const { claim: claim2 } = await signedClaim(sessionKey, fields2, 10n);
    const before = await MarketplaceContract.getSellerClaim(
      buyer.address,
      epoch,
      identityId,
    );
    await expect(
      MarketplaceContract.connect(node.operational).submitReceiptBatch([
        claim2,
        claim2,
      ]),
    ).to.be.revertedWithCustomError(
      MarketplaceContract,
      'AuthorizationAlreadyConsumed',
    );
    expect(
      (
        await MarketplaceContract.getSellerClaim(
          buyer.address,
          epoch,
          identityId,
        )
      ).claimed,
    ).to.equal(before.claimed);
  });

  it('rejects wrong-seller submission (digest binds the seller identity)', async () => {
    const sellerA = await setupCoreNode(1, 2, hre.ethers.parseEther('100000'));
    const sellerB = await setupCoreNode(3, 4, hre.ethers.parseEther('100000'));
    const buyer = accounts[10];
    const sessionKey = newSessionKey();
    const epoch = await ChronosContract.getCurrentEpoch();
    await fund(buyer, hre.ethers.parseEther('10'), sessionKey.address, epoch);

    // Authorization bound to seller A…
    const fields = await makeAuthFields(
      buyer.address,
      sellerA.identityId,
      epoch,
    );
    const { claim } = await signedClaim(sessionKey, fields, 10n);

    // …submitted by seller B: B's identity is packed into the recomputed
    // digest, so recovery yields a stranger address.
    await expect(
      MarketplaceContract.connect(
        sellerB.node.operational,
      ).submitReceiptBatch([claim]),
    ).to.be.revertedWithCustomError(
      MarketplaceContract,
      'InvalidAuthorizationSignature',
    );

    // Seller A itself is accepted — same claim bytes.
    await MarketplaceContract.connect(
      sellerA.node.operational,
    ).submitReceiptBatch([claim]);
  });

  it('rejects expired authorizations, zero/over-max units and foreign session keys', async () => {
    const { node, identityId } = await setupCoreNode(
      1,
      2,
      hre.ethers.parseEther('100000'),
    );
    const buyer = accounts[10];
    const sessionKey = newSessionKey();
    const epoch = await ChronosContract.getCurrentEpoch();
    await fund(buyer, hre.ethers.parseEther('10'), sessionKey.address, epoch);

    // Expired.
    const expired = await makeAuthFields(buyer.address, identityId, epoch, {
      expiry: BigInt(await time.latest()) - 1n,
    });
    const { claim: expiredClaim } = await signedClaim(sessionKey, expired, 10n);
    await expect(
      MarketplaceContract.connect(node.operational).submitReceiptBatch([
        expiredClaim,
      ]),
    ).to.be.revertedWithCustomError(
      MarketplaceContract,
      'AuthorizationExpired',
    );

    // servedUnits > maxUnits.
    const fields = await makeAuthFields(buyer.address, identityId, epoch);
    const { claim: overMax } = await signedClaim(
      sessionKey,
      fields,
      fields.maxUnits + 1n,
    );
    await expect(
      MarketplaceContract.connect(node.operational).submitReceiptBatch([
        overMax,
      ]),
    ).to.be.revertedWithCustomError(MarketplaceContract, 'ServedOverMaxUnits');

    // servedUnits == 0.
    const { claim: zeroUnits } = await signedClaim(sessionKey, fields, 0n);
    await expect(
      MarketplaceContract.connect(node.operational).submitReceiptBatch([
        zeroUnits,
      ]),
    ).to.be.revertedWithCustomError(MarketplaceContract, 'ZeroServedUnits');

    // Signature from a key that is not the buyer's registered session key.
    const strangerKey = newSessionKey();
    const { claim: strangerClaim } = await signedClaim(
      strangerKey,
      fields,
      10n,
    );
    await expect(
      MarketplaceContract.connect(node.operational).submitReceiptBatch([
        strangerClaim,
      ]),
    ).to.be.revertedWithCustomError(
      MarketplaceContract,
      'InvalidAuthorizationSignature',
    );

    // Unfunded bucket.
    const unfunded = await makeAuthFields(
      accounts[11].address,
      identityId,
      epoch,
    );
    const { claim: unfundedClaim } = await signedClaim(
      sessionKey,
      unfunded,
      10n,
    );
    await expect(
      MarketplaceContract.connect(node.operational).submitReceiptBatch([
        unfundedClaim,
      ]),
    ).to.be.revertedWithCustomError(MarketplaceContract, 'BucketNotFunded');

    // Empty batch.
    await expect(
      MarketplaceContract.connect(node.operational).submitReceiptBatch([]),
    ).to.be.revertedWithCustomError(MarketplaceContract, 'EmptyReceiptBatch');
  });

  it('rejects zero-value claims (askPerUnit = 0) — they would brick finalization', async () => {
    const { node, identityId } = await setupCoreNode(
      1,
      2,
      hre.ethers.parseEther('100000'),
    );
    const buyer = accounts[10];
    const sessionKey = newSessionKey();
    const epoch = await ChronosContract.getCurrentEpoch();
    await fund(buyer, hre.ethers.parseEther('10'), sessionKey.address, epoch);

    const fields = await makeAuthFields(buyer.address, identityId, epoch, {
      askPerUnit: 0n,
    });
    const { claim } = await signedClaim(sessionKey, fields, 10n);
    await expect(
      MarketplaceContract.connect(node.operational).submitReceiptBatch([claim]),
    ).to.be.revertedWithCustomError(MarketplaceContract, 'ZeroClaimValue');

    // Nothing accrued and the seller was NOT enrolled in the bucket.
    expect(
      (await MarketplaceContract.getSellerClaim(buyer.address, epoch, identityId))
        .claimed,
    ).to.equal(0n);
    expect(
      await MarketplaceStorageContract.getBucketSellers(buyer.address, epoch),
    ).to.deep.equal([]);
  });

  it('enrolls a seller exactly once: repeated claims never duplicate the finalized weight', async () => {
    const { node, identityId } = await setupCoreNode(
      1,
      2,
      hre.ethers.parseEther('100000'),
    );
    const buyer = accounts[10];
    const sessionKey = newSessionKey();
    const epoch = await ChronosContract.getCurrentEpoch();
    await fund(buyer, hre.ethers.parseEther('10'), sessionKey.address, epoch);

    let totalValue = 0n;
    for (let i = 0; i < 3; i++) {
      const fields = await makeAuthFields(buyer.address, identityId, epoch);
      const { claim } = await signedClaim(sessionKey, fields, 10n);
      await MarketplaceContract.connect(node.operational).submitReceiptBatch([
        claim,
      ]);
      totalValue += 10n * fields.askPerUnit;
    }

    // One membership entry regardless of how many claims accrued.
    expect(
      await MarketplaceStorageContract.getBucketSellers(buyer.address, epoch),
    ).to.deep.equal([identityId]);

    // Finalization credits the seller once (claims < funded → 1:1).
    await warpPastDeadline(epoch);
    await MarketplaceContract.finalizeBucket(buyer.address, epoch, 0);
    const acct = await MarketplaceContract.getNodeEpochAccounting(
      epoch,
      identityId,
    );
    expect(acct.finalizedValue).to.equal(totalValue);
    expect(acct.totalFinalizedValue).to.equal(totalValue);
  });

  it('rejects sellers that are not Core Nodes (no identity / not in sharding table)', async () => {
    const buyer = accounts[10];
    const sessionKey = newSessionKey();
    const epoch = await ChronosContract.getCurrentEpoch();
    await fund(buyer, hre.ethers.parseEther('10'), sessionKey.address, epoch);

    // No identity at all.
    const fields = await makeAuthFields(buyer.address, 1n, epoch);
    const { claim } = await signedClaim(sessionKey, fields, 10n);
    await expect(
      MarketplaceContract.connect(accounts[12]).submitReceiptBatch([claim]),
    ).to.be.revertedWithCustomError(MarketplaceContract, 'NotACoreNode');

    // Identity exists, but the node is not in the sharding table.
    const offTable = {
      operational: accounts[5],
      admin: accounts[6],
    };
    const { identityId } = await createProfile(ProfileContract, offTable);
    const fields2 = await makeAuthFields(
      buyer.address,
      BigInt(identityId),
      epoch,
    );
    const { claim: claim2 } = await signedClaim(sessionKey, fields2, 10n);
    await expect(
      MarketplaceContract.connect(offTable.operational).submitReceiptBatch([
        claim2,
      ]),
    ).to.be.revertedWithCustomError(MarketplaceContract, 'NotACoreNode');
  });

  // --------------------------------------------------------------------------
  // Session key rotation
  // --------------------------------------------------------------------------

  it('session key rotation: historically bound keys keep settling, never-bound keys are rejected', async () => {
    const { node, identityId } = await setupCoreNode(
      1,
      2,
      hre.ethers.parseEther('100000'),
    );
    const buyer = accounts[10];
    const key1 = newSessionKey();
    const key2 = newSessionKey();
    const epoch = await ChronosContract.getCurrentEpoch();
    await fund(buyer, hre.ethers.parseEther('5'), key1.address, epoch);

    // key1 works.
    const fields1 = await makeAuthFields(buyer.address, identityId, epoch);
    const { claim: claim1 } = await signedClaim(key1, fields1, 10n);
    await MarketplaceContract.connect(node.operational).submitReceiptBatch([
      claim1,
    ]);

    // Rotate to key2 (a later funding call carries the new key).
    await expect(
      fund(buyer, hre.ethers.parseEther('5'), key2.address, epoch),
    )
      .to.emit(MarketplaceContract, 'SessionKeyRotated')
      .withArgs(buyer.address, key2.address);
    expect(await MarketplaceContract.activeSessionKey(buyer.address)).to.equal(
      key2.address,
    );
    expect(
      await MarketplaceContract.isSessionKeyBound(buyer.address, key1.address),
    ).to.equal(true);
    expect(
      await MarketplaceContract.isSessionKeyBound(buyer.address, key2.address),
    ).to.equal(true);

    // key1 stays bound: receipts served under it still settle after the
    // rotation (a buyer cannot consume and then rotate to stiff the seller;
    // authorizations stay single-use, seller-bound and expiring).
    const fields2 = await makeAuthFields(buyer.address, identityId, epoch);
    const { claim: servedBeforeRotation } = await signedClaim(
      key1,
      fields2,
      10n,
    );
    await MarketplaceContract.connect(node.operational).submitReceiptBatch([
      servedBeforeRotation,
    ]);

    // key2-signed authorizations are accepted too…
    const fields3 = await makeAuthFields(buyer.address, identityId, epoch);
    const { claim: freshClaim } = await signedClaim(key2, fields3, 10n);
    await MarketplaceContract.connect(node.operational).submitReceiptBatch([
      freshClaim,
    ]);

    // …while a key the buyer never bound is still rejected.
    const neverBound = newSessionKey();
    const fields4 = await makeAuthFields(buyer.address, identityId, epoch);
    const { claim: strangerClaim } = await signedClaim(neverBound, fields4, 10n);
    await expect(
      MarketplaceContract.connect(node.operational).submitReceiptBatch([
        strangerClaim,
      ]),
    ).to.be.revertedWithCustomError(
      MarketplaceContract,
      'InvalidAuthorizationSignature',
    );
  });

  // --------------------------------------------------------------------------
  // Pool rollover
  // --------------------------------------------------------------------------

  it('rollEpochPool: a settled epoch with zero finalized value rolls its pool forward', async () => {
    const buyer = accounts[10];
    const sessionKey = newSessionKey();
    const epoch = await ChronosContract.getCurrentEpoch();
    const amount = hre.ethers.parseEther('3');
    await fund(buyer, amount, sessionKey.address, epoch);

    await warpPastDeadline(epoch);

    // Still gated on every bucket being finalized.
    await expect(
      MarketplaceContract.rollEpochPool(epoch),
    ).to.be.revertedWithCustomError(
      MarketplaceContract,
      'OpenBucketsRemaining',
    );

    // Finalizing a claimless bucket leaves ΣR = 0.
    await MarketplaceContract.finalizeBucket(buyer.address, epoch, 0);
    await expect(
      MarketplaceContract.finalizeBucket(buyer.address, epoch, 0),
    ).to.be.revertedWithCustomError(
      MarketplaceContract,
      'BucketAlreadyFinalized',
    );
    await expect(
      MarketplaceContract.claimEpochReward(1n, epoch),
    ).to.be.revertedWithCustomError(
      MarketplaceContract,
      'NothingFinalizedForEpoch',
    );

    const currentEpoch = await ChronosContract.getCurrentEpoch();
    expect(currentEpoch).to.be.gt(epoch);
    await expect(MarketplaceContract.rollEpochPool(epoch))
      .to.emit(MarketplaceContract, 'EpochPoolRolled')
      .withArgs(epoch, currentEpoch, amount);
    expect(await MarketplaceStorageContract.epochPool(epoch)).to.equal(0n);
    expect(await MarketplaceStorageContract.epochPool(currentEpoch)).to.equal(
      amount,
    );

    await expect(
      MarketplaceContract.rollEpochPool(epoch),
    ).to.be.revertedWithCustomError(MarketplaceContract, 'EmptyEpochPool');
  });

  // --------------------------------------------------------------------------
  // λ_QIF edge values
  // --------------------------------------------------------------------------

  it('λ = 0 rewards purely by finalized value; λ = 1e18 purely by stake-weighted score', async () => {
    // Different conviction tiers → different stake factors → the Q weighting
    // visibly diverges from the R weighting.
    const sellerA = await setupCoreNode(
      1,
      2,
      hre.ethers.parseEther('100000'),
      12, // 6x multiplier
    );
    const sellerB = await setupCoreNode(
      3,
      4,
      hre.ethers.parseEther('400000'),
      0, // rest state, 1x
    );
    const buyer = accounts[10];
    const sessionKey = newSessionKey();
    const epoch = await ChronosContract.getCurrentEpoch();
    const pool = hre.ethers.parseEther('1');
    await fund(buyer, pool, sessionKey.address, epoch);

    const fieldsA = await makeAuthFields(
      buyer.address,
      sellerA.identityId,
      epoch,
    );
    const fieldsB = await makeAuthFields(
      buyer.address,
      sellerB.identityId,
      epoch,
    );
    const { claim: claimA } = await signedClaim(sessionKey, fieldsA, 200n);
    const { claim: claimB } = await signedClaim(sessionKey, fieldsB, 300n);
    await MarketplaceContract.connect(
      sellerA.node.operational,
    ).submitReceiptBatch([claimA]);
    await MarketplaceContract.connect(
      sellerB.node.operational,
    ).submitReceiptBatch([claimB]);

    await warpPastDeadline(epoch);
    await MarketplaceContract.finalizeBucket(buyer.address, epoch, 0);

    const acctA = await MarketplaceContract.getNodeEpochAccounting(
      epoch,
      sellerA.identityId,
    );
    const acctB = await MarketplaceContract.getNodeEpochAccounting(
      epoch,
      sellerB.identityId,
    );

    // λ = 0: QIF_i = R_i/ΣR (18-dec).
    await MarketplaceStorageContract.connect(accounts[0]).setLambdaQif18(0);
    const rShareA =
      (SCALE18 * acctA.finalizedValue) / acctA.totalFinalizedValue;
    const rShareB =
      (SCALE18 * acctB.finalizedValue) / acctB.totalFinalizedValue;
    expect(
      await MarketplaceContract.getQif18(epoch, sellerA.identityId),
    ).to.equal(rShareA);
    expect(
      await MarketplaceContract.getQif18(epoch, sellerB.identityId),
    ).to.equal(rShareB);

    // λ = 1e18: QIF_i = Q_i/ΣQ (18-dec).
    await MarketplaceStorageContract.connect(accounts[0]).setLambdaQif18(
      SCALE18,
    );
    const qShareA = (SCALE18 * acctA.qiScore) / acctA.totalQiScore;
    const qShareB = (SCALE18 * acctB.qiScore) / acctB.totalQiScore;
    expect(
      await MarketplaceContract.getQif18(epoch, sellerA.identityId),
    ).to.equal(qShareA);
    expect(
      await MarketplaceContract.getQif18(epoch, sellerB.identityId),
    ).to.equal(qShareB);

    // The two weightings genuinely differ (A's 6x conviction boosts its Q
    // share above its R share).
    expect(qShareA).to.be.gt(rShareA);
    expect(qShareB).to.be.lt(rShareB);

    // Payout under λ = 1e18 follows the Q share.
    const rewardA = (pool * qShareA) / SCALE18;
    const balanceBefore = await TokenContract.balanceOf(
      sellerA.node.operational.address,
    );
    await MarketplaceContract.connect(
      sellerA.node.operational,
    ).claimEpochReward(sellerA.identityId, epoch);
    expect(
      await TokenContract.balanceOf(sellerA.node.operational.address),
    ).to.equal(balanceBefore + rewardA);
  });

  // --------------------------------------------------------------------------
  // Settlement-window gating
  // --------------------------------------------------------------------------

  it('gates finalization/rewards on the deadline and open buckets; closes claims after it', async () => {
    const { node, identityId } = await setupCoreNode(
      1,
      2,
      hre.ethers.parseEther('100000'),
    );
    const buyer = accounts[10];
    const otherBuyer = accounts[11];
    const sessionKey = newSessionKey();
    const otherKey = newSessionKey();
    const epoch = await ChronosContract.getCurrentEpoch();
    await fund(buyer, hre.ethers.parseEther('2'), sessionKey.address, epoch);
    await fund(otherBuyer, hre.ethers.parseEther('2'), otherKey.address, epoch);

    const fields = await makeAuthFields(buyer.address, identityId, epoch);
    const { claim } = await signedClaim(sessionKey, fields, 10n);
    await MarketplaceContract.connect(node.operational).submitReceiptBatch([
      claim,
    ]);

    // Before the deadline: no finalization, no rewards.
    await expect(
      MarketplaceContract.finalizeBucket(buyer.address, epoch, 0),
    ).to.be.revertedWithCustomError(MarketplaceContract, 'SettlementStillOpen');
    await expect(
      MarketplaceContract.connect(node.operational).claimEpochReward(
        identityId,
        epoch,
      ),
    ).to.be.revertedWithCustomError(MarketplaceContract, 'SettlementStillOpen');

    await warpPastDeadline(epoch);

    // After the deadline: no new receipt claims…
    const lateFields = await makeAuthFields(buyer.address, identityId, epoch, {
      expiry: BigInt(await time.latest()) + 3_600n,
    });
    const { claim: lateClaim } = await signedClaim(sessionKey, lateFields, 1n);
    await expect(
      MarketplaceContract.connect(node.operational).submitReceiptBatch([
        lateClaim,
      ]),
    ).to.be.revertedWithCustomError(MarketplaceContract, 'SettlementClosed');

    // …and rewards stay gated while ANY bucket of the epoch is open.
    await MarketplaceContract.finalizeBucket(buyer.address, epoch, 0);
    await expect(
      MarketplaceContract.connect(node.operational).claimEpochReward(
        identityId,
        epoch,
      ),
    ).to.be.revertedWithCustomError(MarketplaceContract, 'OpenBucketsRemaining');

    await MarketplaceContract.finalizeBucket(otherBuyer.address, epoch, 0);

    // Only an operational wallet of the identity can claim.
    await expect(
      MarketplaceContract.connect(accounts[12]).claimEpochReward(
        identityId,
        epoch,
      ),
    ).to.be.revertedWithCustomError(
      MarketplaceContract,
      'NotOperationalWallet',
    );
    await MarketplaceContract.connect(node.operational).claimEpochReward(
      identityId,
      epoch,
    );
  });

  it('a finalized bucket accepts no claims — even when a grace increase re-opens the window', async () => {
    const { node, identityId } = await setupCoreNode(
      1,
      2,
      hre.ethers.parseEther('100000'),
    );
    const buyer = accounts[10];
    const sessionKey = newSessionKey();
    const epoch = await ChronosContract.getCurrentEpoch();
    await fund(buyer, hre.ethers.parseEther('2'), sessionKey.address, epoch);

    const fields = await makeAuthFields(buyer.address, identityId, epoch);
    const { claim } = await signedClaim(sessionKey, fields, 10n);
    await MarketplaceContract.connect(node.operational).submitReceiptBatch([
      claim,
    ]);

    await warpPastDeadline(epoch);
    await MarketplaceContract.finalizeBucket(buyer.address, epoch, 0);

    // Governance bumps the grace period AFTER finalization: the settlement
    // window is time-open again, but the finalized bucket stays closed.
    const grace = await MarketplaceStorageContract.settlementGraceSeconds();
    await MarketplaceStorageContract.connect(accounts[0]).setSettlementGraceSeconds(
      grace + (await ChronosContract.epochLength()) * 10n,
    );
    const reopenedDeadline = await MarketplaceContract.settlementDeadline(epoch);
    expect(reopenedDeadline).to.be.gt(BigInt(await time.latest()));

    const lateFields = await makeAuthFields(buyer.address, identityId, epoch, {
      expiry: BigInt(await time.latest()) + 3_600n,
    });
    const { claim: lateClaim } = await signedClaim(sessionKey, lateFields, 1n);
    await expect(
      MarketplaceContract.connect(node.operational).submitReceiptBatch([
        lateClaim,
      ]),
    ).to.be.revertedWithCustomError(
      MarketplaceContract,
      'ClaimsClosedForBucket',
    );
  });

  // --------------------------------------------------------------------------
  // Reward cap (wash-trading guard)
  // --------------------------------------------------------------------------

  it('claimEpochReward pays min(pool·QIF, rewardCapMultiple·R_i) and tracks the remainder', async () => {
    const { node, identityId } = await setupCoreNode(
      1,
      2,
      hre.ethers.parseEther('100000'),
    );
    const buyer = accounts[10];
    const sessionKey = newSessionKey();
    const epoch = await ChronosContract.getCurrentEpoch();
    const pool = hre.ethers.parseEther('10');
    await fund(buyer, pool, sessionKey.address, epoch);

    // Tiny finalized value in a big pool: the sole claimant's uncapped QIF
    // reward would sweep the whole pool.
    const fields = await makeAuthFields(buyer.address, identityId, epoch);
    const served = 10n;
    const { claim } = await signedClaim(sessionKey, fields, served);
    await MarketplaceContract.connect(node.operational).submitReceiptBatch([
      claim,
    ]);
    const finalizedValue = served * fields.askPerUnit;

    await warpPastDeadline(epoch);
    await MarketplaceContract.finalizeBucket(buyer.address, epoch, 0);
    expect(await MarketplaceContract.getQif18(epoch, identityId)).to.equal(
      SCALE18,
    );

    // Default cap multiple 10: payout = 10 · R_i, not the pool.
    const cappedReward = 10n * finalizedValue;
    expect(cappedReward).to.be.lt(pool);
    const balanceBefore = await TokenContract.balanceOf(
      node.operational.address,
    );
    await expect(
      MarketplaceContract.connect(node.operational).claimEpochReward(
        identityId,
        epoch,
      ),
    )
      .to.emit(MarketplaceContract, 'EpochRewardClaimed')
      .withArgs(epoch, identityId, node.operational.address, cappedReward);
    expect(await TokenContract.balanceOf(node.operational.address)).to.equal(
      balanceBefore + cappedReward,
    );

    // The undistributed remainder stays in the contract and is reported.
    const [reportedPool, distributed, undistributed] =
      await MarketplaceContract.getEpochRewardDistribution(epoch);
    expect(reportedPool).to.equal(pool);
    expect(distributed).to.equal(cappedReward);
    expect(undistributed).to.equal(pool - cappedReward);
  });

  it('rewardCapMultiple = 0 leaves the QIF payout uncapped', async () => {
    const { node, identityId } = await setupCoreNode(
      1,
      2,
      hre.ethers.parseEther('100000'),
    );
    await MarketplaceStorageContract.connect(accounts[0]).setRewardCapMultiple(
      0,
    );
    const buyer = accounts[10];
    const sessionKey = newSessionKey();
    const epoch = await ChronosContract.getCurrentEpoch();
    const pool = hre.ethers.parseEther('10');
    await fund(buyer, pool, sessionKey.address, epoch);

    const fields = await makeAuthFields(buyer.address, identityId, epoch);
    const { claim } = await signedClaim(sessionKey, fields, 10n);
    await MarketplaceContract.connect(node.operational).submitReceiptBatch([
      claim,
    ]);

    await warpPastDeadline(epoch);
    await MarketplaceContract.finalizeBucket(buyer.address, epoch, 0);

    // Sole claimant, uncapped: the whole pool, exactly the pre-cap behavior.
    await expect(
      MarketplaceContract.connect(node.operational).claimEpochReward(
        identityId,
        epoch,
      ),
    )
      .to.emit(MarketplaceContract, 'EpochRewardClaimed')
      .withArgs(epoch, identityId, node.operational.address, pool);
    const [, distributed, undistributed] =
      await MarketplaceContract.getEpochRewardDistribution(epoch);
    expect(distributed).to.equal(pool);
    expect(undistributed).to.equal(0n);
  });
});
