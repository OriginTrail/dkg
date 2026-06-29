// Standalone V10 Publishing Conviction NFT lifecycle: create → topUp →
// registerAgent → deregisterAgent → settle, plus the discounted publish
// path through a real KnowledgeAssetsLifecycle.publish() and the post-expiry
// revert. Peer of test/v10-e2e-conviction.test.ts (Flow 3).

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionStakingStorage,
  ContextGraphs,
  ContextGraphStorage,
  ContextGraphValueStorage,
  DKGPublishingConvictionNFT,
  DKGStakingConvictionNFT,
  EpochStorage,
  Hub,
  KnowledgeAssetsLifecycle,
  DKGKnowledgeAssets,
  ParametersStorage,
  Profile,
  PublishingConviction,
  StakingV10,
  Token,
} from '../typechain';
import { createProfile, createProfiles } from './helpers/profile-helpers';
import {
  getDefaultKACreator,
  getDefaultPublishingNode,
  getDefaultReceivingNodes,
} from './helpers/setup-helpers';
import {
  buildPublishParams,
  buildUpdateParams,
  packReservedKaId,
  DEFAULT_CHAIN_ID,
} from './helpers/v10-ka-helpers';

const COMMITTED_TRAC = ethers.parseEther('50000'); // 20% discount tier
const EXPECTED_DISCOUNT_BPS = 2000n;
const STAKER_SHARD_ID = 1n;
const MIN_STAKE = ethers.parseEther('50000');

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  Token: Token;
  Chronos: Chronos;
  Profile: Profile;
  ConvictionStakingStorage: ConvictionStakingStorage;
  StakingV10: StakingV10;
  StakingNFT: DKGStakingConvictionNFT;
  KnowledgeAssetsLifecycle: KnowledgeAssetsLifecycle;
  DKGKnowledgeAssets: DKGKnowledgeAssets;
  EpochStorage: EpochStorage;
  ContextGraphs: ContextGraphs;
  ContextGraphStorage: ContextGraphStorage;
  NFT: DKGPublishingConvictionNFT;
  PublishingConviction: PublishingConviction;
};

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
    ConvictionStakingStorage:
      await hre.ethers.getContract<ConvictionStakingStorage>(
        'ConvictionStakingStorage',
      ),
    StakingV10: await hre.ethers.getContract<StakingV10>('StakingV10'),
    StakingNFT: await hre.ethers.getContract<DKGStakingConvictionNFT>(
      'DKGStakingConvictionNFT',
    ),
    KnowledgeAssetsLifecycle: await hre.ethers.getContract<KnowledgeAssetsLifecycle>(
      'KnowledgeAssetsLifecycle',
    ),
    DKGKnowledgeAssets:
      await hre.ethers.getContract<DKGKnowledgeAssets>(
        'DKGKnowledgeAssets',
      ),
    EpochStorage: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
    ContextGraphs: await hre.ethers.getContract<ContextGraphs>('ContextGraphs'),
    ContextGraphStorage:
      await hre.ethers.getContract<ContextGraphStorage>('ContextGraphStorage'),
    NFT: await hre.ethers.getContract<DKGPublishingConvictionNFT>(
      'DKGPublishingConvictionNFT',
    ),
    PublishingConviction:
      await hre.ethers.getContract<PublishingConviction>(
        'PublishingConviction',
      ),
  };
}

