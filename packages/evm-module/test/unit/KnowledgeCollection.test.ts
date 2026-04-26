import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { kcTools } from 'assertion-tools';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  KnowledgeCollection,
  KnowledgeCollectionStorage,
  EpochStorage,
  AskStorage,
  Chronos,
  Token,
  ParametersStorage,
  IdentityStorage,
  Hub,
  Profile,
  Identity,
  Staking,
} from '../../typechain';
import {
  createKnowledgeCollection,
  getKCSignaturesData,
} from '../helpers/kc-helpers';
import { createProfile, createProfiles } from '../helpers/profile-helpers';
import {
  getDefaultPublishingNode,
  getDefaultReceivingNodes,
  getDefaultKCCreator,
} from '../helpers/setup-helpers';

type KnowledgeCollectionFixture = {
  accounts: SignerWithAddress[];
  KnowledgeCollection: KnowledgeCollection;
  KnowledgeCollectionStorage: KnowledgeCollectionStorage;
  EpochStorage: EpochStorage;
  AskStorage: AskStorage;
  Chronos: Chronos;
  Token: Token;
  ParametersStorage: ParametersStorage;
  IdentityStorage: IdentityStorage;
  Identity: Identity;
  Profile: Profile;
  Staking: Staking;
};

describe('@unit KnowledgeCollection', () => {
  let accounts: SignerWithAddress[];
  let KnowledgeCollection: KnowledgeCollection;
  let KnowledgeCollectionStorage: KnowledgeCollectionStorage;
  let EpochStorage: EpochStorage;
  let AskStorage: AskStorage;
  let Chronos: Chronos;
  let Token: Token;
  let ParametersStorage: ParametersStorage;
  let IdentityStorage: IdentityStorage;
  let Identity: Identity;
  let Profile: Profile;
  let Staking: Staking;

  async function deployKnowledgeCollectionFixture(): Promise<KnowledgeCollectionFixture> {
    await hre.deployments.fixture([
      'Token',
      'AskStorage',
      'EpochStorage',
      'KnowledgeCollection',
      'Chronos',
      'Profile',
      'Identity',
      'Staking',
    ]);

    accounts = await hre.ethers.getSigners();
    const Hub = await hre.ethers.getContract<Hub>('Hub');

    KnowledgeCollection = await hre.ethers.getContract<KnowledgeCollection>(
      'KnowledgeCollection',
    );
    KnowledgeCollectionStorage =
      await hre.ethers.getContract<KnowledgeCollectionStorage>(
        'KnowledgeCollectionStorage',
      );
    EpochStorage = await hre.ethers.getContract<EpochStorage>('EpochStorageV8');
    AskStorage = await hre.ethers.getContract<AskStorage>('AskStorage');
    Chronos = await hre.ethers.getContract<Chronos>('Chronos');
    Token = await hre.ethers.getContract<Token>('Token');
    ParametersStorage =
      await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
    IdentityStorage =
      await hre.ethers.getContract<IdentityStorage>('IdentityStorage');
    Identity = await hre.ethers.getContract<Identity>('Identity');
    Profile = await hre.ethers.getContract<Profile>('Profile');
    Staking = await hre.ethers.getContract<Staking>('Staking');

    await Hub.setContractAddress('HubOwner', accounts[0].address);

    return {
      accounts,
      KnowledgeCollection,
      KnowledgeCollectionStorage,
      EpochStorage,
      AskStorage,
      Chronos,
      Token,
      ParametersStorage,
      IdentityStorage,
      Profile,
      Identity,
      Staking,
    };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      KnowledgeCollection,
      KnowledgeCollectionStorage,
      EpochStorage,
      AskStorage,
      Chronos,
      Token,
      ParametersStorage,
      IdentityStorage,
      Profile,
    } = await loadFixture(deployKnowledgeCollectionFixture));
  });

  it('Should create a KC & distribute tokens fractionally across epochs', async () => {
    /* ---------- actors & helpers ---------- */
    const kcCreator = getDefaultKCCreator(accounts);
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts);
    const contracts = { Profile, KnowledgeCollection, Token };

    const { identityId: publishingNodeIdentityId } = await createProfile(
      Profile,
      publishingNode,
    );
    const receivingNodesIdentityIds = (
      await createProfiles(Profile, receivingNodes)
    ).map((p) => p.identityId);

    /* ---------- parameters ---------- */
    const tokenAmount = ethers.parseEther('100');
    const numberOfEpochs = 5n;
    const merkleRoot = kcTools.calculateMerkleRoot(
      ['<urn:x> <urn:y> <urn:z> .'],
      32,
    );

    /* ---------- epoch telemetry BEFORE tx ---------- */
    const currentEpoch = await Chronos.getCurrentEpoch();
    const epochLen = await Chronos.epochLength(); // bigint
    const timeLeft0 = await Chronos.timeUntilNextEpoch();
    const elapsed0 = epochLen - timeLeft0;
    const pct0 = Number((elapsed0 * 100n) / epochLen);

    console.log(
      `\n⏱️  BEFORE  | Epoch #${currentEpoch}: ` +
        `${elapsed0.toString()}s elapsed / ${epochLen.toString()}s  (${pct0}%)`,
    );

    /* ---------- create KC ---------- */
    const { collectionId } = await createKnowledgeCollection(
      kcCreator,
      publishingNode,
      publishingNodeIdentityId,
      receivingNodes,
      receivingNodesIdentityIds,
      contracts,
      merkleRoot,
      'test-operation-id',
      10,
      1000,
      Number(numberOfEpochs),
      tokenAmount,
      false,
      ethers.ZeroAddress,
    );
    expect(collectionId).to.equal(1);

    /* ---------- epoch telemetry AFTER tx ---------- */
    const timeLeft1 = await Chronos.timeUntilNextEpoch();
    const elapsed1 = epochLen - timeLeft1;
    const pct1 = Number((elapsed1 * 100n) / epochLen);
    const delta = elapsed1 - elapsed0;

    console.log(
      `⏱️  AFTER   | Epoch #${currentEpoch}: ` +
        `${elapsed1.toString()}s elapsed / ${epochLen.toString()}s  (${pct1}%)`,
    );
    console.log(
      `🕑  Δ during tx: ${delta.toString()}s (${Number((delta * 100n) / epochLen)}%)`,
    );

    /* ---------- metadata sanity ---------- */
    const meta =
      await KnowledgeCollectionStorage.getKnowledgeCollectionMetadata(1);
    expect(meta[4]).to.equal(currentEpoch);
    expect(meta[5]).to.equal(currentEpoch + numberOfEpochs);
    expect(meta[6]).to.equal(tokenAmount);

    /* ---------- expected distribution ---------- */
    const basePer = tokenAmount / numberOfEpochs;
    const curPart = (basePer * timeLeft1) / epochLen;
    let tailPart = basePer - curPart;
    const fullCnt = numberOfEpochs - 1n;
    const alloc = curPart + basePer * fullCnt + tailPart;
    if (alloc < tokenAmount) tailPart += tokenAmount - alloc;

    console.log('\n🧮  Expected token split');
    console.table({
      'current (fraction)': curPart.toString(),
      'full per epoch': basePer.toString(),
      'tail (fraction)': tailPart.toString(),
      'sum check': (curPart + basePer * fullCnt + tailPart).toString(),
    });

    /* ---------- on-chain pools & assertions ---------- */
    const pools: bigint[] = [];
    for (let i = 0n; i <= numberOfEpochs; i++) {
      const ep = currentEpoch + i;
      const p = await EpochStorage.getEpochPool(1, ep);
      pools.push(p);
      console.log(`epoch ${ep} ➜ ${p.toString()}`);
    }

    // current epoch
    expect(pools[0]).to.equal(curPart);

    // full middle epochs
    for (let i = 1; i < Number(numberOfEpochs); i++) {
      expect(pools[i]).to.equal(basePer);
    }

    // final fractional
    expect(pools[Number(numberOfEpochs)]).to.equal(tailPart);

    // beyond final
    expect(
      await EpochStorage.getEpochPool(1, currentEpoch + numberOfEpochs + 1n),
    ).to.equal(0);

    // sum check
    const total = pools.reduce((a, v) => a + v, 0n);
    expect(total).to.equal(tokenAmount);
  });

  it('Should revert if insufficient signatures provided', async () => {
    const kcCreator = getDefaultKCCreator(accounts);
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts);

    const { identityId: publisherIdentityId } = await createProfile(
      Profile,
      publishingNode,
    );

    const signaturesData = await getKCSignaturesData(
      publishingNode,
      publisherIdentityId,
      receivingNodes,
    );

    // Override receivers arrays to be empty
    const receiversIdentityIds: number[] = [];
    signaturesData.receiverRs = [];
    signaturesData.receiverVSs = [];

    // Approve tokens
    await Token.connect(kcCreator).increaseAllowance(
      KnowledgeCollection.getAddress(),
      ethers.parseEther('100'),
    );

    // Create knowledge collection
    await expect(
      KnowledgeCollection.connect(kcCreator).createKnowledgeCollection(
        'test-operation-id',
        signaturesData.merkleRoot,
        10,
        1000,
        2,
        ethers.parseEther('100'),
        false,
        ethers.ZeroAddress,
        publisherIdentityId,
        signaturesData.publisherR,
        signaturesData.publisherVS,
        receiversIdentityIds,
        signaturesData.receiverRs,
        signaturesData.receiverVSs,
      ),
    ).to.be.revertedWithCustomError(
      KnowledgeCollection,
      'MinSignaturesRequirementNotMet',
    );
  });

  it('Should revert when all receiver identities are the same', async () => {
    const minSigs = Number(await ParametersStorage.minimumRequiredSignatures());
    const kcCreator = getDefaultKCCreator(accounts);
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts, minSigs);

    const { identityId: publisherIdentityId } = await createProfile(
      Profile,
      publishingNode,
    );
    const receiverProfiles = await createProfiles(Profile, receivingNodes);

    const signaturesData = await getKCSignaturesData(
      publishingNode,
      publisherIdentityId,
      receivingNodes,
    );

    await Token.connect(kcCreator).increaseAllowance(
      KnowledgeCollection.getAddress(),
      ethers.parseEther('100'),
    );

    // TAMPER: fill all minSigs positions with receiver 0's identity and signature
    const dupReceiverIds = Array(minSigs).fill(receiverProfiles[0].identityId);
    const dupReceiverRs = Array(minSigs).fill(signaturesData.receiverRs[0]);
    const dupReceiverVSs = Array(minSigs).fill(signaturesData.receiverVSs[0]);

    await expect(
      KnowledgeCollection.connect(kcCreator).createKnowledgeCollection(
        'test-operation-id',
        signaturesData.merkleRoot,
        10,
        1000,
        2,
        ethers.parseEther('100'),
        false,
        ethers.ZeroAddress,
        publisherIdentityId,
        signaturesData.publisherR,
        signaturesData.publisherVS,
        dupReceiverIds,
        dupReceiverRs,
        dupReceiverVSs,
      ),
    ).to.be.revertedWith('Insufficient unique receiver identities');
  });

  it('Should accept KC when duplicates exist but enough unique identities remain', async () => {
    const minSigs = Number(await ParametersStorage.minimumRequiredSignatures());
    const kcCreator = getDefaultKCCreator(accounts);
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts, minSigs);

    const { identityId: publisherIdentityId } = await createProfile(
      Profile,
      publishingNode,
    );
    const receiverProfiles = await createProfiles(Profile, receivingNodes);

    const signaturesData = await getKCSignaturesData(
      publishingNode,
      publisherIdentityId,
      receivingNodes,
    );

    await Token.connect(kcCreator).increaseAllowance(
      KnowledgeCollection.getAddress(),
      ethers.parseEther('100'),
    );

    // minSigs+1 entries: receiver 0 duplicated once, all others unique → minSigs unique
    const mixedReceiverIds = [
      receiverProfiles[0].identityId,
      ...receiverProfiles.map((p) => p.identityId),
    ];
    const mixedReceiverRs = [
      signaturesData.receiverRs[0],
      ...signaturesData.receiverRs,
    ];
    const mixedReceiverVSs = [
      signaturesData.receiverVSs[0],
      ...signaturesData.receiverVSs,
    ];

    // Snapshot the counter pre-tx so the post-tx increment proves the
    // collection actually materialised on-chain — not just "the tx didn't
    // revert", which was the weak contract the earlier version of this
    // test locked in (plain `await tx.wait()` with no follow-up).
    const beforeId = await KnowledgeCollectionStorage.getLatestKnowledgeCollectionId();

    const tx = await KnowledgeCollection.connect(
      kcCreator,
    ).createKnowledgeCollection(
      'test-operation-id',
      signaturesData.merkleRoot,
      10,
      1000,
      2,
      ethers.parseEther('100'),
      false,
      ethers.ZeroAddress,
      publisherIdentityId,
      signaturesData.publisherR,
      signaturesData.publisherVS,
      mixedReceiverIds,
      mixedReceiverRs,
      mixedReceiverVSs,
    );
    await expect(tx).to.emit(
      KnowledgeCollectionStorage,
      'KnowledgeCollectionCreated',
    );

    const afterId = await KnowledgeCollectionStorage.getLatestKnowledgeCollectionId();
    expect(afterId).to.equal(beforeId + 1n);
  });

  it('Should create KC at ~half-epoch mark and distribute tokens correctly', async () => {
    /* ---------- actors ---------- */
    const kcCreator = getDefaultKCCreator(accounts);
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts);
    const contracts = { Profile, KnowledgeCollection, Token };

    const { identityId: pubNodeId } = await createProfile(
      Profile,
      publishingNode,
    );
    const recvIds = (await createProfiles(Profile, receivingNodes)).map(
      (p) => p.identityId,
    );

    /* ---------- params ---------- */
    const tokenAmount = ethers.parseEther('50');
    const numberOfEpochs = 3n;
    const merkleRoot = kcTools.calculateMerkleRoot(
      ['<urn:x> <urn:y> <urn:z> .'],
      32,
    );

    /* ---------- warp EVM to ~50 % of next epoch ---------- */
    const epochLen = await Chronos.epochLength(); // bigint
    const timeLeftInit = await Chronos.timeUntilNextEpoch(); // bigint

    // Δ = remaining-to-end + half epoch
    const delta = timeLeftInit + epochLen / 2n;
    await hre.ethers.provider.send('evm_increaseTime', [Number(delta)]);
    await hre.ethers.provider.send('evm_mine', []); // mine new block

    /* ---------- telemetry just before tx ---------- */
    const currentEpoch = await Chronos.getCurrentEpoch();
    const timeLeft0 = await Chronos.timeUntilNextEpoch();
    const elapsed0 = epochLen - timeLeft0;
    console.log(
      `\n⏱️  HALF-EPOCH TEST | Epoch #${currentEpoch}: ` +
        `${elapsed0.toString()}s elapsed of ${epochLen.toString()}s ` +
        `(~${Number((elapsed0 * 100n) / epochLen)}%)`,
    );

    /* ---------- create KC ---------- */
    const { collectionId } = await createKnowledgeCollection(
      kcCreator,
      publishingNode,
      pubNodeId,
      receivingNodes,
      recvIds,
      contracts,
      merkleRoot,
      'half-epoch-op',
      5, // knowledgeAssetsAmount
      500, // byteSize
      Number(numberOfEpochs),
      tokenAmount,
      false,
      ethers.ZeroAddress,
    );
    expect(collectionId).to.equal(1);

    /* ---------- compute expected parts (use on-chain timeLeft1) ---------- */
    const timeLeft1 = await Chronos.timeUntilNextEpoch();
    const basePer = tokenAmount / numberOfEpochs;
    const curPart = (basePer * timeLeft1) / epochLen;
    let tailPart = basePer - curPart;
    const fullCnt = numberOfEpochs - 1n;
    const alloc = curPart + basePer * fullCnt + tailPart;
    if (alloc < tokenAmount) tailPart += tokenAmount - alloc; // crumbs

    console.log('\n🧮  Expected split (half-epoch)');
    console.table({
      'current (fraction)': curPart.toString(),
      'full per epoch': basePer.toString(),
      'tail (fraction)': tailPart.toString(),
    });

    /* ---------- fetch pools ---------- */
    const pools: bigint[] = [];
    for (let i = 0n; i <= numberOfEpochs; i++) {
      pools.push(await EpochStorage.getEpochPool(1, currentEpoch + i));
    }
    pools.forEach((v, i) =>
      console.log(`epoch ${currentEpoch + BigInt(i)} ➜ ${v.toString()}`),
    );

    /* ---------- assertions ---------- */
    expect(pools[0]).to.equal(curPart); // fractional start
    for (let i = 1; i < Number(numberOfEpochs); i++)
      expect(pools[i]).to.equal(basePer); // full middles
    expect(pools[Number(numberOfEpochs)]).to.equal(tailPart); // fractional end
    expect(
      await EpochStorage.getEpochPool(1, currentEpoch + numberOfEpochs + 1n),
    ).to.equal(0); // nothing beyond

    const sum = pools.reduce((a, v) => a + v, 0n);
    expect(sum).to.equal(tokenAmount); // total check
  });

  /* =================================================================== */
  /* 1️⃣  REVERT-PATH: amount *too low*         */
  /* =================================================================== */
  it('Should revert when tokenAmount is lower than _validateTokenAmount expects', async () => {
    /* ---------- Test-local parameters ---------- */
    const askPerEpoch = ethers.parseEther('20'); // 20 TRAC/epoch
    const totalStake = ethers.parseEther('1'); // 1 TRAC stake
    await AskStorage.setWeightedActiveAskSum(askPerEpoch * totalStake);
    await AskStorage.setTotalActiveStake(totalStake);

    const byteSize = 1024; // 1 KiB
    const epochs = 5;
    const needTokens = ethers.parseEther('100'); // 20 × 5
    const fewTokens = ethers.parseEther('99'); // deliberately low

    /* ---------- Actors & signatures ---------- */
    const kcCreator = getDefaultKCCreator(accounts);
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts);

    const { identityId: publisherId } = await createProfile(
      Profile,
      publishingNode,
    );
    const receiverIds = (await createProfiles(Profile, receivingNodes)).map(
      (p) => p.identityId,
    );

    const sig = await getKCSignaturesData(
      publishingNode,
      publisherId,
      receivingNodes,
    );

    await Token.connect(kcCreator).increaseAllowance(
      KnowledgeCollection.getAddress(),
      needTokens,
    );

    /* ---------- DEBUG OUTPUT ---------- */
    console.log('\n🔎  [REVERT-TEST] Validation parameters');
    console.log(
      `   stakeWeightedAverageAsk : ${ethers.formatEther(askPerEpoch)} TRAC/epoch`,
    );
    console.log(`   byteSize                : ${byteSize} bytes`);
    console.log(`   epochs                  : ${epochs}`);
    console.log(
      `   required tokenAmount    : ${ethers.formatEther(needTokens)} TRAC`,
    );
    console.log(
      `   provided tokenAmount    : ${ethers.formatEther(fewTokens)} TRAC  (expected to FAIL)`,
    );

    /* ---------- Expect revert ---------- */
    await expect(
      KnowledgeCollection.connect(kcCreator).createKnowledgeCollection(
        'validate-fail',
        sig.merkleRoot,
        1,
        byteSize,
        epochs,
        fewTokens, // below requirement
        false,
        ethers.ZeroAddress,
        publisherId,
        sig.publisherR,
        sig.publisherVS,
        receiverIds,
        sig.receiverRs,
        sig.receiverVSs,
      ),
    ).to.be.revertedWithCustomError(KnowledgeCollection, 'InvalidTokenAmount');
  });

  /* =================================================================== */
  /* 2️⃣  SUCCESS-PATH: amount equals requirement – should pass           */
  /* =================================================================== */
  it('Should create KC when tokenAmount equals the required minimum', async () => {
    /* ---------- Test-local parameters ---------- */
    const askPerEpoch = ethers.parseEther('20'); // 20 TRAC/epoch
    const totalStake = ethers.parseEther('1'); // 1 TRAC stake
    await AskStorage.setWeightedActiveAskSum(askPerEpoch * totalStake);
    await AskStorage.setTotalActiveStake(totalStake);

    const byteSize = 1024; // 1 KiB
    const epochs = 5;
    const exactTokens = ethers.parseEther('100'); // 20 × 5

    /* ---------- Actors & signatures ---------- */
    const kcCreator = getDefaultKCCreator(accounts);
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts);

    const { identityId: publisherId } = await createProfile(
      Profile,
      publishingNode,
    );
    const receiverIds = (await createProfiles(Profile, receivingNodes)).map(
      (p) => p.identityId,
    );

    const sig = await getKCSignaturesData(
      publishingNode,
      publisherId,
      receivingNodes,
    );

    await Token.connect(kcCreator).increaseAllowance(
      KnowledgeCollection.getAddress(),
      exactTokens,
    );

    /* ---------- DEBUG OUTPUT ---------- */
    console.log('\n🔎  [SUCCESS-TEST] Validation parameters');
    console.log(
      `   stakeWeightedAverageAsk : ${ethers.formatEther(askPerEpoch)} TRAC/epoch`,
    );
    console.log(`   byteSize                : ${byteSize} bytes`);
    console.log(`   epochs                  : ${epochs}`);
    console.log(
      `   required tokenAmount    : ${ethers.formatEther(exactTokens)} TRAC`,
    );
    console.log(
      `   provided tokenAmount    : ${ethers.formatEther(exactTokens)} TRAC  (expected to PASS)`,
    );

    /* ---------- Expect NO revert *and* a counter increment ---------- */
    const beforeId = await KnowledgeCollectionStorage.getLatestKnowledgeCollectionId();
    const tx = await KnowledgeCollection.connect(
      kcCreator,
    ).createKnowledgeCollection(
      'validate-pass',
      sig.merkleRoot,
      1,
      byteSize,
      epochs,
      exactTokens, // exactly the minimum
      false,
      ethers.ZeroAddress,
      publisherId,
      sig.publisherR,
      sig.publisherVS,
      receiverIds,
      sig.receiverRs,
      sig.receiverVSs,
    );

    const receipt = await tx.wait();
    console.log(`   ✅  KC created – tx hash: ${receipt?.hash}`);

    // Tight guard against a regression that would silently accept the
    // exact-minimum token amount without actually persisting the KC.
    // Checking both the event and the storage counter locks the
    // "accepted == created" contract for the minimum-threshold path.
    await expect(tx).to.emit(
      KnowledgeCollectionStorage,
      'KnowledgeCollectionCreated',
    );
    const afterId = await KnowledgeCollectionStorage.getLatestKnowledgeCollectionId();
    expect(afterId).to.equal(beforeId + 1n);
  });
});
