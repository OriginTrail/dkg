/**
 * KnowledgeAssetsV10-extra.test.ts — audit coverage.
 *
 * Covers findings (see .test-audit/BUGS_FOUND.md, evm-module):
 *   - E-4  (HIGH): ACK signed-vs-submitted cost-param mismatch matrix.
 *                  Each of (tokenAmount, epochs, byteSize,
 *                  knowledgeAssetsAmount) must be part of the ACK digest
 *                  and flipping ONE param after signing must reject.
 *   - E-5  (HIGH): H5 contract-address binding negative — signing the ACK
 *                  digest with KAV10 address A and submitting against
 *                  KAV10 address B must reject, same as cross-chain replay.
 *   - E-8  (HIGH): `minimumRequiredSignatures` dynamism — raising the
 *                  quorum via `ParametersStorage.setMinimumRequiredSignatures`
 *                  must take effect immediately for the NEXT publish.
 *                  Both "r.length < minSigs" (MinSignaturesRequirementNotMet)
 *                  and "uniqueCount < minSigs via duplicate identities"
 *                  (require "Insufficient unique receiver identities") branches.
 *   - E-9  (HIGH): publish event matrix — the spec lists the events the
 *                  KAV10 publish path MUST emit. We capture the full
 *                  event list and assert per-event presence. The
 *                  `KnowledgeBatchCreated` assertion is INTENTIONAL RED —
 *                  the spec says it should fire, but V10 routes through
 *                  `KnowledgeCollectionStorage` (which does not define
 *                  `KnowledgeBatchCreated`), so the assertion pins the
 *                  spec-vs-code mismatch as evidence.
 *
 * All tests use the real V10 deployment stack. No mocks.
 */
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  AskStorage,
  Chronos,
  ContextGraphStorage,
  ContextGraphs,
  EpochStorage,
  Hub,
  KnowledgeAssetsV10,
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

