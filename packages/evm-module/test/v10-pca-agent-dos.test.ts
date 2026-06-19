// =============================================================================
// V10 PCA — consent-free agent-registration DoS regression (audit fix)
// =============================================================================
//
// Agent registration on a publishing-conviction account (PCA) is
// permissionless and requires NO consent from the agent (RFC-001 §3.6).
// `registerAgent` only checks that the caller owns the PCA being registered
// against — the `agent` address is an arbitrary value the caller types in,
// and `agentToAccountId` is a single GLOBAL reverse map. So any unprivileged
// party can:
//
//   1. createAccount(1 wei)             -> active PCA, baseAllowance = 1/12 = 0
//   2. registerAgent(theirAccountId, victim)   (no victim consent needed)
//
// and thereby point `agentToAccountId[victim]` at their own deliberately
// underfunded account. Pre-fix, the victim's publish (with
// `epochs == lockDurationEpochs`) and EVERY paid update routed into
// `coverPublishingCost`, hit `InsufficientAllowance`, and REVERTED — a
// near-permanent brick for ~1 wei + gas. The victim cannot self-deregister
// (owner-gated) nor re-route the global slot.
//
// The fix makes the conviction branch FALL THROUGH to direct spend on the
// PCA-side payment errors (`InsufficientAllowance` / `AccountExpired`) instead
// of reverting, so a consent-free registration can never block a publisher;
// it just loses the (non-existent) discount and the victim pays full price.
//
// Coverage in this suite:
//   - publish()  under an attacker-registered, underfunded PCA  -> direct spend
//   - update()   under an attacker-registered, underfunded PCA  -> direct spend
//   - publish()  under an attacker-registered, EXPIRED PCA      -> direct spend
//   - the fall-through is not a free pass (unfunded victim still reverts)

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  Chronos,
  ContextGraphs,
  ContextGraphStorage,
  DKGKnowledgeAssets,
  DKGPublishingConvictionNFT,
  DKGStakingConvictionNFT,
  EpochStorage,
  Hub,
  KnowledgeAssetsLifecycle,
  Profile,
  StakingV10,
  Token,
} from '../typechain';
import { createProfile, createProfiles } from './helpers/profile-helpers';
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

const MIN_STAKE = ethers.parseEther('50000');

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  Token: Token;
  Chronos: Chronos;
  Profile: Profile;
  StakingV10: StakingV10;
  StakingNFT: DKGStakingConvictionNFT;
  KnowledgeAssetsLifecycle: KnowledgeAssetsLifecycle;
  DKGKnowledgeAssets: DKGKnowledgeAssets;
  EpochStorage: EpochStorage;
  ContextGraphs: ContextGraphs;
  ContextGraphStorage: ContextGraphStorage;
  NFT: DKGPublishingConvictionNFT;
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
    StakingV10: await hre.ethers.getContract<StakingV10>('StakingV10'),
    StakingNFT: await hre.ethers.getContract<DKGStakingConvictionNFT>(
      'DKGStakingConvictionNFT',
    ),
    KnowledgeAssetsLifecycle:
      await hre.ethers.getContract<KnowledgeAssetsLifecycle>(
        'KnowledgeAssetsLifecycle',
      ),
    DKGKnowledgeAssets: await hre.ethers.getContract<DKGKnowledgeAssets>(
      'DKGKnowledgeAssets',
    ),
    EpochStorage: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
    ContextGraphs: await hre.ethers.getContract<ContextGraphs>('ContextGraphs'),
    ContextGraphStorage: await hre.ethers.getContract<ContextGraphStorage>(
      'ContextGraphStorage',
    ),
    NFT: await hre.ethers.getContract<DKGPublishingConvictionNFT>(
      'DKGPublishingConvictionNFT',
    ),
  };
}

