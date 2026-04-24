/**
 * DKG v10 KnowledgeAssetsV10 audit coverage.
 *
 * Findings covered (see .test-audit/BUGS_FOUND.md):
 *   E-4 (HIGH, TEST-DEBT): ACK signed-vs-submitted cost-param mismatch —
 *        sign ACK over one (epochs, tokenAmount, byteSize, knowledgeAssetsAmount)
 *        set, submit with a tampered value, assert signature recovery fails.
 *   E-5 (HIGH, TEST-DEBT): H5 contract-address binding — sign ACK/publisher
 *        digests with a different (foreign) KAV10 address than the contract
 *        handling the tx. Recovery mismatch → revert. Pins `address(this)`
 *        binding in the digest.
 *   E-8 (HIGH, TEST-DEBT): `minimumRequiredSignatures` dynamism — raise the
 *        quorum above the provided signature count and confirm publish reverts
 *        on the min-sigs guard. Also exercise the duplicate-identity branch
 *        which reverts "Insufficient unique receiver identities".
 *   E-9 (HIGH, SPEC-GAP):  KAV10 publish event matrix — spec (PRD v10
 *        §Publish Flow) prescribes dual emission of
 *        `KnowledgeBatchCreated` + `KnowledgeCollectionCreated`. Current V10
 *        code only emits the latter. Test asserts both are present and is
 *        intentionally left RED. See BUGS_FOUND.md#E-9.
 */

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
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
  KnowledgeAssetsStorage,
  KnowledgeCollectionStorage,
  ParametersStorage,
  Profile,
  Staking,
  Token,
} from '../../typechain';
import {
  buildPublishAckDigest,
  buildPublishParams,
  buildPublisherDigest,
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

describe('@unit v10 KnowledgeAssetsV10 audit', () => {
  let accounts: SignerWithAddress[];
  let HubContract: Hub;
  let KAV10: KnowledgeAssetsV10;
  let KCS: KnowledgeCollectionStorage;
  let KASStorage: KnowledgeAssetsStorage | null;
  let EpochStorageContract: EpochStorage;
  let AskStorageContract: AskStorage;
  let ChronosContract: Chronos;
  let TokenContract: Token;
  let ProfileContract: Profile;
  let StakingContract: Staking;
  let ParametersStorageContract: ParametersStorage;
  let Facade: ContextGraphs;
  let CGStorageContract: ContextGraphStorage;
  let CGValueStorage: ContextGraphValueStorage;
  let NFT: DKGPublishingConvictionNFT;

  let kav10Address: string;
  let chainId: bigint;

  const MIN_STAKE = ethers.parseEther('50000');

  type Fixture = {
    accounts: SignerWithAddress[];
    HubContract: Hub;
    KAV10: KnowledgeAssetsV10;
    KCS: KnowledgeCollectionStorage;
    KASStorage: KnowledgeAssetsStorage | null;
    EpochStorageContract: EpochStorage;
    AskStorageContract: AskStorage;
    ChronosContract: Chronos;
    TokenContract: Token;
    ProfileContract: Profile;
    StakingContract: Staking;
    ParametersStorageContract: ParametersStorage;
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
      'KnowledgeAssetsStorage',
      'KnowledgeAssetsV10',
    ]);

    const signers = await hre.ethers.getSigners();
    const HubContract = await hre.ethers.getContract<Hub>('Hub');
    await HubContract.setContractAddress('HubOwner', signers[0].address);

    const KAV10 = await hre.ethers.getContract<KnowledgeAssetsV10>(
      'KnowledgeAssetsV10',
    );
    const KCS = await hre.ethers.getContract<KnowledgeCollectionStorage>(
      'KnowledgeCollectionStorage',
    );
    // KnowledgeAssetsStorage (legacy V8/V9 batch storage) may not be deployed
    // with the V10-only tags — look it up best-effort for E-9's assertion.
    let KASStorage: KnowledgeAssetsStorage | null = null;
    try {
      KASStorage = await hre.ethers.getContract<KnowledgeAssetsStorage>(
        'KnowledgeAssetsStorage',
      );
    } catch (_) {
      KASStorage = null;
    }
    const EpochStorageContract = await hre.ethers.getContract<EpochStorage>(
      'EpochStorageV8',
    );
    const AskStorageContract = await hre.ethers.getContract<AskStorage>(
      'AskStorage',
    );
    const ChronosContract = await hre.ethers.getContract<Chronos>('Chronos');
    const TokenContract = await hre.ethers.getContract<Token>('Token');
    const ProfileContract = await hre.ethers.getContract<Profile>('Profile');
    const StakingContract = await hre.ethers.getContract<Staking>('Staking');
    const ParametersStorageContract =
      await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
    const Facade = await hre.ethers.getContract<ContextGraphs>('ContextGraphs');
    const CGStorageContract = await hre.ethers.getContract<ContextGraphStorage>(
      'ContextGraphStorage',
    );
    const CGValueStorage =
      await hre.ethers.getContract<ContextGraphValueStorage>(
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
      KASStorage,
      EpochStorageContract,
      AskStorageContract,
      ChronosContract,
      TokenContract,
      ProfileContract,
      StakingContract,
      ParametersStorageContract,
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
    KASStorage = f.KASStorage;
    EpochStorageContract = f.EpochStorageContract;
    AskStorageContract = f.AskStorageContract;
    ChronosContract = f.ChronosContract;
    TokenContract = f.TokenContract;
    ProfileContract = f.ProfileContract;
    StakingContract = f.StakingContract;
    ParametersStorageContract = f.ParametersStorageContract;
    Facade = f.Facade;
    CGStorageContract = f.CGStorageContract;
    CGValueStorage = f.CGValueStorage;
    NFT = f.NFT;

    kav10Address = await KAV10.getAddress();
    chainId = DEFAULT_CHAIN_ID;
  });

  async function fundAndStakeNode(node: NodeAccounts, identityId: number) {
    await TokenContract.mint(node.operational.address, MIN_STAKE);
    await TokenContract.connect(node.operational).approve(
      await StakingContract.getAddress(),
      MIN_STAKE,
    );
    await StakingContract.connect(node.operational).stake(identityId, MIN_STAKE);
  }

  async function setupNodes(receivingNodesCount = 3): Promise<{
    publishingNode: NodeAccounts;
    publisherIdentityId: number;
    receivingNodes: NodeAccounts[];
    receiverIdentityIds: number[];
  }> {
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(
      accounts,
      receivingNodesCount,
    );

    const { identityId: publisherIdentityId } = await createProfile(
      ProfileContract,
      publishingNode,
    );
    await fundAndStakeNode(publishingNode, publisherIdentityId);

    const receiverProfiles = await createProfiles(
      ProfileContract,
      receivingNodes,
    );
    const receiverIdentityIds = receiverProfiles.map((p) => p.identityId);
    for (let i = 0; i < receivingNodes.length; i++) {
      await fundAndStakeNode(receivingNodes[i], receiverProfiles[i].identityId);
    }
    return {
      publishingNode,
      publisherIdentityId,
      receivingNodes,
      receiverIdentityIds,
    };
  }

  async function createOpenCG(creator: SignerWithAddress): Promise<bigint> {
    await Facade.connect(creator).createContextGraph(
      [10n, 20n, 30n],
      [],
      2,
      0,
      1,
      ethers.ZeroAddress,
      0,
    );
    return CGStorageContract.getLatestContextGraphId();
  }

  // ==========================================================================
  // E-4: ACK signed-vs-submitted cost-param mismatch
  // ==========================================================================

  describe('E-4 — ACK signed-vs-submitted cost-param mismatch', () => {
    /**
     * Shared helper: produce a PublishParams where the ACK is signed using
     * one set of values but the submitted params use a tampered value. We
     * return the already-signed struct so individual tests can submit and
     * check the revert selector.
     */
    async function buildMismatchedPublishParams(opts: {
      tamper: 'tokenAmount' | 'epochs' | 'byteSize' | 'knowledgeAssetsAmount';
    }): Promise<{
      creator: SignerWithAddress;
      params: KnowledgeAssetsV10.PublishParamsStruct;
      tokenAmount: bigint;
    }> {
      const creator = getDefaultKCCreator(accounts);
      const {
        publishingNode,
        publisherIdentityId,
        receivingNodes,
        receiverIdentityIds,
      } = await setupNodes();
      const cgId = await createOpenCG(creator);

      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('e4-root'));
      const signedTokenAmount = ethers.parseEther('500');
      const signedEpochs = 3;
      const signedByteSize = 1000;
      const signedKnowledgeAssetsAmount = 10;

      // Signatures are computed against the "signed" values.
      const publisherDigest = buildPublisherDigest(
        chainId,
        kav10Address,
        publisherIdentityId,
        cgId,
        merkleRoot,
      );
      const ackDigest = buildPublishAckDigest(
        chainId,
        kav10Address,
        cgId,
        merkleRoot,
        signedKnowledgeAssetsAmount,
        signedByteSize,
        signedEpochs,
        signedTokenAmount,
      );
      const sig = await signPublishDigests(
        publishingNode,
        receivingNodes,
        publisherDigest,
        ackDigest,
      );

      // Submitted params: tamper exactly one field.
      const submitted = {
        publishOperationId: `e4-${opts.tamper}-op`,
        contextGraphId: cgId,
        merkleRoot,
        knowledgeAssetsAmount:
          opts.tamper === 'knowledgeAssetsAmount'
            ? signedKnowledgeAssetsAmount + 1
            : signedKnowledgeAssetsAmount,
        byteSize:
          opts.tamper === 'byteSize' ? signedByteSize + 1 : signedByteSize,
        epochs: opts.tamper === 'epochs' ? signedEpochs + 1 : signedEpochs,
        tokenAmount:
          opts.tamper === 'tokenAmount'
            ? signedTokenAmount + 1n
            : signedTokenAmount,
        isImmutable: false,
        publisherNodeIdentityId: publisherIdentityId,
        publisherNodeR: sig.publisherR,
        publisherNodeVS: sig.publisherVS,
        identityIds: receiverIdentityIds,
        r: sig.receiverRs,
        vs: sig.receiverVSs,
      };

      return { creator, params: submitted, tokenAmount: submitted.tokenAmount as bigint };
    }

    for (const field of [
      'tokenAmount',
      'epochs',
      'byteSize',
      'knowledgeAssetsAmount',
    ] as const) {
      it(`rejects publishDirect when submitted ${field} differs from signed ${field}`, async () => {
        const { creator, params, tokenAmount } =
          await buildMismatchedPublishParams({ tamper: field });
        await TokenContract.connect(creator).approve(
          kav10Address,
          tokenAmount,
        );
        await expect(
          KAV10.connect(creator).publishDirect(params, ethers.ZeroAddress),
        ).to.be.revertedWithCustomError(KAV10, 'SignerIsNotNodeOperator');
      });
    }
  });

  // ==========================================================================
  // E-5: H5 contract-address binding (address(this) in digest)
  // ==========================================================================

  describe('E-5 — H5 `address(this)` binding in publisher + ACK digests', () => {
    it('rejects publishDirect when ACK digest was signed against a foreign KAV10 address', async () => {
      const creator = getDefaultKCCreator(accounts);
      const {
        publishingNode,
        publisherIdentityId,
        receivingNodes,
        receiverIdentityIds,
      } = await setupNodes();
      const cgId = await createOpenCG(creator);

      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('e5-root'));
      const tokenAmount = ethers.parseEther('100');
      const epochs = 2;
      const knowledgeAssetsAmount = 10;
      const byteSize = 1000;

      // Foreign KAV10 address (KAV10_ADDRESS_A in BUGS_FOUND.md). We use
      // accounts[19] — a valid checksummed address that is NOT the deployed
      // KAV10. Signatures bind to this address but the tx lands on the real
      // contract, so `address(this)` mismatch → recovery yields a different
      // signer → `SignerIsNotNodeOperator`.
      const foreignKav10 = accounts[19].address;
      expect(foreignKav10.toLowerCase()).to.not.equal(
        kav10Address.toLowerCase(),
      );

      const publisherDigest = buildPublisherDigest(
        chainId,
        foreignKav10,
        publisherIdentityId,
        cgId,
        merkleRoot,
      );
      const ackDigest = buildPublishAckDigest(
        chainId,
        foreignKav10,
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
        publishOperationId: 'e5-foreign-kav10',
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
      await expect(
        KAV10.connect(creator).publishDirect(p, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(KAV10, 'SignerIsNotNodeOperator');
    });

    it('rejects publishDirect when ONLY the publisher digest was signed against a foreign KAV10 address', async () => {
      const creator = getDefaultKCCreator(accounts);
      const {
        publishingNode,
        publisherIdentityId,
        receivingNodes,
        receiverIdentityIds,
      } = await setupNodes();
      const cgId = await createOpenCG(creator);

      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('e5b-root'));
      const tokenAmount = ethers.parseEther('100');
      const epochs = 2;
      const knowledgeAssetsAmount = 10;
      const byteSize = 1000;

      const foreignKav10 = accounts[18].address;

      // ONLY the publisher digest binds to foreignKav10 — the ACK digest
      // binds to the real kav10Address. The publisher-side check runs first
      // in `_executePublishCore`, so we expect the publisher-sig branch to
      // fail.
      const publisherDigest = buildPublisherDigest(
        chainId,
        foreignKav10,
        publisherIdentityId,
        cgId,
        merkleRoot,
      );
      const ackDigest = buildPublishAckDigest(
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
        publisherDigest,
        ackDigest,
      );

      const p = {
        publishOperationId: 'e5-foreign-publisher-only',
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
      await expect(
        KAV10.connect(creator).publishDirect(p, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(KAV10, 'SignerIsNotNodeOperator');
    });
  });

  // ==========================================================================
  // E-8: minimumRequiredSignatures dynamism
  // ==========================================================================

  describe('E-8 — `minimumRequiredSignatures` dynamism', () => {
    it('raising the quorum above the signer count reverts publishDirect', async () => {
      const creator = getDefaultKCCreator(accounts);
      const {
        publishingNode,
        publisherIdentityId,
        receivingNodes,
        receiverIdentityIds,
      } = await setupNodes();
      const cgId = await createOpenCG(creator);

      // Default quorum is 3 and setupNodes provisioned 3 receiver sigs. We
      // raise the quorum to 5 via ParametersStorage — note the setter is
      // `onlyOwnerOrMultiSigOwner`, and `HubOwner` is registered to accounts[0]
      // in the fixture, so the deployer can call it directly.
      await ParametersStorageContract.connect(
        accounts[0],
      ).setMinimumRequiredSignatures(5);
      expect(
        await ParametersStorageContract.minimumRequiredSignatures(),
      ).to.equal(5n);

      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('e8-root'));
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
        publishOperationId: 'e8-op',
      });
      await TokenContract.connect(creator).approve(kav10Address, tokenAmount);

      // r.length (3) < minSigs (5) → MinSignaturesRequirementNotMet.
      await expect(
        KAV10.connect(creator).publishDirect(p, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(KAV10, 'MinSignaturesRequirementNotMet');
    });

    it('duplicate receiver identities trigger the "Insufficient unique receiver identities" branch', async () => {
      const creator = getDefaultKCCreator(accounts);
      const {
        publishingNode,
        publisherIdentityId,
        receivingNodes,
        receiverIdentityIds,
      } = await setupNodes();
      const cgId = await createOpenCG(creator);

      // Keep default quorum = 3. Provision 4 slots but only 2 unique ids
      // (duplicate one). r.length (4) >= minSigs (3) passes the first guard;
      // the uniqueCount check fires second with the literal require string.
      // We hand-assemble `p` because the helper insists on 1-to-1 node/id
      // alignment.
      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('e8-dup-root'));
      const tokenAmount = ethers.parseEther('100');
      const epochs = 2;
      const knowledgeAssetsAmount = 10;
      const byteSize = 1000;

      const publisherDigest = buildPublisherDigest(
        chainId,
        kav10Address,
        publisherIdentityId,
        cgId,
        merkleRoot,
      );
      const ackDigest = buildPublishAckDigest(
        chainId,
        kav10Address,
        cgId,
        merkleRoot,
        knowledgeAssetsAmount,
        byteSize,
        epochs,
        tokenAmount,
      );

      // 4 signing nodes: [n0, n1, n0, n1] — only 2 unique identities.
      const dupNodes = [
        receivingNodes[0],
        receivingNodes[1],
        receivingNodes[0],
        receivingNodes[1],
      ];
      const dupIds = [
        receiverIdentityIds[0],
        receiverIdentityIds[1],
        receiverIdentityIds[0],
        receiverIdentityIds[1],
      ];
      const sig = await signPublishDigests(
        publishingNode,
        dupNodes,
        publisherDigest,
        ackDigest,
      );

      const p = {
        publishOperationId: 'e8-dup-op',
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
        identityIds: dupIds,
        r: sig.receiverRs,
        vs: sig.receiverVSs,
      };

      await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
      await expect(
        KAV10.connect(creator).publishDirect(p, ethers.ZeroAddress),
      ).to.be.revertedWith('Insufficient unique receiver identities');
    });

    it('lowering the quorum to 1 allows single-signer publishes to pass verification', async () => {
      const creator = getDefaultKCCreator(accounts);
      const {
        publishingNode,
        publisherIdentityId,
        receivingNodes,
        receiverIdentityIds,
      } = await setupNodes();
      const cgId = await createOpenCG(creator);

      await ParametersStorageContract.connect(
        accounts[0],
      ).setMinimumRequiredSignatures(1);
      expect(
        await ParametersStorageContract.minimumRequiredSignatures(),
      ).to.equal(1n);

      // Build a publish with exactly ONE receiver signature.
      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('e8-single'));
      const tokenAmount = ethers.parseEther('100');
      const p = await buildPublishParams({
        chainId,
        kav10Address,
        publishingNode,
        receivingNodes: [receivingNodes[0]],
        publisherIdentityId,
        receiverIdentityIds: [receiverIdentityIds[0]],
        contextGraphId: cgId,
        merkleRoot,
        knowledgeAssetsAmount: 10,
        byteSize: 1000,
        epochs: 2,
        tokenAmount,
        isImmutable: false,
        publishOperationId: 'e8-single-op',
      });
      await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
      await expect(
        KAV10.connect(creator).publishDirect(p, ethers.ZeroAddress),
      ).to.not.be.reverted;
    });
  });

  // ==========================================================================
  // E-9: KAV10 publish event matrix (dual emit per spec)
  // ==========================================================================

  describe('E-9 — publish event matrix (spec: dual emit KnowledgeBatchCreated + KnowledgeCollectionCreated)', () => {
    it('always emits KnowledgeCollectionCreated on publishDirect (current behavior)', async () => {
      const creator = getDefaultKCCreator(accounts);
      const {
        publishingNode,
        publisherIdentityId,
        receivingNodes,
        receiverIdentityIds,
      } = await setupNodes();
      const cgId = await createOpenCG(creator);

      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('e9-root'));
      const tokenAmount = ethers.parseEther('500');
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
        publishOperationId: 'e9-op',
      });
      await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
      const kcIdBefore = await KCS.getLatestKnowledgeCollectionId();
      const tx = await KAV10.connect(creator).publishDirect(
        p,
        ethers.ZeroAddress,
      );

      // Parse the receipt to read the assigned kcId so we can assert the
      // event args exactly. Pinning the full KCS payload (id, operationId,
      // merkleRoot, byteSize, tokenAmount, isImmutable) catches regressions
      // that silently swap operationId, drop the immutability bit, or log
      // the wrong merkle root.
      const receipt = await tx.wait();
      const kcIdAfter = await KCS.getLatestKnowledgeCollectionId();
      expect(kcIdAfter).to.equal(kcIdBefore + 1n);

      const topic = KCS.interface.getEvent('KnowledgeCollectionCreated').topicHash;
      const kcsAddr = (await KCS.getAddress()).toLowerCase();
      const eventLog = receipt!.logs.find(
        (l) => l.address.toLowerCase() === kcsAddr && l.topics[0] === topic,
      );
      expect(eventLog, 'KnowledgeCollectionCreated log present').to.not.equal(undefined);
      const decoded = KCS.interface.decodeEventLog(
        'KnowledgeCollectionCreated',
        eventLog!.data,
        eventLog!.topics,
      );
      expect(decoded.id).to.equal(kcIdAfter);
      expect(decoded.publishOperationId).to.equal('e9-op');
      expect(decoded.merkleRoot).to.equal(merkleRoot);
      expect(decoded.byteSize).to.equal(1000n);
      expect(decoded.tokenAmount).to.equal(tokenAmount);
      expect(decoded.isImmutable).to.equal(false);
      // startEpoch/endEpoch are Chronos-dependent; assert invariants rather
      // than hardcoding values.
      expect(decoded.endEpoch - decoded.startEpoch).to.equal(2n);
    });

    it('SPEC-GAP: must ALSO emit KnowledgeBatchCreated alongside KnowledgeCollectionCreated', async () => {
      // Precondition: the legacy KnowledgeAssetsStorage must be deployed —
      // the PRD expects V10 publish to fan out to it AND to the V10 KCS for
      // indexer symmetry with V8/V9. If the legacy storage isn't deployed
      // at all we record that, too, because the spec drift is strictly
      // worse (no batch event possible).
      if (KASStorage == null) {
        throw new Error(
          'KnowledgeAssetsStorage not deployed — V10 publish cannot dual-emit as the spec requires (BUGS_FOUND.md#E-9)',
        );
      }

      const creator = getDefaultKCCreator(accounts);
      const {
        publishingNode,
        publisherIdentityId,
        receivingNodes,
        receiverIdentityIds,
      } = await setupNodes();
      const cgId = await createOpenCG(creator);

      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('e9-dual-root'));
      const tokenAmount = ethers.parseEther('500');
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
        publishOperationId: 'e9-dual-op',
      });
      await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
      const tx = await KAV10.connect(creator).publishDirect(
        p,
        ethers.ZeroAddress,
      );
      const receipt = await tx.wait();

      const kcsAddr = (KCS.target as string).toLowerCase();
      const kcsCreatedTopic = KCS.interface.getEvent(
        'KnowledgeCollectionCreated',
      ).topicHash;
      const kcsCreated = receipt!.logs.filter(
        (l) =>
          l.address.toLowerCase() === kcsAddr &&
          l.topics[0] === kcsCreatedTopic,
      );
      expect(kcsCreated.length).to.equal(1);

      const kasAddr = (KASStorage.target as string).toLowerCase();
      const batchCreatedTopic = KASStorage.interface.getEvent(
        'KnowledgeBatchCreated',
      ).topicHash;
      const batchCreated = receipt!.logs.filter(
        (l) =>
          l.address.toLowerCase() === kasAddr &&
          l.topics[0] === batchCreatedTopic,
      );
      // Current V10 publish does NOT touch KnowledgeAssetsStorage, so this
      // fails until the spec gap is closed. Intentionally RED.
      expect(
        batchCreated.length,
        'spec requires KnowledgeBatchCreated dual-emit (BUGS_FOUND.md#E-9)',
      ).to.equal(1);
    });
  });
});
