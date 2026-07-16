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
  KnowledgeAssetsLifecycle,
  DKGKnowledgeAssets,
  EpochStorage,
  AskStorage,
  ContextGraphs,
  ContextGraphStorage,
  ContextGraphValueStorage,
  DKGPublishingConvictionNFT,
  PublishingConvictionStorage,
} from '../typechain';
import { createProfile, createProfiles } from './helpers/profile-helpers';
import {
  getDefaultPublishingNode,
  getDefaultReceivingNodes,
  getDefaultKACreator,
} from './helpers/setup-helpers';
import {
  buildPublishParams,
  packReservedKaId,
  DEFAULT_CHAIN_ID,
} from './helpers/v10-ka-helpers';

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
  KnowledgeAssetsLifecycle: KnowledgeAssetsLifecycle;
  DKGKnowledgeAssets: DKGKnowledgeAssets;
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
    'KnowledgeAssetsLifecycle',
    // V10 Phase 8 stack — required by the new `KnowledgeAssetsLifecycle.initialize()`
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
    KnowledgeAssetsLifecycle: await hre.ethers.getContract<KnowledgeAssetsLifecycle>('KnowledgeAssetsLifecycle'),
    DKGKnowledgeAssets: await hre.ethers.getContract<DKGKnowledgeAssets>('DKGKnowledgeAssets'),
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
  // The before-each deploys the full V10 stack and the flow runs a complete
  // publish; under load this far exceeds Mocha's 40s default.
  // `hardhat.node.config.ts` (used by the repo's run-tests.js) has no mocha
  // block to raise the timeout, so set it per-suite here.
  this.timeout(600000);

  let accounts: SignerWithAddress[];
  let Hub: Hub;
  let Token: Token;
  let Chronos: Chronos;
  let ProfileContract: Profile;
  let StakingStorage: StakingStorage;
  let ParametersStorage: ParametersStorage;
  let KAV10: KnowledgeAssetsLifecycle;
  let DKGKnowledgeAssets: DKGKnowledgeAssets;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    const fixture = await loadFixture(deployE2EFixture);
    ({
      accounts,
      Hub,
      Token,
      Chronos,
      ParametersStorage,
      DKGKnowledgeAssets,
    } = fixture);
    ProfileContract = fixture.Profile;
    StakingStorage = fixture.StakingStorage;
    KAV10 = fixture.KnowledgeAssetsLifecycle;
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
  //   7. KA registered in KAS with msg.sender as the publisher of record
  //      (commit 41be7c71 — KA tokens minted to the paying agent, so the
  //      N16 ERC-1155 balanceOf gate works on follow-up updates)
  //   8. Atomic CG binding via ContextGraphs.registerKnowledgeAsset
  //      (kaToContextGraph[kaId] == cgId, contextGraphKaList[cgId] includes
  //      kaId) (N20)
  //   9. CG value ledger written via
  //      ContextGraphValueStorage.addCGValueForEpochRange (N20, Phase 1)
  //  10. Active-sink distribution: `TokensAddedToEpochRange` events
  //      emitted by `EpochStorage` sum to `discountedCost` across the KA's
  //      `[currentEpoch, currentEpoch + epochs]` chain-epoch range
  //      (prorated current-epoch partial + middle full + tail partial,
  //      mirroring `KnowledgeAssetsLifecycle._distributeTokens`). The NFT
  //      is the funding agent on the conviction branch — KAV10 MUST NOT
  //      call `_distributeTokens` (no double-count).
  //  11. KA retrieval through the KAS public reader
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
        DKGKnowledgeAssets,
      } = fixture);
      ProfileContract = fixture.Profile;
      StakingStorage = fixture.StakingStorage;
      StakingV10Contract = fixture.StakingV10;
      StakingNFT = fixture.StakingNFT;
      KAV10 = fixture.KnowledgeAssetsLifecycle;
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
      const creator = getDefaultKACreator(accounts);
      await Token.connect(accounts[0]).transfer(creator.address, COMMITTED_TRAC);
      await Token.connect(creator).approve(await NFT.getAddress(), COMMITTED_TRAC);

      const ConvictionStakingStorage =
        await hre.ethers.getContract<import('../typechain').ConvictionStakingStorage>(
          'ConvictionStakingStorage',
        );
      const cssBalanceBefore = await Token.balanceOf(
        await ConvictionStakingStorage.getAddress(),
      );
      // OT-RFC-51: `createAccount` gained a `primaryNode` arg — the PCA's
      // designated publishing-allocation node. Use the publishing node (already
      // staked / in the sharding table) so the `nodeExists` gate passes and the
      // committed TRAC is prorate-seeded as that node's publishing allocation.
      await NFT.connect(creator).createAccount(COMMITTED_TRAC, publisherIdentityId);
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
        ethers.ZeroHash,   // nameHash (LU-6 Phase B)
      );
      const cgId = await CGS.getLatestContextGraphId();
      expect(cgId).to.equal(1n);
      // N17 sanity: open CG authorizes the paying principal (creator).
      expect(await CGFacade.isAuthorizedPublisher(cgId, creator.address)).to.be.true;

      // ---- Step 4: Compute expected active-sink distribution ----
      //
      // V10 lazy-settlement model: conviction-path publish funds the KA's
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

      // OT-RFC-43 Option 1 (1a): author-namespaced packed id we expect to mint
      // (high 160 bits == creator, the attested author / NFT recipient).
      const reservedKaId = packReservedKaId(creator.address, 1);

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
        knowledgeAssetsAmount: 1,
        byteSize: 1000,
        epochs,
        tokenAmount,
        isImmutable: false,
        publishOperationId: 'flow3-op',
        reservedKaId,
      });

      // ---- Step 6: publish() (conviction path) ----
      //
      // 10.0.8: the conviction branch draws the discounted amount from the
      // PCA's window budget and emits NOTHING to the staker pool at publish
      // time — the base commitment's emission schedule was written at
      // createAccount. We capture the receipt and assert ZERO
      // `TokensAddedToEpochRange` events on this tx (any event would mean a
      // direct-spend fallthrough or a double-emission regression), and that
      // the budget draw landed on `windowSpent`.
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
      // 10.0.8: ZERO pool emissions on the publish tx — the budget draw is
      // the only accounting effect (see Step 6 comment above).
      expect(tokensAddedEvents.length).to.equal(0);
      // Budget draw: the discounted cost landed on the paying account's
      // current (first) billing window.
      const PCS = await hre.ethers.getContract<PublishingConvictionStorage>(
        'PublishingConvictionStorage',
      );
      const payingAccountId = await NFT.agentToAccountId(creator.address);
      expect(await PCS.windowSpent(payingAccountId, 0n)).to.equal(
        expectedDiscounted,
      );
      // Double-count guard is now STRUCTURAL: the conviction branch has no
      // emission call at all — KAV10 skips `_distributeTokens` on this
      // branch AND the NFT's `coverPublishingCost` no longer emits the base
      // portion (it was scheduled at createAccount). Zero events above is
      // the whole proof.
      void kav10AddrLower;

      // ---- Step 7: KA registered in KAS; publisher of record is msg.sender ----
      // OT-RFC-43 Option 1 (1a): the minted kaId equals the packed reservedKaId
      // (author-namespaced; ids are no longer globally sequential 1,2,3,...).
      const kaId = reservedKaId;
      const meta = await DKGKnowledgeAssets.getKnowledgeAssetMetadata(kaId);
      // meta[3] = byteSize, meta[4] = startEpoch, meta[5] = endEpoch, meta[6] = tokenAmount
      expect(meta[3]).to.equal(1000n);
      expect(meta[4]).to.equal(currentEpoch);
      expect(meta[5]).to.equal(currentEpoch + BigInt(epochs));
      expect(meta[6]).to.equal(tokenAmount);
      // The publisher-of-record on the latest merkle root is the PAYING AGENT
      // (commit 41be7c71). This is what enables the N16 ERC-1155 balanceOf
      // gate to work on follow-up updates.
      const latestPublisher =
        await DKGKnowledgeAssets.getLatestMerkleRootPublisher(kaId);
      expect(latestPublisher).to.equal(creator.address);
      // The KA NFT (ERC-721, one token per KA id) is minted to the author on
      // publish (`DKGKnowledgeAssets._safeMint(author, kaId)`). Assert the
      // specific token `kaId` is owned by `creator` — a `balanceOf > 0` check
      // would also pass if some unrelated KA were owned by `creator` while
      // `kaId` was minted to the wrong address. A follow-up `update` passes
      // the author-ownership gate.
      expect(await DKGKnowledgeAssets.ownerOf(kaId)).to.equal(creator.address);

      // ---- Step 8: Atomic CG binding written ----
      expect(await CGS.kaToContextGraph(kaId)).to.equal(cgId);

      // ---- Step 9: CG value ledger written ----
      //
      // `addCGValueForEpochRange(cgId, currentEpoch, epochs, tokenAmount)`
      // writes a positive diff at currentEpoch; reading at currentEpoch
      // yields tokenAmount/epochs (integer division). The value is non-zero.
      const cgValueNow = await CGV.getCurrentCGValue(cgId);
      expect(cgValueNow).to.equal(tokenAmount / BigInt(epochs));

      // ---- Step 10: Double-count guard already pinned at Step 6 ----
      //
      // Step 6 asserted ZERO `TokensAddedToEpochRange` events on the
      // publish tx (10.0.8: the base commitment's emission is scheduled at
      // createAccount; a publish only draws the budget). A regression that
      // re-enabled `_distributeTokens` on the conviction branch — or
      // re-added the base-portion emission in `coverPublishingCost` —
      // would make the event count non-zero. The zero-event assertion is
      // the canonical guard.

      // ---- Step 11: KA retrieval via public reader ----
      const retrievedKa = await DKGKnowledgeAssets.getKnowledgeAsset(kaId);
      expect(retrievedKa.byteSize).to.equal(1000n);
      expect(retrievedKa.startEpoch).to.equal(currentEpoch);
      expect(retrievedKa.endEpoch).to.equal(currentEpoch + BigInt(epochs));
      expect(retrievedKa.tokenAmount).to.equal(tokenAmount);
      expect(retrievedKa.merkleRoots.length).to.equal(1);
      expect(retrievedKa.merkleRoots[0].merkleRoot).to.equal(merkleRoot);
      expect(retrievedKa.merkleRoots[0].publisher).to.equal(creator.address);
      // Verified author identity persisted on chain. In this conviction
      // E2E the author signer == creator (the test builds `p` via
      // `buildPublishParams` with the creator as both author and msg.sender).
      // Author lives in the parallel `merkleRootAuthors` map (keeps the
      // MerkleRoot struct at 3 storage slots so prior KAs decode correctly
      // post-upgrade — see KnowledgeAssetLib comments).
      expect(
        await DKGKnowledgeAssets.getMerkleRootAuthorByIndex(kaId, 0),
      ).to.equal(creator.address);
      expect(
        await DKGKnowledgeAssets.getLatestMerkleRootAuthor(kaId),
      ).to.equal(creator.address);
    });
  });

});
