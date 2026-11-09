// =============================================================================
// V10 — publishing into a curated context graph requires a member author
// =============================================================================
//
// ContextGraphs 10.1.0. A publish into a curated CG passes two gates:
//
//   - the SENDER gate, `isAuthorizedPublisher(cgId, msg.sender)`, unchanged:
//     the EOA/Safe curator, or the live owner or a registered agent of the
//     CG's PCA, may submit and pay;
//   - the AUTHOR gate, `isAuthorizedAuthor(cgId, author)`, enforced in
//     `ContextGraphs.registerKnowledgeAsset`: the KA's EIP-712-attested author
//     must be a member of the CG (roster, CG NFT holder, or EOA/Safe curator).
//
// Before 10.1.0 any agent registered on the CG's PCA could bind KAs it
// authored itself into every CG bound to that PCA. A PCA is a payment vehicle
// shared across graphs, so these tests pin that agency no longer grants write
// access, while an agent can still pay for a member's KA (payer / author split).
//
// These run end to end through `KnowledgeAssetsLifecycle.publish`, with real
// ACK signatures and the PCA conviction branch paying.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  ContextGraphs,
  ContextGraphStorage,
  DKGKnowledgeAssets,
  DKGPublishingConvictionNFT,
  DKGStakingConvictionNFT,
  Hub,
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
// Instrumented coverage runs say nothing about deployed gas (and inflate it past the setup's limits).
const skipUnderCoverage = process.argv.some((a) => a.includes('coverage'));

type Fixture = {
  accounts: SignerWithAddress[];
  Token: Token;
  Profile: Profile;
  StakingV10: StakingV10;
  StakingNFT: DKGStakingConvictionNFT;
  KAV10: KnowledgeAssetsLifecycle;
  KAS: DKGKnowledgeAssets;
  CGFacade: ContextGraphs;
  CGS: ContextGraphStorage;
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
  return {
    accounts,
    Token: await hre.ethers.getContract<Token>('Token'),
    Profile: await hre.ethers.getContract<Profile>('Profile'),
    StakingV10: await hre.ethers.getContract<StakingV10>('StakingV10'),
    StakingNFT: await hre.ethers.getContract<DKGStakingConvictionNFT>('DKGStakingConvictionNFT'),
    KAV10: await hre.ethers.getContract<KnowledgeAssetsLifecycle>('KnowledgeAssetsLifecycle'),
    KAS: await hre.ethers.getContract<DKGKnowledgeAssets>('DKGKnowledgeAssets'),
    CGFacade: await hre.ethers.getContract<ContextGraphs>('ContextGraphs'),
    CGS: await hre.ethers.getContract<ContextGraphStorage>('ContextGraphStorage'),
    NFT: await hre.ethers.getContract<DKGPublishingConvictionNFT>('DKGPublishingConvictionNFT'),
  };
}

