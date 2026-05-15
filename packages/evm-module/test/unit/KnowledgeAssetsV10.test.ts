import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import type {
  AskStorage,
  Chronos,
  ContextGraphs,
  ContextGraphStorage,
  ContextGraphValueStorage,
  DKGPublishingConvictionNFT,
  DKGStakingConvictionNFT,
  EpochStorage,
  Hub,
  KnowledgeAssetsV10,
  KnowledgeCollectionStorage,
  MockERC1271Wallet,
  Profile,
  Staking,
  StakingV10,
  Token,
} from '../../typechain';
import {
  buildAuthorAttestationPayload,
  buildPublishAckDigest,
  buildPublishParams,
  buildUpdateParams,
  DEFAULT_CHAIN_ID,
  signAckDigest,
  signAuthorAttestation,
} from '../helpers/v10-kc-helpers';
import { createProfile, createProfiles } from '../helpers/profile-helpers';
import {
  getDefaultKCCreator,
  getDefaultPublishingNode,
  getDefaultReceivingNodes,
} from '../helpers/setup-helpers';
import { NodeAccounts } from '../helpers/types';

/**
 * V10 KnowledgeAssetsV10 unit tests (Phase 8 Task 4 rewrite).
 *
 * Coverage prioritized per Tier 1 / Tier 2 / Tier 3 in the task brief. The
 * most important regression is T1.1 (double-count guard): conviction-path
 * `publish` MUST NOT re-distribute TRAC to the staker reward pool because the
 * NFT.createAccount already wrote committedTRAC there at lock time. If the
 * contract regresses and starts double-counting, T1.1's epoch pool delta
 * assertion fails immediately.
 *
 * Fixture design:
 *   - Deploys the full V10 stack plus V8 KC infra via deployment tags.
 *   - Creates the publishing + receiver node profiles with minimum stake
 *     so `_verifySignature`'s staking gate passes.
 *   - Mints TRAC to the creator/publisher so `createAccount` /
 *     `publishDirect` paths have balance.
 *   - Creates a baseline open Context Graph owned by the kcCreator so
 *     `isAuthorizedPublisher` authorizes the paying principal (N17 closure).
 *     Curated CGs are created on-demand for auth-specific tests.
 *
 * Chain id: hardhat network is pinned at 31337 in `hardhat.node.config.ts`.
 * The helpers read chain id from the `DEFAULT_CHAIN_ID` constant to keep
 * digest builders deterministic; T1.6 flips this to demonstrate cross-chain
 * replay rejection.
 */
