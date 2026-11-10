// =============================================================================
// V10 — a curated context graph's members send, and pay for, their own publishes
// =============================================================================
//
// ContextGraphs 10.2.0. The sender gate, `isAuthorizedPublisher(cgId,
// msg.sender)`, admits every member of a curated CG (its roster and the CG NFT
// holder) after the curator and PCA routes of 10.1.0. The author gate is
// unchanged: the KA's attested author must be a member.
//
// KnowledgeAssetsLifecycle is unchanged, and it keys the payment on
// `msg.sender` alone. So a member that sends pays like any sender: its own TRAC
// (direct spend), unless it is itself a registered agent of a live PCA whose
// lock matches. The CG's PCA is never charged for a member's send. These tests
// pin that, end to end through `KnowledgeAssetsLifecycle.publish` with real ACK
// signatures, and that a sender that is no member, curator or PCA agent is
// still refused.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
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
  KnowledgeAssetsLifecycle,
  Profile,
  StakingV10,
  Token,
} from '../typechain';
import { createProfile, createProfiles } from './helpers/profile-helpers';
import { getDefaultPublishingNode, getDefaultReceivingNodes } from './helpers/setup-helpers';
import { buildPublishParams, packReservedKaId, DEFAULT_CHAIN_ID } from './helpers/v10-ka-helpers';

const MIN_STAKE = ethers.parseEther('50000');
const COMMITTED_TRAC = ethers.parseEther('50000');
const TOKEN_AMOUNT = ethers.parseEther('1000');

type Fixture = {
  accounts: SignerWithAddress[];
  Token: Token;
  Profile: Profile;
  StakingNFT: DKGStakingConvictionNFT;
  Chronos: Chronos;
  KAV10: KnowledgeAssetsLifecycle;
  KAS: DKGKnowledgeAssets;
  CGFacade: ContextGraphs;
  CGS: ContextGraphStorage;
  NFT: DKGPublishingConvictionNFT;
  StakingV10: StakingV10;
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
  return {
    accounts: await hre.ethers.getSigners(),
    Token: await hre.ethers.getContract<Token>('Token'),
    Profile: await hre.ethers.getContract<Profile>('Profile'),
    StakingNFT: await hre.ethers.getContract<DKGStakingConvictionNFT>('DKGStakingConvictionNFT'),
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    KAV10: await hre.ethers.getContract<KnowledgeAssetsLifecycle>('KnowledgeAssetsLifecycle'),
    KAS: await hre.ethers.getContract<DKGKnowledgeAssets>('DKGKnowledgeAssets'),
    CGFacade: await hre.ethers.getContract<ContextGraphs>('ContextGraphs'),
    CGS: await hre.ethers.getContract<ContextGraphStorage>('ContextGraphStorage'),
    NFT: await hre.ethers.getContract<DKGPublishingConvictionNFT>('DKGPublishingConvictionNFT'),
    StakingV10: await hre.ethers.getContract<StakingV10>('StakingV10'),
  };
}