describe('@integration V10 PCA lifecycle (DKGPublishingConvictionNFT)', function () {
  let accounts: SignerWithAddress[];
  let Token: Token;
  let HubContract: Hub;
  let Chronos: Chronos;
  let ProfileContract: Profile;
  let ConvictionStakingStorage: ConvictionStakingStorage;
  let StakingV10Contract: StakingV10;
  let StakingNFT: DKGStakingConvictionNFT;
  let KAV10: KnowledgeAssetsLifecycle;
  let DKGKnowledgeAssets: DKGKnowledgeAssets;
  let EpochStorageContract: EpochStorage;
  let CGFacade: ContextGraphs;
  let CGS: ContextGraphStorage;
  let NFT: DKGPublishingConvictionNFT;
  let LogicContract: PublishingConviction;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      Hub: HubContract,
      Token,
      Chronos,
      Profile: ProfileContract,
      ConvictionStakingStorage,
      StakingV10: StakingV10Contract,
      StakingNFT,
      KnowledgeAssetsLifecycle: KAV10,
      DKGKnowledgeAssets,
      EpochStorage: EpochStorageContract,
      ContextGraphs: CGFacade,
      ContextGraphStorage: CGS,
      NFT,
      PublishingConviction: LogicContract,
    } = await loadFixture(deployFixture));
  });

  afterEach(async () => {
    // Flow-through invariant: the NFT contract must NEVER custody TRAC.
    expect(await Token.balanceOf(await NFT.getAddress())).to.equal(0n);
  });

  // Mint + fund a fresh conviction account owned by `owner`.
  const createAccountFor = async (
    owner: SignerWithAddress,
  ): Promise<bigint> => {
    await Token.mint(owner.address, COMMITTED_TRAC);
    await Token.connect(owner).approve(await NFT.getAddress(), COMMITTED_TRAC);
    // RFC-51: createAccount(committedTRAC, primaryNode). These lifecycle
    // assertions don't exercise publishing-allocation seeding, so pass an
    // inert primaryNode = 0 (no designated node, no allocation seeded).
    await NFT.connect(owner).createAccount(COMMITTED_TRAC, 0);
    return NFT.totalSupply();
  };

  // --------------------------------------------------------------------------
  // 1. create → topUp → registerAgent → deregisterAgent → settle
  // --------------------------------------------------------------------------
  it('asserts on-chain state across create/topUp/registerAgent/deregisterAgent/settle', async () => {
    const creator = getDefaultKACreator(accounts);
    const agent = accounts[8];
    const stranger = accounts[7];

    // ---- createAccount ----
    const accountId = await createAccountFor(creator);
    expect(accountId).to.equal(1n);
    expect(await NFT.ownerOf(accountId)).to.equal(creator.address);
    let info = await NFT.getAccountInfo(accountId);
    expect(info.committedTRAC).to.equal(COMMITTED_TRAC);
    expect(info.discountBps).to.equal(EXPECTED_DISCOUNT_BPS);
    expect(info.topUpBuffer).to.equal(0n);
    expect(info.agentCount).to.equal(0n);
    expect(info.fullySwept).to.equal(false);
    const expiresAtEpochAtCreate = info.expiresAtEpoch;

    // ---- topUp (owner-gated, does not move committedTRAC/expiry) ----
    const top = ethers.parseEther('1000');
    await Token.mint(creator.address, top);
    await Token.connect(creator).approve(await NFT.getAddress(), top);
    await expect(NFT.connect(creator).topUp(accountId, top))
      .to.emit(LogicContract, 'ToppedUp')
      .withArgs(accountId, top, top);
    info = await NFT.getAccountInfo(accountId);
    expect(info.topUpBuffer).to.equal(top);
    expect(info.committedTRAC).to.equal(COMMITTED_TRAC);
    expect(info.expiresAtEpoch).to.equal(expiresAtEpochAtCreate);

    // Owner-gating invariant: a non-owner write must propagate the revert.
    await expect(
      NFT.connect(stranger).topUp(accountId, top),
    ).to.be.revertedWithCustomError(NFT, 'NotAccountOwner');

    // ---- registerAgent ----
    await expect(NFT.connect(creator).registerAgent(accountId, agent.address))
      .to.emit(LogicContract, 'AgentRegistered')
      .withArgs(accountId, agent.address);
    expect(await NFT.isAgent(accountId, agent.address)).to.equal(true);
    expect(await NFT.agentToAccountId(agent.address)).to.equal(accountId);
    expect((await NFT.getAccountInfo(accountId)).agentCount).to.equal(1n);
    await expect(
      NFT.connect(stranger).registerAgent(accountId, stranger.address),
    ).to.be.revertedWithCustomError(NFT, 'NotAccountOwner');

    // ---- deregisterAgent ----
    await expect(NFT.connect(creator).deregisterAgent(accountId, agent.address))
      .to.emit(LogicContract, 'AgentDeregistered')
      .withArgs(accountId, agent.address);
    expect(await NFT.isAgent(accountId, agent.address)).to.equal(false);
    expect(await NFT.agentToAccountId(agent.address)).to.equal(0n);
    expect((await NFT.getAccountInfo(accountId)).agentCount).to.equal(0n);

    // ---- settle: one elapsed window advances the lazy-settlement cursor ----
    const epochLength = await Chronos.epochLength();
    await time.increase(Number(epochLength));
    await NFT.connect(stranger).settle(accountId); // permissionless
    expect((await NFT.getAccountInfo(accountId)).lastSettledWindow).to.equal(
      1n,
    );

    // ---- settle: post-expiry final sweep marks the account fully swept ----
    const acct = await NFT.accounts(accountId);
    const lockDurationEpochs = acct[5];
    await time.increase(Number(epochLength) * (Number(lockDurationEpochs) + 1));
    await expect(NFT.connect(stranger).settle(accountId)).to.emit(
      LogicContract,
      'AccountFinalSwept',
    );
    expect((await NFT.getAccountInfo(accountId)).fullySwept).to.equal(true);
  });

  // V10 ACK signer gate reads `getNodeStakeV10`; bring nodes' V10 stake
  // above zero via the conviction-staking NFT path.
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

  // Stand up publisher + receiver profiles (V10-staked for the ACK signer
  // gate), a fresh registered conviction agent, and an open context graph.
  // Returns everything `buildPublishParams` needs plus the account's
  // `lockDurationEpochs` (the discount-branch epoch count).
  const setupRegisteredAgentPublish = async () => {
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts);
    const { identityId: publisherIdentityId } = await createProfile(
      ProfileContract,
      publishingNode,
    );
    const receiverProfiles = await createProfiles(
      ProfileContract,
      receivingNodes,
    );
    const receiverIdentityIds = receiverProfiles.map((p) => p.identityId);

    await stakeV10(publishingNode.operational, publisherIdentityId, MIN_STAKE);
    for (let i = 0; i < receivingNodes.length; i++) {
      await stakeV10(
        receivingNodes[i].operational,
        receiverProfiles[i].identityId,
        MIN_STAKE,
      );
    }

    const creator = getDefaultKACreator(accounts);
    const accountId = await createAccountFor(creator);
    await NFT.connect(creator).registerAgent(accountId, creator.address);
    expect(await NFT.agentToAccountId(creator.address)).to.equal(accountId);

    await CGFacade.connect(creator).createContextGraph(
      [],
      0,
      0,
      1,
      ethers.ZeroAddress,
      0,
      ethers.ZeroHash,
    );
    const cgId = await CGS.getLatestContextGraphId();
    expect(await CGFacade.isAuthorizedPublisher(cgId, creator.address)).to.be
      .true;

    // Discount branch requires p.epochs == lockDurationEpochs.
    const epochs = Number((await NFT.accounts(accountId))[5]);
    return {
      creator,
      accountId,
      cgId,
      epochs,
      receivingNodes,
      publisherIdentityId,
      receiverIdentityIds,
    };
  };

  const createCuratedContextGraphFor = async (
    creator: SignerWithAddress,
  ): Promise<bigint> => {
    await CGFacade.connect(creator).createContextGraph(
      [],
      0,
      1,
      0,
      creator.address,
      0,
      ethers.ZeroHash,
    );
    const cgId = await CGS.getLatestContextGraphId();
    expect(await CGS.getIsCurated(cgId)).to.equal(true);
    expect(await CGFacade.isAuthorizedPublisher(cgId, creator.address)).to.be
      .true;
    return cgId;
  };

  // --------------------------------------------------------------------------
  // OT-RFC-53 — publishing into a funded CG spends the registration escrow first
  // --------------------------------------------------------------------------
  it('OT-RFC-53: a publish into the owner-funded CG draws the registration escrow before the wallet/PCA', async () => {
    const Params = await hre.ethers.getContract<ParametersStorage>(
      'ParametersStorage',
    );
    const deposit = ethers.parseEther('100');
    await Params.connect(accounts[0]).setContextGraphRegistrationDeposit(deposit);

    // Fund the creator's deposit allowance to the CG facade BEFORE setup —
    // `setupRegisteredAgentPublish` creates the CG as the creator, which now
    // pulls the deposit.
    const creator = getDefaultKACreator(accounts);
    await Token.mint(creator.address, deposit);
    await Token.connect(creator).approve(await CGFacade.getAddress(), deposit);

    const { cgId, epochs, receivingNodes, publisherIdentityId, receiverIdentityIds } =
      await setupRegisteredAgentPublish();

    // The deposit became the CG's prepaid escrow.
    expect(await CGS.getRegistrationEscrow(cgId)).to.equal(deposit);

    const tokenAmount = ethers.parseEther('1000');
    const p = await buildPublishParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes,
      publisherIdentityId,
      receiverIdentityIds,
      author: creator,
      contextGraphId: cgId,
      merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('rfc53-consume')),
      knowledgeAssetsAmount: 1,
      byteSize: 1000,
      epochs,
      tokenAmount,
      isImmutable: false,
      publishOperationId: 'rfc53-consume-op',
      reservedKaId: packReservedKaId(creator.address, 1),
    });

    // Escrow (100) is drawn first; the 900 remainder flows through the PCA
    // discount branch. Assert BOTH the consume event AND that the staker pool
    // received only escrow-gross(100) + discounted-remainder(720) = 820 — NOT
    // the discounted FULL amount (800 → pool 900) a "consume-but-still-charge-
    // full-tokenAmount" regression would produce.
    const tx = await KAV10.connect(creator).publish(p);
    const receipt = await tx.wait();
    await expect(tx).to.emit(KAV10, 'RegistrationEscrowConsumed').withArgs(cgId, deposit);

    const remainder = tokenAmount - deposit; // 900
    const discountedRemainder = (remainder * (10_000n - EXPECTED_DISCOUNT_BPS)) / 10_000n; // 720
    const expectedPool = deposit + discountedRemainder; // gross escrow 100 + 720 = 820
    const epochStorageAddr = (await EpochStorageContract.getAddress()).toLowerCase();
    let poolSum = 0n;
    for (const log of receipt!.logs) {
      if (log.address.toLowerCase() !== epochStorageAddr) continue;
      try {
        const parsed = EpochStorageContract.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (parsed?.name === 'TokensAddedToEpochRange' && BigInt(parsed.args.shardId) === STAKER_SHARD_ID) {
          poolSum += BigInt(parsed.args.tokenAmount);
        }
      } catch {
        /* not the event we're after */
      }
    }
    expect(poolSum).to.equal(expectedPool);

    // Escrow fully consumed (1000 > 100).
    expect(await CGS.getRegistrationEscrow(cgId)).to.equal(0n);
  });

  // --------------------------------------------------------------------------
  // OT-RFC-53 — escrow-funded publishing pays the protocol treasury fee at CONSUME
  // (parity with the wallet path; no fee-bypass loophole when treasury is live)
  // --------------------------------------------------------------------------
  it('OT-RFC-53: an escrow-funded publish pays the treasury fee at consume (net→stakers, fee→treasury)', async () => {
    const Params = await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
    const CSS = await hre.ethers.getContract<ConvictionStakingStorage>('ConvictionStakingStorage');
    const deposit = ethers.parseEther('100');
    await Params.connect(accounts[0]).setContextGraphRegistrationDeposit(deposit);

    // Switch the treasury fee from dormant → live by wiring a recipient (the 3%
    // rate is the constructor default; `_treasuryFee` is a no-op until this is set).
    const treasury = accounts[9].address;
    await Params.connect(accounts[0]).setProtocolTreasury(treasury);
    const feeBps = await Params.protocolTreasuryFee(); // 300 = 3%
    expect(feeBps).to.be.greaterThan(0n);

    const creator = getDefaultKACreator(accounts);
    await Token.mint(creator.address, deposit);
    await Token.connect(creator).approve(await CGFacade.getAddress(), deposit);

    const { cgId, epochs, receivingNodes, publisherIdentityId, receiverIdentityIds } =
      await setupRegisteredAgentPublish();
    expect(await CGS.getRegistrationEscrow(cgId)).to.equal(deposit);

    // tokenAmount == deposit: escrow covers the WHOLE publish (walletCost 0), so the
    // publish early-returns before the wallet/PCA branch — isolating the escrow fee.
    const tokenAmount = deposit;
    const expectedFee = (tokenAmount * feeBps) / 10_000n; // 3 TRAC
    const expectedNet = tokenAmount - expectedFee; // 97 TRAC
    const treasuryBefore = await Token.balanceOf(treasury);

    const p = await buildPublishParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes,
      publisherIdentityId,
      receiverIdentityIds,
      author: creator,
      contextGraphId: cgId,
      merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('rfc53-escrow-fee')),
      knowledgeAssetsAmount: 1,
      byteSize: 1000,
      epochs,
      tokenAmount,
      isImmutable: false,
      publishOperationId: 'rfc53-escrow-fee-op',
      reservedKaId: packReservedKaId(creator.address, 1),
    });

    const tx = await KAV10.connect(creator).publish(p);
    const receipt = await tx.wait();

    // Escrow consumed in full; its treasury fee routed out of the vault.
    await expect(tx).to.emit(KAV10, 'RegistrationEscrowConsumed').withArgs(cgId, deposit);
    await expect(tx).to.emit(CSS, 'RegistrationDepositFeeTransferred').withArgs(treasury, expectedFee);

    // Treasury received exactly the fee; staker pool received only the NET (not gross).
    expect((await Token.balanceOf(treasury)) - treasuryBefore).to.equal(expectedFee);

    const epochStorageAddr = (await EpochStorageContract.getAddress()).toLowerCase();
    let poolSum = 0n;
    for (const log of receipt!.logs) {
      if (log.address.toLowerCase() !== epochStorageAddr) continue;
      try {
        const parsed = EpochStorageContract.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (parsed?.name === 'TokensAddedToEpochRange' && BigInt(parsed.args.shardId) === STAKER_SHARD_ID) {
          poolSum += BigInt(parsed.args.tokenAmount);
        }
      } catch {
        /* not the event we're after */
      }
    }
    expect(poolSum).to.equal(expectedNet);
    expect(await CGS.getRegistrationEscrow(cgId)).to.equal(0n);
  });

  // --------------------------------------------------------------------------
  // OT-RFC-53 — lifetime extension also draws the registration escrow
  // --------------------------------------------------------------------------
  it('OT-RFC-53: extending a KA in an owner-funded CG draws the escrow (extension path)', async () => {
    const Params = await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
    const deposit = ethers.parseEther('2000'); // large enough to survive a publish + cover the extend
    await Params.connect(accounts[0]).setContextGraphRegistrationDeposit(deposit);

    const creator = getDefaultKACreator(accounts);
    await Token.mint(creator.address, deposit);
    await Token.connect(creator).approve(await CGFacade.getAddress(), deposit);

    const { cgId, epochs, receivingNodes, publisherIdentityId, receiverIdentityIds } =
      await setupRegisteredAgentPublish();
    expect(await CGS.getRegistrationEscrow(cgId)).to.equal(deposit);

    // Publish a KA (escrow covers it: 2000 → 1000).
    const pubAmount = ethers.parseEther('1000');
    const reservedKaId = packReservedKaId(creator.address, 1);
    const p = await buildPublishParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes,
      publisherIdentityId,
      receiverIdentityIds,
      author: creator,
      contextGraphId: cgId,
      merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('rfc53-extend')),
      knowledgeAssetsAmount: 1,
      byteSize: 1000,
      epochs,
      tokenAmount: pubAmount,
      isImmutable: false,
      publishOperationId: 'rfc53-extend-pub',
      reservedKaId,
    });
    await KAV10.connect(creator).publish(p);
    expect(await CGS.getRegistrationEscrow(cgId)).to.equal(deposit - pubAmount); // 1000 left

    // Owner extends the KA — a DIFFERENT consume path (extension window
    // endEpoch..endEpoch+epochs, direct distribution). Escrow covers it: 1000 → 0.
    const extendAmount = ethers.parseEther('1000');
    await expect(
      KAV10.connect(creator).extendKnowledgeAssetLifetime(reservedKaId, epochs, extendAmount),
    )
      .to.emit(KAV10, 'RegistrationEscrowConsumed')
      .withArgs(cgId, extendAmount);
    expect(await CGS.getRegistrationEscrow(cgId)).to.equal(deposit - pubAmount - extendAmount); // 0
  });

  // --------------------------------------------------------------------------
  // #1264-batch — extend funds the staker pool over [endEpoch+1, endEpoch+epochs]
  // (NOT [endEpoch, endEpoch+epochs]). The prior range double-funded `endEpoch`
  // (already funded by the original publish THROUGH endEpoch inclusive) and paid
  // one epoch past the purchased lifetime. Deltas isolate the extension from any
  // other shard-1 funding present in the fixture.
  // --------------------------------------------------------------------------
  it('extend funds [endEpoch+1, endEpoch+epochs] and does NOT double-fund endEpoch', async () => {
    const Params = await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
    const ES = await hre.ethers.getContract<EpochStorage>('EpochStorageV8');
    const KAS = await hre.ethers.getContract<DKGKnowledgeAssets>('DKGKnowledgeAssets');
    const deposit = ethers.parseEther('2000');
    await Params.connect(accounts[0]).setContextGraphRegistrationDeposit(deposit);

    const creator = getDefaultKACreator(accounts);
    await Token.mint(creator.address, deposit);
    await Token.connect(creator).approve(await CGFacade.getAddress(), deposit);

    const { cgId, epochs, receivingNodes, publisherIdentityId, receiverIdentityIds } =
      await setupRegisteredAgentPublish();

    const pubAmount = ethers.parseEther('1000');
    const reservedKaId = packReservedKaId(creator.address, 1);
    const p = await buildPublishParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes,
      publisherIdentityId,
      receiverIdentityIds,
      author: creator,
      contextGraphId: cgId,
      merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('extend-epoch-range')),
      knowledgeAssetsAmount: 1,
      byteSize: 1000,
      epochs,
      tokenAmount: pubAmount,
      isImmutable: false,
      publishOperationId: 'extend-epoch-range-pub',
      reservedKaId,
    });
    await KAV10.connect(creator).publish(p);

    // endEpoch as stored by publish (= currentEpoch + epochs). Tuple index 5:
    // (, , , byteSize, , endEpoch, tokenAmount, ).
    const meta = await KAS.getKnowledgeAssetMetadata(reservedKaId);
    const endEpoch = BigInt(meta[5]);
    const last = endEpoch + BigInt(epochs); // the NEW endEpoch after the extension

    // Snapshot the per-epoch staker pool (shard 1) BEFORE the extend, so deltas
    // isolate the extension's contribution from any other fixture funding.
    const before = {
      end: await ES.getEpochPool(1, endEpoch),
      endPlus1: await ES.getEpochPool(1, endEpoch + 1n),
      last: await ES.getEpochPool(1, last),
      lastPlus1: await ES.getEpochPool(1, last + 1n),
    };

    const extendAmount = ethers.parseEther('1000');
    await KAV10.connect(creator).extendKnowledgeAssetLifetime(reservedKaId, epochs, extendAmount);

    // DECISIVE: endEpoch is NOT re-funded by the extension (no double-fund).
    expect(await ES.getEpochPool(1, endEpoch)).to.equal(
      before.end,
      'extend must not double-fund endEpoch',
    );
    // The extension funds its window start (endEpoch+1) ...
    expect(await ES.getEpochPool(1, endEpoch + 1n)).to.be.gt(
      before.endPlus1,
      'extend must fund endEpoch+1',
    );
    // ... through the new endEpoch (endEpoch+epochs) ...
    expect(await ES.getEpochPool(1, last)).to.be.gt(
      before.last,
      'extend must fund through endEpoch+epochs',
    );
    // ... and NOT one epoch past the purchased lifetime.
    expect(await ES.getEpochPool(1, last + 1n)).to.equal(
      before.lastPlus1,
      'extend must not fund past endEpoch+epochs',
    );
  });

  it('extend (WALLET-funded, escrow drained) funds [endEpoch+1, endEpoch+epochs] too', async () => {
    // Sets the deposit == pubAmount so the PUBLISH drains the escrow to 0; the
    // EXTENSION is then fully wallet-funded, exercising the `walletCost`
    // addTokensToEpochRange branch (the test above only covers `netEscrow`).
    const Params = await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
    const ES = await hre.ethers.getContract<EpochStorage>('EpochStorageV8');
    const KAS = await hre.ethers.getContract<DKGKnowledgeAssets>('DKGKnowledgeAssets');
    const pubAmount = ethers.parseEther('1000');
    const extendAmount = ethers.parseEther('1000');
    await Params.connect(accounts[0]).setContextGraphRegistrationDeposit(pubAmount);

    const creator = getDefaultKACreator(accounts);
    await Token.mint(creator.address, pubAmount + extendAmount);
    await Token.connect(creator).approve(await CGFacade.getAddress(), pubAmount); // escrow pull at create
    await Token.connect(creator).approve(await KAV10.getAddress(), extendAmount); // wallet pull at extend

    const { cgId, epochs, receivingNodes, publisherIdentityId, receiverIdentityIds } =
      await setupRegisteredAgentPublish();

    const reservedKaId = packReservedKaId(creator.address, 1);
    const p = await buildPublishParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes,
      publisherIdentityId,
      receiverIdentityIds,
      author: creator,
      contextGraphId: cgId,
      merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('extend-wallet-range')),
      knowledgeAssetsAmount: 1,
      byteSize: 1000,
      epochs,
      tokenAmount: pubAmount,
      isImmutable: false,
      publishOperationId: 'extend-wallet-range-pub',
      reservedKaId,
    });
    await KAV10.connect(creator).publish(p);
    expect(await CGS.getRegistrationEscrow(cgId)).to.equal(0n); // publish drained escrow → extend is wallet-funded

    const meta = await KAS.getKnowledgeAssetMetadata(reservedKaId);
    const endEpoch = BigInt(meta[5]);
    const last = endEpoch + BigInt(epochs);
    const before = {
      end: await ES.getEpochPool(1, endEpoch),
      endPlus1: await ES.getEpochPool(1, endEpoch + 1n),
      lastPlus1: await ES.getEpochPool(1, last + 1n),
    };

    await KAV10.connect(creator).extendKnowledgeAssetLifetime(reservedKaId, epochs, extendAmount);

    expect(await ES.getEpochPool(1, endEpoch)).to.equal(before.end, 'wallet extend must not double-fund endEpoch');
    expect(await ES.getEpochPool(1, endEpoch + 1n)).to.be.gt(before.endPlus1, 'wallet extend must fund endEpoch+1');
    expect(await ES.getEpochPool(1, last + 1n)).to.equal(before.lastPlus1, 'wallet extend must not fund past endEpoch+epochs');
  });

  it('extend reverts ZeroEpochs on a zero-epoch extension (no arithmetic panic)', async () => {
    const Params = await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
    const deposit = ethers.parseEther('2000');
    await Params.connect(accounts[0]).setContextGraphRegistrationDeposit(deposit);
    const creator = getDefaultKACreator(accounts);
    await Token.mint(creator.address, deposit);
    await Token.connect(creator).approve(await CGFacade.getAddress(), deposit);

    const { cgId, epochs, receivingNodes, publisherIdentityId, receiverIdentityIds } =
      await setupRegisteredAgentPublish();
    const reservedKaId = packReservedKaId(creator.address, 1);
    const p = await buildPublishParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes,
      publisherIdentityId,
      receiverIdentityIds,
      author: creator,
      contextGraphId: cgId,
      merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('extend-zero-epochs')),
      knowledgeAssetsAmount: 1,
      byteSize: 1000,
      epochs,
      tokenAmount: ethers.parseEther('1000'),
      isImmutable: false,
      publishOperationId: 'extend-zero-epochs-pub',
      reservedKaId,
    });
    await KAV10.connect(creator).publish(p);

    await expect(
      KAV10.connect(creator).extendKnowledgeAssetLifetime(reservedKaId, 0, ethers.parseEther('100')),
    ).to.be.revertedWithCustomError(KAV10, 'ZeroEpochs');
  });

  it('extend reverts KnowledgeAssetExpired on an already-expired KA (keeps sampling-prune safe)', async () => {
    // Safety invariant for RandomSampling's decoupled sampling list: the keeper
    // prunes a KA once `endEpoch < currentEpoch`, and a pruned KA can never
    // re-enter the sampling list (the double-registration guard blocks it). If
    // extend could revive an EXPIRED KA, that KA would be live + paid yet
    // permanently unsampleable. extend's expiry guard uses the SAME threshold
    // (`currentEpoch > endEpoch`), so the two are mutually exclusive and the
    // revive-into-unsampleable path is unreachable. This test pins that guard.
    const Params = await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
    const deposit = ethers.parseEther('2000');
    await Params.connect(accounts[0]).setContextGraphRegistrationDeposit(deposit);
    const creator = getDefaultKACreator(accounts);
    await Token.mint(creator.address, deposit);
    await Token.connect(creator).approve(await CGFacade.getAddress(), deposit);

    const { cgId, epochs, receivingNodes, publisherIdentityId, receiverIdentityIds } =
      await setupRegisteredAgentPublish();
    const reservedKaId = packReservedKaId(creator.address, 1);
    const p = await buildPublishParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes,
      publisherIdentityId,
      receiverIdentityIds,
      author: creator,
      contextGraphId: cgId,
      merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('extend-expired')),
      knowledgeAssetsAmount: 1,
      byteSize: 1000,
      epochs,
      tokenAmount: ethers.parseEther('1000'),
      isImmutable: false,
      publishOperationId: 'extend-expired-pub',
      reservedKaId,
    });
    await KAV10.connect(creator).publish(p);

    // Advance past the KA's lifetime so it is expired (and prune-eligible).
    const epochLength = await Chronos.epochLength();
    await time.increase(Number(epochLength) * (Number(epochs) + 1));

    await expect(
      KAV10.connect(creator).extendKnowledgeAssetLifetime(reservedKaId, 1, ethers.parseEther('100')),
    ).to.be.revertedWithCustomError(KAV10, 'KnowledgeAssetExpired');
  });

  // --------------------------------------------------------------------------
  // OT-RFC-53 — update draws the registration escrow for the delta + pays its fee
  // --------------------------------------------------------------------------
  it('OT-RFC-53: updating a KA in an owner-funded CG draws the escrow for the delta and pays its treasury fee', async () => {
    const Params = await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
    const CSS = await hre.ethers.getContract<ConvictionStakingStorage>('ConvictionStakingStorage');
    const deposit = ethers.parseEther('2000');
    await Params.connect(accounts[0]).setContextGraphRegistrationDeposit(deposit);

    const creator = getDefaultKACreator(accounts);
    await Token.mint(creator.address, deposit);
    await Token.connect(creator).approve(await CGFacade.getAddress(), deposit);

    const { cgId, epochs, receivingNodes, publisherIdentityId, receiverIdentityIds } =
      await setupRegisteredAgentPublish();

    // Publish with the treasury still dormant (no fee), so the draw + fee under test
    // are isolated to the UPDATE below. Escrow: 2000 → 1000.
    const pubAmount = ethers.parseEther('1000');
    const reservedKaId = packReservedKaId(creator.address, 1);
    await KAV10.connect(creator).publish(
      await buildPublishParams({
        chainId: DEFAULT_CHAIN_ID,
        kav10Address: await KAV10.getAddress(),
        receivingNodes,
        publisherIdentityId,
        receiverIdentityIds,
        author: creator,
        contextGraphId: cgId,
        merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('rfc53-update-pub')),
        knowledgeAssetsAmount: 1,
        byteSize: 1000,
        epochs,
        tokenAmount: pubAmount,
        isImmutable: false,
        publishOperationId: 'rfc53-update-pub-op',
        reservedKaId,
      }),
    );
    expect(await CGS.getRegistrationEscrow(cgId)).to.equal(deposit - pubAmount); // 1000

    // Enable the treasury, then update: the DELTA is drawn from the remaining
    // escrow via the update consume path (distinct epoch window: remainingEpochs)
    // and its treasury fee is routed out of the vault.
    const treasury = accounts[9].address;
    await Params.connect(accounts[0]).setProtocolTreasury(treasury);
    const feeBps = await Params.protocolTreasuryFee();
    const delta = ethers.parseEther('500');
    const expectedFee = (delta * feeBps) / 10_000n; // 15
    const treasuryBefore = await Token.balanceOf(treasury);

    const up = await buildUpdateParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes,
      publisherIdentityId,
      receiverIdentityIds,
      contextGraphId: cgId,
      id: reservedKaId,
      preUpdateMerkleRootCount: 1n,
      newMerkleRoot: ethers.keccak256(ethers.toUtf8Bytes('rfc53-update-new')),
      newByteSize: 1000n,
      newTokenAmount: pubAmount + delta,
      mintKnowledgeAssetsAmount: 0n,
      knowledgeAssetsToBurn: [],
      updateOperationId: 'rfc53-update-escrow-op',
      author: creator,
    });
    const tx = KAV10.connect(creator).update(up);
    await expect(tx).to.emit(KAV10, 'RegistrationEscrowConsumed').withArgs(cgId, delta);
    await expect(tx).to.emit(CSS, 'RegistrationDepositFeeTransferred').withArgs(treasury, expectedFee);
    expect((await Token.balanceOf(treasury)) - treasuryBefore).to.equal(expectedFee);
    expect(await CGS.getRegistrationEscrow(cgId)).to.equal(deposit - pubAmount - delta); // 500
  });

  // --------------------------------------------------------------------------
  // OT-RFC-53 — PARTIAL escrow: escrow covers part, wallet covers the rest; the
  // treasury fee is charged on BOTH portions independently (no double-fee/underflow)
  // --------------------------------------------------------------------------
  it('OT-RFC-53: a partial-escrow publish fees the escrow AND the wallet remainder independently', async () => {
    const Params = await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
    const CSS = await hre.ethers.getContract<ConvictionStakingStorage>('ConvictionStakingStorage');
    const deposit = ethers.parseEther('100'); // escrow covers only PART of the 1000 publish
    await Params.connect(accounts[0]).setContextGraphRegistrationDeposit(deposit);

    const treasury = accounts[6];
    const feeBps = 500n; // 5%
    await Params.connect(accounts[0]).setProtocolTreasury(treasury.address);
    await Params.connect(accounts[0]).setProtocolTreasuryFee(feeBps);

    const creator = getDefaultKACreator(accounts);
    await Token.mint(creator.address, deposit);
    await Token.connect(creator).approve(await CGFacade.getAddress(), deposit);

    const setup = await setupRegisteredAgentPublish();
    expect(await CGS.getRegistrationEscrow(setup.cgId)).to.equal(deposit);

    const tokenAmount = ethers.parseEther('1000');
    const walletCost = tokenAmount - deposit; // 900
    const feeEscrow = (deposit * feeBps) / 10_000n; // 5
    const feeWallet = (walletCost * feeBps) / 10_000n; // 45

    // Fund + approve the wallet remainder (direct-spend via _addTokens).
    await Token.mint(creator.address, walletCost);
    await Token.connect(creator).approve(await KAV10.getAddress(), walletCost);

    const treasuryBefore = await Token.balanceOf(treasury.address);
    const p = await buildBasePublishParams(setup, 'rfc53-partial-fee', {
      epochs: setup.epochs + 1, // break PCA discount eligibility → remainder via _addTokens
      tokenAmount,
    });
    const tx = KAV10.connect(creator).publish(p);
    // Escrow (100) drawn + its fee (5) routed out; wallet remainder (900) charged
    // its own fee (45) via _addTokens. Each portion fee'd exactly once.
    await expect(tx).to.emit(KAV10, 'RegistrationEscrowConsumed').withArgs(setup.cgId, deposit);
    await expect(tx).to.emit(CSS, 'RegistrationDepositFeeTransferred').withArgs(treasury.address, feeEscrow);
    expect((await Token.balanceOf(treasury.address)) - treasuryBefore).to.equal(feeEscrow + feeWallet);
    expect(await CGS.getRegistrationEscrow(setup.cgId)).to.equal(0n);
  });

  // --------------------------------------------------------------------------
  // OT-RFC-53 — sweep refuses a CG that still holds live value (RS leaf-zeroing
  // mandate: retiring a weighted CG would strand its RandomSampling leaf)
  // --------------------------------------------------------------------------
  it('OT-RFC-53: sweepContextGraphEscrow refuses a CG with live published value', async () => {
    const Params = await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
    const deposit = ethers.parseEther('2000');
    await Params.connect(accounts[0]).setContextGraphRegistrationDeposit(deposit);

    const creator = getDefaultKACreator(accounts);
    await Token.mint(creator.address, deposit);
    await Token.connect(creator).approve(await CGFacade.getAddress(), deposit);

    const { cgId, epochs, receivingNodes, publisherIdentityId, receiverIdentityIds } =
      await setupRegisteredAgentPublish();

    // Publish a KA → the CG now carries live sampling value/weight.
    const pubAmount = ethers.parseEther('1000');
    await KAV10.connect(creator).publish(
      await buildPublishParams({
        chainId: DEFAULT_CHAIN_ID,
        kav10Address: await KAV10.getAddress(),
        receivingNodes,
        publisherIdentityId,
        receiverIdentityIds,
        author: creator,
        contextGraphId: cgId,
        merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('rfc53-sweep-live')),
        knowledgeAssetsAmount: 1,
        byteSize: 1000,
        epochs,
        tokenAmount: pubAmount,
        isImmutable: false,
        publishOperationId: 'rfc53-sweep-live-op',
        reservedKaId: packReservedKaId(creator.address, 1),
      }),
    );

    // Sweep is REFUSED while the CG holds live value — deactivating it would strand
    // its RandomSampling weight. The CG stays active and its escrow intact.
    await expect(
      CGFacade.connect(accounts[0]).sweepContextGraphEscrow(cgId),
    ).to.be.revertedWithCustomError(CGFacade, 'InvalidContextGraphConfig');
    expect(await CGS.isContextGraphActive(cgId)).to.equal(true);
    expect(await CGS.getRegistrationEscrow(cgId)).to.equal(deposit - pubAmount);
  });

  // --------------------------------------------------------------------------
  // 2. registered agent publishes via real KnowledgeAssetsLifecycle.publish()
  // --------------------------------------------------------------------------
  it('takes the discount branch when epochs == lockDurationEpochs and the discounted cost is asserted on chain', async () => {
    const {
      creator,
      epochs,
      cgId,
      receivingNodes,
      publisherIdentityId,
      receiverIdentityIds,
    } = await setupRegisteredAgentPublish();

    const tokenAmount = ethers.parseEther('1000');
    const expectedDiscounted =
      (tokenAmount * (10_000n - EXPECTED_DISCOUNT_BPS)) / 10_000n;
    expect(expectedDiscounted).to.be.lessThan(tokenAmount);

    const currentEpoch = await Chronos.getCurrentEpoch();
    const merkleRoot = ethers.keccak256(
      ethers.toUtf8Bytes('v10-pca-lifecycle'),
    );
    // OT-RFC-43 Option 1 (1a): author-namespaced packed id we expect to mint.
    const reservedKaId = packReservedKaId(creator.address, 1);
    const p = await buildPublishParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes,
      publisherIdentityId,
      receiverIdentityIds,
      author: creator,
      contextGraphId: cgId,
      merkleRoot,
      knowledgeAssetsAmount: 1,
      byteSize: 1000,
      epochs,
      tokenAmount,
      isImmutable: false,
      publishOperationId: 'v10-pca-lifecycle-op',
      reservedKaId,
    });

    const tx = await KAV10.connect(creator).publish(p);
    const receipt = await tx.wait();
    expect(receipt!.status).to.equal(1);

    // The conviction branch funds the staker pool with the DISCOUNTED cost
    // via the NFT's `coverPublishingCost` → `addTokensToEpochRange`. A
    // direct-spend fallthrough would instead distribute the full amount.
    const epochStorageAddr = (
      await EpochStorageContract.getAddress()
    ).toLowerCase();
    let activeSinkSum = 0n;
    for (const log of receipt!.logs) {
      if (log.address.toLowerCase() !== epochStorageAddr) continue;
      try {
        const parsed = EpochStorageContract.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (parsed?.name === 'TokensAddedToEpochRange') {
          expect(BigInt(parsed.args.shardId)).to.equal(STAKER_SHARD_ID);
          expect(BigInt(parsed.args.startEpoch)).to.be.gte(currentEpoch);
          expect(BigInt(parsed.args.endEpoch)).to.be.lte(
            currentEpoch + BigInt(epochs),
          );
          activeSinkSum += BigInt(parsed.args.tokenAmount);
        }
      } catch {
        // not the event we're after
      }
    }
    expect(activeSinkSum).to.equal(expectedDiscounted);

    // KA records the FULL tokenAmount; only the staker-pool distribution is
    // discounted — the on-chain proof the discount branch (not direct
    // spend) executed. OT-RFC-43 Option 1 (1a): the minted kaId equals the
    // packed reservedKaId we supplied (ids are no longer globally sequential).
    const kaId = reservedKaId;
    expect(await DKGKnowledgeAssets.ownerOf(kaId)).to.equal(creator.address);
    const meta =
      await DKGKnowledgeAssets.getKnowledgeAssetMetadata(kaId);
    expect(meta[6]).to.equal(tokenAmount);
    expect(activeSinkSum).to.be.lessThan(meta[6]);
  });

  // --------------------------------------------------------------------------
  // 3. expired account: real publish() loses the discount and reverts
  // --------------------------------------------------------------------------
  //
  // On an expired PCA `KnowledgeAssetsLifecycle.publish()` gates the conviction
  // discount off (block.timestamp >= expiresAtTimestamp) and falls through
  // to the direct-spend branch — `_addTokens` pulls the FULL cost from the
  // agent. The registered agent here was only ever funded for the up-front
  // `committedTRAC` (consumed by createAccount) and never approved KAV10
  // for a direct spend, so the post-expiry publish reverts with
  // `TooLowAllowance` and no KA is created (atomic rollback). The same
  // agent publishing the SAME unfunded params BEFORE expiry succeeds via
  // the NFT-funded discount branch (asserted in test 2) — the revert is
  // expiry-driven, not a missing-approval artifact.
  it('expired account: real publish() drops the discount, reverts TooLowAllowance, creates no KA', async () => {
    const {
      creator,
      accountId,
      epochs,
      cgId,
      receivingNodes,
      publisherIdentityId,
      receiverIdentityIds,
    } = await setupRegisteredAgentPublish();

    // Advance past `expiresAtTimestamp` (lockDurationEpochs + 1 to clear
    // the window containing expiry plus the chain-epoch drift buffer).
    const epochLength = await Chronos.epochLength();
    await time.increase(Number(epochLength) * (epochs + 1));
    expect(
      BigInt((await hre.ethers.provider.getBlock('latest'))!.timestamp),
    ).to.be.gte((await NFT.getAccountInfo(accountId)).expiresAtTimestamp);

    const tokenAmount = ethers.parseEther('1000');
    const merkleRoot = ethers.keccak256(
      ethers.toUtf8Bytes('v10-pca-lifecycle-expired'),
    );
    const p = await buildPublishParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes,
      publisherIdentityId,
      receiverIdentityIds,
      author: creator,
      contextGraphId: cgId,
      merkleRoot,
      knowledgeAssetsAmount: 1,
      byteSize: 1000,
      epochs,
      tokenAmount,
      isImmutable: false,
      publishOperationId: 'v10-pca-lifecycle-expired-op',
    });

    await expect(
      KAV10.connect(creator).publish(p),
    ).to.be.revertedWithCustomError(KAV10, 'TooLowAllowance');

    // Atomic rollback: the expired publish minted no knowledge asset.
    // OT-RFC-43 Option 1 (1a): `getLatestKnowledgeAssetId` is deprecated (it
    // reverts), so we assert the reserved id was never minted — `ownerOf`
    // reverts on a non-existent token.
    await expect(
      DKGKnowledgeAssets.ownerOf(p.reservedKaId),
    ).to.be.revertedWithCustomError(DKGKnowledgeAssets, 'ERC721NonexistentToken');
  });

  // --------------------------------------------------------------------------
  // 4. Greenfield KA invariants (KA→KA rename / PR #815)
  // --------------------------------------------------------------------------
  //
  // These guard the core economic + ownership invariants of the greenfield
  // Knowledge Asset model that the KA→KA rename re-plumbed. Before this
  // block the `KnowledgeAssetsLifecycle.publish` negatives (one-KA-per-tx,
  // strict-positive token floor) and the owner-sealed update gate had no
  // direct on-chain coverage — only happy-path publishes were exercised, so
  // a regression that dropped a gate or renamed an error would have shipped
  // green. Each test pins the EXACT custom error (and args) rather than a
  // bare `to.be.reverted`, so a renamed/removed revert turns the lane red.

  const buildBasePublishParams = async (
    setup: Awaited<ReturnType<typeof setupRegisteredAgentPublish>>,
    label: string,
    overrides: Partial<Parameters<typeof buildPublishParams>[0]> = {},
  ) =>
    buildPublishParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes: setup.receivingNodes,
      publisherIdentityId: setup.publisherIdentityId,
      receiverIdentityIds: setup.receiverIdentityIds,
      author: setup.creator,
      contextGraphId: setup.cgId,
      merkleRoot: ethers.keccak256(ethers.toUtf8Bytes(label)),
      knowledgeAssetsAmount: 1,
      byteSize: 1000,
      epochs: setup.epochs,
      tokenAmount: ethers.parseEther('1000'),
      isImmutable: false,
      publishOperationId: `${label}-op`,
      ...overrides,
    });

  it('greenfield: publish reverts InvalidKnowledgeAssetsAmount unless exactly one KA is minted per tx', async () => {
    const setup = await setupRegisteredAgentPublish();
    // The author attestation does NOT commit to knowledgeAssetsAmount, so the
    // amount gate (`_executePublishCore`) is reached before the ACK signature
    // check — flipping the count to anything but 1 must revert with the
    // amount echoed back.
    const attemptedKaIds: bigint[] = [];
    for (const amount of [0, 2, 5]) {
      const p = await buildBasePublishParams(setup, `amount-gate-${amount}`, {
        knowledgeAssetsAmount: amount,
      });
      attemptedKaIds.push(BigInt(p.reservedKaId));
      await expect(KAV10.connect(setup.creator).publish(p))
        .to.be.revertedWithCustomError(KAV10, 'InvalidKnowledgeAssetsAmount')
        .withArgs(BigInt(amount));
    }
    // None of the reverted attempts minted a token. OT-RFC-43 Option 1 (1a):
    // `getLatestKnowledgeAssetId` reverts (deprecated), so assert each
    // reserved id is unminted (`ownerOf` reverts on a non-existent token).
    for (const id of attemptedKaIds) {
      await expect(
        DKGKnowledgeAssets.ownerOf(id),
      ).to.be.revertedWithCustomError(
        DKGKnowledgeAssets,
        'ERC721NonexistentToken',
      );
    }
  });

  it('greenfield: publish reverts InvalidTokenAmount(1,0) on a zero token amount (strict-positive floor)', async () => {
    const setup = await setupRegisteredAgentPublish();
    const p = await buildBasePublishParams(setup, 'token-floor', {
      tokenAmount: 0n,
    });
    await expect(KAV10.connect(setup.creator).publish(p))
      .to.be.revertedWithCustomError(KAV10, 'InvalidTokenAmount')
      .withArgs(1, 0);
    // OT-RFC-43 Option 1 (1a): nothing minted — the reserved id stays unowned.
    await expect(
      DKGKnowledgeAssets.ownerOf(p.reservedKaId),
    ).to.be.revertedWithCustomError(
      DKGKnowledgeAssets,
      'ERC721NonexistentToken',
    );
  });

  it('greenfield: curated publish requires a catalog commitment before value enters sampling', async () => {
    const setup = await setupRegisteredAgentPublish();
    const curatedCgId = await createCuratedContextGraphFor(setup.creator);
    const p = await buildBasePublishParams(setup, 'curated-missing-catalog', {
      contextGraphId: curatedCgId,
    });

    await expect(KAV10.connect(setup.creator).publish(p))
      .to.be.revertedWithCustomError(
        KAV10,
        'CuratedCGRequiresCatalogCommitment',
      )
      .withArgs(curatedCgId);

    await expect(
      DKGKnowledgeAssets.ownerOf(p.reservedKaId),
    ).to.be.revertedWithCustomError(
      DKGKnowledgeAssets,
      'ERC721NonexistentToken',
    );
  });

  it('greenfield: curated publish with a full catalog commitment persists the sampling proof anchor', async () => {
    const setup = await setupRegisteredAgentPublish();
    const curatedCgId = await createCuratedContextGraphFor(setup.creator);
    const catalogRoot = ethers.keccak256(
      ethers.toUtf8Bytes('curated-publish-catalog-root'),
    );
    const catalogLeafCount = 3n;
    const p = await buildBasePublishParams(setup, 'curated-with-catalog', {
      contextGraphId: curatedCgId,
      catalogRoot,
      catalogLeafCount,
    });

    await (await KAV10.connect(setup.creator).publish(p)).wait();

    const kaId = BigInt(p.reservedKaId);
    expect(await CGS.kaToContextGraph(kaId)).to.equal(curatedCgId);
    expect(await DKGKnowledgeAssets.getCatalogRoot(kaId)).to
      .equal(catalogRoot);
    expect(await DKGKnowledgeAssets.getCatalogLeafCount(kaId)).to.equal(
      catalogLeafCount,
    );
  });

  it('update: paid legacy curated top-up requires the first catalog commitment', async () => {
    const setup = await setupRegisteredAgentPublish();
    const curatedCgId = await createCuratedContextGraphFor(setup.creator);
    const storageOperator = accounts[19];
    await HubContract.setContractAddress(
      'TestStorageOperator',
      storageOperator.address,
    );

    const currentEpoch = await Chronos.getCurrentEpoch();
    const endEpoch = currentEpoch + BigInt(setup.epochs);
    const initialTokenAmount = ethers.parseEther('1000');
    const kaId = packReservedKaId(setup.creator.address, 777);
    await DKGKnowledgeAssets.connect(storageOperator).createKnowledgeAsset(
      storageOperator.address,
      setup.creator.address,
      kaId,
      'legacy-curated-uncommitted-op',
      ethers.keccak256(ethers.toUtf8Bytes('legacy-curated-uncommitted')),
      1,
      1000,
      currentEpoch,
      endEpoch,
      initialTokenAmount,
      false,
      1,
    );
    await CGS.connect(storageOperator).registerKnowledgeAssetToContextGraph(
      curatedCgId,
      kaId,
    );
    expect(await DKGKnowledgeAssets.getCatalogRoot(kaId)).to
      .equal(ethers.ZeroHash);

    const up = await buildUpdateParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes: setup.receivingNodes,
      publisherIdentityId: setup.publisherIdentityId,
      receiverIdentityIds: setup.receiverIdentityIds,
      contextGraphId: curatedCgId,
      id: kaId,
      preUpdateMerkleRootCount: 1n,
      newMerkleRoot: ethers.keccak256(
        ethers.toUtf8Bytes('legacy-curated-paid-top-up'),
      ),
      newByteSize: 1000n,
      newTokenAmount: initialTokenAmount + ethers.parseEther('1'),
      mintKnowledgeAssetsAmount: 0n,
      knowledgeAssetsToBurn: [],
      updateOperationId: 'legacy-curated-paid-top-up-op',
      author: setup.creator,
    });

    await expect(KAV10.connect(setup.creator).update(up))
      .to.be.revertedWithCustomError(
        KAV10,
        'CuratedCGRequiresCatalogCommitment',
      )
      .withArgs(curatedCgId);
  });

  it('update: paid legacy curated top-up succeeds when it supplies the first catalog commitment', async () => {
    const setup = await setupRegisteredAgentPublish();
    const curatedCgId = await createCuratedContextGraphFor(setup.creator);
    const storageOperator = accounts[19];
    await HubContract.setContractAddress(
      'TestStorageOperator',
      storageOperator.address,
    );

    const currentEpoch = await Chronos.getCurrentEpoch();
    const endEpoch = currentEpoch + BigInt(setup.epochs);
    const initialTokenAmount = ethers.parseEther('1000');
    const kaId = packReservedKaId(setup.creator.address, 778);
    await DKGKnowledgeAssets.connect(storageOperator).createKnowledgeAsset(
      storageOperator.address,
      setup.creator.address,
      kaId,
      'legacy-curated-first-commit-op',
      ethers.keccak256(ethers.toUtf8Bytes('legacy-curated-first-commit')),
      1,
      1000,
      currentEpoch,
      endEpoch,
      initialTokenAmount,
      false,
      1,
    );
    await CGS.connect(storageOperator).registerKnowledgeAssetToContextGraph(
      curatedCgId,
      kaId,
    );
    expect(await DKGKnowledgeAssets.getCatalogRoot(kaId)).to
      .equal(ethers.ZeroHash);

    const firstCommitmentRoot = ethers.keccak256(
      ethers.toUtf8Bytes('legacy-curated-first-commit-root'),
    );
    const firstCommitmentCount = 4n;
    const up = await buildUpdateParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes: setup.receivingNodes,
      publisherIdentityId: setup.publisherIdentityId,
      receiverIdentityIds: setup.receiverIdentityIds,
      contextGraphId: curatedCgId,
      id: kaId,
      preUpdateMerkleRootCount: 1n,
      newMerkleRoot: ethers.keccak256(
        ethers.toUtf8Bytes('legacy-curated-paid-top-up-committed'),
      ),
      newByteSize: 1000n,
      newTokenAmount: initialTokenAmount + ethers.parseEther('1'),
      mintKnowledgeAssetsAmount: 0n,
      knowledgeAssetsToBurn: [],
      updateOperationId: 'legacy-curated-first-commit-op',
      author: setup.creator,
      newCatalogRoot: firstCommitmentRoot,
      newCatalogLeafCount: firstCommitmentCount,
    });

    await (await KAV10.connect(setup.creator).update(up)).wait();

    // The paid top-up supplied the first commitment, so the legacy KA can now
    // enter value-weighted sampling — the commitment anchor is persisted.
    expect(await DKGKnowledgeAssets.getCatalogRoot(kaId)).to
      .equal(firstCommitmentRoot);
    expect(await DKGKnowledgeAssets.getCatalogLeafCount(kaId)).to.equal(
      firstCommitmentCount,
    );
  });

  // --------------------------------------------------------------------------
  // OT-RFC-49 catalog-commitment integrity reverts. These MUST/MUST-NOT guards
  // previously had ZERO assertions; `IncompleteCatalogCommitment` is the exact
  // KnowledgeAssetsLifecycle lifecycle revert behind the PR #1198 regression.
  // --------------------------------------------------------------------------
  it('publish: a PARTIAL catalog commitment (exactly one field zero) on a curated CG reverts IncompleteCatalogCommitment', async () => {
    const setup = await setupRegisteredAgentPublish();
    const curatedCgId = await createCuratedContextGraphFor(setup.creator);

    // root set, leafCount zero
    const pRootOnly = await buildBasePublishParams(setup, 'partial-root-only', {
      contextGraphId: curatedCgId,
      catalogRoot: ethers.keccak256(ethers.toUtf8Bytes('partial-root')),
      catalogLeafCount: 0n,
    });
    await expect(
      KAV10.connect(setup.creator).publish(pRootOnly),
    ).to.be.revertedWithCustomError(KAV10, 'IncompleteCatalogCommitment');

    // leafCount set, root zero
    const pCountOnly = await buildBasePublishParams(
      setup,
      'partial-count-only',
      {
        contextGraphId: curatedCgId,
        catalogRoot: ethers.ZeroHash,
        catalogLeafCount: 5n,
      },
    );
    await expect(
      KAV10.connect(setup.creator).publish(pCountOnly),
    ).to.be.revertedWithCustomError(KAV10, 'IncompleteCatalogCommitment');

    // nothing minted on either reverted attempt
    await expect(
      DKGKnowledgeAssets.ownerOf(pRootOnly.reservedKaId),
    ).to.be.revertedWithCustomError(
      DKGKnowledgeAssets,
      'ERC721NonexistentToken',
    );
  });

  it('publish: a PUBLIC CG carrying a catalog commitment reverts PublicCGCannotHaveCatalogCommitment', async () => {
    const setup = await setupRegisteredAgentPublish();
    // setup.cgId is the open/public CG created in setupRegisteredAgentPublish.
    const p = await buildBasePublishParams(setup, 'public-with-catalog', {
      catalogRoot: ethers.keccak256(
        ethers.toUtf8Bytes('illegal-public-catalog'),
      ),
      catalogLeafCount: 3n,
    });
    await expect(KAV10.connect(setup.creator).publish(p))
      .to.be.revertedWithCustomError(
        KAV10,
        'PublicCGCannotHaveCatalogCommitment',
      )
      .withArgs(setup.cgId);
  });

  it('publish: a PUBLIC CG with merkleLeafCount == 0 reverts PublicKARequiresMerkleLeafCount (F08)', async () => {
    // A public KA is sampled against its merkleLeafCount; zero makes it
    // unchallengeable. Rejecting it at publish stops a griefer from packing a CG
    // with live zero-leaf KAs that burn the bounded MAX_KA_RETRIES sampling budget.
    const setup = await setupRegisteredAgentPublish();
    const p = await buildBasePublishParams(setup, 'public-zero-leaf', {
      merkleLeafCount: 0,
    });
    await expect(KAV10.connect(setup.creator).publish(p))
      .to.be.revertedWithCustomError(KAV10, 'PublicKARequiresMerkleLeafCount')
      .withArgs(setup.cgId);
  });

  it('update: a PARTIAL new catalog commitment (one field zero) on a curated KA reverts IncompleteCatalogCommitment', async () => {
    const setup = await setupRegisteredAgentPublish();
    const curatedCgId = await createCuratedContextGraphFor(setup.creator);
    const storageOperator = accounts[19];
    await HubContract.setContractAddress(
      'TestStorageOperator',
      storageOperator.address,
    );

    const currentEpoch = await Chronos.getCurrentEpoch();
    const endEpoch = currentEpoch + BigInt(setup.epochs);
    const initialTokenAmount = ethers.parseEther('1000');
    const kaId = packReservedKaId(setup.creator.address, 811);
    await DKGKnowledgeAssets.connect(storageOperator).createKnowledgeAsset(
      storageOperator.address,
      setup.creator.address,
      kaId,
      'partial-update-op',
      ethers.keccak256(ethers.toUtf8Bytes('partial-update')),
      1,
      1000,
      currentEpoch,
      endEpoch,
      initialTokenAmount,
      false,
      1,
    );
    await CGS.connect(storageOperator).registerKnowledgeAssetToContextGraph(
      curatedCgId,
      kaId,
    );

    const up = await buildUpdateParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes: setup.receivingNodes,
      publisherIdentityId: setup.publisherIdentityId,
      receiverIdentityIds: setup.receiverIdentityIds,
      contextGraphId: curatedCgId,
      id: kaId,
      preUpdateMerkleRootCount: 1n,
      newMerkleRoot: ethers.keccak256(ethers.toUtf8Bytes('partial-update-root')),
      newByteSize: 1000n,
      newTokenAmount: initialTokenAmount + ethers.parseEther('1'),
      mintKnowledgeAssetsAmount: 0n,
      knowledgeAssetsToBurn: [],
      updateOperationId: 'partial-update-op',
      author: setup.creator,
      newCatalogRoot: ethers.keccak256(ethers.toUtf8Bytes('partial-update-cat')),
      newCatalogLeafCount: 0n, // partial — one field zero
    });
    await expect(
      KAV10.connect(setup.creator).update(up),
    ).to.be.revertedWithCustomError(KAV10, 'IncompleteCatalogCommitment');
  });

  it('update: zero-pairing the catalog on an already-committed curated KA reverts IncompleteCatalogCommitment (no stranding)', async () => {
    const setup = await setupRegisteredAgentPublish();
    const curatedCgId = await createCuratedContextGraphFor(setup.creator);

    // Publish with a full commitment so the KA is genuinely committed.
    const catalogRoot = ethers.keccak256(ethers.toUtf8Bytes('committed-root'));
    const pub = await buildBasePublishParams(setup, 'strand-publish', {
      contextGraphId: curatedCgId,
      catalogRoot,
      catalogLeafCount: 3n,
    });
    await (await KAV10.connect(setup.creator).publish(pub)).wait();
    const kaId = BigInt(pub.reservedKaId);
    expect(await DKGKnowledgeAssets.getCatalogRoot(kaId)).to.equal(catalogRoot);

    // A zero-pair (both fields zero) update on a committed KA would strand the
    // stale commitment — must revert.
    const up = await buildUpdateParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes: setup.receivingNodes,
      publisherIdentityId: setup.publisherIdentityId,
      receiverIdentityIds: setup.receiverIdentityIds,
      contextGraphId: curatedCgId,
      id: kaId,
      preUpdateMerkleRootCount: 1n,
      newMerkleRoot: ethers.keccak256(ethers.toUtf8Bytes('strand-update-root')),
      newByteSize: 1000n,
      newTokenAmount: ethers.parseEther('1000'),
      mintKnowledgeAssetsAmount: 0n,
      knowledgeAssetsToBurn: [],
      updateOperationId: 'strand-update-op',
      author: setup.creator,
      newCatalogRoot: ethers.ZeroHash,
      newCatalogLeafCount: 0n,
    });
    await expect(
      KAV10.connect(setup.creator).update(up),
    ).to.be.revertedWithCustomError(KAV10, 'IncompleteCatalogCommitment');
  });

  it('update: a PUBLIC CG update carrying a catalog commitment reverts PublicCGCannotHaveCatalogCommitment', async () => {
    const setup = await setupRegisteredAgentPublish();
    const storageOperator = accounts[19];
    await HubContract.setContractAddress(
      'TestStorageOperator',
      storageOperator.address,
    );

    const currentEpoch = await Chronos.getCurrentEpoch();
    const endEpoch = currentEpoch + BigInt(setup.epochs);
    const initialTokenAmount = ethers.parseEther('1000');
    const kaId = packReservedKaId(setup.creator.address, 812);
    await DKGKnowledgeAssets.connect(storageOperator).createKnowledgeAsset(
      storageOperator.address,
      setup.creator.address,
      kaId,
      'public-update-op',
      ethers.keccak256(ethers.toUtf8Bytes('public-update')),
      1,
      1000,
      currentEpoch,
      endEpoch,
      initialTokenAmount,
      false,
      1,
    );
    // setup.cgId is PUBLIC.
    await CGS.connect(storageOperator).registerKnowledgeAssetToContextGraph(
      setup.cgId,
      kaId,
    );

    const up = await buildUpdateParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes: setup.receivingNodes,
      publisherIdentityId: setup.publisherIdentityId,
      receiverIdentityIds: setup.receiverIdentityIds,
      contextGraphId: setup.cgId,
      id: kaId,
      preUpdateMerkleRootCount: 1n,
      newMerkleRoot: ethers.keccak256(ethers.toUtf8Bytes('public-update-root')),
      newByteSize: 1000n,
      newTokenAmount: initialTokenAmount + ethers.parseEther('1'),
      mintKnowledgeAssetsAmount: 0n,
      knowledgeAssetsToBurn: [],
      updateOperationId: 'public-update-op',
      author: setup.creator,
      newCatalogRoot: ethers.keccak256(ethers.toUtf8Bytes('illegal-public-cat')),
      newCatalogLeafCount: 4n, // illegal on a public CG
    });
    await expect(KAV10.connect(setup.creator).update(up))
      .to.be.revertedWithCustomError(
        KAV10,
        'PublicCGCannotHaveCatalogCommitment',
      )
      .withArgs(setup.cgId);
  });

  it('update: a PUBLIC CG update with newMerkleLeafCount == 0 reverts PublicKARequiresMerkleLeafCount (F08)', async () => {
    // A content update must keep a public KA challengeable — zeroing its leaf
    // count would strand it from the sampling draw (pure top-ups/extends use a
    // different path, so they are unaffected).
    const setup = await setupRegisteredAgentPublish();
    const storageOperator = accounts[19];
    await HubContract.setContractAddress(
      'TestStorageOperator',
      storageOperator.address,
    );

    const currentEpoch = await Chronos.getCurrentEpoch();
    const endEpoch = currentEpoch + BigInt(setup.epochs);
    const initialTokenAmount = ethers.parseEther('1000');
    const kaId = packReservedKaId(setup.creator.address, 813);
    await DKGKnowledgeAssets.connect(storageOperator).createKnowledgeAsset(
      storageOperator.address,
      setup.creator.address,
      kaId,
      'public-update-zero-op',
      ethers.keccak256(ethers.toUtf8Bytes('public-update-zero')),
      1,
      1000,
      currentEpoch,
      endEpoch,
      initialTokenAmount,
      false,
      1,
    );
    await CGS.connect(storageOperator).registerKnowledgeAssetToContextGraph(
      setup.cgId,
      kaId,
    );

    const up = await buildUpdateParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes: setup.receivingNodes,
      publisherIdentityId: setup.publisherIdentityId,
      receiverIdentityIds: setup.receiverIdentityIds,
      contextGraphId: setup.cgId,
      id: kaId,
      preUpdateMerkleRootCount: 1n,
      newMerkleRoot: ethers.keccak256(ethers.toUtf8Bytes('public-update-zero-root')),
      newMerkleLeafCount: 0, // F08: zeroing strands the KA from sampling
      newByteSize: 1000n,
      newTokenAmount: initialTokenAmount + ethers.parseEther('1'),
      mintKnowledgeAssetsAmount: 0n,
      knowledgeAssetsToBurn: [],
      updateOperationId: 'public-update-zero-op',
      author: setup.creator,
    });
    await expect(KAV10.connect(setup.creator).update(up))
      .to.be.revertedWithCustomError(KAV10, 'PublicKARequiresMerkleLeafCount')
      .withArgs(setup.cgId);
  });

  it('update: metadata-only maintenance of a legacy uncommitted curated KA stays allowed without a commitment', async () => {
    const setup = await setupRegisteredAgentPublish();
    const curatedCgId = await createCuratedContextGraphFor(setup.creator);
    const storageOperator = accounts[19];
    await HubContract.setContractAddress(
      'TestStorageOperator',
      storageOperator.address,
    );

    const currentEpoch = await Chronos.getCurrentEpoch();
    const endEpoch = currentEpoch + BigInt(setup.epochs);
    const initialTokenAmount = ethers.parseEther('1000');
    const kaId = packReservedKaId(setup.creator.address, 779);
    await DKGKnowledgeAssets.connect(storageOperator).createKnowledgeAsset(
      storageOperator.address,
      setup.creator.address,
      kaId,
      'legacy-curated-metadata-only-op',
      ethers.keccak256(ethers.toUtf8Bytes('legacy-curated-metadata-only')),
      1,
      1000,
      currentEpoch,
      endEpoch,
      initialTokenAmount,
      false,
      1,
    );
    await CGS.connect(storageOperator).registerKnowledgeAssetToContextGraph(
      curatedCgId,
      kaId,
    );

    // No paid top-up (newTokenAmount unchanged) and no catalog pair: this is
    // metadata-only maintenance, which stays allowed for legacy uncommitted
    // curated KAs — the commitment gate only guards value-adding (paid) updates.
    const up = await buildUpdateParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes: setup.receivingNodes,
      publisherIdentityId: setup.publisherIdentityId,
      receiverIdentityIds: setup.receiverIdentityIds,
      contextGraphId: curatedCgId,
      id: kaId,
      preUpdateMerkleRootCount: 1n,
      newMerkleRoot: ethers.keccak256(
        ethers.toUtf8Bytes('legacy-curated-metadata-only-update'),
      ),
      newByteSize: 1000n,
      newTokenAmount: initialTokenAmount,
      mintKnowledgeAssetsAmount: 0n,
      knowledgeAssetsToBurn: [],
      updateOperationId: 'legacy-curated-metadata-only-op',
      author: setup.creator,
    });

    await (await KAV10.connect(setup.creator).update(up)).wait();

    // Still uncommitted and that is fine — metadata maintenance does not force
    // a commitment on a legacy curated KA.
    expect(await DKGKnowledgeAssets.getCatalogRoot(kaId)).to
      .equal(ethers.ZeroHash);
  });

  it('greenfield: a successful publish mints exactly one KA (the packed reservedKaId) to the author and binds it to the CG', async () => {
    const setup = await setupRegisteredAgentPublish();
    const p = await buildBasePublishParams(setup, 'greenfield-mint');
    await (await KAV10.connect(setup.creator).publish(p)).wait();

    // OT-RFC-43 Option 1 (1a): the minted kaId equals the packed reservedKaId
    // (author-namespaced; ids are no longer globally sequential).
    const kaId = BigInt(p.reservedKaId);
    expect(kaId >> 96n).to.equal(BigInt(setup.creator.address));
    // Minted to the attesting author (not the relaying node / msg.sender path).
    expect(await DKGKnowledgeAssets.ownerOf(kaId)).to.equal(
      setup.creator.address,
    );
    // Atomic kaId → cgId binding written by `registerKnowledgeAsset`.
    expect(await CGS.kaToContextGraph(kaId)).to.equal(setup.cgId);
  });

  it('greenfield: update is owner-sealed — a valid attestation from a non-owner reverts NotKnowledgeAssetOwner', async () => {
    const setup = await setupRegisteredAgentPublish();
    const p = await buildBasePublishParams(setup, 'owner-gate-publish');
    await (await KAV10.connect(setup.creator).publish(p)).wait();
    // OT-RFC-43 Option 1 (1a): minted kaId == packed reservedKaId.
    const kaId = BigInt(p.reservedKaId);
    expect(await DKGKnowledgeAssets.ownerOf(kaId)).to.equal(
      setup.creator.address,
    );

    // A non-owner who correctly signs the EIP-712 update attestation over
    // THEIR OWN address passes `_verifyUpdateAuthorAttestation` but must still
    // be rejected by the ownerOf gate. `msg.sender` is the authorized CG
    // publisher (creator) so the policy branch is not what trips — the owner
    // mismatch is.
    const nonOwner = accounts[8];
    expect(nonOwner.address).to.not.equal(setup.creator.address);

    const up = await buildUpdateParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes: setup.receivingNodes,
      publisherIdentityId: setup.publisherIdentityId,
      receiverIdentityIds: setup.receiverIdentityIds,
      contextGraphId: setup.cgId,
      id: kaId,
      preUpdateMerkleRootCount: 1n, // fresh KA from a single publish
      newMerkleRoot: ethers.keccak256(ethers.toUtf8Bytes('owner-gate-update')),
      newByteSize: 1000n,
      newTokenAmount: ethers.parseEther('1'),
      mintKnowledgeAssetsAmount: 0n,
      knowledgeAssetsToBurn: [],
      updateOperationId: 'owner-gate-update-op',
      author: nonOwner,
    });

    await expect(KAV10.connect(setup.creator).update(up))
      .to.be.revertedWithCustomError(KAV10, 'NotKnowledgeAssetOwner')
      .withArgs(kaId, setup.creator.address, nonOwner.address);
  });

  it('G-7 (guard invariant): the _executeUpdateCore value-write gate rejects a paid update to an inactive CG (inactive state seeded directly)', async () => {
    // GUARD INVARIANT (low-level). The _executeUpdateCore value-write branch is
    // gated on isContextGraphActive, so a paid update to an INACTIVE CG reverts
    // regardless of HOW the CG became inactive. Here the inactive state is seeded
    // DIRECTLY via the storage operator — a unit/corruption construction, NOT the
    // production sweep state: sweepContextGraphEscrow REFUSES a CG with live value
    // (see the OT-RFC-53 refusal test above), so it can never produce
    // inactive-WITH-live-value. On the update path the inactive-CG gate is in fact
    // defense-in-depth: the only reachable way to a sweep-inactive CG also expires
    // every KA in it, so a real paid update is stopped by KnowledgeAssetExpired
    // first (proven by the companion test below). Seeding the inactive state
    // directly is therefore the only way to exercise the gate itself in isolation,
    // which is what this test does.
    const setup = await setupRegisteredAgentPublish();
    const p = await buildBasePublishParams(setup, 'g7-update-gate'); // publishes at 1000 TRAC
    await (await KAV10.connect(setup.creator).publish(p)).wait();
    const kaId = BigInt(p.reservedKaId);

    // Seed the inactive state directly via the storage operator (onlyContracts seeder).
    const storageOperator = accounts[19];
    await HubContract.setContractAddress('TestStorageOperator', storageOperator.address);
    await (await CGS.connect(storageOperator).deactivateContextGraph(setup.cgId)).wait();
    expect(await CGS.isContextGraphActive(setup.cgId)).to.equal(false);

    // Fund the creator so the paid-update consume can't be the thing that reverts.
    await Token.mint(setup.creator.address, ethers.parseEther('10'));
    await Token.connect(setup.creator).approve(await KAV10.getAddress(), ethers.parseEther('10'));

    // A paid update (positive token delta) reaches _executeUpdateCore's value-write
    // branch, now gated on isContextGraphActive — so it reverts instead of
    // re-stranding sampling weight onto the retired CG.
    const up = await buildUpdateParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes: setup.receivingNodes,
      publisherIdentityId: setup.publisherIdentityId,
      receiverIdentityIds: setup.receiverIdentityIds,
      contextGraphId: setup.cgId,
      id: kaId,
      preUpdateMerkleRootCount: 1n,
      newMerkleRoot: ethers.keccak256(ethers.toUtf8Bytes('g7-update-gate-new')),
      newByteSize: 1000n,
      newTokenAmount: ethers.parseEther('1001'), // > published 1000 => positive delta
      mintKnowledgeAssetsAmount: 0n,
      knowledgeAssetsToBurn: [],
      updateOperationId: 'g7-update-gate-op',
      author: setup.creator,
    });
    await expect(KAV10.connect(setup.creator).update(up)).to.be.revertedWithCustomError(
      KAV10,
      'CannotWriteValueToInactiveContextGraph',
    );
  });

  it('G-7 (reachable path): a paid update onto a sweep-retired CG is independently blocked by KnowledgeAssetExpired — the inactive-CG gate is defense-in-depth behind it', async () => {
    // The REACHABLE retirement, and what it actually does on the UPDATE path.
    // sweepContextGraphEscrow deactivates a CG ONLY after its published value has
    // decayed to zero (it settles the sampling leaf and REFUSES while
    // getCurrentCGValue != 0 — the OT-RFC-53 refusal above). But "CG value == 0"
    // means EVERY KA in the CG has expired, so on the update path a paid update is
    // independently rejected by KnowledgeAssetExpired BEFORE _executeUpdateCore's
    // value-write branch (hence the inactive-CG gate) is ever reached. That gate is
    // therefore defense-in-depth on the update path — exercised in isolation by the
    // guard-invariant test above, and reachably exercised on the EXTEND path (which
    // CAN revive an expired KA) by g7-inactive-cg-restrand.regression.test.ts. This
    // test pins the real, reachable sequence end-to-end: publish -> live-value sweep
    // refused -> value expiry -> sweep retires the CG -> paid update reverts
    // KnowledgeAssetExpired.
    const Params = await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
    const CGVS = await hre.ethers.getContract<ContextGraphValueStorage>(
      'ContextGraphValueStorage',
    );
    const deposit = ethers.parseEther('2000');
    await Params.connect(accounts[0]).setContextGraphRegistrationDeposit(deposit);

    const creator = getDefaultKACreator(accounts);
    await Token.mint(creator.address, deposit);
    await Token.connect(creator).approve(await CGFacade.getAddress(), deposit);

    const setup = await setupRegisteredAgentPublish();
    const p = await buildBasePublishParams(setup, 'g7-sweep-reachable'); // 1000 TRAC, setup.epochs lifetime
    await (await KAV10.connect(setup.creator).publish(p)).wait();
    const kaId = BigInt(p.reservedKaId);
    expect(await CGS.getRegistrationEscrow(setup.cgId)).to.equal(
      deposit - ethers.parseEther('1000'),
    );

    // While the published value is live, sweep is REFUSED — this is exactly why
    // the direct-deactivation state in the guard-invariant test is unreachable.
    await expect(
      CGFacade.connect(accounts[0]).sweepContextGraphEscrow(setup.cgId),
    ).to.be.revertedWithCustomError(CGFacade, 'InvalidContextGraphConfig');
    expect(await CGS.isContextGraphActive(setup.cgId)).to.equal(true);

    // Let the published value expire so the CG becomes genuinely sweepable.
    const epochLength = await Chronos.epochLength();
    await time.increase(Number(epochLength) * (setup.epochs + 1));
    expect(await CGVS.getCurrentCGValue(setup.cgId)).to.equal(0n);

    // The REAL retirement path now succeeds: sweep settles the (zero) leaf and
    // deactivates the CG, leaving exactly the inactive state production produces.
    await (await CGFacade.connect(accounts[0]).sweepContextGraphEscrow(setup.cgId)).wait();
    expect(await CGS.isContextGraphActive(setup.cgId)).to.equal(false);

    // Fund a direct-spend paid update (post-expiry the PCA discount is gone), so
    // the revert can only be the inactive-CG gate, not a funding shortfall.
    await Token.mint(setup.creator.address, ethers.parseEther('2000'));
    await Token.connect(setup.creator).approve(
      await KAV10.getAddress(),
      ethers.parseEther('2000'),
    );

    const up = await buildUpdateParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes: setup.receivingNodes,
      publisherIdentityId: setup.publisherIdentityId,
      receiverIdentityIds: setup.receiverIdentityIds,
      contextGraphId: setup.cgId,
      id: kaId,
      preUpdateMerkleRootCount: 1n,
      newMerkleRoot: ethers.keccak256(ethers.toUtf8Bytes('g7-sweep-reachable-new')),
      newByteSize: 1000n,
      newTokenAmount: ethers.parseEther('1001'), // positive delta => value-write branch
      mintKnowledgeAssetsAmount: 0n,
      knowledgeAssetsToBurn: [],
      updateOperationId: 'g7-sweep-reachable-op',
      author: setup.creator,
    });
    await expect(KAV10.connect(setup.creator).update(up)).to.be.revertedWithCustomError(
      KAV10,
      'KnowledgeAssetExpired',
    );
  });

  // --------------------------------------------------------------------------
  // 5. Protocol treasury fee split on the direct-spend path (v10.0.2)
  // --------------------------------------------------------------------------
  //
  // `_addTokens` skims the protocol treasury fee out of the staker-bound
  // TRAC on every paid publish/update/lifetime-extension. The split is a
  // conservation invariant — `fee + net == gross`, the publisher pays the
  // gross, nothing is minted or burned — yet it had NO test. A regression
  // that double-charged the fee, paid it out of thin air, or skewed the
  // split would have shipped green. These two tests pin BOTH branches of
  // `_treasuryFee`: governance opted-in (recipient wired) and the SHIPPING
  // default (recipient unset → fee dormant, full gross to stakers).
  //
  // Both force the DIRECT-SPEND branch by publishing with
  // `epochs != lockDurationEpochs`, which fails PCA eligibility gate (3) so
  // `_addTokens` runs against the publisher's own wallet (no time travel,
  // the PCA stays live).

  it('treasury: direct-spend publish skims the protocol fee — fee + staker-net == gross', async () => {
    const setup = await setupRegisteredAgentPublish();

    const Parameters =
      await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
    const treasury = accounts[6];
    const feeBps = 500n; // 5% — well under MAX_PROTOCOL_TREASURY_FEE (1000)
    await Parameters.setProtocolTreasury(treasury.address);
    await Parameters.setProtocolTreasuryFee(feeBps);
    expect(await Parameters.protocolTreasury()).to.equal(treasury.address);

    const tokenAmount = ethers.parseEther('1000');
    const expectedFee = (tokenAmount * feeBps) / 10_000n; // 50 ether
    const expectedNet = tokenAmount - expectedFee; // 950 ether

    // Fund the publisher (msg.sender on direct-spend) for the gross + approve.
    await Token.mint(setup.creator.address, tokenAmount);
    await Token.connect(setup.creator).approve(
      await KAV10.getAddress(),
      tokenAmount,
    );

    const cssAddr = await ConvictionStakingStorage.getAddress();
    const treasuryBefore = await Token.balanceOf(treasury.address);
    const cssBefore = await Token.balanceOf(cssAddr);
    const creatorBefore = await Token.balanceOf(setup.creator.address);

    const p = await buildBasePublishParams(setup, 'treasury-split', {
      epochs: setup.epochs + 1, // breaks the PCA discount-branch eligibility
      tokenAmount,
    });
    await (await KAV10.connect(setup.creator).publish(p)).wait();

    const feePaid = (await Token.balanceOf(treasury.address)) - treasuryBefore;
    const netToStakers = (await Token.balanceOf(cssAddr)) - cssBefore;
    const creatorSpent =
      creatorBefore - (await Token.balanceOf(setup.creator.address));

    expect(feePaid).to.equal(expectedFee);
    expect(netToStakers).to.equal(expectedNet);
    // Conservation: the fee is carved OUT of the gross (not added on top);
    // the publisher pays exactly the gross and nothing is minted/burned.
    expect(feePaid + netToStakers).to.equal(tokenAmount);
    expect(creatorSpent).to.equal(tokenAmount);
  });

  it('treasury: with no recipient wired (shipping default) the FULL gross reaches stakers', async () => {
    const setup = await setupRegisteredAgentPublish();

    // Default deploy: protocolTreasury == address(0) with a NON-zero default
    // bps. `_treasuryFee` must short-circuit to (0, address(0)) so the fee
    // stays dormant and the entire gross flows to the staker pool. This is
    // the path almost every mainnet publish takes today.
    const Parameters =
      await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
    expect(await Parameters.protocolTreasury()).to.equal(ethers.ZeroAddress);
    expect(await Parameters.protocolTreasuryFee()).to.be.greaterThan(0n);

    const tokenAmount = ethers.parseEther('1000');
    await Token.mint(setup.creator.address, tokenAmount);
    await Token.connect(setup.creator).approve(
      await KAV10.getAddress(),
      tokenAmount,
    );

    const cssAddr = await ConvictionStakingStorage.getAddress();
    const cssBefore = await Token.balanceOf(cssAddr);

    const p = await buildBasePublishParams(setup, 'treasury-dormant', {
      epochs: setup.epochs + 1,
      tokenAmount,
    });
    await (await KAV10.connect(setup.creator).publish(p)).wait();

    expect((await Token.balanceOf(cssAddr)) - cssBefore).to.equal(tokenAmount);
  });

  // --------------------------------------------------------------------------
  // 6. Update happy-path: kaId/owner stable, merkle-root history grows
  // --------------------------------------------------------------------------
  //
  // The only update coverage before this was the owner-gate REVERT. The
  // success path — a metadata-only update mutates the KA in place, never
  // mints a new id, never changes the owner, and appends to the merkle-root
  // chain — was untested. A regression that minted a fresh kaId on update,
  // overwrote (rather than appended) the merkle root, or reassigned
  // ownership would slip through. `newTokenAmount == current` keeps delta at
  // zero so the update charges nothing (no PCA / approval plumbing needed).

  it('update: metadata-only update keeps kaId + owner stable and appends to the merkle-root history', async () => {
    const setup = await setupRegisteredAgentPublish();

    const publishMerkleRoot = ethers.keccak256(
      ethers.toUtf8Bytes('update-happy-publish'),
    );
    const tokenAmount = ethers.parseEther('1000');
    const p = await buildBasePublishParams(setup, 'update-happy', {
      merkleRoot: publishMerkleRoot,
      tokenAmount,
    });
    await (await KAV10.connect(setup.creator).publish(p)).wait();

    // OT-RFC-43 Option 1 (1a): minted kaId == packed reservedKaId.
    const kaId = BigInt(p.reservedKaId);
    expect(await DKGKnowledgeAssets.ownerOf(kaId)).to.equal(
      setup.creator.address,
    );
    // Fresh KA: exactly one merkle root, equal to the publish root.
    expect((await DKGKnowledgeAssets.getMerkleRoots(kaId)).length).to.equal(1);
    expect(await DKGKnowledgeAssets.getLatestMerkleRoot(kaId)).to.equal(
      publishMerkleRoot,
    );

    // Metadata-only update: SAME tokenAmount (delta 0 → no payment) + SAME
    // byteSize; only the merkle root rolls forward. preUpdateMerkleRootCount
    // = 1 pins the optimistic-concurrency version the ACK quorum signs over.
    const newMerkleRoot = ethers.keccak256(
      ethers.toUtf8Bytes('update-happy-v2'),
    );
    const up = await buildUpdateParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes: setup.receivingNodes,
      publisherIdentityId: setup.publisherIdentityId,
      receiverIdentityIds: setup.receiverIdentityIds,
      contextGraphId: setup.cgId,
      id: kaId,
      preUpdateMerkleRootCount: 1n,
      newMerkleRoot,
      newByteSize: 1000n,
      newTokenAmount: tokenAmount, // delta 0 — metadata-only
      mintKnowledgeAssetsAmount: 0n,
      knowledgeAssetsToBurn: [],
      updateOperationId: 'update-happy-op',
      author: setup.creator, // KA owner signs the EIP-712 update attestation
    });
    await (await KAV10.connect(setup.creator).update(up)).wait();

    // kaId stable: update mutates in place, never mints a new id. OT-RFC-43
    // Option 1 (1a): the KA is still owned at the SAME packed id (no new mint).
    expect(await DKGKnowledgeAssets.ownerOf(kaId)).to.equal(
      setup.creator.address,
    );
    // Owner stable across the update.
    expect(await DKGKnowledgeAssets.ownerOf(kaId)).to.equal(
      setup.creator.address,
    );
    // Merkle-root history GREW by exactly one; the new root is appended last.
    const roots = await DKGKnowledgeAssets.getMerkleRoots(kaId);
    expect(roots.length).to.equal(2);
    expect(roots[0].merkleRoot).to.equal(publishMerkleRoot);
    expect(roots[1].merkleRoot).to.equal(newMerkleRoot);
    expect(await DKGKnowledgeAssets.getLatestMerkleRoot(kaId)).to.equal(
      newMerkleRoot,
    );
    // tokenAmount unchanged (delta 0).
    const meta = await DKGKnowledgeAssets.getKnowledgeAssetMetadata(kaId);
    expect(meta[6]).to.equal(tokenAmount);
  });

  // --------------------------------------------------------------------------
  // 7. OT-RFC-43 Option 1 (variant 1a) — caller-supplied, author-namespaced
  //    KA ids (§B5). The KA id is now a deterministic packed value
  //    `(uint160(author) << 96) | uint96(number)` chosen off-chain. KAS
  //    enforces `(reservedKaId >> 96) == author` (the EIP-712 attestation
  //    signer / NFT mint recipient, NOT msg.sender) so a wallet can only mint
  //    in its own namespace; a re-used id reverts (no silent clobber); the old
  //    global counter getter is deprecated; and ownership (OT-RFC-45) survives
  //    NFT transfer under the new id scheme.
  // --------------------------------------------------------------------------

  // Direct-spend funding for a publisher that is NOT a registered agent:
  // mint the gross + approve KAV10 so `_addTokens` can pull it.
  const fundDirectSpend = async (
    publisher: SignerWithAddress,
    amount: bigint,
  ) => {
    await Token.mint(publisher.address, amount);
    await Token.connect(publisher).approve(await KAV10.getAddress(), amount);
  };

  it('B5(a): publish with a valid packed reservedKaId mints kaId == reservedKaId and ownerOf == the attested AUTHOR (not msg.sender/publisher)', async () => {
    const setup = await setupRegisteredAgentPublish();

    // publisher (msg.sender) != author. The open CG authorizes any non-zero
    // publisher; the publisher is NOT a registered agent + epochs is off the
    // discount tier, so payment runs through the direct-spend branch against
    // the publisher's own wallet. The author only signs the EIP-712
    // attestation and is the ERC-721 mint recipient.
    const publisher = accounts[10];
    const author = accounts[11];
    expect(publisher.address).to.not.equal(author.address);
    expect(publisher.address).to.not.equal(setup.creator.address);

    const tokenAmount = ethers.parseEther('1000');
    const reservedKaId = packReservedKaId(author.address, 7);
    await fundDirectSpend(publisher, tokenAmount);

    const p = await buildBasePublishParams(setup, 'b5-a-author-namespaced', {
      author, // EIP-712 attestation signer + NFT mint recipient
      epochs: setup.epochs + 1, // off the PCA discount tier → direct-spend
      tokenAmount,
      reservedKaId,
    });

    await (await KAV10.connect(publisher).publish(p)).wait();

    // The minted id is EXACTLY the supplied reservedKaId.
    expect(BigInt(p.reservedKaId)).to.equal(reservedKaId);
    // High 160 bits == the AUTHOR, not the publisher/msg.sender.
    expect(reservedKaId >> 96n).to.equal(BigInt(author.address));
    expect(reservedKaId >> 96n).to.not.equal(BigInt(publisher.address));
    // NFT minted to the attested author (OT-RFC-43: namespace binds to author).
    expect(await DKGKnowledgeAssets.ownerOf(reservedKaId)).to.equal(
      author.address,
    );
  });

  it('B5(b): a reservedKaId whose high bits != author reverts KaIdNamespaceMismatch', async () => {
    const setup = await setupRegisteredAgentPublish();

    // Pack the id in a DIFFERENT address's namespace than the attested author
    // (setup.creator). The contract recomputes `kaId >> 96` and compares it to
    // the attested author, so this is rejected before any mint.
    const otherAddr = accounts[12];
    expect(otherAddr.address).to.not.equal(setup.creator.address);
    const wrongNamespaceId = packReservedKaId(otherAddr.address, 1);

    const p = await buildBasePublishParams(setup, 'b5-b-wrong-namespace', {
      reservedKaId: wrongNamespaceId,
    });

    await expect(KAV10.connect(setup.creator).publish(p))
      .to.be.revertedWithCustomError(
        DKGKnowledgeAssets,
        'KaIdNamespaceMismatch',
      )
      .withArgs(wrongNamespaceId, setup.creator.address);

    // Nothing minted under the foreign id.
    await expect(
      DKGKnowledgeAssets.ownerOf(wrongNamespaceId),
    ).to.be.revertedWithCustomError(
      DKGKnowledgeAssets,
      'ERC721NonexistentToken',
    );
  });

  it('B5(f): a delegated publisher cannot swap the author-signed reservedKaId to another number in the same namespace (OT-RFC-43 §F2 digest binding)', async () => {
    const setup = await setupRegisteredAgentPublish();

    // The author (setup.creator) signs an attestation that binds slot #7.
    const signedKaId = packReservedKaId(setup.creator.address, 7);
    const p = await buildBasePublishParams(setup, 'b5-f-signed-slot-7', {
      reservedKaId: signedKaId,
    });

    // A relay/publisher tampers the publish to mint at slot #99 instead —
    // still inside the author's OWN namespace, so the `(kaId >> 96) == author`
    // guard would pass. Pre-F2 the author signature covered only the content,
    // so this substitution succeeded. With `reservedKaId` bound into the
    // EIP-712 digest, the recomputed digest no longer recovers to the author.
    const substitutedKaId = packReservedKaId(setup.creator.address, 99);
    expect(substitutedKaId >> 96n).to.equal(BigInt(setup.creator.address));
    const tampered = { ...p, reservedKaId: substitutedKaId };

    await expect(
      KAV10.connect(setup.creator).publish(tampered),
    ).to.be.revertedWithCustomError(KAV10, 'InvalidAuthorSignature');

    // Neither the signed nor the substituted slot was minted.
    for (const id of [signedKaId, substitutedKaId]) {
      await expect(
        DKGKnowledgeAssets.ownerOf(id),
      ).to.be.revertedWithCustomError(
        DKGKnowledgeAssets,
        'ERC721NonexistentToken',
      );
    }
  });

  it('B5(c): reusing the same (author, number) reverts KaIdAlreadyMinted on the second publish (no silent clobber)', async () => {
    const setup = await setupRegisteredAgentPublish();

    // First publish claims the packed id and mints it to the author.
    const reservedKaId = packReservedKaId(setup.creator.address, 42);
    const p1 = await buildBasePublishParams(setup, 'b5-c-first', {
      reservedKaId,
    });
    await (await KAV10.connect(setup.creator).publish(p1)).wait();
    expect(await DKGKnowledgeAssets.ownerOf(reservedKaId)).to.equal(
      setup.creator.address,
    );

    // Second publish reuses the EXACT same reservedKaId (same author + number)
    // with a fresh merkle root / operation id. The id is already minted, so it
    // must revert — not silently overwrite the existing KA.
    const p2 = await buildBasePublishParams(setup, 'b5-c-second', {
      reservedKaId,
    });
    await expect(KAV10.connect(setup.creator).publish(p2))
      .to.be.revertedWithCustomError(DKGKnowledgeAssets, 'KaIdAlreadyMinted')
      .withArgs(reservedKaId);

    // The original KA is untouched: still exactly one merkle root, the first.
    const roots = await DKGKnowledgeAssets.getMerkleRoots(reservedKaId);
    expect(roots.length).to.equal(1);
    expect(roots[0].merkleRoot).to.equal(
      ethers.keccak256(ethers.toUtf8Bytes('b5-c-first')),
    );
  });

  it('B5(d): getLatestKnowledgeAssetId() is deprecated and always reverts GetLatestKnowledgeAssetIdDeprecated', async () => {
    // The global sequential counter is gone under Option 1 — packed ids are
    // not enumerable through a single "latest id". The getter must revert
    // regardless of how many KAs exist (pure function: even on a clean state).
    await expect(
      DKGKnowledgeAssets.getLatestKnowledgeAssetId(),
    ).to.be.revertedWithCustomError(
      DKGKnowledgeAssets,
      'GetLatestKnowledgeAssetIdDeprecated',
    );

    // Still reverts after a successful publish (the count changed, the getter
    // did not come back).
    const setup = await setupRegisteredAgentPublish();
    const p = await buildBasePublishParams(setup, 'b5-d-deprecated');
    await (await KAV10.connect(setup.creator).publish(p)).wait();
    await expect(
      DKGKnowledgeAssets.getLatestKnowledgeAssetId(),
    ).to.be.revertedWithCustomError(
      DKGKnowledgeAssets,
      'GetLatestKnowledgeAssetIdDeprecated',
    );
  });

  it('B5(e): update stays owner-only across an NFT transfer — old author reverts NotKnowledgeAssetOwner, new owner succeeds', async () => {
    const setup = await setupRegisteredAgentPublish();

    // Publish: author (setup.creator) owns the freshly minted KA NFT.
    const publishRoot = ethers.keccak256(ethers.toUtf8Bytes('b5-e-publish'));
    const tokenAmount = ethers.parseEther('1000');
    const reservedKaId = packReservedKaId(setup.creator.address, 99);
    const p = await buildBasePublishParams(setup, 'b5-e-publish', {
      merkleRoot: publishRoot,
      tokenAmount,
      reservedKaId,
    });
    await (await KAV10.connect(setup.creator).publish(p)).wait();
    const kaId = reservedKaId;
    expect(await DKGKnowledgeAssets.ownerOf(kaId)).to.equal(
      setup.creator.address,
    );

    // Transfer the KA NFT to a new owner. The kaId is unchanged (the packed id
    // is the ERC-721 tokenId); only the owner moves.
    const newOwner = accounts[13];
    expect(newOwner.address).to.not.equal(setup.creator.address);
    await DKGKnowledgeAssets.connect(setup.creator).transferFrom(
      setup.creator.address,
      newOwner.address,
      kaId,
    );
    expect(await DKGKnowledgeAssets.ownerOf(kaId)).to.equal(newOwner.address);

    // (1) An update attested by the OLD author (no longer the owner) reverts
    //     NotKnowledgeAssetOwner — owner-only survives the NFT transfer.
    const staleRoot = ethers.keccak256(ethers.toUtf8Bytes('b5-e-stale'));
    const staleUpdate = await buildUpdateParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes: setup.receivingNodes,
      publisherIdentityId: setup.publisherIdentityId,
      receiverIdentityIds: setup.receiverIdentityIds,
      contextGraphId: setup.cgId,
      id: kaId,
      preUpdateMerkleRootCount: 1n,
      newMerkleRoot: staleRoot,
      newByteSize: 1000n,
      newTokenAmount: tokenAmount, // delta 0 — metadata-only, no payment
      mintKnowledgeAssetsAmount: 0n,
      knowledgeAssetsToBurn: [],
      updateOperationId: 'b5-e-stale-op',
      author: setup.creator, // old author signs — now NOT the owner
    });
    await expect(KAV10.connect(setup.creator).update(staleUpdate))
      .to.be.revertedWithCustomError(KAV10, 'NotKnowledgeAssetOwner')
      .withArgs(kaId, newOwner.address, setup.creator.address);

    // (2) An update attested by the NEW owner succeeds — the merkle-root
    //     history grows and the new root is appended.
    const newRoot = ethers.keccak256(ethers.toUtf8Bytes('b5-e-new'));
    const newOwnerUpdate = await buildUpdateParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes: setup.receivingNodes,
      publisherIdentityId: setup.publisherIdentityId,
      receiverIdentityIds: setup.receiverIdentityIds,
      contextGraphId: setup.cgId,
      id: kaId,
      preUpdateMerkleRootCount: 1n,
      newMerkleRoot: newRoot,
      newByteSize: 1000n,
      newTokenAmount: tokenAmount, // delta 0 — metadata-only, no payment
      mintKnowledgeAssetsAmount: 0n,
      knowledgeAssetsToBurn: [],
      updateOperationId: 'b5-e-new-op',
      author: newOwner, // new owner signs + owns → passes both gates
    });
    await (await KAV10.connect(newOwner).update(newOwnerUpdate)).wait();

    // Owner unchanged by the update; merkle-root history grew by one.
    expect(await DKGKnowledgeAssets.ownerOf(kaId)).to.equal(newOwner.address);
    const roots = await DKGKnowledgeAssets.getMerkleRoots(kaId);
    expect(roots.length).to.equal(2);
    expect(roots[0].merkleRoot).to.equal(publishRoot);
    expect(roots[1].merkleRoot).to.equal(newRoot);
  });

  // --------------------------------------------------------------------------
  // OT-RFC-53 — registration-deposit WAIVER for PCA-backed CGs.
  // A CG whose publish authority is a PCA the CREATOR owns or is a registered
  // agent of pays NO separate 100-TRAC deposit: the PCA already locks real TRAC
  // (the anti-spam stake) and funds the CG's publishing. Caller authz is owner
  // OR registered agent — NOT merely authority==owner (that would let a third
  // party dodge the deposit against someone else's PCA).
  // --------------------------------------------------------------------------
  describe('OT-RFC-53 deposit waiver for PCA-backed CGs', () => {
    const DEPOSIT = ethers.parseEther('100');

    const setDeposit = async () => {
      const Params = await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
      await Params.connect(accounts[0]).setContextGraphRegistrationDeposit(DEPOSIT);
    };
    // Curated CG (publishPolicy 0) whose authority is `owner` and which is
    // bound to PCA `accountId` — the PCA-authority shape the waiver keys on.
    const createPcaCg = (caller: SignerWithAddress, owner: SignerWithAddress, accountId: bigint) =>
      CGFacade.connect(caller).createContextGraph([], 0, 1, 0, owner.address, accountId, ethers.ZeroHash);

    it('WAIVES the deposit when the PCA OWNER creates the CG (no TRAC pulled)', async () => {
      await setDeposit();
      const owner = accounts[1];
      const accountId = await createAccountFor(owner);
      const before = await Token.balanceOf(owner.address); // owner funded nothing for a deposit

      await expect(createPcaCg(owner, owner, accountId))
        .to.emit(CGFacade, 'ContextGraphRegistrationDepositWaived')
        .and.not.to.emit(CGFacade, 'ContextGraphRegistrationDeposited');

      const cgId = await CGS.getLatestContextGraphId();
      expect(await CGS.getRegistrationEscrow(cgId)).to.equal(0n); // no escrow
      expect(await Token.balanceOf(owner.address)).to.equal(before); // nothing pulled
    });

    it('WAIVES the deposit when a REGISTERED AGENT of the PCA creates the CG', async () => {
      await setDeposit();
      const owner = accounts[1];
      const agent = accounts[3];
      const accountId = await createAccountFor(owner);
      await NFT.connect(owner).registerAgent(accountId, agent.address);
      expect(await NFT.agentToAccountId(agent.address)).to.equal(accountId);

      const before = await Token.balanceOf(agent.address);
      await expect(createPcaCg(agent, owner, accountId)) // authority must be the owner (coherence)
        .to.emit(CGFacade, 'ContextGraphRegistrationDepositWaived');

      const cgId = await CGS.getLatestContextGraphId();
      expect(await CGS.getRegistrationEscrow(cgId)).to.equal(0n);
      expect(await Token.balanceOf(agent.address)).to.equal(before);
    });

    it('does NOT waive for a non-owner non-agent — the deposit is still charged (caller guard)', async () => {
      await setDeposit();
      const owner = accounts[1];
      const stranger = accounts[4];
      const accountId = await createAccountFor(owner);

      // Stranger sets authority=owner so the coherence gate passes, but is
      // neither owner nor a registered agent → must pay. Unfunded → revert.
      await expect(createPcaCg(stranger, owner, accountId)).to.be.reverted;

      // Funded + approved, the stranger CAN create it — but is CHARGED (not waived).
      await Token.mint(stranger.address, DEPOSIT);
      await Token.connect(stranger).approve(await CGFacade.getAddress(), DEPOSIT);
      await expect(createPcaCg(stranger, owner, accountId))
        .to.emit(CGFacade, 'ContextGraphRegistrationDeposited')
        .and.not.to.emit(CGFacade, 'ContextGraphRegistrationDepositWaived');
      const cgId = await CGS.getLatestContextGraphId();
      expect(await CGS.getRegistrationEscrow(cgId)).to.equal(DEPOSIT);
    });

    it('does NOT waive a CG with no PCA (accountId 0) — normal deposit applies', async () => {
      await setDeposit();
      const creator = accounts[5];
      // No PCA designated → unfunded create reverts (deposit charged, not waived).
      await expect(
        CGFacade.connect(creator).createContextGraph([], 0, 0, 1, ethers.ZeroAddress, 0, ethers.ZeroHash),
      ).to.be.reverted;
    });
  });
});
