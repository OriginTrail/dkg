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
  StakingStorage,
  ConvictionStakingStorage,
  StakingV10,
  DKGStakingConvictionNFT,
  ParametersStorage,
  KnowledgeAssetsV10,
  KnowledgeCollectionStorage,
  EpochStorage,
  AskStorage,
  ContextGraphs,
  ContextGraphStorage,
  ContextGraphValueStorage,
  DKGPublishingConvictionNFT,
} from '../typechain';
import { createProfile, createProfiles } from './helpers/profile-helpers';
import {
  getDefaultPublishingNode,
  getDefaultReceivingNodes,
  getDefaultKCCreator,
} from './helpers/setup-helpers';
import { buildPublishParams, DEFAULT_CHAIN_ID } from './helpers/v10-kc-helpers';

const SCALE18 = 10n ** 18n;

type E2EFixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  Token: Token;
  Chronos: Chronos;
  Profile: Profile;
  StakingStorage: StakingStorage;
  ConvictionStakingStorage: ConvictionStakingStorage;
  StakingV10: StakingV10;
  StakingNFT: DKGStakingConvictionNFT;
  ParametersStorage: ParametersStorage;
  KnowledgeAssetsV10: KnowledgeAssetsV10;
  KnowledgeCollectionStorage: KnowledgeCollectionStorage;
  EpochStorage: EpochStorage;
  AskStorage: AskStorage;
  ContextGraphs: ContextGraphs;
  ContextGraphStorage: ContextGraphStorage;
  ContextGraphValueStorage: ContextGraphValueStorage;
  PublishingConvictionNFT: DKGPublishingConvictionNFT;
};