describe('@integration V10 — members send and pay for their own publishes into a curated CG', function () {
  this.timeout(600000);

  let f: Fixture;
  let nodes: {
    receivingNodes: ReturnType<typeof getDefaultReceivingNodes>;
    publisherIdentityId: number;
    receiverIdentityIds: number[];
  };
  // Roles (signers 20+ stay clear of the node helpers' 1-9). None of the
  // members is an agent of any PCA unless a test registers it.
  let pcaOwner: SignerWithAddress; // owns the PCA the CG is bound to
  let cgHolder: SignerWithAddress; // registered the CG and holds its NFT; not on the roster
  let member: SignerWithAddress; // on the roster
  let otherMember: SignerWithAddress; // on the roster too
  let agent: SignerWithAddress; // agent of the CG's PCA, not a member
  let stranger: SignerWithAddress; // neither
  let accountId: bigint;
  let lockEpochs: number;
  let cgId: bigint;
  let opCounter = 0;

  const stakeV10 = async (staker: SignerWithAddress, identityId: number, amount: bigint) => {
    await f.Token.mint(staker.address, amount);
    await f.Token.connect(staker).approve(await f.StakingV10.getAddress(), amount);
    await f.StakingNFT.connect(staker).createConviction(identityId, amount, 1);
  };

  const standUpNodes = async () => {
    const publishingNode = getDefaultPublishingNode(f.accounts);
    const receivingNodes = getDefaultReceivingNodes(f.accounts);
    const { identityId: publisherIdentityId } = await createProfile(f.Profile, publishingNode);
    const receiverProfiles = await createProfiles(f.Profile, receivingNodes);
    await stakeV10(publishingNode.operational, publisherIdentityId, MIN_STAKE);
    for (let i = 0; i < receivingNodes.length; i++) {
      await stakeV10(receivingNodes[i].operational, receiverProfiles[i].identityId, MIN_STAKE);
    }
    return {
      receivingNodes,
      publisherIdentityId,
      receiverIdentityIds: receiverProfiles.map((p) => p.identityId),
    };
  };

  /** Give `wallet` TRAC of its own and approve KnowledgeAssetsLifecycle to spend it. */
  const fund = async (wallet: SignerWithAddress, amount = TOKEN_AMOUNT) => {
    await f.Token.mint(wallet.address, amount);
    await f.Token.connect(wallet).approve(await f.KAV10.getAddress(), amount);
  };

  /** Publicly readable, PCA-curated CG registered by `holder`, with `roster`. */
  const pcaCuratedCg = async (holder: SignerWithAddress, roster: string[]): Promise<bigint> => {
    await f.CGFacade.connect(holder).createContextGraph(
      roster,
      0,
      0, // accessPolicy = public (no catalog commitment needed)
      0, // publishPolicy = curated
      pcaOwner.address,
      accountId,
      ethers.ZeroHash,
    );
    return f.CGS.getLatestContextGraphId();
  };

  /** Publish one KA authored by `author` and sent (and paid) by `sender`. */
  const publish = async (sender: SignerWithAddress, author: SignerWithAddress, cg: bigint, epochs = lockEpochs) => {
    opCounter += 1;
    const opId = `cg-member-sender-${opCounter}`;
    const reservedKaId = packReservedKaId(author.address, opCounter);
    const p = await buildPublishParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await f.KAV10.getAddress(),
      receivingNodes: nodes.receivingNodes,
      publisherIdentityId: nodes.publisherIdentityId,
      receiverIdentityIds: nodes.receiverIdentityIds,
      author,
      contextGraphId: cg,
      merkleRoot: ethers.keccak256(ethers.toUtf8Bytes(opId)),
      knowledgeAssetsAmount: 1,
      byteSize: 1000,
      epochs,
      tokenAmount: TOKEN_AMOUNT,
      isImmutable: false,
      publishOperationId: opId,
      reservedKaId,
    });
    return { tx: f.KAV10.connect(sender).publish(p), reservedKaId };
  };

  /** What the CG's PCA can still spend now: base allowance left plus top-up. */
  const pcaAllowance = async () => f.NFT.getRemainingAllowance(accountId, await f.Chronos.getCurrentEpoch());

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    f = await loadFixture(deployFixture);
    nodes = await standUpNodes();
    [pcaOwner, cgHolder, member, otherMember, agent, stranger] = f.accounts.slice(20, 26);

    await f.Token.mint(pcaOwner.address, COMMITTED_TRAC);
    await f.Token.connect(pcaOwner).approve(await f.NFT.getAddress(), COMMITTED_TRAC);
    await f.NFT.connect(pcaOwner).createAccount(COMMITTED_TRAC, 0);
    accountId = await f.NFT.totalSupply();
    lockEpochs = Number((await f.NFT.accounts(accountId))[5]);
    await f.NFT.connect(pcaOwner).registerAgent(accountId, agent.address);

    cgId = await pcaCuratedCg(cgHolder, [member.address, otherMember.address]);
  });

  it('a member sends its own KA and pays with its own TRAC, not the PCA\'s allowance', async () => {
    const Logic = await hre.ethers.getContract('PublishingConviction');
    // For contrast: an agent of the PCA paying for a member's KA draws the PCA.
    const beforeAgent = await pcaAllowance();
    const viaAgent = await publish(agent, member, cgId);
    await expect(viaAgent.tx).to.emit(Logic, 'CostCovered');
    expect(await pcaAllowance()).to.be.lt(beforeAgent);

    // The member is not an agent of any PCA, so its send is a direct spend.
    expect(await f.NFT.agentToAccountId(member.address)).to.equal(0n);
    await fund(member);
    const memberBalance = await f.Token.balanceOf(member.address);
    const allowanceBefore = await pcaAllowance();
    const topUpBefore = await f.NFT.topUpBalance(accountId);

    const { tx, reservedKaId } = await publish(member, member, cgId);
    await expect(tx).not.to.emit(Logic, 'CostCovered');
    // The member paid the full token amount (treasury fee included) ...
    expect(await f.Token.balanceOf(member.address)).to.equal(memberBalance - TOKEN_AMOUNT);
    // ... and the PCA paid nothing.
    expect(await pcaAllowance()).to.equal(allowanceBefore);
    expect(await f.NFT.topUpBalance(accountId)).to.equal(topUpBefore);

    expect(await f.KAS.ownerOf(reservedKaId)).to.equal(member.address);
    expect(await f.CGS.kaToContextGraph(reservedKaId)).to.equal(cgId);
  });

  it('a member without its own TRAC approval is refused: there is no fallback to the CG\'s PCA', async () => {
    await f.Token.mint(member.address, TOKEN_AMOUNT); // TRAC, but no approval
    const { tx } = await publish(member, member, cgId);
    await expect(tx).to.be.revertedWithCustomError(f.KAV10, 'TooLowAllowance');
    expect(await f.CGS.getContextGraphKaCount(cgId)).to.equal(0n);
  });

  it('a member that is also an agent of the CG\'s PCA is paid for by the PCA, as before', async () => {
    await f.NFT.connect(pcaOwner).registerAgent(accountId, member.address);
    const Logic = await hre.ethers.getContract('PublishingConviction');
    const memberBalance = await f.Token.balanceOf(member.address);

    const { tx, reservedKaId } = await publish(member, member, cgId);
    await expect(tx).to.emit(Logic, 'CostCovered');
    expect(await f.Token.balanceOf(member.address)).to.equal(memberBalance);
    expect(await f.KAS.ownerOf(reservedKaId)).to.equal(member.address);
  });

  it('the CG NFT holder sends and pays for its own KA, though it is neither curator nor PCA agent', async () => {
    expect(await f.NFT.agentToAccountId(cgHolder.address)).to.equal(0n);
    await fund(cgHolder);
    const holderBalance = await f.Token.balanceOf(cgHolder.address);

    const { tx, reservedKaId } = await publish(cgHolder, cgHolder, cgId);
    expect((await (await tx).wait())!.status).to.equal(1);
    expect(await f.Token.balanceOf(cgHolder.address)).to.equal(holderBalance - TOKEN_AMOUNT);
    expect(await f.CGS.kaToContextGraph(reservedKaId)).to.equal(cgId);
  });

  it('a member may send, and pay for, another member\'s KA, which the author owns', async () => {
    await fund(otherMember);
    const payerBalance = await f.Token.balanceOf(otherMember.address);

    const { tx, reservedKaId } = await publish(otherMember, member, cgId);
    expect((await (await tx).wait())!.status).to.equal(1);
    expect(await f.Token.balanceOf(otherMember.address)).to.equal(payerBalance - TOKEN_AMOUNT);
    expect(await f.KAS.ownerOf(reservedKaId)).to.equal(member.address);
  });

  it('refuses a sender that is no member, curator or PCA agent, even for a member\'s KA', async () => {
    await fund(stranger);
    const strangerBalance = await f.Token.balanceOf(stranger.address);

    const { tx } = await publish(stranger, member, cgId);
    await expect(tx)
      .to.be.revertedWithCustomError(f.KAV10, 'UnauthorizedPublisher')
      .withArgs(cgId, stranger.address);
    expect(await f.Token.balanceOf(stranger.address)).to.equal(strangerBalance);
    expect(await f.CGS.getContextGraphKaCount(cgId)).to.equal(0n);
  });

  it('refuses a removed member at the sender gate, which runs before the author gate', async () => {
    await fund(member);
    await f.CGFacade.connect(cgHolder).removeParticipantAgent(cgId, member.address);

    const { tx } = await publish(member, member, cgId);
    await expect(tx)
      .to.be.revertedWithCustomError(f.KAV10, 'UnauthorizedPublisher')
      .withArgs(cgId, member.address);
    expect(await f.CGS.getContextGraphKaCount(cgId)).to.equal(0n);
  });

  it('a member of one CG is not a sender into another', async () => {
    const elsewhere = await pcaCuratedCg(cgHolder, [otherMember.address]);
    await fund(member);

    const { tx } = await publish(member, member, elsewhere);
    await expect(tx)
      .to.be.revertedWithCustomError(f.KAV10, 'UnauthorizedPublisher')
      .withArgs(elsewhere, member.address);
  });

  // Figures for the PR and OT-RFC-75, printed rather than asserted: coverage
  // instrumentation inflates every one of them. The sender gate is measured on
  // the view with all reads cold. The two publishes go into the same
  // EOA-curated CG, both pay by direct spend, and both follow a warm-up KA by
  // the same author, so they differ only in the gates: the curator passes the
  // sender gate at once and the author gate then reads the roster cold; a
  // member reads it cold in the sender gate and warm in the author gate.
  it('gas: a member pays its membership read once, in the sender gate', async () => {
    const gate = (cg: bigint, sender: string) => f.CGFacade.isAuthorizedPublisher.estimateGas(cg, sender);
    const pcaFigures = {
      agent: await gate(cgId, agent.address),
      pcaOwner: await gate(cgId, pcaOwner.address),
      member: await gate(cgId, member.address),
      holder: await gate(cgId, cgHolder.address),
      refused: await gate(cgId, stranger.address),
    };

    const curator = f.accounts[26];
    await f.CGFacade.connect(curator).createContextGraph(
      [member.address], 0, 0, 0, curator.address, 0, ethers.ZeroHash,
    );
    const eoaCg = await f.CGS.getLatestContextGraphId();
    const eoaFigures = {
      curator: await gate(eoaCg, curator.address),
      member: await gate(eoaCg, member.address),
    };

    await fund(curator, TOKEN_AMOUNT * 2n);
    await fund(member);
    // The first KA in a CG, and the first by an author, write fresh slots.
    const warmUp = await publish(curator, member, eoaCg, 2);
    expect((await (await warmUp.tx).wait())!.status).to.equal(1);
    const byCurator = await (await (await publish(curator, member, eoaCg, 2)).tx).wait();
    const byMember = await (await (await publish(member, member, eoaCg, 2)).tx).wait();
    expect(byCurator!.status).to.equal(1);
    expect(byMember!.status).to.equal(1);

    // eslint-disable-next-line no-console
    console.log(
      `      sender gate (view, cold), PCA-curated: agent ${pcaFigures.agent}, PCA owner ${pcaFigures.pcaOwner}, ` +
        `member ${pcaFigures.member}, ` +
        `CG NFT holder ${pcaFigures.holder}, refused ${pcaFigures.refused}; ` +
        `EOA-curated: curator ${eoaFigures.curator}, member ${eoaFigures.member}`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `      publish, member's KA into an EOA-curated CG: sent by the curator ${byCurator!.gasUsed}, ` +
        `by the member ${byMember!.gasUsed} gas`,
    );
  });
});