describe('@integration V10 PCA — consent-free agent DoS (audit fix)', function () {
  let accounts: SignerWithAddress[];
  let Token: Token;
  let Chronos: Chronos;
  let ProfileContract: Profile;
  let StakingV10Contract: StakingV10;
  let StakingNFT: DKGStakingConvictionNFT;
  let KAV10: KnowledgeAssetsLifecycle;
  let DKGKnowledgeAssets: DKGKnowledgeAssets;
  let EpochStorageContract: EpochStorage;
  let CGFacade: ContextGraphs;
  let CGS: ContextGraphStorage;
  let NFT: DKGPublishingConvictionNFT;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      Token,
      Chronos,
      Profile: ProfileContract,
      StakingV10: StakingV10Contract,
      StakingNFT,
      KnowledgeAssetsLifecycle: KAV10,
      DKGKnowledgeAssets,
      EpochStorage: EpochStorageContract,
      ContextGraphs: CGFacade,
      ContextGraphStorage: CGS,
      NFT,
    } = await loadFixture(deployFixture));
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

  // Publisher + 3 receiver profiles, all V10-staked above the ACK signer gate.
  const standUpNodes = async () => {
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts);
    const { identityId: publisherIdentityId } = await createProfile(
      ProfileContract,
      publishingNode,
    );
    const receiverProfiles = await createProfiles(ProfileContract, receivingNodes);
    const receiverIdentityIds = receiverProfiles.map((p) => p.identityId);

    await stakeV10(publishingNode.operational, publisherIdentityId, MIN_STAKE);
    for (let i = 0; i < receivingNodes.length; i++) {
      await stakeV10(
        receivingNodes[i].operational,
        receiverProfiles[i].identityId,
        MIN_STAKE,
      );
    }
    return { receivingNodes, publisherIdentityId, receiverIdentityIds };
  };

  // Attacker mints a 1-wei PCA (baseAllowance = 1/lockDurationEpochs = 0) and
  // registers the victim as a paying agent — no victim consent involved.
  const attackerSquats = async (
    attacker: SignerWithAddress,
    victim: SignerWithAddress,
  ) => {
    await Token.mint(attacker.address, 1n);
    await Token.connect(attacker).approve(await NFT.getAddress(), 1n);
    // RFC-51: createAccount(committedTRAC, primaryNode); inert node = 0.
    await NFT.connect(attacker).createAccount(1n, 0);
    const accountId = await NFT.totalSupply();
    await NFT.connect(attacker).registerAgent(accountId, victim.address);
    expect(await NFT.agentToAccountId(victim.address)).to.equal(accountId);
    const lockDurationEpochs = Number((await NFT.accounts(accountId))[5]);
    return { accountId, lockDurationEpochs };
  };

  // Open-publish-policy context graph owned by `owner` (authorizes any
  // non-zero publisher, including the victim).
  const openContextGraphFor = async (owner: SignerWithAddress) => {
    await CGFacade.connect(owner).createContextGraph(
      [],
      0,
      0,
      1, // open publish policy
      ethers.ZeroAddress,
      0,
      ethers.ZeroHash,
    );
    const cgId = await CGS.getLatestContextGraphId();
    expect(await CGFacade.isAuthorizedPublisher(cgId, owner.address)).to.be.true;
    return cgId;
  };

  // Fund + execute a victim-authored publish that pays via DIRECT spend.
  const victimPublish = async (args: {
    victim: SignerWithAddress;
    cgId: bigint;
    epochs: number;
    tokenAmount: bigint;
    kaNumber: number;
    nodes: Awaited<ReturnType<typeof standUpNodes>>;
    opId: string;
  }) => {
    await Token.mint(args.victim.address, args.tokenAmount);
    await Token.connect(args.victim).approve(
      await KAV10.getAddress(),
      args.tokenAmount,
    );
    const reservedKaId = packReservedKaId(args.victim.address, args.kaNumber);
    const p = await buildPublishParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes: args.nodes.receivingNodes,
      publisherIdentityId: args.nodes.publisherIdentityId,
      receiverIdentityIds: args.nodes.receiverIdentityIds,
      author: args.victim,
      contextGraphId: args.cgId,
      merkleRoot: ethers.keccak256(ethers.toUtf8Bytes(args.opId)),
      knowledgeAssetsAmount: 1,
      byteSize: 1000,
      epochs: args.epochs,
      tokenAmount: args.tokenAmount,
      isImmutable: false,
      publishOperationId: args.opId,
      reservedKaId,
    });
    await (await KAV10.connect(args.victim).publish(p)).wait();
    return reservedKaId;
  };

  // --------------------------------------------------------------------------
  // publish() fall-through under an underfunded squatted PCA
  // --------------------------------------------------------------------------
  it('publish: attacker-registered underfunded PCA no longer bricks the victim (falls through to direct spend)', async () => {
    const nodes = await standUpNodes();
    const attacker = accounts[8];
    const victim = getDefaultKACreator(accounts); // accounts[9]

    const { accountId, lockDurationEpochs } = await attackerSquats(
      attacker,
      victim,
    );
    const cgId = await openContextGraphFor(victim);

    // epochs == lockDurationEpochs ⇒ conviction gate ACTIVE ⇒ the publish MUST
    // enter coverPublishingCost and rely on the fall-through (not skip the gate).
    const tokenAmount = ethers.parseEther('1000');
    await Token.mint(victim.address, tokenAmount);
    await Token.connect(victim).approve(await KAV10.getAddress(), tokenAmount);

    const reservedKaId = packReservedKaId(victim.address, 1);
    const p = await buildPublishParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes: nodes.receivingNodes,
      publisherIdentityId: nodes.publisherIdentityId,
      receiverIdentityIds: nodes.receiverIdentityIds,
      author: victim,
      contextGraphId: cgId,
      merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('pca-dos-publish')),
      knowledgeAssetsAmount: 1,
      byteSize: 1000,
      epochs: lockDurationEpochs,
      tokenAmount,
      isImmutable: false,
      publishOperationId: 'pca-dos-publish-op',
      reservedKaId,
    });

    const balBefore = await Token.balanceOf(victim.address);
    const tx = await KAV10.connect(victim).publish(p); // pre-fix: reverts
    expect((await tx.wait())!.status).to.equal(1);

    // Direct-spend proof: the victim's OWN TRAC funded the publish (a discount
    // branch would have drawn from the PCA escrow — and couldn't succeed on a
    // 1-wei account anyway).
    expect(balBefore - (await Token.balanceOf(victim.address))).to.equal(
      tokenAmount,
    );
    expect(await DKGKnowledgeAssets.ownerOf(reservedKaId)).to.equal(
      victim.address,
    );
    // Squat survives (consent-free registration is not auto-removed) but is now
    // harmless — the victim published.
    expect(await NFT.agentToAccountId(victim.address)).to.equal(accountId);
  });

  // --------------------------------------------------------------------------
  // update() fall-through under an underfunded squatted PCA
  // --------------------------------------------------------------------------
  //
  // The update gate has NO epoch-match escape (`remainingEpochs <=
  // lockDurationEpochs`), so EVERY paid update on a squatted address routed
  // into coverPublishingCost pre-fix. This pins the update() branch.
  it('update: attacker-registered underfunded PCA no longer bricks a paid victim update', async () => {
    const nodes = await standUpNodes();
    const attacker = accounts[8];
    const victim = getDefaultKACreator(accounts);

    const cgId = await openContextGraphFor(victim);
    const initialTokenAmount = ethers.parseEther('1000');

    // Create the attacker's 1-wei PCA but DON'T register the victim yet, so the
    // victim's initial publish is an ordinary direct spend. We read the global
    // lock duration off this account so the publish/update epoch counts keep
    // the conviction gate active once the victim IS registered.
    await Token.mint(attacker.address, 1n);
    await Token.connect(attacker).approve(await NFT.getAddress(), 1n);
    // RFC-51: createAccount(committedTRAC, primaryNode); inert node = 0.
    await NFT.connect(attacker).createAccount(1n, 0);
    const attackerAccountId = await NFT.totalSupply();
    const lockEpochs = Number((await NFT.accounts(attackerAccountId))[5]);

    const kaId = await victimPublish({
      victim,
      cgId,
      epochs: lockEpochs,
      tokenAmount: initialTokenAmount,
      kaNumber: 5,
      nodes,
      opId: 'pca-dos-update-base',
    });

    // Now spring the trap: register the victim against the 1-wei PCA.
    await NFT.connect(attacker).registerAgent(attackerAccountId, victim.address);
    expect(await NFT.agentToAccountId(victim.address)).to.equal(
      attackerAccountId,
    );

    // A paid update (grow tokenAmount). remainingEpochs == lockEpochs ⇒ gate
    // ACTIVE ⇒ enters coverPublishingCost and relies on the fall-through.
    const delta = ethers.parseEther('250');
    const newTokenAmount = initialTokenAmount + delta;
    await Token.mint(victim.address, delta);
    await Token.connect(victim).approve(await KAV10.getAddress(), delta);

    const up = await buildUpdateParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes: nodes.receivingNodes,
      publisherIdentityId: nodes.publisherIdentityId,
      receiverIdentityIds: nodes.receiverIdentityIds,
      contextGraphId: cgId,
      id: kaId,
      preUpdateMerkleRootCount: 1n,
      newMerkleRoot: ethers.keccak256(ethers.toUtf8Bytes('pca-dos-update-new')),
      newByteSize: 1000n,
      newTokenAmount,
      mintKnowledgeAssetsAmount: 0n,
      knowledgeAssetsToBurn: [],
      updateOperationId: 'pca-dos-update-op',
      author: victim,
    });

    const balBefore = await Token.balanceOf(victim.address);
    const tx = await KAV10.connect(victim).update(up); // pre-fix: reverts
    expect((await tx.wait())!.status).to.equal(1);

    // The delta was paid from the victim's OWN TRAC (direct-spend fall-through).
    expect(balBefore - (await Token.balanceOf(victim.address))).to.equal(delta);
    const meta = await DKGKnowledgeAssets.getKnowledgeAssetMetadata(kaId);
    expect(meta[6]).to.equal(newTokenAmount);
  });

  // --------------------------------------------------------------------------
  // expired squatted PCA: publish still falls through (gate-level)
  // --------------------------------------------------------------------------
  //
  // The `AccountExpired` catch arm in `_coverViaConvictionOrFallThrough` is
  // defensive: the gate already drops the conviction branch once
  // `block.timestamp >= expiresAtTimestamp` (the SAME field
  // `coverPublishingCost` checks), so an expired squat falls through BEFORE
  // the external call. This test pins that partner protection — an expired
  // squatted registration must not brick the victim either.
  it('publish: expired squatted PCA falls through at the gate (expiry can never brick the victim)', async () => {
    const nodes = await standUpNodes();
    const attacker = accounts[8];
    const victim = getDefaultKACreator(accounts);

    const { lockDurationEpochs } = await attackerSquats(attacker, victim);
    const cgId = await openContextGraphFor(victim);

    // Advance past the PCA's expiry (lockDurationEpochs + 1 to clear the
    // expiry window plus chain-epoch drift).
    const epochLength = await Chronos.epochLength();
    await time.increase(Number(epochLength) * (lockDurationEpochs + 1));

    const tokenAmount = ethers.parseEther('1000');
    await Token.mint(victim.address, tokenAmount);
    await Token.connect(victim).approve(await KAV10.getAddress(), tokenAmount);

    const reservedKaId = packReservedKaId(victim.address, 9);
    const p = await buildPublishParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes: nodes.receivingNodes,
      publisherIdentityId: nodes.publisherIdentityId,
      receiverIdentityIds: nodes.receiverIdentityIds,
      author: victim,
      contextGraphId: cgId,
      merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('pca-dos-expired')),
      knowledgeAssetsAmount: 1,
      byteSize: 1000,
      epochs: lockDurationEpochs,
      tokenAmount,
      isImmutable: false,
      publishOperationId: 'pca-dos-expired-op',
      reservedKaId,
    });

    const balBefore = await Token.balanceOf(victim.address);
    expect((await (await KAV10.connect(victim).publish(p)).wait())!.status).to.equal(
      1,
    );
    expect(balBefore - (await Token.balanceOf(victim.address))).to.equal(
      tokenAmount,
    );
    expect(await DKGKnowledgeAssets.ownerOf(reservedKaId)).to.equal(
      victim.address,
    );
  });

  // --------------------------------------------------------------------------
  // the fall-through is not a free pass
  // --------------------------------------------------------------------------
  it('publish: fall-through still reverts for an unfunded victim (not a free publish)', async () => {
    const nodes = await standUpNodes();
    const attacker = accounts[8];
    const victim = getDefaultKACreator(accounts);

    const { lockDurationEpochs } = await attackerSquats(attacker, victim);
    const cgId = await openContextGraphFor(victim);

    const tokenAmount = ethers.parseEther('1000');
    // Victim intentionally NOT funded / NOT approved.
    const reservedKaId = packReservedKaId(victim.address, 13);
    const p = await buildPublishParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes: nodes.receivingNodes,
      publisherIdentityId: nodes.publisherIdentityId,
      receiverIdentityIds: nodes.receiverIdentityIds,
      author: victim,
      contextGraphId: cgId,
      merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('pca-dos-nofund')),
      knowledgeAssetsAmount: 1,
      byteSize: 1000,
      epochs: lockDurationEpochs,
      tokenAmount,
      isImmutable: false,
      publishOperationId: 'pca-dos-nofund-op',
      reservedKaId,
    });

    await expect(KAV10.connect(victim).publish(p)).to.be.revertedWithCustomError(
      KAV10,
      'TooLowAllowance',
    );
  });
});