describe('@integration V10 — publishing into a curated CG requires a member author', function () {
  this.timeout(600000);

  let f: Fixture;
  let nodes: {
    receivingNodes: ReturnType<typeof getDefaultReceivingNodes>;
    publisherIdentityId: number;
    receiverIdentityIds: number[];
  };
  // Roles (signers 20+ stay clear of the node helpers' 1-9).
  let pcaOwner: SignerWithAddress; // owns the PCA the CG is bound to
  let registrar: SignerWithAddress; // payer that registered the CG: holds its NFT
  let payer: SignerWithAddress; // another payer on the PCA, not a member, no TRAC
  let outsider: SignerWithAddress; // agent registered on the PCA by its owner, not a member
  let member: SignerWithAddress; // the node key on the CG's roster; authors
  let accountId: bigint;
  let lockEpochs: number;
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

  /** Publicly readable, PCA-curated CG registered by `registrar`, with `roster`. */
  const pcaCuratedCg = async (roster: string[]): Promise<bigint> => {
    await f.CGFacade.connect(registrar).createContextGraph(
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
  const publish = async (sender: SignerWithAddress, author: SignerWithAddress, cgId: bigint, epochs = lockEpochs) => {
    opCounter += 1;
    const opId = `cg-membership-${opCounter}`;
    const reservedKaId = packReservedKaId(author.address, opCounter);
    const p = await buildPublishParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await f.KAV10.getAddress(),
      receivingNodes: nodes.receivingNodes,
      publisherIdentityId: nodes.publisherIdentityId,
      receiverIdentityIds: nodes.receiverIdentityIds,
      author,
      contextGraphId: cgId,
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

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    f = await loadFixture(deployFixture);
    nodes = await standUpNodes();
    [pcaOwner, registrar, payer, outsider, member] = f.accounts.slice(20, 25);

    await f.Token.mint(pcaOwner.address, COMMITTED_TRAC);
    await f.Token.connect(pcaOwner).approve(await f.NFT.getAddress(), COMMITTED_TRAC);
    await f.NFT.connect(pcaOwner).createAccount(COMMITTED_TRAC, 0);
    accountId = await f.NFT.totalSupply();
    lockEpochs = Number((await f.NFT.accounts(accountId))[5]);
    for (const agent of [registrar, payer, outsider]) {
      await f.NFT.connect(pcaOwner).registerAgent(accountId, agent.address);
    }
    // No agent approves KnowledgeAssetsLifecycle, so a publish they send can
    // only be paid through the PCA (direct spend would revert TooLowAllowance).
  });

  it('refuses an agent of the CG\'s PCA that authors its own KA', async () => {
    const cgId = await pcaCuratedCg([member.address]);
    // The sender gate still passes: the agent may submit and pay.
    expect(await f.CGFacade.isAuthorizedPublisher(cgId, outsider.address)).to.equal(true);
    expect(await f.CGFacade.isAuthorizedAuthor(cgId, outsider.address)).to.equal(false);

    const { tx } = await publish(outsider, outsider, cgId);
    await expect(tx)
      .to.be.revertedWithCustomError(f.CGFacade, 'AuthorNotContextGraphMember')
      .withArgs(cgId, outsider.address);
    expect(await f.CGS.getContextGraphKaCount(cgId)).to.equal(0n);
  });

  it('lets a payer that is not a member pay, through the PCA, for a member\'s KA', async () => {
    const cgId = await pcaCuratedCg([member.address]);
    const Logic = await hre.ethers.getContract('PublishingConviction');
    const payerBalance = await f.Token.balanceOf(payer.address);

    const { tx, reservedKaId } = await publish(payer, member, cgId);
    // The PCA paid; the payer's own TRAC is untouched.
    await expect(tx).to.emit(Logic, 'CostCovered');
    expect(await f.Token.balanceOf(payer.address)).to.equal(payerBalance);

    // The member authors and owns the KA; it is bound to the CG.
    expect(await f.KAS.ownerOf(reservedKaId)).to.equal(member.address);
    expect(await f.CGS.kaToContextGraph(reservedKaId)).to.equal(cgId);
  });

  it('lets the CG NFT holder publish its own KA (it governs the roster)', async () => {
    const cgId = await pcaCuratedCg([]);
    const { tx, reservedKaId } = await publish(registrar, registrar, cgId);
    expect((await (await tx).wait())!.status).to.equal(1);
    expect(await f.CGS.kaToContextGraph(reservedKaId)).to.equal(cgId);
  });

  it('refuses a member once the CG\'s owner removes it from the roster', async () => {
    const cgId = await pcaCuratedCg([member.address]);
    const first = await publish(payer, member, cgId);
    expect((await (await first.tx).wait())!.status).to.equal(1);

    await f.CGFacade.connect(registrar).removeParticipantAgent(cgId, member.address);
    const second = await publish(payer, member, cgId);
    await expect(second.tx)
      .to.be.revertedWithCustomError(f.CGFacade, 'AuthorNotContextGraphMember')
      .withArgs(cgId, member.address);
  });

  // The upgrade is a Hub facade swap plus a re-initialize of KnowledgeAssetsLifecycle (step 998 does both in
  // one transaction). Graphs, rosters and KAs live in ContextGraphStorage and survive it; until KAL is
  // re-initialized it still calls the replaced facade, which the Hub dropped, so publishes revert rather
  // than slip past the new rule.
  it('upgrade: a facade swap keeps graphs, rosters and KAs; KAL follows once re-initialized', async () => {
    const cgId = await pcaCuratedCg([member.address]);
    const first = await publish(payer, member, cgId);
    expect((await (await first.tx).wait())!.status).to.equal(1);

    const hub = await hre.ethers.getContract<Hub>('Hub');
    const next = await (await hre.ethers.getContractFactory('ContextGraphs')).deploy(await hub.getAddress());
    const nextAddress = await next.getAddress();
    const kalAddress = await f.KAV10.getAddress();

    // Swap the facade without re-initializing KAL: the stale facade has lost storage access.
    await hub.setAndReinitializeContracts([{ name: 'ContextGraphs', addr: nextAddress }], [], [nextAddress], []);
    expect(await hub.getContractAddress('ContextGraphs')).to.equal(nextAddress);
    const stale = await publish(payer, member, cgId);
    await expect(stale.tx).to.be.revertedWithCustomError(hub, 'UnauthorizedAccess');

    // Re-initialize KAL, as step 998 does: publishing resumes through the new facade, on the same storage.
    await hub.setAndReinitializeContracts([], [], [kalAddress], []);
    expect(await f.KAV10.contextGraphs()).to.equal(nextAddress);
    const second = await publish(payer, member, cgId);
    expect((await (await second.tx).wait())!.status).to.equal(1);
    expect(await f.CGS.getContextGraphKaCount(cgId)).to.equal(2n);
    expect(await f.CGS.kaToContextGraph(first.reservedKaId)).to.equal(cgId);
    expect(await next.isAuthorizedAuthor(cgId, member.address)).to.equal(true);

    const refused = await publish(outsider, outsider, cgId);
    await expect(refused.tx)
      .to.be.revertedWithCustomError(next, 'AuthorNotContextGraphMember')
      .withArgs(cgId, outsider.address);
  });

  it('leaves open CGs open: any agent may publish its own KA', async () => {
    await f.CGFacade.connect(registrar).createContextGraph(
      [], 0, 0, 1, ethers.ZeroAddress, 0, ethers.ZeroHash,
    );
    const openCg = await f.CGS.getLatestContextGraphId();
    const { tx, reservedKaId } = await publish(outsider, outsider, openCg);
    expect((await (await tx).wait())!.status).to.equal(1);
    expect(await f.KAS.ownerOf(reservedKaId)).to.equal(outsider.address);
  });

  // The roster scan is the only part of the author gate whose cost grows: one
  // cold SLOAD per entry before the match. Measured on the gate itself
  // (`isAuthorizedAuthor`, all reads cold), since publish-to-publish gas
  // varies by more than the gate's fixed part. In a publish the policy and
  // accountId reads are already warm, so these figures are an upper bound.
  (skipUnderCoverage ? it.skip : it)('gas: the author gate costs one cold storage read per roster entry scanned', async () => {
    const curator = f.accounts[25];
    const rosterOf = (n: number) =>
      Array.from({ length: n }, (_, i) => ethers.getAddress(ethers.toBeHex(0x1000 + i, 20)));

    /** EOA-curated CG whose roster has `n` entries, `member` last. */
    const cgWithRoster = async (n: number): Promise<bigint> => {
      const roster = rosterOf(n);
      roster[n - 1] = member.address;
      // A full 256-entry roster at creation exceeds the network's 15M default
      // per-transaction gas (O(n²) dedup + 256 fresh slots); this is setup only.
      await f.CGFacade.connect(curator).createContextGraph(
        roster, 0, 0, 0, curator.address, 0, ethers.ZeroHash, { gasLimit: 29_000_000 },
      );
      return f.CGS.getLatestContextGraphId();
    };
    const gateGas = (cgId: bigint, author: string) =>
      f.CGFacade.isAuthorizedAuthor.estimateGas(cgId, author);

    const curatorCg = await cgWithRoster(1);
    const curatorGas = await gateGas(curatorCg, curator.address); // matched before any scan
    const rows: Array<[number, bigint]> = [];
    const cgs: bigint[] = [];
    for (const n of [1, 16, 256]) {
      const cgId = await cgWithRoster(n);
      cgs.push(cgId);
      rows.push([n, (await gateGas(cgId, member.address)) - curatorGas]);
    }
    const perEntry = (rows[2][1] - rows[0][1]) / 255n;
    // eslint-disable-next-line no-console
    console.log(
      `      author gate, extra gas over a curator author: ` +
        rows.map(([n, d]) => `${d} with the member last of ${n}`).join(', ') +
        `; ~${perEntry} per entry scanned`,
    );
    expect(rows[0][1]).to.be.lt(10_000n);
    expect(perEntry).to.be.lt(3_000n);

    // The worst case still publishes, end to end: the curator sends and pays
    // for a KA authored by the 256th roster entry.
    await f.Token.mint(curator.address, TOKEN_AMOUNT);
    await f.Token.connect(curator).approve(await f.KAV10.getAddress(), TOKEN_AMOUNT);
    const { tx, reservedKaId } = await publish(curator, member, cgs[2], 2);
    const receipt = await (await tx).wait();
    expect(receipt!.status).to.equal(1);
    expect(await f.CGS.kaToContextGraph(reservedKaId)).to.equal(cgs[2]);
    // eslint-disable-next-line no-console
    console.log(`      worst-case publish (member last of 256): ${receipt!.gasUsed} gas`);
  });
});