describe('@unit KnowledgeAssetsV10', () => {
  let accounts: SignerWithAddress[];
  let HubContract: Hub;
  let KAV10: KnowledgeAssetsV10;
  let KCS: KnowledgeCollectionStorage;
  let EpochStorageContract: EpochStorage;
  let AskStorageContract: AskStorage;
  let ChronosContract: Chronos;
  let TokenContract: Token;
  let ProfileContract: Profile;
  let StakingContract: Staking;
  let StakingV10Contract: StakingV10;
  let StakingNFT: DKGStakingConvictionNFT;
  let Facade: ContextGraphs;
  let CGStorageContract: ContextGraphStorage;
  let CGValueStorage: ContextGraphValueStorage;
  let NFT: DKGPublishingConvictionNFT;

  let kav10Address: string;
  let chainId: bigint;

  const MIN_STAKE = ethers.parseEther('50000');
  const STAKER_SHARD_ID = 1n;

  type Fixture = {
    accounts: SignerWithAddress[];
    HubContract: Hub;
    KAV10: KnowledgeAssetsV10;
    KCS: KnowledgeCollectionStorage;
    EpochStorageContract: EpochStorage;
    AskStorageContract: AskStorage;
    ChronosContract: Chronos;
    TokenContract: Token;
    ProfileContract: Profile;
    StakingContract: Staking;
    StakingV10Contract: StakingV10;
    StakingNFT: DKGStakingConvictionNFT;
    Facade: ContextGraphs;
    CGStorageContract: ContextGraphStorage;
    CGValueStorage: ContextGraphValueStorage;
    NFT: DKGPublishingConvictionNFT;
  };

  async function deployFixture(): Promise<Fixture> {
    await hre.deployments.fixture([
      'Token',
      'Hub',
      'AskStorage',
      'EpochStorage',
      'Chronos',
      'Profile',
      'Identity',
      'Staking',
      'ParametersStorage',
      'IdentityStorage',
      'KnowledgeCollectionStorage',
      'PaymasterManager',
      'ContextGraphStorage',
      'ContextGraphs',
      'ContextGraphValueStorage',
      'DKGPublishingConvictionNFT',
      // v4.0.0 — KAv10 ACK gate reads `getNodeStakeV10`; pull in the V10
      // staking stack so `setupNodes` can stake via the V10 NFT path.
      'StakingV10',
      'DKGStakingConvictionNFT',
      'KnowledgeAssetsV10',
    ]);

    const signers = await hre.ethers.getSigners();
    const HubContract = await hre.ethers.getContract<Hub>('Hub');
    await HubContract.setContractAddress('HubOwner', signers[0].address);

    const KAV10 = await hre.ethers.getContract<KnowledgeAssetsV10>('KnowledgeAssetsV10');
    const KCS = await hre.ethers.getContract<KnowledgeCollectionStorage>(
      'KnowledgeCollectionStorage',
    );
    const EpochStorageContract = await hre.ethers.getContract<EpochStorage>('EpochStorageV8');
    const AskStorageContract = await hre.ethers.getContract<AskStorage>('AskStorage');
    const ChronosContract = await hre.ethers.getContract<Chronos>('Chronos');
    const TokenContract = await hre.ethers.getContract<Token>('Token');
    const ProfileContract = await hre.ethers.getContract<Profile>('Profile');
    const StakingContract = await hre.ethers.getContract<Staking>('Staking');
    const StakingV10Contract =
      await hre.ethers.getContract<StakingV10>('StakingV10');
    const StakingNFT = await hre.ethers.getContract<DKGStakingConvictionNFT>(
      'DKGStakingConvictionNFT',
    );
    const Facade = await hre.ethers.getContract<ContextGraphs>('ContextGraphs');
    const CGStorageContract = await hre.ethers.getContract<ContextGraphStorage>(
      'ContextGraphStorage',
    );
    const CGValueStorage = await hre.ethers.getContract<ContextGraphValueStorage>(
      'ContextGraphValueStorage',
    );
    const NFT = await hre.ethers.getContract<DKGPublishingConvictionNFT>(
      'DKGPublishingConvictionNFT',
    );

    return {
      accounts: signers,
      HubContract,
      KAV10,
      KCS,
      EpochStorageContract,
      AskStorageContract,
      ChronosContract,
      TokenContract,
      ProfileContract,
      StakingContract,
      StakingV10Contract,
      StakingNFT,
      Facade,
      CGStorageContract,
      CGValueStorage,
      NFT,
    };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    const f = await loadFixture(deployFixture);
    accounts = f.accounts;
    HubContract = f.HubContract;
    KAV10 = f.KAV10;
    KCS = f.KCS;
    EpochStorageContract = f.EpochStorageContract;
    AskStorageContract = f.AskStorageContract;
    ChronosContract = f.ChronosContract;
    TokenContract = f.TokenContract;
    ProfileContract = f.ProfileContract;
    StakingContract = f.StakingContract;
    StakingV10Contract = f.StakingV10Contract;
    StakingNFT = f.StakingNFT;
    Facade = f.Facade;
    CGStorageContract = f.CGStorageContract;
    CGValueStorage = f.CGValueStorage;
    NFT = f.NFT;

    kav10Address = await KAV10.getAddress();
    chainId = DEFAULT_CHAIN_ID;
  });

  // ========================================================================
  // Shared setup helpers
  // ========================================================================

  // v4.0.0 — KAv10's `_verifySignature` ACK gate now reads
  // `convictionStakingStorage.getNodeStakeV10(identityId) > 0`. Stake via the
  // V10 NFT path (`DKGStakingConvictionNFT.createConviction`) so V10 stake is
  // populated; V8 `Staking.stake` writes V8 storage only and no longer makes
  // the signer eligible.
  async function fundAndStakeNode(node: NodeAccounts, identityId: number) {
    await TokenContract.mint(node.operational.address, MIN_STAKE);
    await TokenContract.connect(node.operational).approve(
      await StakingV10Contract.getAddress(),
      MIN_STAKE,
    );
    await StakingNFT.connect(node.operational).createConviction(
      identityId,
      MIN_STAKE,
      1,
    );
  }

  /**
   * Set up publishing + receiving nodes (with profiles, stake, and signature-ready
   * identities). Receiver count defaults to `minimumRequiredSignatures` (== 3).
   */
  async function setupNodes(): Promise<{
    publishingNode: NodeAccounts;
    publisherIdentityId: number;
    receivingNodes: NodeAccounts[];
    receiverIdentityIds: number[];
  }> {
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts);

    const { identityId: publisherIdentityId } = await createProfile(
      ProfileContract,
      publishingNode,
    );
    await fundAndStakeNode(publishingNode, publisherIdentityId);

    const receiverProfiles = await createProfiles(ProfileContract, receivingNodes);
    const receiverIdentityIds = receiverProfiles.map((p) => p.identityId);
    for (let i = 0; i < receivingNodes.length; i++) {
      await fundAndStakeNode(receivingNodes[i], receiverProfiles[i].identityId);
    }
    return { publishingNode, publisherIdentityId, receivingNodes, receiverIdentityIds };
  }

  /**
   * Create an open-policy CG (all non-zero publishers authorized) owned by
   * `creator`. Returns the new cgId.
   */
  async function createOpenCG(creator: SignerWithAddress): Promise<bigint> {
    await Facade.connect(creator).createContextGraph(
      [10n, 20n, 30n], // hosting nodes (not validated against identity storage)
      [], // participant agents
      2, // requiredSignatures
      0, // metadataBatchId
      0, // accessPolicy = public/discoverable
      1, // publishPolicy = open
      ethers.ZeroAddress,
      0, // publishAuthorityAccountId
    );
    return CGStorageContract.getLatestContextGraphId();
  }

  /**
   * Create a curated CG with an EOA publishAuthority. Returns the new cgId.
   */
  async function createCuratedCG(
    creator: SignerWithAddress,
    authority: string,
    accountId: bigint = 0n,
  ): Promise<bigint> {
    await Facade.connect(creator).createContextGraph(
      [10n, 20n, 30n],
      [],
      2,
      0,
      0, // accessPolicy = public/discoverable
      0, // publishPolicy = curated
      authority,
      accountId,
    );
    return CGStorageContract.getLatestContextGraphId();
  }

  /**
   * Create a publisher conviction NFT account for `owner` with `committedTRAC`
   * committed, then register `agent` as a publishing agent under it. Returns
   * the new NFT account id.
   */
  async function createConvictionAccountWithAgent(
    owner: SignerWithAddress,
    committed: bigint,
    agent: string,
  ): Promise<bigint> {
    const nftAddr = await NFT.getAddress();
    // owner needs TRAC — the deployer (accounts[0]) starts with 10M TRAC from the
    // Token deploy script; for any other account, we top up from the deployer.
    if (owner.address !== accounts[0].address) {
      await TokenContract.connect(accounts[0]).transfer(owner.address, committed);
    }
    await TokenContract.connect(owner).approve(nftAddr, committed);
    await NFT.connect(owner).createAccount(committed);
    const accountId = await NFT.totalSupply();
    await NFT.connect(owner).registerAgent(accountId, agent);
    return accountId;
  }

  // ========================================================================
  // Tier 1 — critical regression checks
  // ========================================================================

  describe('Tier 1 — critical regression checks', () => {
    // ----------------------------------------------------------------------
    // T1.1: publish via conviction — active-sink distribution (CRITICAL)
    // ----------------------------------------------------------------------
    describe('T1.1: conviction-path `publish` active-sink distribution', () => {
      it('NFT distributes discounted cost into the KC epoch range; KAV10 does NOT call _distributeTokens', async () => {
        // V10 lazy-settlement model: under the new model the conviction
        // branch IS responsible for funding the staker pool over the KC's
        // epoch range — but via the NFT's `addTokensToEpochRange` call
        // through `coverPublishingCost`, NOT via KAV10's
        // `_distributeTokens`. The double-count guard now reads:
        //   exactly ONE `TokensAddedToEpochRange` event is emitted for the
        //   discounted amount, on the KC's `[currentEpoch, currentEpoch +
        //   epochs - 1]` range, from `EpochStorage`.
        const creator = getDefaultKCCreator(accounts);
        const { publishingNode, publisherIdentityId, receivingNodes, receiverIdentityIds } =
          await setupNodes();

        // committed = 50K TRAC → discountBps = 20% (per the contract's
        // tier ladder). discountedCost = baseCost * 0.8.
        const committed = ethers.parseEther('50000');
        const expectedDiscountBps = 2000n;
        await createConvictionAccountWithAgent(
          creator,
          committed,
          creator.address,
        );

        const cgId = await createOpenCG(creator);

        const ParametersStorageContract =
          await hre.ethers.getContract('ParametersStorage');
        const currentEpoch = await ChronosContract.getCurrentEpoch();
        const tokenAmount = ethers.parseEther('1000');
        const epochs = Number(
          await ParametersStorageContract.publishingConvictionEpochs(),
        );
        const expectedDiscounted =
          (tokenAmount * (10_000n - expectedDiscountBps)) / 10_000n;
        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t1.1-root'));

        const p = await buildPublishParams({
          chainId,
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
          publishOperationId: 't1.1-op',
        });

        // Active-sink invariant: the discounted cost is spread across
        // `epochs + 1` chain epochs (current partial + epochs-1 full +
        // final partial), mirroring `KnowledgeAssetsV10._distributeTokens`.
        // Sum of all `TokensAddedToEpochRange` events emitted by
        // `EpochStorage` against shard 1 inside `[currentEpoch,
        // currentEpoch+epochs]` MUST equal `expectedDiscounted`. We
        // assert via the event sum (not per-epoch pool deltas) for the
        // same reason as the NFT unit suite: shared shard storage with
        // pre-existing unfinalized diffs pollutes per-epoch math.
        const tx = await KAV10.connect(creator).publish(p);
        const receipt = await tx.wait();
        const epsAddr = (await EpochStorageContract.getAddress()).toLowerCase();
        const iface = EpochStorageContract.interface;
        let totalDistributed = 0n;
        let eventCount = 0;
        for (const log of receipt!.logs) {
          if (log.address.toLowerCase() !== epsAddr) continue;
          let parsed;
          try { parsed = iface.parseLog({ topics: log.topics as string[], data: log.data }); }
          catch { continue; }
          if (parsed?.name !== 'TokensAddedToEpochRange') continue;
          eventCount++;
          expect(parsed.args.shardId).to.equal(STAKER_SHARD_ID);
          expect(parsed.args.startEpoch).to.be.gte(currentEpoch);
          expect(parsed.args.endEpoch).to.be.lte(currentEpoch + BigInt(epochs));
          totalDistributed += BigInt(parsed.args.tokenAmount);
        }
        expect(eventCount).to.be.greaterThan(0);
        expect(totalDistributed).to.equal(expectedDiscounted);

        // KC landed correctly.
        const meta = await KCS.getKnowledgeCollectionMetadata(1);
        expect(meta[3]).to.equal(1000n);
        expect(meta[4]).to.equal(currentEpoch);
        expect(meta[5]).to.equal(currentEpoch + BigInt(epochs));
        expect(meta[6]).to.equal(tokenAmount);
        expect(meta[7]).to.equal(false);

        // CG binding and value ledger are both non-zero after publish.
        expect(await CGStorageContract.kcToContextGraph(1)).to.equal(cgId);
        const currentCGValue = await CGValueStorage.getCurrentCGValue(cgId);
        expect(currentCGValue).to.be.gt(0n);
        expect(currentCGValue).to.equal(tokenAmount / BigInt(epochs));
      });
    });

    // ----------------------------------------------------------------------
    // T1.2: publishDirect distributes tokenAmount to the staker pool
    // ----------------------------------------------------------------------
    describe('T1.2: publishDirect writes tokenAmount to EpochStorage', () => {
      it('distributes the full tokenAmount across the epoch range', async () => {
        const creator = getDefaultKCCreator(accounts);
        const { publishingNode, publisherIdentityId, receivingNodes, receiverIdentityIds } =
          await setupNodes();

        const cgId = await createOpenCG(creator);

        const currentEpoch = await ChronosContract.getCurrentEpoch();
        const tokenAmount = ethers.parseEther('1000');
        const epochs = 2;
        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t1.2-root'));

        const poolsBefore: bigint[] = [];
        for (let i = 0n; i <= BigInt(epochs); i++) {
          poolsBefore.push(
            await EpochStorageContract.getEpochPool(STAKER_SHARD_ID, currentEpoch + i),
          );
        }

        const p = await buildPublishParams({
          chainId,
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
          publishOperationId: 't1.2-op',
        });

        await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
        const tx = await KAV10.connect(creator).publish(p);
        const receipt = await tx.wait();
        expect(receipt!.status).to.equal(1);

        // Sum deltas across the full distribution window == tokenAmount.
        let totalDelta = 0n;
        for (let i = 0n; i <= BigInt(epochs); i++) {
          const after = await EpochStorageContract.getEpochPool(
            STAKER_SHARD_ID,
            currentEpoch + i,
          );
          totalDelta += after - poolsBefore[Number(i)];
        }
        expect(totalDelta).to.equal(tokenAmount);

        // KC metadata landed.
        const meta = await KCS.getKnowledgeCollectionMetadata(1);
        expect(meta[6]).to.equal(tokenAmount);

        // CG binding + value ledger written.
        expect(await CGStorageContract.kcToContextGraph(1)).to.equal(cgId);
        expect(await CGValueStorage.getCurrentCGValue(cgId)).to.be.gt(0n);
      });
    });

    // ----------------------------------------------------------------------
    // T1.3: contextGraphId == 0 reverts ZeroContextGraphId
    // ----------------------------------------------------------------------
    describe('T1.3: contextGraphId == 0 reverts ZeroContextGraphId', () => {
      it('rejects publish with contextGraphId = 0', async () => {
        const creator = getDefaultKCCreator(accounts);
        const { publishingNode, publisherIdentityId, receivingNodes, receiverIdentityIds } =
          await setupNodes();

        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t1.3-root'));
        const tokenAmount = ethers.parseEther('100');

        const p = await buildPublishParams({
          chainId,
          kav10Address,
          receivingNodes,
          publisherIdentityId,
          receiverIdentityIds,
          author: creator,
          contextGraphId: 0n,
          merkleRoot,
          knowledgeAssetsAmount: 10,
          byteSize: 1000,
          epochs: 2,
          tokenAmount,
          isImmutable: false,
          publishOperationId: 't1.3-op',
        });

        await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
        await expect(
          KAV10.connect(creator).publish(p),
        ).to.be.revertedWithCustomError(KAV10, 'ZeroContextGraphId');
      });

      // Codex-found gap: T1.3 only covered `publishDirect`. Conviction-path
      // `publish` runs the same `_executePublishCore` so the guard applies
      // identically, but a regression could isolate to one branch. Lock both.
      it('rejects publish() (conviction path) with contextGraphId = 0', async () => {
        const creator = getDefaultKCCreator(accounts);
        const { publishingNode, publisherIdentityId, receivingNodes, receiverIdentityIds } =
          await setupNodes();

        // Creator needs a conviction NFT for `publish()` to reach the cgId
        // guard — the guard runs AFTER signature verification but BEFORE the
        // NFT's cost coverage. Allocate an account + register creator as an
        // agent so the flow would otherwise succeed.
        await createConvictionAccountWithAgent(
          creator,
          ethers.parseEther('50000'),
          creator.address,
        );

        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t1.3b-root'));
        const tokenAmount = ethers.parseEther('100');
        const p = await buildPublishParams({
          chainId,
          kav10Address,
          receivingNodes,
          publisherIdentityId,
          receiverIdentityIds,
          author: creator,
          contextGraphId: 0n,
          merkleRoot,
          knowledgeAssetsAmount: 10,
          byteSize: 1000,
          epochs: 2,
          tokenAmount,
          isImmutable: false,
          publishOperationId: 't1.3b-op',
        });

        await expect(
          KAV10.connect(creator).publish(p),
        ).to.be.revertedWithCustomError(KAV10, 'ZeroContextGraphId');
      });
    });

    // ----------------------------------------------------------------------
    // T1.4: epochs == 0 reverts ZeroEpochs
    // ----------------------------------------------------------------------
    describe('T1.4: epochs == 0 reverts ZeroEpochs', () => {
      it('rejects publish with epochs = 0', async () => {
        const creator = getDefaultKCCreator(accounts);
        const { publishingNode, publisherIdentityId, receivingNodes, receiverIdentityIds } =
          await setupNodes();

        const cgId = await createOpenCG(creator);
        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t1.4-root'));
        const tokenAmount = ethers.parseEther('100');

        const p = await buildPublishParams({
          chainId,
          kav10Address,
          receivingNodes,
          publisherIdentityId,
          receiverIdentityIds,
          author: creator,
          contextGraphId: cgId,
          merkleRoot,
          knowledgeAssetsAmount: 10,
          byteSize: 1000,
          epochs: 0,
          tokenAmount,
          isImmutable: false,
          publishOperationId: 't1.4-op',
        });

        await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
        await expect(
          KAV10.connect(creator).publish(p),
        ).to.be.revertedWithCustomError(KAV10, 'ZeroEpochs');
      });
    });

    // ----------------------------------------------------------------------
    // T1.5: Author attestation (RFC-001) — required-field gates, EOA replay
    //       guards, and EIP-1271 dispatch.
    //
    // RFC-001 replaced the per-publish publisher signature with an EIP-712
    // `AuthorAttestation` over `(contextGraphId, merkleRoot, authorAddress,
    // schemeVersion)`. The contract gates the publish path on:
    //   - `authorAddress != 0`           → AuthorRequired
    //   - `authorSchemeVersion == 1`     → UnsupportedAuthorScheme
    //   - EOA: `ECDSA.tryRecover(...) == authorAddress`
    //                                    → InvalidAuthorSignature
    //   - SC wallet: `IERC1271.isValidSignature == 0x1626ba7e`
    //                                    → InvalidAuthorSignature1271
    //
    // The happy paths (EOA + EIP-1271) are exercised by every passing publish
    // test in the suite (T1.1 onwards); this block locks the negative paths
    // and the smart-wallet positive path explicitly.
    // ----------------------------------------------------------------------
    describe('T1.5: author attestation (RFC-001) — required gates + 1271', () => {
      async function buildBaselinePublishParams() {
        const creator = getDefaultKCCreator(accounts);
        const { publisherIdentityId, receivingNodes, receiverIdentityIds } =
          await setupNodes();
        const cgId = await createOpenCG(creator);
        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t1.5-root'));
        const tokenAmount = ethers.parseEther('100');

        const p = await buildPublishParams({
          chainId,
          kav10Address,
          receivingNodes,
          publisherIdentityId,
          receiverIdentityIds,
          author: creator,
          contextGraphId: cgId,
          merkleRoot,
          knowledgeAssetsAmount: 10,
          byteSize: 1000,
          epochs: 2,
          tokenAmount,
          isImmutable: false,
          publishOperationId: 't1.5-op',
        });
        await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
        return { creator, cgId, merkleRoot, tokenAmount, p };
      }

      it('T1.5a: reverts AuthorRequired when authorAddress == address(0)', async () => {
        const { creator, p } = await buildBaselinePublishParams();
        const corrupted = { ...p, authorAddress: ethers.ZeroAddress };
        await expect(
          KAV10.connect(creator).publish(corrupted),
        ).to.be.revertedWithCustomError(KAV10, 'AuthorRequired');
      });

      it('T1.5b: reverts UnsupportedAuthorScheme when authorSchemeVersion != 1', async () => {
        const { creator, p } = await buildBaselinePublishParams();
        const corrupted = { ...p, authorSchemeVersion: 2 };
        await expect(KAV10.connect(creator).publish(corrupted))
          .to.be.revertedWithCustomError(KAV10, 'UnsupportedAuthorScheme')
          .withArgs(2);
      });

      it('T1.5c: EOA — reverts InvalidAuthorSignature when signer != authorAddress', async () => {
        // Signature is valid for `stranger` over the right (cgId, merkleRoot,
        // creator-as-author, scheme=1) payload, but `authorAddress` declares
        // `creator`. ECDSA recovers `stranger` → mismatch → revert.
        const creator = getDefaultKCCreator(accounts);
        const stranger = accounts[15];
        const { publisherIdentityId, receivingNodes, receiverIdentityIds } =
          await setupNodes();
        const cgId = await createOpenCG(creator);
        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t1.5c-root'));
        const tokenAmount = ethers.parseEther('100');

        const wrongSig = await signAuthorAttestation(
          stranger,
          buildAuthorAttestationPayload({
            chainId,
            kav10Address,
            contextGraphId: cgId,
            merkleRoot,
            authorAddress: creator.address,
          }),
        );

        const p = await buildPublishParams({
          chainId,
          kav10Address,
          receivingNodes,
          publisherIdentityId,
          receiverIdentityIds,
          author: creator,
          contextGraphId: cgId,
          merkleRoot,
          knowledgeAssetsAmount: 10,
          byteSize: 1000,
          epochs: 2,
          tokenAmount,
          isImmutable: false,
          publishOperationId: 't1.5c-op',
          authorSigOverride: wrongSig,
        });
        await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
        await expect(
          KAV10.connect(creator).publish(p),
        ).to.be.revertedWithCustomError(KAV10, 'InvalidAuthorSignature');
      });

      it('T1.5d: EOA — rejects a signature scoped to a different (cgId, merkleRoot)', async () => {
        // Author signs an attestation for cgId=cgB / merkleRoot=B but the
        // publish payload is bound to cgA / merkleRoot=A. The EIP-712 digest
        // domain-binds the struct hash, so recovery yields a non-creator
        // address (or wrong recovery) and the contract reverts.
        const creator = getDefaultKCCreator(accounts);
        const { publisherIdentityId, receivingNodes, receiverIdentityIds } =
          await setupNodes();
        const cgIdA = await createOpenCG(creator);
        const cgIdB = await createOpenCG(creator);
        const merkleRootA = ethers.keccak256(ethers.toUtf8Bytes('t1.5d-A'));
        const merkleRootB = ethers.keccak256(ethers.toUtf8Bytes('t1.5d-B'));
        const tokenAmount = ethers.parseEther('100');

        const wrongPayloadSig = await signAuthorAttestation(
          creator,
          buildAuthorAttestationPayload({
            chainId,
            kav10Address,
            contextGraphId: cgIdB,
            merkleRoot: merkleRootB,
            authorAddress: creator.address,
          }),
        );

        const p = await buildPublishParams({
          chainId,
          kav10Address,
          receivingNodes,
          publisherIdentityId,
          receiverIdentityIds,
          author: creator,
          contextGraphId: cgIdA,
          merkleRoot: merkleRootA,
          knowledgeAssetsAmount: 10,
          byteSize: 1000,
          epochs: 2,
          tokenAmount,
          isImmutable: false,
          publishOperationId: 't1.5d-op',
          authorSigOverride: wrongPayloadSig,
        });
        await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
        await expect(
          KAV10.connect(creator).publish(p),
        ).to.be.revertedWithCustomError(KAV10, 'InvalidAuthorSignature');
      });

      it('T1.5e: EIP-1271 happy path — wallet returns magic value and publish succeeds', async () => {
        const creator = getDefaultKCCreator(accounts);
        const walletSigner = accounts[15];
        const { publisherIdentityId, receivingNodes, receiverIdentityIds } =
          await setupNodes();

        // Deploy mock wallet with `walletSigner` as the configured EOA. The
        // wallet will recover `walletSigner` from the EIP-1271 signature and
        // return `0x1626ba7e` only if recovery matches.
        const MockERC1271WalletF = await hre.ethers.getContractFactory(
          'MockERC1271Wallet',
          accounts[0],
        );
        const wallet = (await MockERC1271WalletF.deploy(
          walletSigner.address,
        )) as unknown as MockERC1271Wallet;
        const walletAddress = await wallet.getAddress();

        const cgId = await createOpenCG(creator);
        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t1.5e-root'));
        const tokenAmount = ethers.parseEther('100');

        // `walletSigner` signs the EIP-712 digest scoped to the wallet as
        // authorAddress. Contract dispatches to `wallet.isValidSignature` →
        // wallet recovers `walletSigner` → magic value → success.
        const sig = await signAuthorAttestation(
          walletSigner,
          buildAuthorAttestationPayload({
            chainId,
            kav10Address,
            contextGraphId: cgId,
            merkleRoot,
            authorAddress: walletAddress,
          }),
        );

        // We need to override `authorAddress` to point at the wallet. The
        // helper's `args.author.address` defaults to the EOA's address, so we
        // build via the helper and then mutate the struct.
        const p = await buildPublishParams({
          chainId,
          kav10Address,
          receivingNodes,
          publisherIdentityId,
          receiverIdentityIds,
          author: walletSigner,
          contextGraphId: cgId,
          merkleRoot,
          knowledgeAssetsAmount: 10,
          byteSize: 1000,
          epochs: 2,
          tokenAmount,
          isImmutable: false,
          publishOperationId: 't1.5e-op',
          authorSigOverride: sig,
        });
        const corrupted = { ...p, authorAddress: walletAddress };

        await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
        await expect(KAV10.connect(creator).publish(corrupted)).to.not.be.reverted;
      });

      it('T1.5f: EIP-1271 negative path — wallet returns non-magic value reverts InvalidAuthorSignature1271', async () => {
        const creator = getDefaultKCCreator(accounts);
        const walletSigner = accounts[15];
        const { publisherIdentityId, receivingNodes, receiverIdentityIds } =
          await setupNodes();

        const MockERC1271WalletF = await hre.ethers.getContractFactory(
          'MockERC1271Wallet',
          accounts[0],
        );
        const wallet = (await MockERC1271WalletF.deploy(
          walletSigner.address,
        )) as unknown as MockERC1271Wallet;
        await wallet.setForceFailure(true);
        const walletAddress = await wallet.getAddress();

        const cgId = await createOpenCG(creator);
        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t1.5f-root'));
        const tokenAmount = ethers.parseEther('100');

        const sig = await signAuthorAttestation(
          walletSigner,
          buildAuthorAttestationPayload({
            chainId,
            kav10Address,
            contextGraphId: cgId,
            merkleRoot,
            authorAddress: walletAddress,
          }),
        );

        const p = await buildPublishParams({
          chainId,
          kav10Address,
          receivingNodes,
          publisherIdentityId,
          receiverIdentityIds,
          author: walletSigner,
          contextGraphId: cgId,
          merkleRoot,
          knowledgeAssetsAmount: 10,
          byteSize: 1000,
          epochs: 2,
          tokenAmount,
          isImmutable: false,
          publishOperationId: 't1.5f-op',
          authorSigOverride: sig,
        });
        const corrupted = { ...p, authorAddress: walletAddress };

        await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
        await expect(
          KAV10.connect(creator).publish(corrupted),
        ).to.be.revertedWithCustomError(KAV10, 'InvalidAuthorSignature1271');
      });

      it('T1.5g: EOA — publish persists the recovered author on chain', async () => {
        // Locks the design's central promise: post-publish, an off-chain
        // reader can fetch the verified author via
        // `getLatestMerkleRootAuthor` / `getMerkleRootAuthorByIndex`
        // (parallel `merkleRootAuthors` map — keeps the MerkleRoot
        // struct at 3 slots so prior KCs decode correctly). This is
        // what `/api/get` and `/api/kc/:id/author` read.
        const creator = getDefaultKCCreator(accounts);
        const author = accounts[14];
        const { publisherIdentityId, receivingNodes, receiverIdentityIds } =
          await setupNodes();
        const cgId = await createOpenCG(creator);
        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t1.5g-root'));
        const tokenAmount = ethers.parseEther('100');

        const p = await buildPublishParams({
          chainId,
          kav10Address,
          receivingNodes,
          publisherIdentityId,
          receiverIdentityIds,
          author,
          contextGraphId: cgId,
          merkleRoot,
          knowledgeAssetsAmount: 10,
          byteSize: 1000,
          epochs: 2,
          tokenAmount,
          isImmutable: false,
          publishOperationId: 't1.5g-op',
        });

        await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
        await expect(KAV10.connect(creator).publish(p)).to.not.be.reverted;

        // Storage assertion — the recovered author is persisted on the
        // freshly-minted KC's first merkle-root entry. `creator` (msg.sender)
        // is the publisher of record; `author` (the EIP-712 signer) is a
        // different account, so this also confirms the two roles do not
        // collapse into msg.sender.
        const latestKcId = await KCS.getLatestKnowledgeCollectionId();
        const kc = await KCS.getKnowledgeCollection(latestKcId);
        expect(kc.merkleRoots.length).to.equal(1);
        expect(kc.merkleRoots[0].publisher).to.equal(creator.address);
        // Author lives in parallel `merkleRootAuthors` map — read via
        // the dedicated getters, not as a `MerkleRoot` struct field
        // (struct preserved at 3 slots; see KnowledgeCollectionLib).
        expect(await KCS.getLatestMerkleRootAuthor(latestKcId)).to.equal(
          author.address,
        );
        expect(
          await KCS.getMerkleRootAuthorByIndex(latestKcId, 0),
        ).to.equal(author.address);
      });

      it('T1.5h: EIP-1271 — publish persists the wallet contract address as author', async () => {
        // Mirror of T1.5g for the smart-contract author path. After a
        // successful 1271 verification, `getLatestMerkleRootAuthor` is the
        // *wallet contract* address (not the inner EOA signer).
        const creator = getDefaultKCCreator(accounts);
        const walletSigner = accounts[16];
        const { publisherIdentityId, receivingNodes, receiverIdentityIds } =
          await setupNodes();

        const MockERC1271WalletF = await hre.ethers.getContractFactory(
          'MockERC1271Wallet',
          accounts[0],
        );
        const wallet = (await MockERC1271WalletF.deploy(
          walletSigner.address,
        )) as unknown as MockERC1271Wallet;
        const walletAddress = await wallet.getAddress();

        const cgId = await createOpenCG(creator);
        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t1.5h-root'));
        const tokenAmount = ethers.parseEther('100');

        const sig = await signAuthorAttestation(
          walletSigner,
          buildAuthorAttestationPayload({
            chainId,
            kav10Address,
            contextGraphId: cgId,
            merkleRoot,
            authorAddress: walletAddress,
          }),
        );

        const p = await buildPublishParams({
          chainId,
          kav10Address,
          receivingNodes,
          publisherIdentityId,
          receiverIdentityIds,
          author: walletSigner,
          contextGraphId: cgId,
          merkleRoot,
          knowledgeAssetsAmount: 10,
          byteSize: 1000,
          epochs: 2,
          tokenAmount,
          isImmutable: false,
          publishOperationId: 't1.5h-op',
          authorSigOverride: sig,
        });
        const corrupted = { ...p, authorAddress: walletAddress };

        await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
        await expect(KAV10.connect(creator).publish(corrupted)).to.not.be.reverted;

        const latestKcId = await KCS.getLatestKnowledgeCollectionId();
        expect(await KCS.getLatestMerkleRootAuthor(latestKcId)).to.equal(
          walletAddress,
        );
      });
    });

    // ----------------------------------------------------------------------
    // T1.6: H5 ACK digest cross-chain replay rejection
    // ----------------------------------------------------------------------
    describe('T1.6: H5 cross-chain replay rejection', () => {
      it('rejects an ACK digest built with a different chain id', async () => {
        const creator = getDefaultKCCreator(accounts);
        const { publisherIdentityId, receivingNodes, receiverIdentityIds } =
          await setupNodes();

        const cgId = await createOpenCG(creator);
        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t1.6-root'));
        const tokenAmount = ethers.parseEther('100');
        const epochs = 2;
        const knowledgeAssetsAmount = 10;
        const byteSize = 1000;

        // Build a fake "mainnet" ACK digest (chain id 1) — signer attestation
        // is valid for mainnet, but the contract verifies against 31337.
        const mainnetChainId = 1n;
        const ackDigest = buildPublishAckDigest(
          mainnetChainId,
          kav10Address,
          cgId,
          merkleRoot,
          knowledgeAssetsAmount,
          byteSize,
          epochs,
          tokenAmount,
          1,
        );
        const sig = await signAckDigest(receivingNodes, ackDigest);

        // Build a valid author attestation for the LOCAL chain so the
        // author-attestation gate passes — we want to isolate the ACK
        // cross-chain replay rejection.
        const authorSig = await signAuthorAttestation(
          creator,
          buildAuthorAttestationPayload({
            chainId,
            kav10Address,
            contextGraphId: cgId,
            merkleRoot,
            authorAddress: creator.address,
          }),
        );

        const p = {
          publishOperationId: 't1.6-op',
          contextGraphId: cgId,
          merkleRoot,
          knowledgeAssetsAmount,
          byteSize,
          epochs,
          tokenAmount,
          isImmutable: false,
          merkleLeafCount: 1,
          publisherNodeIdentityId: publisherIdentityId,
          authorAddress: creator.address,
          authorR: authorSig.authorR,
          authorVS: authorSig.authorVS,
          authorSchemeVersion: 1,
          identityIds: receiverIdentityIds,
          r: sig.receiverRs,
          vs: sig.receiverVSs,
        };

        await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
        // Wrong-chain digest recovers a valid-but-mismatched signer; the
        // contract verifies against chainid 31337, fails `keyHasPurpose`,
        // and reverts `SignerIsNotNodeOperator`. Pin the specific error so
        // a future drift to `InvalidSignature` (recovered address zero)
        // makes the test noisy instead of silently passing.
        await expect(
          KAV10.connect(creator).publish(p),
        ).to.be.revertedWithCustomError(KAV10, 'SignerIsNotNodeOperator');
      });
    });

    // ----------------------------------------------------------------------
    // T1.7: update fresh ACK + payment + balanceOf gate
    // ----------------------------------------------------------------------
    describe('T1.7: update — ACK / payment / policy-branch auth', () => {
      async function publishBaselineKC(): Promise<{
        creator: SignerWithAddress;
        cgId: bigint;
        publishingNode: NodeAccounts;
        publisherIdentityId: number;
        receivingNodes: NodeAccounts[];
        receiverIdentityIds: number[];
        kcId: bigint;
        tokenAmount: bigint;
        byteSize: bigint;
      }> {
        const creator = getDefaultKCCreator(accounts);
        const nodes = await setupNodes();
        const cgId = await createOpenCG(creator);

        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t1.7-root'));
        const tokenAmount = ethers.parseEther('500');
        const byteSize = 1000n;

        const p = await buildPublishParams({
          chainId,
          kav10Address,
          receivingNodes: nodes.receivingNodes,
          publisherIdentityId: nodes.publisherIdentityId,
          receiverIdentityIds: nodes.receiverIdentityIds,
          author: creator,
          contextGraphId: cgId,
          merkleRoot,
          knowledgeAssetsAmount: 10,
          byteSize: Number(byteSize),
          epochs: 5, // give ourselves plenty of lifetime for update
          tokenAmount,
          isImmutable: false,
          publishOperationId: 't1.7-publish',
        });
        await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
        await KAV10.connect(creator).publish(p);

        return { creator, cgId, ...nodes, kcId: 1n, tokenAmount, byteSize };
      }

      // -- T1.7a: valid update with payment delta succeeds --
      it('T1.7a: succeeds with valid ACK + payment delta + creator as token holder', async () => {
        const base = await publishBaselineKC();
        const newMerkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t1.7a-new'));
        const delta = ethers.parseEther('100');
        const newTokenAmount = base.tokenAmount + delta;

        const up = await buildUpdateParams({
          chainId,
          kav10Address,
          receivingNodes: base.receivingNodes,
          publisherIdentityId: base.publisherIdentityId,
          receiverIdentityIds: base.receiverIdentityIds,
          contextGraphId: base.cgId,
          id: base.kcId,
          preUpdateMerkleRootCount: 1n, // fresh KC has exactly 1 root
          newMerkleRoot,
          newByteSize: base.byteSize,
          newTokenAmount,
          mintKnowledgeAssetsAmount: 1n, // >= 1 required by KCS mint guard
          knowledgeAssetsToBurn: [],
          updateOperationId: 't1.7a-update',
        });

        await TokenContract.connect(base.creator).approve(kav10Address, delta);
        await expect(
          KAV10.connect(base.creator).update(up),
        ).to.not.be.reverted;

        const meta = await KCS.getKnowledgeCollectionMetadata(base.kcId);
        expect(meta[6]).to.equal(newTokenAmount);
      });

      // -- T1.7b: metadata-only update (delta == 0) succeeds --
      it('T1.7b: succeeds with delta == 0 (metadata-only update)', async () => {
        const base = await publishBaselineKC();
        const newMerkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t1.7b-new'));

        const up = await buildUpdateParams({
          chainId,
          kav10Address,
          receivingNodes: base.receivingNodes,
          publisherIdentityId: base.publisherIdentityId,
          receiverIdentityIds: base.receiverIdentityIds,
          contextGraphId: base.cgId,
          id: base.kcId,
          preUpdateMerkleRootCount: 1n,
          newMerkleRoot,
          newByteSize: base.byteSize, // unchanged
          newTokenAmount: base.tokenAmount, // delta == 0
          mintKnowledgeAssetsAmount: 1n,
          knowledgeAssetsToBurn: [],
          updateOperationId: 't1.7b-update',
        });

        await expect(
          KAV10.connect(base.creator).update(up),
        ).to.not.be.reverted;
      });

      // -- T1.7c: unauthorized (non-publisher) caller reverts --
      //
      // Baseline uses an OPEN CG, where update auth pins to the ORIGINAL
      // publisher (`merkleRoots[0].publisher`). Any non-publisher caller
      // reverts `UnauthorizedPublisher`, regardless of KA token ownership.
      // This is the policy-branch auth gate (Codex Round 4 Finding 3);
      // replaces the earlier `balanceOf`-based `NotKnowledgeCollectionTokenHolder`
      // gate, which was hijackable under ERC-1155Delta transferability.
      it('T1.7c: reverts UnauthorizedPublisher when caller is not the original publisher', async () => {
        const base = await publishBaselineKC();
        const stranger = accounts[15];
        const newMerkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t1.7c-new'));
        const delta = ethers.parseEther('10');
        const newTokenAmount = base.tokenAmount + delta;

        const up = await buildUpdateParams({
          chainId,
          kav10Address,
          receivingNodes: base.receivingNodes,
          publisherIdentityId: base.publisherIdentityId,
          receiverIdentityIds: base.receiverIdentityIds,
          contextGraphId: base.cgId,
          id: base.kcId,
          preUpdateMerkleRootCount: 1n,
          newMerkleRoot,
          newByteSize: base.byteSize,
          newTokenAmount,
          mintKnowledgeAssetsAmount: 1n,
          knowledgeAssetsToBurn: [],
          updateOperationId: 't1.7c-update',
        });

        // Give stranger TRAC + approval so the revert is auth-only, not
        // a shortfall in allowance or balance.
        await TokenContract.connect(accounts[0]).transfer(stranger.address, delta);
        await TokenContract.connect(stranger).approve(kav10Address, delta);

        await expect(
          KAV10.connect(stranger).update(up),
        )
          .to.be.revertedWithCustomError(KAV10, 'UnauthorizedPublisher')
          .withArgs(base.cgId, stranger.address);
      });

      // -- T1.7d: rebate (newTokenAmount < current) reverts --
      it('T1.7d: reverts CannotShrinkTokenAmount when newTokenAmount < currentTokenAmount', async () => {
        const base = await publishBaselineKC();
        const newMerkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t1.7d-new'));
        const newTokenAmount = base.tokenAmount - 1n;

        const up = await buildUpdateParams({
          chainId,
          kav10Address,
          receivingNodes: base.receivingNodes,
          publisherIdentityId: base.publisherIdentityId,
          receiverIdentityIds: base.receiverIdentityIds,
          contextGraphId: base.cgId,
          id: base.kcId,
          preUpdateMerkleRootCount: 1n,
          newMerkleRoot,
          newByteSize: base.byteSize,
          newTokenAmount,
          mintKnowledgeAssetsAmount: 1n,
          knowledgeAssetsToBurn: [],
          updateOperationId: 't1.7d-update',
        });

        await expect(KAV10.connect(base.creator).update(up))
          .to.be.revertedWithCustomError(KAV10, 'CannotShrinkTokenAmount')
          .withArgs(base.tokenAmount, newTokenAmount);
      });

      // -- T1.7e: stale-ACK replay regression (Codex MEDIUM finding) --
      //
      // Commit 3f3554d9 added `merkleRoots.length` to the update ACK digest
      // to prevent replays. This regression captures a valid ACK, lands
      // the update (chain's merkleRoots.length advances from 1 → 2), then
      // replays the SAME ACK and expects revert. Without the length binding
      // a metadata-only ACK could be replayed for free to roll the merkle
      // root back.
      it('T1.7e: rejects replay of an update ACK after the chain advances', async () => {
        const base = await publishBaselineKC();

        // First update: metadata-only (delta == 0). Chain preUpdate count = 1.
        // `mintKnowledgeAssetsAmount: 1n` mirrors T1.7b since KCS's mint
        // helper requires > 0 (same reason T1.7b uses 1).
        const firstRoot = ethers.keccak256(ethers.toUtf8Bytes('t1.7e-first'));
        const up1 = await buildUpdateParams({
          chainId,
          kav10Address,
          receivingNodes: base.receivingNodes,
          publisherIdentityId: base.publisherIdentityId,
          receiverIdentityIds: base.receiverIdentityIds,
          contextGraphId: base.cgId,
          id: base.kcId,
          preUpdateMerkleRootCount: 1n,
          newMerkleRoot: firstRoot,
          newByteSize: base.byteSize,
          newTokenAmount: base.tokenAmount,
          mintKnowledgeAssetsAmount: 1n,
          knowledgeAssetsToBurn: [],
          updateOperationId: 't1.7e-first',
        });
        await expect(
          KAV10.connect(base.creator).update(up1),
        ).to.not.be.reverted;

        // Chain is now at merkleRoots.length == 2. Replaying up1 must fail —
        // the contract will compute the ACK digest with count = 2 against
        // the signatures built against count = 1, recovering the wrong
        // signer. The revert comes from `_verifySignature` /
        // `_verifySignatures`, not a dedicated error.
        //
        // Tightened: a valid ECDSA over the wrong digest still recovers a
        // non-zero address, so the contract trips the operator-key check and
        // raises `SignerIsNotNodeOperator` from KnowledgeCollectionLib. This
        // catches regressions where replay is silently accepted or the wrong
        // branch (InvalidSignature/TokenAmount) masks the real bug.
        await expect(
          KAV10.connect(base.creator).update(up1),
        ).to.be.revertedWithCustomError(KAV10, 'SignerIsNotNodeOperator');
      });

      // -- T1.7f: conviction-path update() happy path --
      //
      // T1.7a-d only exercised `updateDirect`. The conviction-path `update()`
      // shares `_executeUpdateCore` and only differs in how the delta is
      // paid (NFT.coverPublishingCost vs _addTokens+_distributeTokens). This
      // regression locks the conviction-path flow end-to-end.
      it('T1.7f: conviction-path update() pays delta via NFT active-sink (no _distributeTokens double-count)', async () => {
        const base = await publishBaselineKC();

        // committed = 50K TRAC → discountBps = 20%. The discount applies
        // to the DELTA only (newTokenAmount - currentTokenAmount), not
        // the original tokenAmount.
        const expectedDiscountBps = 2000n;
        await createConvictionAccountWithAgent(
          base.creator,
          ethers.parseEther('50000'),
          base.creator.address,
        );

        const newMerkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t1.7f-new'));
        const delta = ethers.parseEther('10');
        const newTokenAmount = base.tokenAmount + delta;
        const expectedDiscountedDelta =
          (delta * (10_000n - expectedDiscountBps)) / 10_000n;

        const up = await buildUpdateParams({
          chainId,
          kav10Address,
          receivingNodes: base.receivingNodes,
          publisherIdentityId: base.publisherIdentityId,
          receiverIdentityIds: base.receiverIdentityIds,
          contextGraphId: base.cgId,
          id: base.kcId,
          preUpdateMerkleRootCount: 1n,
          newMerkleRoot,
          newByteSize: base.byteSize,
          newTokenAmount,
          mintKnowledgeAssetsAmount: 1n,
          knowledgeAssetsToBurn: [],
          updateOperationId: 't1.7f-update',
        });

        // Active-sink invariant for update(): the discounted delta is
        // prorated across `remainingEpochs + 1` chain epochs (current
        // partial + remainingEpochs-1 full + final partial), summed
        // across all `TokensAddedToEpochRange` events emitted by
        // `EpochStorage`. KAV10 still must NOT call `_distributeTokens`
        // on the conviction branch — the NFT is the funding agent.
        const currentEpoch = await ChronosContract.getCurrentEpoch();
        const meta = await KCS.getKnowledgeCollectionMetadata(base.kcId);
        const endEpoch = meta[5];
        const remainingEpochs = endEpoch - currentEpoch;
        const tx = await KAV10.connect(base.creator).update(up);
        const receipt = await tx.wait();
        const epsAddr = (await EpochStorageContract.getAddress()).toLowerCase();
        const iface = EpochStorageContract.interface;
        let totalDistributed = 0n;
        let eventCount = 0;
        for (const log of receipt!.logs) {
          if (log.address.toLowerCase() !== epsAddr) continue;
          let parsed;
          try { parsed = iface.parseLog({ topics: log.topics as string[], data: log.data }); }
          catch { continue; }
          if (parsed?.name !== 'TokensAddedToEpochRange') continue;
          eventCount++;
          expect(parsed.args.shardId).to.equal(STAKER_SHARD_ID);
          expect(parsed.args.startEpoch).to.be.gte(currentEpoch);
          expect(parsed.args.endEpoch).to.be.lte(currentEpoch + remainingEpochs);
          totalDistributed += BigInt(parsed.args.tokenAmount);
        }
        expect(eventCount).to.be.greaterThan(0);
        expect(totalDistributed).to.equal(expectedDiscountedDelta);

        const metaAfter = await KCS.getKnowledgeCollectionMetadata(base.kcId);
        expect(metaAfter[6]).to.equal(newTokenAmount);
      });

      // -- T1.7g: true metadata-only update (mint=0, burn=[], delta=0) --
      //
      // Codex Round 2 finding: KCS unconditionally called
      // `mintKnowledgeAssetsTokens` which reverts `MintZeroQuantity` when
      // amount == 0, blocking the metadata-only rotation path. Fix guards
      // the mint in KCS. This test locks the fix by running a pure
      // merkle-root rotation with no mint, no burn, no payment delta.
      it('T1.7g: true metadata-only update (mint=0, burn=[], delta=0) succeeds', async () => {
        const base = await publishBaselineKC();
        const newMerkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t1.7g-new'));

        const up = await buildUpdateParams({
          chainId,
          kav10Address,
          receivingNodes: base.receivingNodes,
          publisherIdentityId: base.publisherIdentityId,
          receiverIdentityIds: base.receiverIdentityIds,
          contextGraphId: base.cgId,
          id: base.kcId,
          preUpdateMerkleRootCount: 1n,
          newMerkleRoot,
          newByteSize: base.byteSize,
          newTokenAmount: base.tokenAmount,
          mintKnowledgeAssetsAmount: 0n, // load-bearing: no mint
          knowledgeAssetsToBurn: [],
          updateOperationId: 't1.7g-update',
        });

        await expect(
          KAV10.connect(base.creator).update(up),
        ).to.not.be.reverted;

        // Merkle root rotated; minted count unchanged.
        const roots = await KCS.getMerkleRoots(base.kcId);
        expect(roots.length).to.equal(2);
        expect(roots[1].merkleRoot).to.equal(newMerkleRoot);
        expect(roots[1].publisher).to.equal(base.creator.address);
        const metaAfter = await KCS.getKnowledgeCollectionMetadata(base.kcId);
        expect(metaAfter[2]).to.equal(10n);
        expect(metaAfter[6]).to.equal(base.tokenAmount);
      });

      // -- T1.7h: burn-list happy path (Codex Round 2, Fix A positive) --
      //
      // Regression for `_burnBatch` inverted range check. Pre-fix, the
      // condition reverted on tokens INSIDE the KC's range. Post-fix, the
      // caller can burn their own KC's KA tokens via updateDirect.
      it('T1.7h: update with a valid burn list burns the caller-owned KA tokens', async () => {
        const base = await publishBaselineKC();

        const maxSize = await KCS.KNOWLEDGE_COLLECTION_MAX_SIZE();
        const firstTokenId = (base.kcId - 1n) * maxSize + 1n;

        // Sanity: caller owns the token BEFORE the update.
        expect(
          await KCS['balanceOf(address,uint256,uint256)'](
            base.creator.address,
            firstTokenId,
            firstTokenId + 1n,
          ),
        ).to.equal(1n);

        const newMerkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t1.7h-new'));
        const up = await buildUpdateParams({
          chainId,
          kav10Address,
          receivingNodes: base.receivingNodes,
          publisherIdentityId: base.publisherIdentityId,
          receiverIdentityIds: base.receiverIdentityIds,
          contextGraphId: base.cgId,
          id: base.kcId,
          preUpdateMerkleRootCount: 1n,
          newMerkleRoot,
          newByteSize: base.byteSize,
          newTokenAmount: base.tokenAmount,
          mintKnowledgeAssetsAmount: 0n,
          knowledgeAssetsToBurn: [firstTokenId],
          updateOperationId: 't1.7h-update',
        });

        await expect(
          KAV10.connect(base.creator).update(up),
        ).to.not.be.reverted;

        // Caller no longer owns the token.
        expect(
          await KCS['balanceOf(address,uint256,uint256)'](
            base.creator.address,
            firstTokenId,
            firstTokenId + 1n,
          ),
        ).to.equal(0n);

        // Token recorded in KC's burned[] list.
        const metaAfter = await KCS.getKnowledgeCollectionMetadata(base.kcId);
        const burnedList = metaAfter[1];
        expect(burnedList.length).to.equal(1);
        expect(burnedList[0]).to.equal(firstTokenId);
      });

      // -- T1.7i: out-of-range burn reverts (Codex Round 2, Fix A negative) --
      //
      // The burn-range gate must still reject tokens from a DIFFERENT KC.
      // A caller that owns tokens from KC #2 must NOT be able to pass them
      // to an update on KC #1 — the inverted pre-fix code let this through.
      it('T1.7i: update with out-of-range burn token reverts NotPartOfKnowledgeCollection', async () => {
        const base = await publishBaselineKC();

        // Token ID from KC #2's range (not KC #1's). KC #1 has
        // [1, 1 + minted); KC #2 has [1 + MAX_SIZE, 1 + MAX_SIZE + minted).
        const maxSize = await KCS.KNOWLEDGE_COLLECTION_MAX_SIZE();
        const outOfRangeTokenId = maxSize + 1n;

        const newMerkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t1.7i-new'));
        const up = await buildUpdateParams({
          chainId,
          kav10Address,
          receivingNodes: base.receivingNodes,
          publisherIdentityId: base.publisherIdentityId,
          receiverIdentityIds: base.receiverIdentityIds,
          contextGraphId: base.cgId,
          id: base.kcId,
          preUpdateMerkleRootCount: 1n,
          newMerkleRoot,
          newByteSize: base.byteSize,
          newTokenAmount: base.tokenAmount,
          mintKnowledgeAssetsAmount: 0n,
          knowledgeAssetsToBurn: [outOfRangeTokenId],
          updateOperationId: 't1.7i-update',
        });

        await expect(KAV10.connect(base.creator).update(up))
          .to.be.revertedWithCustomError(KCS, 'NotPartOfKnowledgeCollection')
          .withArgs(base.kcId, outOfRangeTokenId);
      });

      // -- T1.7j: KA token transfer does NOT grant update authority --
      //
      // Codex Round 4 Finding 3. Baseline publishes in an open CG. The
      // original publisher transfers 1 KA token to a stranger via
      // `safeTransferFrom`. Pre-fix, the `balanceOf(stranger, kcRange) > 0`
      // gate would have authorized the stranger to rotate the merkle
      // root, mint new KAs, and burn existing KAs. Post-fix, open-CG
      // update auth is pinned to `merkleRoots[0].publisher` (the original
      // paying principal), so holding a transferred KA token buys
      // nothing. Locks the exploit closed.
      it('T1.7j: KA token transfer to stranger does NOT grant update auth', async () => {
        const base = await publishBaselineKC();
        const stranger = accounts[16];

        // Transfer 1 KA from the original publisher to the stranger.
        const maxSize = await KCS.KNOWLEDGE_COLLECTION_MAX_SIZE();
        const firstTokenId = (base.kcId - 1n) * maxSize + 1n;
        await KCS.connect(base.creator).safeTransferFrom(
          base.creator.address,
          stranger.address,
          firstTokenId,
          1n,
          '0x',
        );
        // Sanity: stranger now holds the transferred token.
        expect(
          await KCS['balanceOf(address,uint256,uint256)'](
            stranger.address,
            firstTokenId,
            firstTokenId + 1n,
          ),
        ).to.equal(1n);

        const newMerkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t1.7j-new'));
        const up = await buildUpdateParams({
          chainId,
          kav10Address,
          receivingNodes: base.receivingNodes,
          publisherIdentityId: base.publisherIdentityId,
          receiverIdentityIds: base.receiverIdentityIds,
          contextGraphId: base.cgId,
          id: base.kcId,
          preUpdateMerkleRootCount: 1n,
          newMerkleRoot,
          newByteSize: base.byteSize,
          newTokenAmount: base.tokenAmount, // metadata-only update
          mintKnowledgeAssetsAmount: 1n,
          knowledgeAssetsToBurn: [],
          updateOperationId: 't1.7j-update',
        });

        // Stranger's update attempt reverts even though they now hold a
        // KA token from the KC. The revert comes from the open-CG
        // original-publisher pin, NOT from the balanceOf gate.
        await expect(
          KAV10.connect(stranger).update(up),
        )
          .to.be.revertedWithCustomError(KAV10, 'UnauthorizedPublisher')
          .withArgs(base.cgId, stranger.address);

        // Positive sanity: the original publisher, who no longer holds
        // token `firstTokenId` (it's with the stranger), can still
        // update via the original-publisher pin. Locks "original
        // publisher retains rights even after selling a KA token".
        await expect(
          KAV10.connect(base.creator).update(up),
        ).to.not.be.reverted;
      });
    });

    // ----------------------------------------------------------------------
    // T1.8: update with byte-size growth requires payment
    // ----------------------------------------------------------------------
    describe('T1.8: update byte-size growth requires payment', () => {
      async function publishBaselineKCWithAsk(): Promise<{
        creator: SignerWithAddress;
        cgId: bigint;
        publishingNode: NodeAccounts;
        publisherIdentityId: number;
        receivingNodes: NodeAccounts[];
        receiverIdentityIds: number[];
        kcId: bigint;
        tokenAmount: bigint;
        byteSize: bigint;
        epochs: number;
      }> {
        const creator = getDefaultKCCreator(accounts);
        const nodes = await setupNodes();
        const cgId = await createOpenCG(creator);

        // Set a non-zero ask so _validateTokenAmount computes a floor:
        //   expectedTokenAmount = (stakeWeightedAsk * byteSize * epochs) / 1024
        // With ask = 1 TRAC (1e18), byteSize = 1024, epochs = 5 -> 5 TRAC minimum.
        // The test makes byte size growth require a TRAC bump.
        await AskStorageContract.setTotalActiveStake(ethers.parseEther('1'));
        await AskStorageContract.setWeightedActiveAskSum(
          ethers.parseEther('1') * ethers.parseEther('1'),
        );

        const epochs = 5;
        const byteSize = 1024n;
        const tokenAmount = ethers.parseEther('5'); // exact minimum
        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t1.8-root'));

        const p = await buildPublishParams({
          chainId,
          kav10Address,
          receivingNodes: nodes.receivingNodes,
          publisherIdentityId: nodes.publisherIdentityId,
          receiverIdentityIds: nodes.receiverIdentityIds,
          author: creator,
          contextGraphId: cgId,
          merkleRoot,
          knowledgeAssetsAmount: 10,
          byteSize: Number(byteSize),
          epochs,
          tokenAmount,
          isImmutable: false,
          publishOperationId: 't1.8-publish',
        });
        await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
        await KAV10.connect(creator).publish(p);

        return {
          creator,
          cgId,
          kcId: 1n,
          byteSize,
          tokenAmount,
          epochs,
          ...nodes,
        };
      }

      // -- T1.8a: byte-size grew but token amount stayed -> reverts --
      it('T1.8a: reverts InvalidTokenAmount when newByteSize grows without raising token amount', async () => {
        const base = await publishBaselineKCWithAsk();
        const newMerkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t1.8a-new'));

        // Double the byte size; keep token amount the same; the price-check
        // gate re-runs (byte size grew) and rejects the under-payment.
        const newByteSize = base.byteSize * 2n;

        const up = await buildUpdateParams({
          chainId,
          kav10Address,
          receivingNodes: base.receivingNodes,
          publisherIdentityId: base.publisherIdentityId,
          receiverIdentityIds: base.receiverIdentityIds,
          contextGraphId: base.cgId,
          id: base.kcId,
          preUpdateMerkleRootCount: 1n,
          newMerkleRoot,
          newByteSize,
          newTokenAmount: base.tokenAmount,
          mintKnowledgeAssetsAmount: 1n,
          knowledgeAssetsToBurn: [],
          updateOperationId: 't1.8a-update',
        });

        await expect(
          KAV10.connect(base.creator).update(up),
        ).to.be.revertedWithCustomError(KAV10, 'InvalidTokenAmount');
      });

      // -- T1.8b: byte size grew with matching token bump -> succeeds --
      it('T1.8b: succeeds when newTokenAmount covers the larger byte size × remaining lifetime', async () => {
        const base = await publishBaselineKCWithAsk();
        const newMerkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t1.8b-new'));

        // Double the byte size; the original was exact minimum, so we must
        // double the tokenAmount (remaining lifetime == epochs because no
        // time has advanced mid-test). The contract uses
        // `_validateTokenAmount(newByteSize, remainingEpochs, newTokenAmount)`.
        const newByteSize = base.byteSize * 2n;
        const newTokenAmount = base.tokenAmount * 2n;

        const up = await buildUpdateParams({
          chainId,
          kav10Address,
          receivingNodes: base.receivingNodes,
          publisherIdentityId: base.publisherIdentityId,
          receiverIdentityIds: base.receiverIdentityIds,
          contextGraphId: base.cgId,
          id: base.kcId,
          preUpdateMerkleRootCount: 1n,
          newMerkleRoot,
          newByteSize,
          newTokenAmount,
          mintKnowledgeAssetsAmount: 1n,
          knowledgeAssetsToBurn: [],
          updateOperationId: 't1.8b-update',
        });

        const delta = newTokenAmount - base.tokenAmount;
        await TokenContract.connect(base.creator).approve(kav10Address, delta);
        await expect(
          KAV10.connect(base.creator).update(up),
        ).to.not.be.reverted;

        const meta = await KCS.getKnowledgeCollectionMetadata(base.kcId);
        expect(meta[3]).to.equal(newByteSize);
        expect(meta[6]).to.equal(newTokenAmount);
      });

      // -- T1.8c: final-epoch byte-size growth without payment must revert --
      //
      // Codex Round 3: the Round-1 I1 fix gated `_validateTokenAmount` on
      // `(delta > 0 || newByteSize > currentByteSize)` to unblock
      // metadata-only rotations under ask drift. That closed one hole but
      // opened another: at `currentEpoch == endEpoch` (remainingEpochs == 0)
      // the pricing formula `ask * newByteSize * 0 / 1024` collapses to
      // ZERO, so a caller could pass `delta == 0` AND grow byteSize and
      // the validation would rubber-stamp it — free storage commitment.
      //
      // The final-epoch guard used to fire only on `delta > 0`. We now
      // also catch byte-size growth at remainingEpochs == 0 so the
      // commitment must have SOME future window to land in.
      it('T1.8c: byte-size growth at final epoch reverts NoRemainingLifetimeForDelta', async () => {
        const base = await publishBaselineKCWithAsk();

        // Advance to the KC's final epoch (currentEpoch == endEpoch).
        // T2.5 uses the same pattern with a 1-epoch KC; T1.8's baseline
        // is a 5-epoch KC, so we need to push `epochs` epochs forward.
        const epochLen = Number(await ChronosContract.epochLength());
        for (let i = 0; i < base.epochs; i++) {
          await time.increase(epochLen + 1);
        }
        const now = await ChronosContract.getCurrentEpoch();
        const meta = await KCS.getKnowledgeCollectionMetadata(base.kcId);
        expect(now).to.equal(meta[5]); // currentEpoch == endEpoch

        const newMerkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t1.8c-new'));
        // Load-bearing: byte size GROWS, tokenAmount UNCHANGED (delta == 0).
        const newByteSize = base.byteSize * 2n;
        const newTokenAmount = base.tokenAmount;

        const up = await buildUpdateParams({
          chainId,
          kav10Address,
          receivingNodes: base.receivingNodes,
          publisherIdentityId: base.publisherIdentityId,
          receiverIdentityIds: base.receiverIdentityIds,
          contextGraphId: base.cgId,
          id: base.kcId,
          preUpdateMerkleRootCount: 1n,
          newMerkleRoot,
          newByteSize,
          newTokenAmount,
          mintKnowledgeAssetsAmount: 1n,
          knowledgeAssetsToBurn: [],
          updateOperationId: 't1.8c-update',
        });

        await expect(KAV10.connect(base.creator).update(up))
          .to.be.revertedWithCustomError(KAV10, 'NoRemainingLifetimeForDelta')
          .withArgs(base.kcId, now, meta[5]);
      });

      // -- T1.8d: mid-lifetime byte-size growth with zero delta reverts --
      //
      // Codex Round 4 Finding 2. The pre-fix validation compared the
      // CUMULATIVE `newTokenAmount` against `remainingEpochs` —
      // late in a KC's lifetime, most of the cumulative has already been
      // paid out to past epoch pools, so the check was too permissive: a
      // publisher could double the byteSize near the end of the lifetime
      // with `delta == 0` because the cumulative still "covered" the
      // smaller remaining window on paper, even though the actual
      // undistributed reward pool was a fraction of the new footprint's
      // cost.
      //
      // Post-fix, the check charges `delta` alone against the MARGINAL
      // cost of `(newByteSize - currentByteSize) × remainingEpochs`, so
      // any growth without matching delta reverts regardless of where
      // in the lifetime the update lands.
      //
      // This test advances to the middle of the KC's lifetime, then
      // attempts to double the byte size with `delta == 0`. Pre-fix this
      // would silently succeed; post-fix it reverts
      // `InvalidTokenAmount`.
      it('T1.8d: mid-lifetime byte-size growth without delta reverts (Codex R4 F2)', async () => {
        const base = await publishBaselineKCWithAsk();

        // Advance to roughly the middle of the KC's lifetime. With epochs
        // == 5, we advance 3 epochs so `remainingEpochs == 2`. At that
        // point the pre-fix cumulative check would let a doubled byte
        // size through with delta == 0 because `newTokenAmount (5 TRAC)
        // >= expected(newByteSize=2048, remainingEpochs=2) == 4 TRAC`.
        const epochLen = Number(await ChronosContract.epochLength());
        for (let i = 0; i < 3; i++) {
          await time.increase(epochLen + 1);
        }
        const now = await ChronosContract.getCurrentEpoch();
        const meta = await KCS.getKnowledgeCollectionMetadata(base.kcId);
        // Sanity: current epoch is strictly inside the KC's lifetime, so
        // `NoRemainingLifetimeForDelta` does NOT short-circuit this test.
        expect(now).to.be.lt(meta[5]);
        expect(meta[5] - now).to.be.gt(0n);

        const newMerkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t1.8d-new'));
        // Load-bearing: byte size DOUBLES, tokenAmount UNCHANGED (delta == 0).
        const newByteSize = base.byteSize * 2n;
        const newTokenAmount = base.tokenAmount;

        const up = await buildUpdateParams({
          chainId,
          kav10Address,
          receivingNodes: base.receivingNodes,
          publisherIdentityId: base.publisherIdentityId,
          receiverIdentityIds: base.receiverIdentityIds,
          contextGraphId: base.cgId,
          id: base.kcId,
          preUpdateMerkleRootCount: 1n,
          newMerkleRoot,
          newByteSize,
          newTokenAmount,
          mintKnowledgeAssetsAmount: 1n,
          knowledgeAssetsToBurn: [],
          updateOperationId: 't1.8d-update',
        });

        await expect(
          KAV10.connect(base.creator).update(up),
        ).to.be.revertedWithCustomError(KAV10, 'InvalidTokenAmount');
      });
    });
  });

  // ========================================================================
  // Tier 2 — should-have coverage
  // ========================================================================

  describe('Tier 2 — should-have coverage', () => {
    // ----------------------------------------------------------------------
    // T2.1 (RFC-001): publish without PCA agent registration falls through
    // to the direct-spend branch.
    //
    // RFC-001 unified `publish`/`publishDirect` into a single entrypoint that
    // auto-detects the cost-coverage branch via
    // `agentToAccountId[msg.sender]`. A caller with no PCA registration no
    // longer reverts with `NoConvictionAccount`; instead the entry pulls
    // TRAC via `transferFrom(msg.sender, CSS, fullCost)` and runs
    // `_distributeTokens` over the epoch range. This regression locks the
    // new fall-through behaviour (and asserts the staker pool sees the
    // expected delta).
    // ----------------------------------------------------------------------
    describe('T2.1: publish without PCA agent registration takes the direct-spend branch', () => {
      it('pulls TRAC from msg.sender and distributes to the staker pool', async () => {
        const creator = getDefaultKCCreator(accounts);
        const { publisherIdentityId, receivingNodes, receiverIdentityIds } =
          await setupNodes();

        const cgId = await createOpenCG(creator);
        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t2.1-root'));
        const tokenAmount = ethers.parseEther('100');
        const epochs = 2;

        // Sanity: creator is NOT registered as an agent.
        expect(await NFT.agentToAccountId(creator.address)).to.equal(0n);

        const currentEpoch = await ChronosContract.getCurrentEpoch();
        const poolsBefore: bigint[] = [];
        for (let i = 0n; i <= BigInt(epochs); i++) {
          poolsBefore.push(
            await EpochStorageContract.getEpochPool(STAKER_SHARD_ID, currentEpoch + i),
          );
        }

        const p = await buildPublishParams({
          chainId,
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
          publishOperationId: 't2.1-op',
        });

        await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
        await expect(KAV10.connect(creator).publish(p)).to.not.be.reverted;

        // Sum deltas across the full distribution window == tokenAmount.
        let totalDelta = 0n;
        for (let i = 0n; i <= BigInt(epochs); i++) {
          const after = await EpochStorageContract.getEpochPool(
            STAKER_SHARD_ID,
            currentEpoch + i,
          );
          totalDelta += after - poolsBefore[Number(i)];
        }
        expect(totalDelta).to.equal(tokenAmount);
      });

      it('reverts TooLowAllowance when caller has no PCA and no TRAC approval', async () => {
        const creator = getDefaultKCCreator(accounts);
        const { publisherIdentityId, receivingNodes, receiverIdentityIds } =
          await setupNodes();

        const cgId = await createOpenCG(creator);
        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t2.1b-root'));
        const tokenAmount = ethers.parseEther('100');

        const p = await buildPublishParams({
          chainId,
          kav10Address,
          receivingNodes,
          publisherIdentityId,
          receiverIdentityIds,
          author: creator,
          contextGraphId: cgId,
          merkleRoot,
          knowledgeAssetsAmount: 10,
          byteSize: 1000,
          epochs: 2,
          tokenAmount,
          isImmutable: false,
          publishOperationId: 't2.1b-op',
        });

        // Make sure creator hasn't pre-approved TRAC.
        await TokenContract.connect(creator).approve(kav10Address, 0n);
        await expect(KAV10.connect(creator).publish(p))
          .to.be.revertedWithCustomError(KAV10, 'TooLowAllowance');
      });
    });

    // ----------------------------------------------------------------------
    // T2.2: curated CG auth (N17 callsite)
    // ----------------------------------------------------------------------
    describe('T2.2: private CG curator auth (N17 callsite)', () => {
      it('T2.2a: authorized publisher succeeds', async () => {
        const creator = getDefaultKCCreator(accounts);
        const { publishingNode, publisherIdentityId, receivingNodes, receiverIdentityIds } =
          await setupNodes();

        const cgId = await createCuratedCG(creator, creator.address);
        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t2.2a-root'));
        const tokenAmount = ethers.parseEther('100');

        const p = await buildPublishParams({
          chainId,
          kav10Address,
          receivingNodes,
          publisherIdentityId,
          receiverIdentityIds,
          author: creator,
          contextGraphId: cgId,
          merkleRoot,
          knowledgeAssetsAmount: 10,
          byteSize: 1000,
          epochs: 2,
          tokenAmount,
          isImmutable: false,
          publishOperationId: 't2.2a-op',
        });

        await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
        await expect(
          KAV10.connect(creator).publish(p),
        ).to.not.be.reverted;
      });

      it('T2.2b: unauthorized publisher reverts UnauthorizedPublisher', async () => {
        const authority = accounts[8];
        const stranger = accounts[15];
        // Fund stranger so revert is auth-only, not allowance-only.
        await TokenContract.connect(accounts[0]).transfer(
          stranger.address,
          ethers.parseEther('100'),
        );

        const { publisherIdentityId, receivingNodes, receiverIdentityIds } =
          await setupNodes();

        const cgId = await createCuratedCG(accounts[0], authority.address);
        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t2.2b-root'));
        const tokenAmount = ethers.parseEther('100');

        const p = await buildPublishParams({
          chainId,
          kav10Address,
          receivingNodes,
          publisherIdentityId,
          receiverIdentityIds,
          // The unauthorized caller signs their own author attestation —
          // the test isolates the curator-auth gate; the author check must
          // pass so the revert below is provably from `isAuthorizedPublisher`,
          // not from `InvalidAuthorSignature`.
          author: stranger,
          contextGraphId: cgId,
          merkleRoot,
          knowledgeAssetsAmount: 10,
          byteSize: 1000,
          epochs: 2,
          tokenAmount,
          isImmutable: false,
          publishOperationId: 't2.2b-op',
        });

        await TokenContract.connect(stranger).approve(kav10Address, tokenAmount);
        await expect(KAV10.connect(stranger).publish(p))
          .to.be.revertedWithCustomError(KAV10, 'UnauthorizedPublisher')
          .withArgs(cgId, stranger.address);
      });
    });

    // ----------------------------------------------------------------------
    // T2.3: PCA agent path (N17 + N8 cross-fix)
    // ----------------------------------------------------------------------
    describe('T2.3: PCA agent path (isAuthorizedPublisher via registered agent)', () => {
      it('authorizes a registered agent via live ownerOf + agent resolve', async () => {
        const nftOwner = accounts[0]; // funds available
        const agent = getDefaultKCCreator(accounts); // kcCreator will publish

        const committed = ethers.parseEther('50000');
        const pcaAccountId = await createConvictionAccountWithAgent(
          nftOwner,
          committed,
          agent.address,
        );

        const { publisherIdentityId, receivingNodes, receiverIdentityIds } =
          await setupNodes();

        // Create a curated CG in PCA mode: publishAuthority = NFT owner
        // (matches ownerOf(accountId) right now), accountId = pcaAccountId.
        // The CG lives on its own — it doesn't have to be owned by the NFT
        // owner. Using accounts[0] as CG creator keeps TRAC on the deployer
        // (which is fine because the agent is the real publishing principal).
        await Facade.connect(accounts[0]).createContextGraph(
          [10n, 20n, 30n],
          [],
          2,
          0,
          0, // accessPolicy = public/discoverable
          0, // publishPolicy = curated
          nftOwner.address,
          pcaAccountId,
        );
        const cgId = await CGStorageContract.getLatestContextGraphId();

        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t2.3-root'));
        const tokenAmount = ethers.parseEther('100');
        const ParametersStorageContract =
          await hre.ethers.getContract('ParametersStorage');
        const convictionEpochs = Number(
          await ParametersStorageContract.publishingConvictionEpochs(),
        );

        const p = await buildPublishParams({
          chainId,
          kav10Address,
          receivingNodes,
          publisherIdentityId,
          receiverIdentityIds,
          author: agent,
          contextGraphId: cgId,
          merkleRoot,
          knowledgeAssetsAmount: 10,
          byteSize: 1000,
          epochs: convictionEpochs,
          tokenAmount,
          isImmutable: false,
          publishOperationId: 't2.3-op',
        });

        // Conviction path: agent calls publish, NFT auto-resolves accountId.
        // isAuthorizedPublisher(cgId, agent) resolves via agentToAccountId[agent]
        // == pcaAccountId == cg.publishAuthorityAccountId -> authorized.
        await expect(KAV10.connect(agent).publish(p)).to.not.be.reverted;
      });
    });

    // ----------------------------------------------------------------------
    // T2.4 — DELETED in RFC-001.
    //
    // Paymaster.sol / PaymasterManager.sol are removed from KAv10's active
    // path. Sponsorship is now expressed via PCA agent registration: a
    // sponsoring core calls `DKGPublishingConvictionNFT.registerAgent(its
    // accountId, sponsoredWallet)`, and that wallet's publishes flow through
    // the PCA discount branch automatically. The sponsorship semantic is
    // exercised by T2.3 and T1.1 already.
    // ----------------------------------------------------------------------

    // ----------------------------------------------------------------------
    // T2.5: NoRemainingLifetimeForDelta at KC's final epoch
    // ----------------------------------------------------------------------
    describe('T2.5: NoRemainingLifetimeForDelta on update at final epoch', () => {
      it('reverts when delta > 0 but remainingEpochs == 0', async () => {
        const creator = getDefaultKCCreator(accounts);
        const nodes = await setupNodes();
        const cgId = await createOpenCG(creator);

        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t2.5-root'));
        const tokenAmount = ethers.parseEther('100');
        const epochs = 1;
        const byteSize = 1000;

        const p = await buildPublishParams({
          chainId,
          kav10Address,
          receivingNodes: nodes.receivingNodes,
          publisherIdentityId: nodes.publisherIdentityId,
          receiverIdentityIds: nodes.receiverIdentityIds,
          author: creator,
          contextGraphId: cgId,
          merkleRoot,
          knowledgeAssetsAmount: 10,
          byteSize,
          epochs,
          tokenAmount,
          isImmutable: false,
          publishOperationId: 't2.5-publish',
        });
        await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
        await KAV10.connect(creator).publish(p);

        // Advance the clock into the KC's final epoch (currentEpoch == endEpoch).
        // With startEpoch == N and epochs == 1, endEpoch == N + 1. We warp so
        // currentEpoch is exactly endEpoch, which makes remainingEpochs == 0.
        await time.increase(Number(await ChronosContract.epochLength()) + 1);
        const now = await ChronosContract.getCurrentEpoch();
        const meta = await KCS.getKnowledgeCollectionMetadata(1);
        expect(now).to.equal(meta[5]); // endEpoch == currentEpoch

        const newMerkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t2.5-new'));
        const delta = ethers.parseEther('10');
        const newTokenAmount = tokenAmount + delta;

        const up = await buildUpdateParams({
          chainId,
          kav10Address,
          receivingNodes: nodes.receivingNodes,
          publisherIdentityId: nodes.publisherIdentityId,
          receiverIdentityIds: nodes.receiverIdentityIds,
          author: creator,
          contextGraphId: cgId,
          id: 1n,
          preUpdateMerkleRootCount: 1n,
          newMerkleRoot,
          newByteSize: BigInt(byteSize),
          newTokenAmount,
          mintKnowledgeAssetsAmount: 1n,
          knowledgeAssetsToBurn: [],
          updateOperationId: 't2.5-update',
        });

        await TokenContract.connect(creator).approve(kav10Address, delta);
        await expect(KAV10.connect(creator).update(up))
          .to.be.revertedWithCustomError(KAV10, 'NoRemainingLifetimeForDelta')
          .withArgs(1n, now, meta[5]);
      });
    });

    // ----------------------------------------------------------------------
    // T2.6: extendKnowledgeCollectionLifetime writes CG value delta
    //
    // Codex Fix 2: extending a KC's lifetime adds value to the CG it belongs
    // to. Pre-fix, `extendKnowledgeCollectionLifetime` wrote to EpochStorage
    // but skipped `ContextGraphValueStorage`, so future value-weighted random
    // sampling undercounted extended KCs.
    //
    // Post-fix, the extension span writes a positive CG value diff at the
    // (old) endEpoch and a matching negative diff at (old endEpoch + epochs).
    // ----------------------------------------------------------------------
    describe('T2.6: extendKnowledgeCollectionLifetime writes CG value delta', () => {
      it('adds a CG value diff over the extension window', async () => {
        const creator = getDefaultKCCreator(accounts);
        const nodes = await setupNodes();
        const cgId = await createOpenCG(creator);

        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t2.6-root'));
        const tokenAmount = ethers.parseEther('100');
        const epochs = 2;
        const byteSize = 1000;

        const p = await buildPublishParams({
          chainId,
          kav10Address,
          receivingNodes: nodes.receivingNodes,
          publisherIdentityId: nodes.publisherIdentityId,
          receiverIdentityIds: nodes.receiverIdentityIds,
          author: creator,
          contextGraphId: cgId,
          merkleRoot,
          knowledgeAssetsAmount: 10,
          byteSize,
          epochs,
          tokenAmount,
          isImmutable: false,
          publishOperationId: 't2.6-publish',
        });
        await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
        const kcId = 1n;
        await KAV10.connect(creator).publish(p);

        const meta = await KCS.getKnowledgeCollectionMetadata(kcId);
        const originalEndEpoch = meta[5];

        // Extension parameters. `extensionEpochs` is the duration of the
        // extension window; `extensionTokenAmount` is the TRAC paid for it.
        // Together they define the CG value diff we're asserting.
        const extensionEpochs = 3n;
        const extensionTokenAmount = ethers.parseEther('30');
        const expectedPerEpoch = extensionTokenAmount / extensionEpochs;

        // Capture diffs BEFORE extension so we can assert the delta is
        // EXACTLY the extension's per-epoch contribution (the original
        // publish already wrote its own diffs at publish time; we don't
        // want to include those in the delta).
        const positiveDiffBefore = await CGValueStorage.cgValueDiff(
          cgId,
          originalEndEpoch,
        );
        const negativeDiffBefore = await CGValueStorage.cgValueDiff(
          cgId,
          originalEndEpoch + extensionEpochs,
        );

        // Fund + execute extension.
        await TokenContract.connect(creator).approve(
          kav10Address,
          extensionTokenAmount,
        );
        await KAV10
          .connect(creator)
          .extendKnowledgeCollectionLifetime(
            kcId,
            extensionEpochs,
            extensionTokenAmount,
          );

        // Assert the extension's positive + negative diffs landed exactly at
        // the extension window boundaries, with the right per-epoch value.
        const positiveDiffAfter = await CGValueStorage.cgValueDiff(
          cgId,
          originalEndEpoch,
        );
        const negativeDiffAfter = await CGValueStorage.cgValueDiff(
          cgId,
          originalEndEpoch + extensionEpochs,
        );
        expect(positiveDiffAfter - positiveDiffBefore).to.equal(expectedPerEpoch);
        expect(negativeDiffBefore - negativeDiffAfter).to.equal(expectedPerEpoch);

        // KCS endEpoch advanced as expected.
        const newMeta = await KCS.getKnowledgeCollectionMetadata(kcId);
        expect(newMeta[5]).to.equal(originalEndEpoch + extensionEpochs);
      });
    });

    // ----------------------------------------------------------------------
    // T-VAL: publisherNodeIdentityId validation gate
    //
    // RFC-001 §3.6 makes `publisherNodeIdentityId` a self-claim, but the
    // contract MUST refuse to credit nonexistent nodes. Without this gate,
    // any publisher with a valid ACK quorum could pump publishing-factor
    // credit into arbitrary identity ids that the sharding table never
    // minted, distorting RandomSampling node scores.
    //
    // Spec: `_executePublishCore` requires
    //   p.publisherNodeIdentityId == 0 || shardingTableStorage.nodeExists(...)
    // and skips the EpochStorage write entirely when it's 0.
    // ----------------------------------------------------------------------
    describe('T-VAL: publisherNodeIdentityId validation', () => {
      it('reverts when publisherNodeIdentityId names a nonexistent node', async () => {
        const creator = getDefaultKCCreator(accounts);
        const author = creator;
        const nodes = await setupNodes();
        const cgId = await createOpenCG(creator);
        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t-val-1-root'));
        const tokenAmount = ethers.parseEther('100');

        // Use an obviously-out-of-band identity id that the sharding table
        // can't have minted (~`uint72` max).
        const FAKE_ID = 4_722_366_482_869_645_213_695n;

        const p = await buildPublishParams({
          chainId,
          kav10Address,
          receivingNodes: nodes.receivingNodes,
          publisherIdentityId: FAKE_ID,
          receiverIdentityIds: nodes.receiverIdentityIds,
          author,
          contextGraphId: cgId,
          merkleRoot,
          knowledgeAssetsAmount: 10,
          byteSize: 1000,
          epochs: 2,
          tokenAmount,
          isImmutable: false,
          publishOperationId: 't-val-1-op',
        });

        await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
        await expect(KAV10.connect(creator).publish(p)).to.be.revertedWith(
          'publisherNodeIdentityId not in sharding table',
        );
      });

      it('publisherNodeIdentityId=0 publishes successfully and writes NO produced-value credit', async () => {
        const creator = getDefaultKCCreator(accounts);
        const author = creator;
        const nodes = await setupNodes();
        const cgId = await createOpenCG(creator);
        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t-val-2-root'));
        const tokenAmount = ethers.parseEther('100');

        const p = await buildPublishParams({
          chainId,
          kav10Address,
          receivingNodes: nodes.receivingNodes,
          publisherIdentityId: 0n,
          receiverIdentityIds: nodes.receiverIdentityIds,
          author,
          contextGraphId: cgId,
          merkleRoot,
          knowledgeAssetsAmount: 10,
          byteSize: 1000,
          epochs: 2,
          tokenAmount,
          isImmutable: false,
          publishOperationId: 't-val-2-op',
        });

        await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
        const epochBefore = await ChronosContract.getCurrentEpoch();
        const globalBefore = await EpochStorageContract.getEpochProducedKnowledgeValue(epochBefore);

        await expect(KAV10.connect(creator).publish(p)).to.not.be.reverted;

        // Global epoch produced-value should be UNCHANGED — id=0 means
        // "no attribution," skip the EpochStorage write entirely.
        const globalAfter = await EpochStorageContract.getEpochProducedKnowledgeValue(epochBefore);
        expect(globalAfter).to.equal(globalBefore);
      });

      it('publisherNodeIdentityId on a real registered node credits that node', async () => {
        const creator = getDefaultKCCreator(accounts);
        const author = creator;
        const nodes = await setupNodes();
        const cgId = await createOpenCG(creator);
        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t-val-3-root'));
        const tokenAmount = ethers.parseEther('100');

        const p = await buildPublishParams({
          chainId,
          kav10Address,
          receivingNodes: nodes.receivingNodes,
          publisherIdentityId: nodes.publisherIdentityId,
          receiverIdentityIds: nodes.receiverIdentityIds,
          author,
          contextGraphId: cgId,
          merkleRoot,
          knowledgeAssetsAmount: 10,
          byteSize: 1000,
          epochs: 2,
          tokenAmount,
          isImmutable: false,
          publishOperationId: 't-val-3-op',
        });

        await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
        const epoch = await ChronosContract.getCurrentEpoch();
        const nodeBefore = await EpochStorageContract.getNodeEpochProducedKnowledgeValue(
          nodes.publisherIdentityId,
          epoch,
        );

        await expect(KAV10.connect(creator).publish(p)).to.not.be.reverted;

        const nodeAfter = await EpochStorageContract.getNodeEpochProducedKnowledgeValue(
          nodes.publisherIdentityId,
          epoch,
        );
        expect(nodeAfter - nodeBefore).to.equal(tokenAmount);
      });
    });

    // ----------------------------------------------------------------------
    // T-AUTHOR: parallel `merkleRootAuthors` mapping invariants
    //
    // PR #436 round 3 review feedback (@branarakic): the parallel mapping
    // can leak stale authors when array indices get reused via
    // `popMerkleRoot()` + `pushMerkleRoot()` or wholesale-replaced via
    // `setMerkleRoots()`. These tests pin the post-fix invariant:
    // `getLatestMerkleRootAuthor` and `getMerkleRootAuthorByIndex` must
    // never return an author that has been logically removed from the
    // canonical `merkleRoots[]` history.
    // ----------------------------------------------------------------------
    describe('T-AUTHOR: parallel author mapping does not leak stale entries', () => {
      it('popMerkleRoot clears the parallel author slot — no leak through pop+push', async () => {
        const creator = getDefaultKCCreator(accounts);
        const author = accounts[14];
        const nodes = await setupNodes();
        const cgId = await createOpenCG(creator);
        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t-author-1-root'));
        const tokenAmount = ethers.parseEther('100');

        const p = await buildPublishParams({
          chainId,
          kav10Address,
          receivingNodes: nodes.receivingNodes,
          publisherIdentityId: nodes.publisherIdentityId,
          receiverIdentityIds: nodes.receiverIdentityIds,
          author,
          contextGraphId: cgId,
          merkleRoot,
          knowledgeAssetsAmount: 10,
          byteSize: 1000,
          epochs: 2,
          tokenAmount,
          isImmutable: false,
          publishOperationId: 't-author-1-op',
        });

        await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
        await KAV10.connect(creator).publish(p);
        const kcId = await KCS.getLatestKnowledgeCollectionId();
        expect(await KCS.getLatestMerkleRootAuthor(kcId)).to.equal(author.address);

        // Register a test signer as a Hub-authorized contract so it can
        // call the `onlyContracts` admin-path functions on KCS.
        const testContract = accounts[19];
        await HubContract.setContractAddress('TestKCSAdmin', testContract.address);

        // Pop the only root → merkleRoots is empty; PRE-FIX the parallel
        // slot at index 0 still pointed at `author`.
        await KCS.connect(testContract).popMerkleRoot(kcId);

        // Push a fresh, unauthenticated root via the legacy path. PRE-FIX
        // this would have re-used index 0's stale author entry; POST-FIX
        // both `pop` (clear) and `push` (defensive clear) ensure the
        // reader sees `address(0)` for the new unauthenticated root.
        const newRoot = ethers.keccak256(ethers.toUtf8Bytes('t-author-1-newroot'));
        await KCS.connect(testContract).pushMerkleRoot(creator.address, kcId, newRoot);

        expect(await KCS.getLatestMerkleRootAuthor(kcId)).to.equal(ethers.ZeroAddress);
        expect(await KCS.getMerkleRootAuthorByIndex(kcId, 0)).to.equal(ethers.ZeroAddress);
      });

      it('setMerkleRoots clears stale author entries on wholesale replacement', async () => {
        const creator = getDefaultKCCreator(accounts);
        const author = accounts[14];
        const nodes = await setupNodes();
        const cgId = await createOpenCG(creator);
        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t-author-2-root'));
        const tokenAmount = ethers.parseEther('100');

        const p = await buildPublishParams({
          chainId,
          kav10Address,
          receivingNodes: nodes.receivingNodes,
          publisherIdentityId: nodes.publisherIdentityId,
          receiverIdentityIds: nodes.receiverIdentityIds,
          author,
          contextGraphId: cgId,
          merkleRoot,
          knowledgeAssetsAmount: 10,
          byteSize: 1000,
          epochs: 2,
          tokenAmount,
          isImmutable: false,
          publishOperationId: 't-author-2-op',
        });

        await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
        await KAV10.connect(creator).publish(p);
        const kcId = await KCS.getLatestKnowledgeCollectionId();
        expect(await KCS.getMerkleRootAuthorByIndex(kcId, 0)).to.equal(author.address);

        const testContract = accounts[19];
        await HubContract.setContractAddress('TestKCSAdmin', testContract.address);

        const replacement = [
          {
            publisher: creator.address,
            merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('t-author-2-replace-1')),
            timestamp: 0n,
          },
          {
            publisher: creator.address,
            merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('t-author-2-replace-2')),
            timestamp: 0n,
          },
        ];
        await KCS.connect(testContract).setMerkleRoots(kcId, replacement);

        // Both old (now overwritten) and new indices must read as zero —
        // wholesale replacement nukes the parallel mapping for the union
        // of old/new index ranges.
        expect(await KCS.getMerkleRootAuthorByIndex(kcId, 0)).to.equal(ethers.ZeroAddress);
        expect(await KCS.getMerkleRootAuthorByIndex(kcId, 1)).to.equal(ethers.ZeroAddress);
        expect(await KCS.getLatestMerkleRootAuthor(kcId)).to.equal(ethers.ZeroAddress);
      });
    });
  });
});
