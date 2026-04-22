import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  AskStorage,
  Chronos,
  ContextGraphs,
  ContextGraphStorage,
  ContextGraphValueStorage,
  DKGPublishingConvictionNFT,
  EpochStorage,
  Hub,
  KnowledgeAssetsV10,
  KnowledgeCollectionStorage,
  Profile,
  Staking,
  Token,
} from '../../typechain';
import {
  buildPublishAckDigest,
  buildPublishParams,
  buildPublisherDigest,
  buildUpdateParams,
  DEFAULT_CHAIN_ID,
  signPublishDigests,
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
      'ParanetKnowledgeCollectionsRegistry',
      'ParanetKnowledgeMinersRegistry',
      'ParanetsRegistry',
      'PaymasterManager',
      'ContextGraphStorage',
      'ContextGraphs',
      'ContextGraphValueStorage',
      'DKGPublishingConvictionNFT',
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

  async function fundAndStakeNode(node: NodeAccounts, identityId: number) {
    await TokenContract.mint(node.operational.address, MIN_STAKE);
    await TokenContract.connect(node.operational).approve(
      await StakingContract.getAddress(),
      MIN_STAKE,
    );
    await StakingContract.connect(node.operational).stake(identityId, MIN_STAKE);
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
      0, // curated
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
    // T1.1: publish via conviction — double-count guard (CRITICAL)
    // ----------------------------------------------------------------------
    describe('T1.1: conviction-path `publish` double-count guard', () => {
      it('does NOT call _distributeTokens — staker pool delta is zero during the publish itself', async () => {
        const creator = getDefaultKCCreator(accounts);
        const { publishingNode, publisherIdentityId, receivingNodes, receiverIdentityIds } =
          await setupNodes();

        // Create a conviction NFT account (committed TRAC already flows into
        // StakingStorage + EpochStorage at createAccount time — see DKGPublishingConvictionNFT).
        // The agent is the kc creator, so `publish` (conviction path) can resolve
        // agent -> accountId.
        await createConvictionAccountWithAgent(
          creator,
          ethers.parseEther('50000'),
          creator.address,
        );

        // Open CG so the creator is authorized without curator config.
        const cgId = await createOpenCG(creator);

        const currentEpoch = await ChronosContract.getCurrentEpoch();
        const tokenAmount = ethers.parseEther('1000');
        const epochs = 2;
        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t1.1-root'));

        // Snapshot staker pool across the epoch range that `_distributeTokens`
        // would touch (publish writes to [currentEpoch, currentEpoch + epochs]).
        // For conviction path the deltas MUST be zero for every entry.
        const poolsBefore: bigint[] = [];
        for (let i = 0n; i <= BigInt(epochs); i++) {
          poolsBefore.push(
            await EpochStorageContract.getEpochPool(STAKER_SHARD_ID, currentEpoch + i),
          );
        }

        const p = await buildPublishParams({
          chainId,
          kav10Address,
          publishingNode,
          receivingNodes,
          publisherIdentityId,
          receiverIdentityIds,
          contextGraphId: cgId,
          merkleRoot,
          knowledgeAssetsAmount: 10,
          byteSize: 1000,
          epochs,
          tokenAmount,
          isImmutable: false,
          publishOperationId: 't1.1-op',
        });

        const tx = await KAV10.connect(creator).publish(p);
        const receipt = await tx.wait();
        expect(receipt!.status).to.equal(1);

        // Assert every epoch in the publish window got ZERO delta from publish.
        // The createAccount-era deltas are already baked into poolsBefore
        // because they happened earlier in the same fixture setup.
        for (let i = 0n; i <= BigInt(epochs); i++) {
          const after = await EpochStorageContract.getEpochPool(
            STAKER_SHARD_ID,
            currentEpoch + i,
          );
          const delta = after - poolsBefore[Number(i)];
          expect(delta, `epoch +${i} delta must be 0 (double-count guard)`).to.equal(0n);
        }

        // KC landed correctly.
        const meta = await KCS.getKnowledgeCollectionMetadata(1);
        expect(meta[3]).to.equal(1000n); // byteSize
        expect(meta[4]).to.equal(currentEpoch); // startEpoch
        expect(meta[5]).to.equal(currentEpoch + BigInt(epochs)); // endEpoch
        expect(meta[6]).to.equal(tokenAmount);
        expect(meta[7]).to.equal(false); // isImmutable

        // CG binding and value ledger are both non-zero after publish.
        expect(await CGStorageContract.kcToContextGraph(1)).to.equal(cgId);
        const currentCGValue = await CGValueStorage.getCurrentCGValue(cgId);
        // Publish writes `tokenAmount / epochs` to `cgValueDiff[cgId][startEpoch]`;
        // at currentEpoch (== startEpoch) the value read equals tokenAmount/epochs.
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
          publishingNode,
          receivingNodes,
          publisherIdentityId,
          receiverIdentityIds,
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
        const tx = await KAV10.connect(creator).publishDirect(p, ethers.ZeroAddress);
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
          publishingNode,
          receivingNodes,
          publisherIdentityId,
          receiverIdentityIds,
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
          KAV10.connect(creator).publishDirect(p, ethers.ZeroAddress),
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
          publishingNode,
          receivingNodes,
          publisherIdentityId,
          receiverIdentityIds,
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
          publishingNode,
          receivingNodes,
          publisherIdentityId,
          receiverIdentityIds,
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
          KAV10.connect(creator).publishDirect(p, ethers.ZeroAddress),
        ).to.be.revertedWithCustomError(KAV10, 'ZeroEpochs');
      });
    });

    // ----------------------------------------------------------------------
    // T1.5: N26 publisher field order regression
    // ----------------------------------------------------------------------
    describe('T1.5: N26 publisher digest field order regression', () => {
      it('rejects a publisher signature built with the WRONG field order', async () => {
        const creator = getDefaultKCCreator(accounts);
        const { publishingNode, publisherIdentityId, receivingNodes, receiverIdentityIds } =
          await setupNodes();

        const cgId = await createOpenCG(creator);
        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t1.5-root'));
        const tokenAmount = ethers.parseEther('100');
        const epochs = 2;
        const knowledgeAssetsAmount = 10;
        const byteSize = 1000;

        // WRONG field order: (contextGraphId, publisherNodeIdentityId, merkleRoot).
        // Contract expects: (publisherNodeIdentityId, contextGraphId, merkleRoot).
        const wrongPublisherDigest = ethers.solidityPackedKeccak256(
          ['uint256', 'address', 'uint256', 'uint72', 'bytes32'],
          [chainId, kav10Address, cgId, publisherIdentityId, merkleRoot],
        );

        // ACK digest uses correct order so the receiver signatures aren't the
        // failing branch — we want to isolate the publisher sig failure.
        const rightAckDigest = buildPublishAckDigest(
          chainId,
          kav10Address,
          cgId,
          merkleRoot,
          knowledgeAssetsAmount,
          byteSize,
          epochs,
          tokenAmount,
        );

        const sig = await signPublishDigests(
          publishingNode,
          receivingNodes,
          wrongPublisherDigest,
          rightAckDigest,
        );

        const p = {
          publishOperationId: 't1.5-op',
          contextGraphId: cgId,
          merkleRoot,
          knowledgeAssetsAmount,
          byteSize,
          epochs,
          tokenAmount,
          isImmutable: false,
          publisherNodeIdentityId: publisherIdentityId,
          publisherNodeR: sig.publisherR,
          publisherNodeVS: sig.publisherVS,
          identityIds: receiverIdentityIds,
          r: sig.receiverRs,
          vs: sig.receiverVSs,
        };

        await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
        // The contract computes the CORRECT publisher digest and recovers a
        // different (valid but mismatched) signer from the wrong-order
        // signature, which fails `identityStorage.keyHasPurpose` and reverts
        // `SignerIsNotNodeOperator`. Pin the specific revert so future
        // changes to the publisher-sig path can't drift this test into a
        // silent false-positive.
        await expect(
          KAV10.connect(creator).publishDirect(p, ethers.ZeroAddress),
        ).to.be.revertedWithCustomError(KAV10, 'SignerIsNotNodeOperator');
      });
    });

    // ----------------------------------------------------------------------
    // T1.5b: ACK digest spec-conformance regression (Codex BLOCKER 1)
    //
    // Spec `03_PROTOCOL_CORE.md:2104` + decision #25 Option B
    // (`V10_CONTRACTS_REDESIGN_v2.md:549`) define the publish ACK digest as:
    //   (block.chainid, address(this), contextGraphId, merkleRoot,
    //    knowledgeAssetsAmount, byteSize, epochs, tokenAmount)
    //
    // An earlier draft of the contract incorrectly included
    // `publisherNodeIdentityId` in the ACK digest. This regression locks in
    // the spec-conformant shape: signing the WRONG (with-identityId) shape
    // must revert.
    // ----------------------------------------------------------------------
    describe('T1.5b: ACK digest spec-conformance regression', () => {
      it('rejects an ACK signed with the deprecated (publisherNodeIdentityId-included) shape', async () => {
        const creator = getDefaultKCCreator(accounts);
        const { publishingNode, publisherIdentityId, receivingNodes, receiverIdentityIds } =
          await setupNodes();

        const cgId = await createOpenCG(creator);
        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t1.5b-root'));
        const tokenAmount = ethers.parseEther('100');
        const epochs = 2;
        const knowledgeAssetsAmount = 10;
        const byteSize = 1000;

        // Correct publisher digest (publisher-side is fine).
        const publisherDigest = buildPublisherDigest(
          chainId,
          kav10Address,
          publisherIdentityId,
          cgId,
          merkleRoot,
        );

        // WRONG ACK digest: mirrors the deprecated layout that included
        // publisherNodeIdentityId. The contract computes the correct shape
        // (without identityId) so recovery yields a different signer.
        const wrongAckDigest = ethers.solidityPackedKeccak256(
          [
            'uint256', // chainId
            'address', // kav10Address
            'uint72',  // publisherNodeIdentityId (DEPRECATED — must NOT be in ACK)
            'uint256', // contextGraphId
            'bytes32', // merkleRoot
            'uint256', // knowledgeAssetsAmount
            'uint256', // byteSize
            'uint256', // epochs
            'uint256', // tokenAmount
          ],
          [
            chainId,
            kav10Address,
            publisherIdentityId,
            cgId,
            merkleRoot,
            knowledgeAssetsAmount,
            byteSize,
            epochs,
            tokenAmount,
          ],
        );

        const sig = await signPublishDigests(
          publishingNode,
          receivingNodes,
          publisherDigest,
          wrongAckDigest,
        );

        const p = {
          publishOperationId: 't1.5b-op',
          contextGraphId: cgId,
          merkleRoot,
          knowledgeAssetsAmount,
          byteSize,
          epochs,
          tokenAmount,
          isImmutable: false,
          publisherNodeIdentityId: publisherIdentityId,
          publisherNodeR: sig.publisherR,
          publisherNodeVS: sig.publisherVS,
          identityIds: receiverIdentityIds,
          r: sig.receiverRs,
          vs: sig.receiverVSs,
        };

        await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
        // Same rationale as T1.5: the wrong ACK field set produces a valid
        // signature over a different message, the contract recovers a
        // mismatched signer (publisher sig OR first receiver sig, whichever
        // the contract checks first), and `keyHasPurpose` rejects it. Pin
        // the specific error to keep the regression honest.
        await expect(
          KAV10.connect(creator).publishDirect(p, ethers.ZeroAddress),
        ).to.be.revertedWithCustomError(KAV10, 'SignerIsNotNodeOperator');
      });
    });

    // ----------------------------------------------------------------------
    // T1.6: H5 ACK digest cross-chain replay rejection
    // ----------------------------------------------------------------------
    describe('T1.6: H5 cross-chain replay rejection', () => {
      it('rejects an ACK digest built with a different chain id', async () => {
        const creator = getDefaultKCCreator(accounts);
        const { publishingNode, publisherIdentityId, receivingNodes, receiverIdentityIds } =
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
        const publisherDigest = buildPublisherDigest(
          mainnetChainId,
          kav10Address,
          publisherIdentityId,
          cgId,
          merkleRoot,
        );
        const ackDigest = buildPublishAckDigest(
          mainnetChainId,
          kav10Address,
          cgId,
          merkleRoot,
          knowledgeAssetsAmount,
          byteSize,
          epochs,
          tokenAmount,
        );
        const sig = await signPublishDigests(
          publishingNode,
          receivingNodes,
          publisherDigest,
          ackDigest,
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
          publisherNodeIdentityId: publisherIdentityId,
          publisherNodeR: sig.publisherR,
          publisherNodeVS: sig.publisherVS,
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
          KAV10.connect(creator).publishDirect(p, ethers.ZeroAddress),
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
          publishingNode: nodes.publishingNode,
          receivingNodes: nodes.receivingNodes,
          publisherIdentityId: nodes.publisherIdentityId,
          receiverIdentityIds: nodes.receiverIdentityIds,
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
        await KAV10.connect(creator).publishDirect(p, ethers.ZeroAddress);

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
          publishingNode: base.publishingNode,
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
          KAV10.connect(base.creator).updateDirect(up, ethers.ZeroAddress),
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
          publishingNode: base.publishingNode,
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
          KAV10.connect(base.creator).updateDirect(up, ethers.ZeroAddress),
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
          publishingNode: base.publishingNode,
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
          KAV10.connect(stranger).updateDirect(up, ethers.ZeroAddress),
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
          publishingNode: base.publishingNode,
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

        await expect(KAV10.connect(base.creator).updateDirect(up, ethers.ZeroAddress))
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
          publishingNode: base.publishingNode,
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
          KAV10.connect(base.creator).updateDirect(up1, ethers.ZeroAddress),
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
          KAV10.connect(base.creator).updateDirect(up1, ethers.ZeroAddress),
        ).to.be.revertedWithCustomError(KAV10, 'SignerIsNotNodeOperator');
      });

      // -- T1.7f: conviction-path update() happy path --
      //
      // T1.7a-d only exercised `updateDirect`. The conviction-path `update()`
      // shares `_executeUpdateCore` and only differs in how the delta is
      // paid (NFT.coverPublishingCost vs _addTokens+_distributeTokens). This
      // regression locks the conviction-path flow end-to-end.
      it('T1.7f: conviction-path update() pays delta via NFT without touching the staker pool', async () => {
        const base = await publishBaselineKC();

        // Register the creator as a conviction agent so `coverPublishingCost`
        // auto-resolves msg.sender -> accountId via agentToAccountId.
        await createConvictionAccountWithAgent(
          base.creator,
          ethers.parseEther('50000'),
          base.creator.address,
        );

        const newMerkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t1.7f-new'));
        const delta = ethers.parseEther('10');
        const newTokenAmount = base.tokenAmount + delta;

        const up = await buildUpdateParams({
          chainId,
          kav10Address,
          publishingNode: base.publishingNode,
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

        // Capture staker pool BEFORE update. Conviction path MUST leave it
        // untouched — the NFT's allowance already lives in EpochStorage.
        const currentEpoch = await ChronosContract.getCurrentEpoch();
        const meta = await KCS.getKnowledgeCollectionMetadata(base.kcId);
        const endEpoch = meta[5];
        const poolsBefore: bigint[] = [];
        for (let e = currentEpoch; e <= endEpoch; e++) {
          poolsBefore.push(
            await EpochStorageContract.getEpochPool(STAKER_SHARD_ID, e),
          );
        }

        await expect(KAV10.connect(base.creator).update(up)).to.not.be.reverted;

        // Post-condition: staker pool delta zero across the remaining window.
        let idx = 0;
        for (let e = currentEpoch; e <= endEpoch; e++) {
          const after = await EpochStorageContract.getEpochPool(STAKER_SHARD_ID, e);
          expect(after - poolsBefore[idx++], `epoch ${e} double-count`).to.equal(0n);
        }

        // KC metadata updated.
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
          publishingNode: base.publishingNode,
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
          KAV10.connect(base.creator).updateDirect(up, ethers.ZeroAddress),
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
          publishingNode: base.publishingNode,
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
          KAV10.connect(base.creator).updateDirect(up, ethers.ZeroAddress),
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
          publishingNode: base.publishingNode,
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

        await expect(KAV10.connect(base.creator).updateDirect(up, ethers.ZeroAddress))
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
          publishingNode: base.publishingNode,
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
          KAV10.connect(stranger).updateDirect(up, ethers.ZeroAddress),
        )
          .to.be.revertedWithCustomError(KAV10, 'UnauthorizedPublisher')
          .withArgs(base.cgId, stranger.address);

        // Positive sanity: the original publisher, who no longer holds
        // token `firstTokenId` (it's with the stranger), can still
        // update via the original-publisher pin. Locks "original
        // publisher retains rights even after selling a KA token".
        await expect(
          KAV10.connect(base.creator).updateDirect(up, ethers.ZeroAddress),
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
          publishingNode: nodes.publishingNode,
          receivingNodes: nodes.receivingNodes,
          publisherIdentityId: nodes.publisherIdentityId,
          receiverIdentityIds: nodes.receiverIdentityIds,
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
        await KAV10.connect(creator).publishDirect(p, ethers.ZeroAddress);

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
          publishingNode: base.publishingNode,
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
          KAV10.connect(base.creator).updateDirect(up, ethers.ZeroAddress),
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
          publishingNode: base.publishingNode,
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
          KAV10.connect(base.creator).updateDirect(up, ethers.ZeroAddress),
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
          publishingNode: base.publishingNode,
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

        await expect(KAV10.connect(base.creator).updateDirect(up, ethers.ZeroAddress))
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
          publishingNode: base.publishingNode,
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
          KAV10.connect(base.creator).updateDirect(up, ethers.ZeroAddress),
        ).to.be.revertedWithCustomError(KAV10, 'InvalidTokenAmount');
      });
    });
  });

  // ========================================================================
  // Tier 2 — should-have coverage
  // ========================================================================

  describe('Tier 2 — should-have coverage', () => {
    // ----------------------------------------------------------------------
    // T2.1: publish without conviction account reverts NoConvictionAccount
    // ----------------------------------------------------------------------
    describe('T2.1: publish without NFT account reverts NoConvictionAccount', () => {
      it('reverts when msg.sender is not registered as an agent', async () => {
        const creator = getDefaultKCCreator(accounts);
        const { publishingNode, publisherIdentityId, receivingNodes, receiverIdentityIds } =
          await setupNodes();

        const cgId = await createOpenCG(creator);
        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t2.1-root'));
        const tokenAmount = ethers.parseEther('100');

        const p = await buildPublishParams({
          chainId,
          kav10Address,
          publishingNode,
          receivingNodes,
          publisherIdentityId,
          receiverIdentityIds,
          contextGraphId: cgId,
          merkleRoot,
          knowledgeAssetsAmount: 10,
          byteSize: 1000,
          epochs: 2,
          tokenAmount,
          isImmutable: false,
          publishOperationId: 't2.1-op',
        });

        await expect(KAV10.connect(creator).publish(p))
          .to.be.revertedWithCustomError(NFT, 'NoConvictionAccount')
          .withArgs(creator.address);
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
          publishingNode,
          receivingNodes,
          publisherIdentityId,
          receiverIdentityIds,
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
          KAV10.connect(creator).publishDirect(p, ethers.ZeroAddress),
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

        const { publishingNode, publisherIdentityId, receivingNodes, receiverIdentityIds } =
          await setupNodes();

        const cgId = await createCuratedCG(accounts[0], authority.address);
        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t2.2b-root'));
        const tokenAmount = ethers.parseEther('100');

        const p = await buildPublishParams({
          chainId,
          kav10Address,
          publishingNode,
          receivingNodes,
          publisherIdentityId,
          receiverIdentityIds,
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
        await expect(KAV10.connect(stranger).publishDirect(p, ethers.ZeroAddress))
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

        const { publishingNode, publisherIdentityId, receivingNodes, receiverIdentityIds } =
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
          0, // curated
          nftOwner.address,
          pcaAccountId,
        );
        const cgId = await CGStorageContract.getLatestContextGraphId();

        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t2.3-root'));
        const tokenAmount = ethers.parseEther('100');

        const p = await buildPublishParams({
          chainId,
          kav10Address,
          publishingNode,
          receivingNodes,
          publisherIdentityId,
          receiverIdentityIds,
          contextGraphId: cgId,
          merkleRoot,
          knowledgeAssetsAmount: 10,
          byteSize: 1000,
          epochs: 2,
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
    // T2.4: publishDirect with paymaster path
    // ----------------------------------------------------------------------
    describe('T2.4: publishDirect via paymaster', () => {
      it('pulls TRAC from the paymaster contract, not msg.sender', async () => {
        const creator = getDefaultKCCreator(accounts);
        const { publishingNode, publisherIdentityId, receivingNodes, receiverIdentityIds } =
          await setupNodes();

        const cgId = await createOpenCG(creator);
        const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('t2.4-root'));
        const tokenAmount = ethers.parseEther('100');

        // ---- Paymaster wire-up ----
        //
        // KAV10's `_addTokens` checks `PaymasterManager.validPaymasters(paymaster)`
        // before taking the paymaster branch, so we MUST deploy through the
        // manager (it's the only code path that sets `validPaymasters[p] = true`).
        //
        // Paymaster ownership quirk: PaymasterManager calls `new Paymaster(hub)`,
        // which runs `Ownable(msg.sender)` with `msg.sender = PaymasterManager`.
        // That makes PaymasterManager the owner — not an EOA. `addAllowedAddress`
        // is `onlyOwner`, so we impersonate the PaymasterManager contract to
        // authorize KAV10. `fundPaymaster` is NOT onlyOwner, so any caller with
        // a matching TRAC allowance can top it up.
        const pmAddr = await HubContract.getContractAddress('PaymasterManager');
        const PaymasterManagerContract = await hre.ethers.getContractAt(
          'PaymasterManager',
          pmAddr,
        );
        await PaymasterManagerContract.connect(accounts[0]).deployPaymaster();
        const paymasterAddr = await PaymasterManagerContract.deployedPaymasters(
          accounts[0].address,
          0,
        );
        expect(await PaymasterManagerContract.validPaymasters(paymasterAddr)).to.be.true;

        // Impersonate the PaymasterManager so we can call `addAllowedAddress`
        // as the Paymaster's owner. `setBalance` gives the impersonated
        // account enough ETH to pay gas.
        const hardhatHelpers = await import('@nomicfoundation/hardhat-network-helpers');
        await hardhatHelpers.impersonateAccount(pmAddr);
        await hardhatHelpers.setBalance(pmAddr, ethers.parseEther('1'));
        const pmSigner = await hre.ethers.getSigner(pmAddr);
        const PaymasterContract = await hre.ethers.getContractAt('Paymaster', paymasterAddr);
        await PaymasterContract.connect(pmSigner).addAllowedAddress(kav10Address);
        await hardhatHelpers.stopImpersonatingAccount(pmAddr);

        // Fund the paymaster directly via ERC20 transfer from the deployer —
        // Paymaster's `_transferTokens` just reads `balanceOf(address(this))`,
        // so any path that leaves TRAC on the paymaster is equivalent.
        await TokenContract.connect(accounts[0]).transfer(paymasterAddr, tokenAmount);
        expect(await TokenContract.balanceOf(paymasterAddr)).to.equal(tokenAmount);

        const creatorBalanceBefore = await TokenContract.balanceOf(creator.address);

        const p = await buildPublishParams({
          chainId,
          kav10Address,
          publishingNode,
          receivingNodes,
          publisherIdentityId,
          receiverIdentityIds,
          contextGraphId: cgId,
          merkleRoot,
          knowledgeAssetsAmount: 10,
          byteSize: 1000,
          epochs: 2,
          tokenAmount,
          isImmutable: false,
          publishOperationId: 't2.4-op',
        });

        await KAV10.connect(creator).publishDirect(p, paymasterAddr);

        // Paymaster TRAC consumed; creator balance untouched.
        expect(await TokenContract.balanceOf(paymasterAddr)).to.equal(0n);
        expect(await TokenContract.balanceOf(creator.address)).to.equal(
          creatorBalanceBefore,
        );
      });
    });

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
          publishingNode: nodes.publishingNode,
          receivingNodes: nodes.receivingNodes,
          publisherIdentityId: nodes.publisherIdentityId,
          receiverIdentityIds: nodes.receiverIdentityIds,
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
        await KAV10.connect(creator).publishDirect(p, ethers.ZeroAddress);

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
          publishingNode: nodes.publishingNode,
          receivingNodes: nodes.receivingNodes,
          publisherIdentityId: nodes.publisherIdentityId,
          receiverIdentityIds: nodes.receiverIdentityIds,
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
        await expect(KAV10.connect(creator).updateDirect(up, ethers.ZeroAddress))
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
          publishingNode: nodes.publishingNode,
          receivingNodes: nodes.receivingNodes,
          publisherIdentityId: nodes.publisherIdentityId,
          receiverIdentityIds: nodes.receiverIdentityIds,
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
        await KAV10.connect(creator).publishDirect(p, ethers.ZeroAddress);

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
            ethers.ZeroAddress,
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
  });
});