describe('@unit KnowledgeAssetsV10 — extra audit coverage (E-4, E-5, E-8, E-9)', () => {
  let accounts: SignerWithAddress[];
  let HubContract: Hub;
  let KAV10: KnowledgeAssetsV10;
  let KCS: KnowledgeCollectionStorage;
  let TokenContract: Token;
  let ProfileContract: Profile;
  let StakingContract: Staking;
  let ParametersStorageContract: ParametersStorage;
  let Facade: ContextGraphs;
  let CGStorageContract: ContextGraphStorage;

  let kav10Address: string;
  const chainId = DEFAULT_CHAIN_ID;
  const MIN_STAKE = ethers.parseEther('50000');

  async function deployFixture() {
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
    const Hub = await hre.ethers.getContract<Hub>('Hub');
    await Hub.setContractAddress('HubOwner', signers[0].address);
    return {
      accounts: signers,
      Hub,
      KAV10: await hre.ethers.getContract<KnowledgeAssetsV10>('KnowledgeAssetsV10'),
      KCS: await hre.ethers.getContract<KnowledgeCollectionStorage>(
        'KnowledgeCollectionStorage',
      ),
      Token: await hre.ethers.getContract<Token>('Token'),
      Profile: await hre.ethers.getContract<Profile>('Profile'),
      Staking: await hre.ethers.getContract<Staking>('Staking'),
      ParametersStorage: await hre.ethers.getContract<ParametersStorage>(
        'ParametersStorage',
      ),
      AskStorage: await hre.ethers.getContract<AskStorage>('AskStorage'),
      Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
      EpochStorage: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
      Facade: await hre.ethers.getContract<ContextGraphs>('ContextGraphs'),
      CGStorage: await hre.ethers.getContract<ContextGraphStorage>(
        'ContextGraphStorage',
      ),
    };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    const f = await loadFixture(deployFixture);
    accounts = f.accounts;
    HubContract = f.Hub;
    KAV10 = f.KAV10;
    KCS = f.KCS;
    TokenContract = f.Token;
    ProfileContract = f.Profile;
    StakingContract = f.Staking;
    ParametersStorageContract = f.ParametersStorage;
    Facade = f.Facade;
    CGStorageContract = f.CGStorage;
    kav10Address = await KAV10.getAddress();
  });

  async function fundAndStakeNode(node: NodeAccounts, identityId: number) {
    await TokenContract.mint(node.operational.address, MIN_STAKE);
    await TokenContract.connect(node.operational).approve(
      await StakingContract.getAddress(),
      MIN_STAKE,
    );
    await StakingContract.connect(node.operational).stake(identityId, MIN_STAKE);
  }

  async function setupNodes(receivingNodesCount = 3) {
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts, receivingNodesCount);
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

  async function createOpenCG(creator: SignerWithAddress): Promise<bigint> {
    await Facade.connect(creator).createContextGraph(
      [10n, 20n, 30n],
      [],
      2,
      0,
      1, // open
      ethers.ZeroAddress,
      0,
    );
    return CGStorageContract.getLatestContextGraphId();
  }

  // =========================================================================
  // E-4 — ACK signed-vs-submitted cost-param mismatch matrix
  //
  // For each of tokenAmount / epochs / byteSize / knowledgeAssetsAmount:
  //   1. Compute CORRECT publisher digest (so the publisher sig is fine).
  //   2. Compute an ACK digest with the SIGNED value of the field under test.
  //   3. Sign both.
  //   4. Submit PublishParams with a DIFFERENT value for the field under test.
  //   5. Assert revert SignerIsNotNodeOperator (the contract recomputes the
  //      ACK digest with the SUBMITTED value, recovers a different signer,
  //      and keyHasPurpose rejects it).
  //
  // This is the matrix-style pin that proves each param is inside the ACK
  // digest. If a future drift drops any field from the digest, the
  // corresponding assertion flips green and the test fails.
  // =========================================================================
  describe('E-4: ACK cost-param mismatch matrix', () => {
    const baseKaAmount = 10;
    const baseByteSize = 1000;
    const baseEpochs = 2;
    const baseTokenAmount = ethers.parseEther('100');

    async function runMismatch(
      signedAck: {
        knowledgeAssetsAmount: number | bigint;
        byteSize: number | bigint;
        epochs: number | bigint;
        tokenAmount: bigint;
      },
      submittedOverride: Partial<{
        knowledgeAssetsAmount: number;
        byteSize: number;
        epochs: number;
        tokenAmount: bigint;
      }>,
      opId: string,
    ) {
      const creator = getDefaultKCCreator(accounts);
      const { publishingNode, publisherIdentityId, receivingNodes, receiverIdentityIds } =
        await setupNodes();
      const cgId = await createOpenCG(creator);
      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes(opId));

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
        signedAck.knowledgeAssetsAmount,
        signedAck.byteSize,
        signedAck.epochs,
        signedAck.tokenAmount,
      );
      const sig = await signPublishDigests(
        publishingNode,
        receivingNodes,
        publisherDigest,
        ackDigest,
      );

      const submitted = {
        publishOperationId: opId,
        contextGraphId: cgId,
        merkleRoot,
        knowledgeAssetsAmount:
          submittedOverride.knowledgeAssetsAmount ?? baseKaAmount,
        byteSize: submittedOverride.byteSize ?? baseByteSize,
        epochs: submittedOverride.epochs ?? baseEpochs,
        tokenAmount: submittedOverride.tokenAmount ?? baseTokenAmount,
        isImmutable: false,
        publisherNodeIdentityId: publisherIdentityId,
        publisherNodeR: sig.publisherR,
        publisherNodeVS: sig.publisherVS,
        identityIds: receiverIdentityIds,
        r: sig.receiverRs,
        vs: sig.receiverVSs,
      };

      await TokenContract.connect(creator).approve(kav10Address, submitted.tokenAmount);
      return expect(
        KAV10.connect(creator).publishDirect(submitted, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(KAV10, 'SignerIsNotNodeOperator');
    }

    it('tokenAmount mismatch: signed X, submitted Y → reject', async () => {
      await runMismatch(
        {
          knowledgeAssetsAmount: baseKaAmount,
          byteSize: baseByteSize,
          epochs: baseEpochs,
          tokenAmount: baseTokenAmount,
        },
        { tokenAmount: baseTokenAmount + 1n },
        'e4-tokenAmount',
      );
    });

    it('epochs mismatch: signed 2, submitted 3 → reject', async () => {
      await runMismatch(
        {
          knowledgeAssetsAmount: baseKaAmount,
          byteSize: baseByteSize,
          epochs: baseEpochs,
          tokenAmount: baseTokenAmount,
        },
        { epochs: baseEpochs + 1 },
        'e4-epochs',
      );
    });

    it('byteSize mismatch: signed 1000, submitted 2000 → reject', async () => {
      await runMismatch(
        {
          knowledgeAssetsAmount: baseKaAmount,
          byteSize: baseByteSize,
          epochs: baseEpochs,
          tokenAmount: baseTokenAmount,
        },
        { byteSize: baseByteSize * 2 },
        'e4-byteSize',
      );
    });

    it('knowledgeAssetsAmount mismatch: signed 10, submitted 11 → reject', async () => {
      await runMismatch(
        {
          knowledgeAssetsAmount: baseKaAmount,
          byteSize: baseByteSize,
          epochs: baseEpochs,
          tokenAmount: baseTokenAmount,
        },
        { knowledgeAssetsAmount: baseKaAmount + 1 },
        'e4-kaAmount',
      );
    });
  });

  // =========================================================================
  // E-5 — H5 contract-address binding negative
  //
  // Sign ACK + publisher digests using KAV10 address A (some other address);
  // submit against the REAL KAV10 address. The contract prefixes with
  // `address(this)` so the recovered signer differs and the call reverts.
  // =========================================================================
  describe('E-5: H5 contract-address binding negative', () => {
    it('rejects signatures built against a DIFFERENT KAV10 address', async () => {
      const creator = getDefaultKCCreator(accounts);
      const { publishingNode, publisherIdentityId, receivingNodes, receiverIdentityIds } =
        await setupNodes();
      const cgId = await createOpenCG(creator);
      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('e5-root'));
      const tokenAmount = ethers.parseEther('100');
      const epochs = 2;
      const knowledgeAssetsAmount = 10;
      const byteSize = 1000;

      // WRONG binding: sign against a sibling KAV10 address. The 20-byte
      // diff leaks through `address(this)` and recovery yields a
      // mismatched signer.
      const otherKav10 = '0x000000000000000000000000000000000000dEaD';
      const publisherDigest = buildPublisherDigest(
        chainId,
        otherKav10,
        publisherIdentityId,
        cgId,
        merkleRoot,
      );
      const ackDigest = buildPublishAckDigest(
        chainId,
        otherKav10,
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
        publishOperationId: 'e5-op',
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

  // =========================================================================
  // E-8 — minimumRequiredSignatures dynamism
  //
  // Two flavors:
  //   a) Raise quorum above r.length → MinSignaturesRequirementNotMet.
  //   b) Raise quorum where r.length == quorum but identity ids are
  //      duplicated so uniqueCount < quorum → "Insufficient unique receiver
  //      identities" require(...). Flavor (b) is CRITICAL because the
  //      duplicate-identity Sybil shortcut must be rejected even when the
  //      array length looks correct.
  // =========================================================================
  describe('E-8: minimumRequiredSignatures dynamism', () => {
    it('raising quorum above r.length reverts MinSignaturesRequirementNotMet', async () => {
      const creator = getDefaultKCCreator(accounts);
      const { publishingNode, publisherIdentityId, receivingNodes, receiverIdentityIds } =
        await setupNodes(3);
      const cgId = await createOpenCG(creator);

      // Raise quorum from 3 -> 5. signers count is still 3.
      await ParametersStorageContract.connect(accounts[0]).setMinimumRequiredSignatures(5);
      expect(await ParametersStorageContract.minimumRequiredSignatures()).to.equal(5n);

      const p = await buildPublishParams({
        chainId,
        kav10Address,
        publishingNode,
        receivingNodes,
        publisherIdentityId,
        receiverIdentityIds,
        contextGraphId: cgId,
        merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('e8a')),
        knowledgeAssetsAmount: 10,
        byteSize: 1000,
        epochs: 2,
        tokenAmount: ethers.parseEther('100'),
        isImmutable: false,
        publishOperationId: 'e8a-op',
      });

      await TokenContract.connect(creator).approve(kav10Address, p.tokenAmount);
      await expect(
        KAV10.connect(creator).publishDirect(p, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(KAV10, 'MinSignaturesRequirementNotMet');
    });

    it('duplicate identity ids: uniqueCount < minSigs reverts "Insufficient unique receiver identities"', async () => {
      const creator = getDefaultKCCreator(accounts);
      const { publishingNode, publisherIdentityId, receivingNodes, receiverIdentityIds } =
        await setupNodes(3);
      const cgId = await createOpenCG(creator);

      // Build a FOUR-signer pack where receiver #3 is a duplicate of
      // receiver #0's identity id. Then raise the quorum to 4. r.length
      // satisfies the first gate (r.length >= minSigs == 4), but
      // uniqueCount = 3 < 4 triggers the second gate.
      await ParametersStorageContract.connect(accounts[0]).setMinimumRequiredSignatures(4);

      // Reuse the first receiver node signer so the ACK signature is valid
      // (keyHasPurpose passes) but the identity id collides.
      const extendedReceiverNodes = [...receivingNodes, receivingNodes[0]];
      const extendedReceiverIdentityIds = [...receiverIdentityIds, receiverIdentityIds[0]];

      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('e8b'));
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
      const sig = await signPublishDigests(
        publishingNode,
        extendedReceiverNodes,
        publisherDigest,
        ackDigest,
      );

      const p = {
        publishOperationId: 'e8b-op',
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
        identityIds: extendedReceiverIdentityIds,
        r: sig.receiverRs,
        vs: sig.receiverVSs,
      };

      await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
      await expect(
        KAV10.connect(creator).publishDirect(p, ethers.ZeroAddress),
      ).to.be.revertedWith('Insufficient unique receiver identities');
    });

    it('lowering quorum re-enables a submission that would otherwise fail', async () => {
      const creator = getDefaultKCCreator(accounts);
      const { publishingNode, publisherIdentityId, receivingNodes, receiverIdentityIds } =
        await setupNodes(2);
      const cgId = await createOpenCG(creator);

      // Default minSigs = 3; we only have 2 receivers — expect revert first.
      const p1 = await buildPublishParams({
        chainId,
        kav10Address,
        publishingNode,
        receivingNodes,
        publisherIdentityId,
        receiverIdentityIds,
        contextGraphId: cgId,
        merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('e8c-1')),
        knowledgeAssetsAmount: 10,
        byteSize: 1000,
        epochs: 2,
        tokenAmount: ethers.parseEther('100'),
        isImmutable: false,
        publishOperationId: 'e8c-1-op',
      });
      await TokenContract.connect(creator).approve(kav10Address, p1.tokenAmount);
      await expect(
        KAV10.connect(creator).publishDirect(p1, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(KAV10, 'MinSignaturesRequirementNotMet');

      // Lower quorum to 2, rebuild, retry — must succeed.
      await ParametersStorageContract.connect(accounts[0]).setMinimumRequiredSignatures(2);

      const p2 = await buildPublishParams({
        chainId,
        kav10Address,
        publishingNode,
        receivingNodes,
        publisherIdentityId,
        receiverIdentityIds,
        contextGraphId: cgId,
        merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('e8c-2')),
        knowledgeAssetsAmount: 10,
        byteSize: 1000,
        epochs: 2,
        tokenAmount: ethers.parseEther('100'),
        isImmutable: false,
        publishOperationId: 'e8c-2-op',
      });
      await TokenContract.connect(creator).approve(kav10Address, p2.tokenAmount);
      await expect(KAV10.connect(creator).publishDirect(p2, ethers.ZeroAddress)).to.not.be
        .reverted;
    });
  });

  // =========================================================================
  // E-9 — publish event matrix
  //
  // Spec list (per V10 protocol core §9):
  //   - KnowledgeCollectionCreated (on KCS)              [real, should fire]
  //   - KnowledgeAssetsMinted (on KCS)                   [real, should fire]
  //   - KnowledgeBatchCreated                            [spec says yes, code does NOT emit → INTENTIONAL RED]
  //
  // The test captures the full topic list from the tx receipt. Assertions
  // that document the gap are marked as such; flip-to-green semantics are
  // pinned to the spec, not the current code.
  // =========================================================================
  describe('E-9: publish event matrix (full spec list)', () => {
    let txReceipt: Awaited<ReturnType<Awaited<ReturnType<KnowledgeAssetsV10['publishDirect']>>['wait']>>;

    beforeEach(async () => {
      const creator = getDefaultKCCreator(accounts);
      const { publishingNode, publisherIdentityId, receivingNodes, receiverIdentityIds } =
        await setupNodes();
      const cgId = await createOpenCG(creator);

      const p = await buildPublishParams({
        chainId,
        kav10Address,
        publishingNode,
        receivingNodes,
        publisherIdentityId,
        receiverIdentityIds,
        contextGraphId: cgId,
        merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('e9-root')),
        knowledgeAssetsAmount: 10,
        byteSize: 1000,
        epochs: 2,
        tokenAmount: ethers.parseEther('100'),
        isImmutable: false,
        publishOperationId: 'e9-op',
      });

      await TokenContract.connect(creator).approve(kav10Address, p.tokenAmount);
      const tx = await KAV10.connect(creator).publishDirect(p, ethers.ZeroAddress);
      txReceipt = await tx.wait();
    });

    function logsByTopic(topicHash: string, emitter?: string) {
      return txReceipt!.logs.filter((l) => {
        if (l.topics[0] !== topicHash) return false;
        if (emitter && l.address.toLowerCase() !== emitter.toLowerCase()) return false;
        return true;
      });
    }

    it('emits KnowledgeCollectionCreated exactly once from KnowledgeCollectionStorage', async () => {
      const topic = KCS.interface.getEvent('KnowledgeCollectionCreated').topicHash;
      const logs = logsByTopic(topic, await KCS.getAddress());
      expect(logs.length).to.equal(1);
    });

    it('emits KnowledgeAssetsMinted exactly once from KnowledgeCollectionStorage', async () => {
      const topic = KCS.interface.getEvent('KnowledgeAssetsMinted').topicHash;
      const logs = logsByTopic(topic, await KCS.getAddress());
      expect(logs.length).to.equal(1);
    });

    it('SPEC-GAP (INTENTIONAL RED): spec requires KnowledgeBatchCreated but V10 never emits it', async () => {
      // KnowledgeBatchCreated is defined in `KnowledgeAssetsStorage` (the
      // V8-era assets contract). KAV10 publishes via
      // `KnowledgeCollectionStorage.createKnowledgeCollection`, which does
      // NOT emit KnowledgeBatchCreated. If the spec intends indexers to
      // track batch events from the KAV10 path, they will be silent.
      const topicHash = ethers.id(
        'KnowledgeBatchCreated(uint256,uint256,uint256,uint256,uint256,uint256,uint96,bool)',
      );
      const all = txReceipt!.logs.filter((l) => l.topics[0] === topicHash);
      // Spec says >= 1. Audit evidence: current V10 emits 0.
      expect(
        all.length,
        'spec-aligned V10 publish should emit KnowledgeBatchCreated at least once',
      ).to.be.gte(1);
    });
  });
});