async function deployE2EFixture(): Promise<E2EFixture> {
  await hre.deployments.fixture([
    'Token',
    'AskStorage',
    'EpochStorage',
    'Chronos',
    'Profile',
    'Identity',
    'KnowledgeAssetsV10',
    // V10 Phase 8 stack — required by the new `KnowledgeAssetsV10.initialize()`
    // fail-fast Hub lookups (commit e89ecb75). Flow 3 (V10 publish via NFT)
    // depends on the full V10 stack being deployed in the same fixture.
    'ContextGraphStorage',
    'ContextGraphs',
    'ContextGraphValueStorage',
    'DKGPublishingConvictionNFT',
    // v4.0.0 — Flow 3 needs nodeStakeV10 > 0 for the ACK signer gate (KAv10
    // reads V10 stake post-consolidation). Pull in the V10 staking stack so
    // the test can stake nodes via `DKGStakingConvictionNFT.createConviction`.
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
    StakingStorage: await hre.ethers.getContract<StakingStorage>('StakingStorage'),
    ConvictionStakingStorage: await hre.ethers.getContract<ConvictionStakingStorage>(
      'ConvictionStakingStorage',
    ),
    StakingV10: await hre.ethers.getContract<StakingV10>('StakingV10'),
    StakingNFT: await hre.ethers.getContract<DKGStakingConvictionNFT>(
      'DKGStakingConvictionNFT',
    ),
    ParametersStorage: await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
    KnowledgeAssetsV10: await hre.ethers.getContract<KnowledgeAssetsV10>('KnowledgeAssetsV10'),
    KnowledgeCollectionStorage: await hre.ethers.getContract<KnowledgeCollectionStorage>('KnowledgeCollectionStorage'),
    EpochStorage: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
    AskStorage: await hre.ethers.getContract<AskStorage>('AskStorage'),
    ContextGraphs: await hre.ethers.getContract<ContextGraphs>('ContextGraphs'),
    ContextGraphStorage: await hre.ethers.getContract<ContextGraphStorage>('ContextGraphStorage'),
    ContextGraphValueStorage: await hre.ethers.getContract<ContextGraphValueStorage>('ContextGraphValueStorage'),
    PublishingConvictionNFT: await hre.ethers.getContract<DKGPublishingConvictionNFT>(
      'DKGPublishingConvictionNFT',
    ),
  };
}

describe('V10 E2E Conviction System', function () {
  let accounts: SignerWithAddress[];
  let Hub: Hub;
  let Token: Token;
  let Chronos: Chronos;
  let ProfileContract: Profile;
  let StakingStorage: StakingStorage;
  let ParametersStorage: ParametersStorage;
  let KAV10: KnowledgeAssetsV10;
  let KnowledgeCollectionStorage: KnowledgeCollectionStorage;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    const fixture = await loadFixture(deployE2EFixture);
    ({
      accounts,
      Hub,
      Token,
      Chronos,
      ParametersStorage,
      KnowledgeCollectionStorage,
    } = fixture);
    ProfileContract = fixture.Profile;
    StakingStorage = fixture.StakingStorage;
    KAV10 = fixture.KnowledgeAssetsV10;
  });

  // ========================================================================
  // Flows 1 + 2 (V8 Staking lifecycle, V9 PublishingConvictionAccount
  // lifecycle) archived in TB-2 — the underlying contracts moved to
  // contracts/archive/ and are no longer registered in the Hub. The V10
  // publish path stands on its own below.
  // ========================================================================
  // Flow 3: V10 Publish via Conviction NFT + Context Graphs
  //
  // Closes Codex BLOCKER 2 — no dedicated end-to-end test covered the full
  // V10 publish pipeline spanning:
  //   1. Conviction NFT account creation (createAccount: TRAC flows directly
  //      into StakingStorage, full committedTRAC distributed to EpochStorage
  //      across the 12-epoch lock window)
  //   2. Agent registration (agentToAccountId reverse map written)
  //   3. Context Graph creation (open policy, no curator)
  //   4. Publish via `publish(PublishParams)` — conviction path
  //   5. Authorization via ContextGraphs.isAuthorizedPublisher using the
  //      PAYING principal (msg.sender), NOT the recovered node signer (N17)
  //   6. Auto-resolve via agentToAccountId inside coverPublishingCost (N8)
  //   7. KC registered in KCS with msg.sender as the publisher of record
  //      (commit 41be7c71 — KA tokens minted to the paying agent, so the
  //      N16 ERC-1155 balanceOf gate works on follow-up updates)
  //   8. Atomic CG binding via ContextGraphs.registerKnowledgeCollection
  //      (kcToContextGraph[kcId] == cgId, contextGraphKCList[cgId] includes
  //      kcId) (N20)
  //   9. CG value ledger written via
  //      ContextGraphValueStorage.addCGValueForEpochRange (N20, Phase 1)
  //  10. Active-sink distribution: `TokensAddedToEpochRange` events
  //      emitted by `EpochStorage` sum to `discountedCost` across the KC's
  //      `[currentEpoch, currentEpoch + epochs]` chain-epoch range
  //      (prorated current-epoch partial + middle full + tail partial,
  //      mirroring `KnowledgeAssetsV10._distributeTokens`). The NFT
  //      is the funding agent on the conviction branch — KAV10 MUST NOT
  //      call `_distributeTokens` (no double-count).
  //  11. KC retrieval through the KCS public reader
  // ========================================================================
  describe('Flow 3: V10 Publish via Conviction NFT + Context Graphs', function () {
    const COMMITTED_TRAC = ethers.parseEther('50000'); // 20% discount tier
    const MIN_STAKE = ethers.parseEther('50000');
    const STAKER_SHARD_ID = 1n;

    let NFT: DKGPublishingConvictionNFT;
    let CGFacade: ContextGraphs;
    let CGS: ContextGraphStorage;
    let CGV: ContextGraphValueStorage;
    let EpochStorageContract: EpochStorage;

    let kav10Address: string;
    let StakingV10Contract: StakingV10;
    let StakingNFT: DKGStakingConvictionNFT;

    beforeEach(async () => {
      hre.helpers.resetDeploymentsJson();
      const fixture = await loadFixture(deployE2EFixture);
      ({
        accounts,
        Token,
        Chronos,
        ParametersStorage,
        KnowledgeCollectionStorage,
      } = fixture);
      ProfileContract = fixture.Profile;
      StakingStorage = fixture.StakingStorage;
      StakingV10Contract = fixture.StakingV10;
      StakingNFT = fixture.StakingNFT;
      KAV10 = fixture.KnowledgeAssetsV10;
      NFT = fixture.PublishingConvictionNFT;
      CGFacade = fixture.ContextGraphs;
      CGS = fixture.ContextGraphStorage;
      CGV = fixture.ContextGraphValueStorage;
      EpochStorageContract = fixture.EpochStorage;
      kav10Address = await KAV10.getAddress();
    });

    // v4.0.0 — Bring `nodeStakeV10` > 0 for the ACK signer gate via the V10
    // path. KAv10 reads `convictionStakingStorage.getNodeStakeV10`.
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

    it('end-to-end: createAccount → createContextGraph → publish → atomic bind → CG value written → double-count-free', async () => {
      // ---- Step 0: Set up publishing + receiving nodes (profiles + stake) ----
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);
      const { identityId: publisherIdentityId } = await createProfile(
        ProfileContract,
        publishingNode,
      );
      const receiverProfiles = await createProfiles(ProfileContract, receivingNodes);
      const receiverIdentityIds = receiverProfiles.map((p) => p.identityId);

      // Stake all nodes so `_verifySignature`'s stake gate passes.
      // v4.0.0 — KAv10 reads V10 stake (`getNodeStakeV10`) for the ACK
      // signer gate, so we route through the V10 NFT path.
      await stakeV10(publishingNode.operational, publisherIdentityId, MIN_STAKE);
      for (let i = 0; i < receivingNodes.length; i++) {
        await stakeV10(
          receivingNodes[i].operational,
          receiverProfiles[i].identityId,
          MIN_STAKE,
        );
      }

      // ---- Step 1: Conviction NFT account creation ----
      //
      // v4.0.0 — The NFT's `createAccount` pulls `committedTRAC` from
      // msg.sender into the CSS vault directly (fail-closed transferFrom)
      // and writes the full amount across the 12-epoch lock window via
      // `EpochStorage.addTokensToEpochRange`. The contract NEVER holds TRAC.
      const creator = getDefaultKCCreator(accounts);
      await Token.connect(accounts[0]).transfer(creator.address, COMMITTED_TRAC);
      await Token.connect(creator).approve(await NFT.getAddress(), COMMITTED_TRAC);

      const ConvictionStakingStorage =
        await hre.ethers.getContract<import('../typechain').ConvictionStakingStorage>(
          'ConvictionStakingStorage',
        );
      const cssBalanceBefore = await Token.balanceOf(
        await ConvictionStakingStorage.getAddress(),
      );
      await NFT.connect(creator).createAccount(COMMITTED_TRAC);
      const accountId = await NFT.totalSupply();
      expect(accountId).to.equal(1n);

      // createAccount side-effects (v4.0.0):
      // - TRAC moved publisher → CSS vault
      expect(
        await Token.balanceOf(await ConvictionStakingStorage.getAddress()),
      ).to.equal(cssBalanceBefore + COMMITTED_TRAC);
      // - NFT minted to creator
      expect(await NFT.ownerOf(accountId)).to.equal(creator.address);

      // ---- Step 2: Agent registration (creator self-registers as own agent) ----
      await NFT.connect(creator).registerAgent(accountId, creator.address);
      expect(await NFT.agentToAccountId(creator.address)).to.equal(accountId);

      // ---- Step 3: Context Graph creation (open policy) ----
      await CGFacade.connect(creator).createContextGraph(
        [],                // participant agents
        0,                 // metadataBatchId
        0,                 // accessPolicy = public/discoverable
        1,                 // publishPolicy = open (any non-zero publisher auth'd)
        ethers.ZeroAddress,
        0,                 // publishAuthorityAccountId
      );
      const cgId = await CGS.getLatestContextGraphId();
      expect(cgId).to.equal(1n);
      // N17 sanity: open CG authorizes the paying principal (creator).
      expect(await CGFacade.isAuthorizedPublisher(cgId, creator.address)).to.be.true;

      // ---- Step 4: Compute expected active-sink distribution ----
      //
      // V10 lazy-settlement model: conviction-path publish funds the KC's
      // epoch range with `discountedCost = tokenAmount * (1 - discountBps/1e4)`
      // through the NFT's `coverPublishingCost` → `addTokensToEpochRange`.
      // For COMMITTED_TRAC = 50K, discountBps = 2000 (20%), so the active
      // sink discounts `tokenAmount` by 20%. KAV10 MUST NOT call
      // `_distributeTokens` on this branch (double-count guard).
      const currentEpoch = await Chronos.getCurrentEpoch();
      const tokenAmount = ethers.parseEther('1000');
      // PCA discount eligibility: the contract takes the PCA branch
      // only when `publishEpochs == lockDurationEpochs` (along with
      // not-expired + registered-agent gates). Any other value
      // silently falls through to direct spend, which would skip the
      // discount and break this test's assertions. Read the
      // `lockDurationEpochs` back from the NFT to keep this test
      // immune to governance changes of the deploy-script default.
      const acctInfo = await NFT.accounts(1);
      const epochs = Number(acctInfo[5]); // index 5 = lockDurationEpochs
      const expectedDiscountBps = 2000n;
      const expectedDiscounted =
        (tokenAmount * (10_000n - expectedDiscountBps)) / 10_000n;
      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('flow3-merkle'));

      // ---- Step 5: Build V10 publish params (N26 + H5 + post-BLOCKER-1 ACK) ----
      const p = await buildPublishParams({
        chainId: DEFAULT_CHAIN_ID,
        kav10Address,
        receivingNodes,
        publisherIdentityId,
        receiverIdentityIds,
        author: creator,
        contextGraphId: cgId,
        merkleRoot,
        knowledgeAssetsAmount: 10,
        byteSize: 1000,
        epochs,
        tokenAmount,
        isImmutable: false,
        publishOperationId: 'flow3-op',
      });

      // ---- Step 6: publish() (conviction path) ----
      //
      // Capture the receipt so we can count `TokensAddedToEpochRange`
      // emits from EpochStorage. The active sink mirrors
      // `KnowledgeAssetsV10._distributeTokens` semantics: the discounted
      // amount is prorated across `epochs + 1` chain epochs (current
      // partial + epochs-1 full + tail partial), producing 1-3 events.
      // We assert: (a) every event sits within `[currentEpoch,
      // currentEpoch + epochs]`, (b) the SUM equals expectedDiscounted,
      // and (c) NO event from KAV10 itself — only the NFT funds the
      // staker pool here (double-count guard).
      const tx = await KAV10.connect(creator).publish(p);
      const receipt = await tx.wait();
      expect(receipt!.status).to.equal(1);

      const epochStorageAddr = (await EpochStorageContract.getAddress()).toLowerCase();
      const kav10AddrLower = kav10Address.toLowerCase();
      type ParsedTokensAdded = {
        shardId: bigint;
        startEpoch: bigint;
        endEpoch: bigint;
        tokenAmount: bigint;
      };
      const tokensAddedEvents: ParsedTokensAdded[] = [];
      for (const log of receipt!.logs) {
        if (log.address.toLowerCase() !== epochStorageAddr) continue;
        try {
          const parsed = EpochStorageContract.interface.parseLog({
            topics: [...log.topics],
            data: log.data,
          });
          if (parsed?.name === 'TokensAddedToEpochRange') {
            tokensAddedEvents.push({
              shardId: BigInt(parsed.args.shardId),
              startEpoch: BigInt(parsed.args.startEpoch),
              endEpoch: BigInt(parsed.args.endEpoch),
              tokenAmount: BigInt(parsed.args.tokenAmount),
            });
          }
        } catch {
          // not the event we're after
        }
      }
      // Active sink emitted at least once and at most 3 times (current
      // partial + middle full range + tail partial). All must target
      // shard 1 and sit within [currentEpoch, currentEpoch + epochs].
      expect(tokensAddedEvents.length).to.be.greaterThan(0);
      expect(tokensAddedEvents.length).to.be.lessThanOrEqual(3);
      let activeSinkSum = 0n;
      for (const sink of tokensAddedEvents) {
        expect(sink.shardId).to.equal(STAKER_SHARD_ID);
        expect(sink.startEpoch).to.be.gte(currentEpoch);
        expect(sink.endEpoch).to.be.lte(currentEpoch + BigInt(epochs));
        activeSinkSum += sink.tokenAmount;
      }
      expect(activeSinkSum).to.equal(expectedDiscounted);
      // Double-count guard: KAV10 itself must NOT have made any direct
      // call to addTokensToEpochRange on the conviction branch — every
      // emission must trace back to the NFT contract. We probe this by
      // confirming no EpochStorage event was triggered from msg.sender
      // == KAV10. (Solidity event emission carries the EMITTING contract
      // address but not the call-site; ethers receipt logs include the
      // emitting contract via `log.address`. Both emissions originate
      // from EpochStorage, so we can't distinguish source by address —
      // instead we rely on the explicit sum-equals-discounted assertion
      // above + the contract-side invariant that KAV10.publish() removed
      // the _distributeTokens call on the conviction branch.)
      void kav10AddrLower;

      // ---- Step 7: KC registered in KCS; publisher of record is msg.sender ----
      const kcId = 1n;
      const meta = await KnowledgeCollectionStorage.getKnowledgeCollectionMetadata(kcId);
      // meta[3] = byteSize, meta[4] = startEpoch, meta[5] = endEpoch, meta[6] = tokenAmount
      expect(meta[3]).to.equal(1000n);
      expect(meta[4]).to.equal(currentEpoch);
      expect(meta[5]).to.equal(currentEpoch + BigInt(epochs));
      expect(meta[6]).to.equal(tokenAmount);
      // The publisher-of-record on the latest merkle root is the PAYING AGENT
      // (commit 41be7c71). This is what enables the N16 ERC-1155 balanceOf
      // gate to work on follow-up updates.
      const latestPublisher =
        await KnowledgeCollectionStorage.getLatestMerkleRootPublisher(kcId);
      expect(latestPublisher).to.equal(creator.address);
      // ERC-1155 KA tokens minted to msg.sender. A follow-up `update` would
      // pass the `balanceOf(msg.sender, kcRange) > 0` gate.
      const maxSize = await KnowledgeCollectionStorage.KNOWLEDGE_COLLECTION_MAX_SIZE();
      const startTokenId = (kcId - 1n) * maxSize + 1n;
      const stopTokenId = startTokenId + 10n; // knowledgeAssetsAmount = 10
      expect(
        await KnowledgeCollectionStorage['balanceOf(address,uint256,uint256)'](
          creator.address,
          startTokenId,
          stopTokenId,
        ),
      ).to.be.gt(0n);

      // ---- Step 8: Atomic CG binding written ----
      expect(await CGS.kcToContextGraph(kcId)).to.equal(cgId);

      // ---- Step 9: CG value ledger written ----
      //
      // `addCGValueForEpochRange(cgId, currentEpoch, epochs, tokenAmount)`
      // writes a positive diff at currentEpoch; reading at currentEpoch
      // yields tokenAmount/epochs (integer division). The value is non-zero.
      const cgValueNow = await CGV.getCurrentCGValue(cgId);
      expect(cgValueNow).to.equal(tokenAmount / BigInt(epochs));

      // ---- Step 10: Double-count guard already pinned at Step 6 ----
      //
      // Step 6 asserted `sum(tokensAddedEvents) == expectedDiscounted`
      // and that every emission falls inside `[currentEpoch,
      // currentEpoch + epochs]`. A regression that re-enabled
      // `_distributeTokens` on the conviction branch would push the
      // sum to ~2× expected (NFT pays the discounted cost once and
      // KAV10 pays the full tokenAmount on top). The active-sink event
      // sum is the canonical guard.

      // ---- Step 11: KC retrieval via public reader ----
      const retrievedKc = await KnowledgeCollectionStorage.getKnowledgeCollection(kcId);
      expect(retrievedKc.byteSize).to.equal(1000n);
      expect(retrievedKc.startEpoch).to.equal(currentEpoch);
      expect(retrievedKc.endEpoch).to.equal(currentEpoch + BigInt(epochs));
      expect(retrievedKc.tokenAmount).to.equal(tokenAmount);
      expect(retrievedKc.merkleRoots.length).to.equal(1);
      expect(retrievedKc.merkleRoots[0].merkleRoot).to.equal(merkleRoot);
      expect(retrievedKc.merkleRoots[0].publisher).to.equal(creator.address);
      // Verified author identity persisted on chain. In this conviction
      // E2E the author signer == creator (the test builds `p` via
      // `buildPublishParams` with the creator as both author and msg.sender).
      // Author lives in the parallel `merkleRootAuthors` map (keeps the
      // MerkleRoot struct at 3 storage slots so prior KCs decode correctly
      // post-upgrade — see KnowledgeCollectionLib comments).
      expect(
        await KnowledgeCollectionStorage.getMerkleRootAuthorByIndex(kcId, 0),
      ).to.equal(creator.address);
      expect(
        await KnowledgeCollectionStorage.getLatestMerkleRootAuthor(kcId),
      ).to.equal(creator.address);
    });,
        ethers.ZeroHash,
  ));

});
