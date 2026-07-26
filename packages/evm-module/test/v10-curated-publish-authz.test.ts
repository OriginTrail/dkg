// #1689 — curated-CG publish authorization must consider the EIP-712-attested
// AUTHOR in addition to the paying principal (`msg.sender`).
//
// `KnowledgeAssetsLifecycle._executePublishCore` cryptographically proves the
// author (`_verifyAuthorAttestation`) and then authorizes against the CG publish
// policy. Before this change it authorized ONLY `msg.sender`, so for a curated
// CG in EOA/Safe mode — where `ContextGraphs.isAuthorizedPublisher` demands
// exact equality with the single stored authority — a curator with agent
// identity `A` could publish only from `A` itself. Any distinct funded
// operational / async-publisher wallet `P` was rejected before a transaction
// was ever built, which is what #1689 reports.
//
// The gate now accepts EITHER principal. This suite is the on-chain proof, and
// it is deliberately a MATRIX rather than a single happy-path test, because the
// change is a WIDENING and the risk is on both sides:
//
//   R2 proves the widening happened            (#1689 — the fix)
//   R3 proves it did not become author-only    (#1778 — curator pays for a
//                                               member-authored KA)
//   R4 proves it is still a gate at all        (neither principal ⇒ revert)
//
// There was previously ZERO coverage of the `UnauthorizedPublisher` revert
// anywhere in the repo, and no lifecycle-level test file at all —
// `test/unit/ContextGraphs.test.ts` covers the facade VIEW, which this change
// does not touch, so it is false comfort for this gate.
//
// TRAP (cost a reviewer real time, kept documented here): a curated CG requires
// a non-zero `catalogRoot` AND `catalogLeafCount`, validated BEFORE the
// authorization gate. Omitting them reverts `CuratedCGRequiresCatalogCommitment`
// — a failure that superficially resembles an authorization failure but is a
// different revert entirely. Every curated row below therefore commits a
// catalog.

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
import {
  getDefaultPublishingNode,
  getDefaultReceivingNodes,
} from './helpers/setup-helpers';
import { NodeAccounts } from './helpers/types';
import { buildPublishParams, DEFAULT_CHAIN_ID } from './helpers/v10-ka-helpers';

const MIN_STAKE = ethers.parseEther('50000');
const PCA_COMMITTED_TRAC = ethers.parseEther('50000');
const TOKEN_AMOUNT = ethers.parseEther('1000');
const BYTE_SIZE = 1000;
const EPOCHS = 5;

// Curated CGs must carry a catalog commitment (both fields non-zero) or the
// publish reverts BEFORE the authorization gate. See the TRAP note above.
const CATALOG_ROOT = ethers.keccak256(ethers.toUtf8Bytes('authz-catalog-root'));
const CATALOG_LEAF_COUNT = 3n;

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  Token: Token;
  Profile: Profile;
  StakingV10: StakingV10;
  StakingNFT: DKGStakingConvictionNFT;
  KnowledgeAssetsLifecycle: KnowledgeAssetsLifecycle;
  DKGKnowledgeAssets: DKGKnowledgeAssets;
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
    'ContextGraphWaiverStorage',
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
    Profile: await hre.ethers.getContract<Profile>('Profile'),
    StakingV10: await hre.ethers.getContract<StakingV10>('StakingV10'),
    StakingNFT: await hre.ethers.getContract<DKGStakingConvictionNFT>(
      'DKGStakingConvictionNFT',
    ),
    KnowledgeAssetsLifecycle:
      await hre.ethers.getContract<KnowledgeAssetsLifecycle>(
        'KnowledgeAssetsLifecycle',
      ),
    DKGKnowledgeAssets:
      await hre.ethers.getContract<DKGKnowledgeAssets>('DKGKnowledgeAssets'),
    ContextGraphs: await hre.ethers.getContract<ContextGraphs>('ContextGraphs'),
    ContextGraphStorage:
      await hre.ethers.getContract<ContextGraphStorage>('ContextGraphStorage'),
    NFT: await hre.ethers.getContract<DKGPublishingConvictionNFT>(
      'DKGPublishingConvictionNFT',
    ),
  };
}

describe('@integration V10 curated publish authorization (#1689)', function () {
  // Each row redeploys the full contract set through `deployments.fixture`,
  // which alone can exceed mocha's 40s default on a cold artifact cache (e.g.
  // the first run after a recompile). Same treatment as the other
  // deployment-heavy V10 suites.
  this.timeout(600_000);

  let accounts: SignerWithAddress[];
  let Token: Token;
  let ProfileContract: Profile;
  let StakingV10Contract: StakingV10;
  let StakingNFT: DKGStakingConvictionNFT;
  let KAV10: KnowledgeAssetsLifecycle;
  let KAS: DKGKnowledgeAssets;
  let CGFacade: ContextGraphs;
  let CGS: ContextGraphStorage;
  let NFT: DKGPublishingConvictionNFT;

  // Node/ACK plumbing, shared by every row.
  let receivingNodes: NodeAccounts[];
  let publisherIdentityId: number;
  let receiverIdentityIds: number[];

  // The cast of principals. `authority` is the curated CG's single stored
  // publish authority in EOA mode; everyone else is deliberately NOT it.
  let authority: SignerWithAddress; // A
  let payer: SignerWithAddress; // P — funded, never the authority
  let member: SignerWithAddress; // M — a CG member author, never the authority

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      Token,
      Profile: ProfileContract,
      StakingV10: StakingV10Contract,
      StakingNFT,
      KnowledgeAssetsLifecycle: KAV10,
      DKGKnowledgeAssets: KAS,
      ContextGraphs: CGFacade,
      ContextGraphStorage: CGS,
      NFT,
    } = await loadFixture(deployFixture));

    authority = accounts[10];
    payer = accounts[11];
    member = accounts[12];

    ({ receivingNodes, publisherIdentityId, receiverIdentityIds } =
      await setupNodes());
  });

  // ------------------------------------------------------------------------
  // Fixtures
  // ------------------------------------------------------------------------

  // The V10 ACK signer gate reads `getNodeStakeV10`; bring the nodes above zero
  // through the conviction-staking NFT path.
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

  const setupNodes = async () => {
    const publishingNode = getDefaultPublishingNode(accounts);
    const nodes = getDefaultReceivingNodes(accounts);
    const { identityId: pubIdentityId } = await createProfile(
      ProfileContract,
      publishingNode,
    );
    const receiverProfiles = await createProfiles(ProfileContract, nodes);

    await stakeV10(publishingNode.operational, pubIdentityId, MIN_STAKE);
    for (let i = 0; i < nodes.length; i++) {
      await stakeV10(
        nodes[i].operational,
        receiverProfiles[i].identityId,
        MIN_STAKE,
      );
    }

    return {
      receivingNodes: nodes,
      publisherIdentityId: pubIdentityId,
      receiverIdentityIds: receiverProfiles.map((p) => p.identityId),
    };
  };

  /**
   * Curated CG (publishPolicy 0) in EOA/Safe mode: `publishAuthorityAccountId`
   * is 0, so `isAuthorizedPublisher` takes the exact-equality branch against
   * `authorityAddress`. This is the shape #1689 is about.
   */
  const createCuratedCg = async (
    creator: SignerWithAddress,
    authorityAddress: string,
  ): Promise<bigint> => {
    await CGFacade.connect(creator).createContextGraph(
      [],
      0,
      1,
      0,
      authorityAddress,
      0,
      ethers.ZeroHash,
    );
    const cgId = await CGS.getLatestContextGraphId();
    expect(await CGS.getIsCurated(cgId)).to.equal(true);
    expect(await CGFacade.isAuthorizedPublisher(cgId, authorityAddress)).to.be
      .true;
    return cgId;
  };

  /** Open CG (publishPolicy 1): authorizes any non-zero principal. */
  const createOpenCg = async (creator: SignerWithAddress): Promise<bigint> => {
    await CGFacade.connect(creator).createContextGraph(
      [],
      0,
      0,
      1,
      ethers.ZeroAddress,
      0,
      ethers.ZeroHash,
    );
    const cgId = await CGS.getLatestContextGraphId();
    expect(await CGS.getIsCurated(cgId)).to.equal(false);
    return cgId;
  };

  const createPcaAccount = async (owner: SignerWithAddress): Promise<bigint> => {
    await Token.mint(owner.address, PCA_COMMITTED_TRAC);
    await Token.connect(owner).approve(
      await NFT.getAddress(),
      PCA_COMMITTED_TRAC,
    );
    await NFT.connect(owner).createAccount(PCA_COMMITTED_TRAC, 0);
    return NFT.totalSupply();
  };

  /**
   * Curated CG in PCA mode: `isAuthorizedPublisher` ignores the stored
   * authority snapshot and live-resolves `ownerOf(accountId)`, additionally
   * accepting any registered agent of that account. The CG is minted by a
   * SEPARATE wallet so the EOA branch can never trivially match.
   */
  const createPcaCuratedCg = async (
    minter: SignerWithAddress,
    pcaOwner: SignerWithAddress,
    accountId: bigint,
  ): Promise<bigint> => {
    await CGFacade.connect(minter).createContextGraph(
      [],
      0,
      1,
      0,
      pcaOwner.address,
      accountId,
      ethers.ZeroHash,
    );
    const cgId = await CGS.getLatestContextGraphId();
    expect(await CGS.getIsCurated(cgId)).to.equal(true);
    return cgId;
  };

  /**
   * Direct-spend funding: `_addTokens` pulls the gross from `msg.sender`, so a
   * payer that is not covered by a PCA discount must hold + approve it. Applied
   * to EVERY payer in this suite so that an under-funded wallet can never be
   * mistaken for an authorization failure.
   */
  const fundPayer = async (wallet: SignerWithAddress) => {
    await Token.mint(wallet.address, TOKEN_AMOUNT);
    await Token.connect(wallet).approve(await KAV10.getAddress(), TOKEN_AMOUNT);
  };

  const buildParams = async (args: {
    author: SignerWithAddress;
    contextGraphId: bigint;
    label: string;
    curated: boolean;
    epochs?: number;
  }) =>
    buildPublishParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes,
      publisherIdentityId,
      receiverIdentityIds,
      author: args.author,
      contextGraphId: args.contextGraphId,
      merkleRoot: ethers.keccak256(ethers.toUtf8Bytes(args.label)),
      knowledgeAssetsAmount: 1,
      byteSize: BYTE_SIZE,
      epochs: args.epochs ?? EPOCHS,
      tokenAmount: TOKEN_AMOUNT,
      isImmutable: false,
      publishOperationId: `${args.label}-op`,
      // Curated ⇒ commitment REQUIRED; public/open ⇒ commitment FORBIDDEN
      // (`PublicCGCannotHaveCatalogCommitment`). Both are checked before the
      // authorization gate.
      catalogRoot: args.curated ? CATALOG_ROOT : ethers.ZeroHash,
      catalogLeafCount: args.curated ? CATALOG_LEAF_COUNT : 0,
    });

  // ------------------------------------------------------------------------
  // R1 — baseline: the authority is both author and payer.
  // ------------------------------------------------------------------------
  it('R1: curated CG — author == payer == the CG authority publishes (baseline, unchanged)', async () => {
    const cgId = await createCuratedCg(authority, authority.address);
    await fundPayer(authority);

    const p = await buildParams({
      author: authority,
      contextGraphId: cgId,
      label: 'r1-authority-self',
      curated: true,
    });

    await (await KAV10.connect(authority).publish(p)).wait();

    expect(await KAS.ownerOf(p.reservedKaId)).to.equal(authority.address);
    expect(await CGS.kaToContextGraph(BigInt(p.reservedKaId))).to.equal(cgId);
  });

  // ------------------------------------------------------------------------
  // R2 — THE #1689 PROOF. Reverts `UnauthorizedPublisher` before the fix.
  // ------------------------------------------------------------------------
  it('R2: curated CG — attested author IS the authority, payer is a distinct funded wallet (#1689 proof)', async () => {
    const cgId = await createCuratedCg(authority, authority.address);
    await fundPayer(payer);

    // The payer is genuinely unauthorized on its own; only the author is.
    // Without both of these, R2 could pass for the wrong reason.
    expect(await CGFacade.isAuthorizedPublisher(cgId, payer.address)).to.be
      .false;
    expect(await CGFacade.isAuthorizedPublisher(cgId, authority.address)).to.be
      .true;

    const p = await buildParams({
      author: authority,
      contextGraphId: cgId,
      label: 'r2-author-authorized-payer-not',
      curated: true,
    });

    // Deltas, not absolutes: the deployment fixture pre-mints TRAC to every
    // signer, so absolute balances say nothing about who paid.
    const payerBefore = await Token.balanceOf(payer.address);
    const authorBefore = await Token.balanceOf(authority.address);

    await (await KAV10.connect(payer).publish(p)).wait();

    const kaId = BigInt(p.reservedKaId);
    // AUTHORIZATION moved; ATTRIBUTION did not. The payer is the
    // publisher-of-record and pays; the author owns the NFT.
    const roots = await KAS.getMerkleRoots(kaId);
    expect(roots.length).to.equal(1);
    expect(roots[0].publisher).to.equal(payer.address);
    expect(await KAS.ownerOf(kaId)).to.equal(authority.address);
    expect(await KAS.getLatestMerkleRootAuthor(kaId)).to.equal(
      authority.address,
    );
    // The full gross left the PAYER's wallet (direct-spend branch) and the
    // author paid nothing — the economics did not follow the authorization.
    expect(payerBefore - (await Token.balanceOf(payer.address))).to.equal(
      TOKEN_AMOUNT,
    );
    expect(await Token.balanceOf(authority.address)).to.equal(authorBefore);
    expect(await CGS.kaToContextGraph(kaId)).to.equal(cgId);
  });

  // ------------------------------------------------------------------------
  // R3 — #1778 must survive. This is the row that makes the OR load-bearing;
  // a strict author-only replacement (what the issue literally asks for)
  // breaks it.
  // ------------------------------------------------------------------------
  it('R3: curated CG — author is a member, the authorized CURATOR pays (#1778 curator-publishes-member-KA)', async () => {
    const cgId = await createCuratedCg(authority, authority.address);
    await fundPayer(authority);

    expect(await CGFacade.isAuthorizedPublisher(cgId, member.address)).to.be
      .false;

    const p = await buildParams({
      author: member,
      contextGraphId: cgId,
      label: 'r3-member-author-curator-pays',
      curated: true,
    });

    await (await KAV10.connect(authority).publish(p)).wait();

    const kaId = BigInt(p.reservedKaId);
    expect(await KAS.ownerOf(kaId)).to.equal(member.address);
    const roots = await KAS.getMerkleRoots(kaId);
    expect(roots[0].publisher).to.equal(authority.address);
  });

  // ------------------------------------------------------------------------
  // R4 — the gate is still a gate. Neither principal authorized ⇒ revert.
  // ------------------------------------------------------------------------
  it('R4: curated CG — neither author nor payer is authorized ⇒ reverts UnauthorizedPublisher(cgId, msg.sender)', async () => {
    const cgId = await createCuratedCg(authority, authority.address);
    await fundPayer(payer);

    expect(await CGFacade.isAuthorizedPublisher(cgId, payer.address)).to.be
      .false;
    expect(await CGFacade.isAuthorizedPublisher(cgId, member.address)).to.be
      .false;

    const p = await buildParams({
      author: member,
      contextGraphId: cgId,
      label: 'r4-neither-authorized',
      curated: true,
    });

    const payerBefore = await Token.balanceOf(payer.address);

    // The revert argument is deliberately `msg.sender`, not the author — the
    // ABI is unchanged by #1689 (decision D-2).
    await expect(KAV10.connect(payer).publish(p))
      .to.be.revertedWithCustomError(KAV10, 'UnauthorizedPublisher')
      .withArgs(cgId, payer.address);

    // Nothing was minted and no TRAC moved.
    await expect(KAS.ownerOf(p.reservedKaId)).to.be.revertedWithCustomError(
      KAS,
      'ERC721NonexistentToken',
    );
    expect(await Token.balanceOf(payer.address)).to.equal(payerBefore);
  });

  // ------------------------------------------------------------------------
  // R5 — open CGs authorize any non-zero principal and are untouched.
  // ------------------------------------------------------------------------
  it('R5: open CG (publishPolicy 1) — unauthorized-elsewhere author and payer both publish fine (unaffected)', async () => {
    const cgId = await createOpenCg(authority);
    await fundPayer(payer);

    const p = await buildParams({
      author: member,
      contextGraphId: cgId,
      label: 'r5-open-cg',
      curated: false,
    });

    await (await KAV10.connect(payer).publish(p)).wait();

    expect(await KAS.ownerOf(p.reservedKaId)).to.equal(member.address);
  });

  // ------------------------------------------------------------------------
  // R6 — PCA-curated CG, payer-side branch. Already worked via
  // `agentToAccountId`; must keep working.
  // ------------------------------------------------------------------------
  it('R6: PCA-curated CG — a registered PCA agent pays for a member-authored KA (PCA payer branch unaffected)', async () => {
    const pcaOwner = accounts[13];
    const pcaAgent = accounts[14];
    const cgMinter = accounts[16];

    const accountId = await createPcaAccount(pcaOwner);
    await NFT.connect(pcaOwner).registerAgent(accountId, pcaAgent.address);
    const cgId = await createPcaCuratedCg(cgMinter, pcaOwner, accountId);

    expect(await CGFacade.isAuthorizedPublisher(cgId, pcaAgent.address)).to.be
      .true;
    expect(await CGFacade.isAuthorizedPublisher(cgId, member.address)).to.be
      .false;

    // Take the DIRECT-SPEND branch, not the PCA discount branch: the discount
    // requires `p.epochs == lockDurationEpochs`, and this row is about
    // AUTHORIZATION, not economics. `+ 1` puts it off the tier deterministically.
    const lockDurationEpochs = Number((await NFT.accounts(accountId))[5]);
    await fundPayer(pcaAgent);

    const p = await buildParams({
      author: member,
      contextGraphId: cgId,
      label: 'r6-pca-agent-payer',
      curated: true,
      epochs: lockDurationEpochs + 1,
    });

    await (await KAV10.connect(pcaAgent).publish(p)).wait();

    expect(await KAS.ownerOf(p.reservedKaId)).to.equal(member.address);
  });

  // ------------------------------------------------------------------------
  // R7 — PCA-curated CG, AUTHOR-side branch. Reverts before the fix: the
  // author resolves through `ownerOf(accountId)` but was never consulted.
  // ------------------------------------------------------------------------
  it('R7: PCA-curated CG — the PCA owner is the attested author, a stranger pays (author-side PCA branch)', async () => {
    const pcaOwner = accounts[13];
    const stranger = accounts[15];
    const cgMinter = accounts[16];

    const accountId = await createPcaAccount(pcaOwner);
    const cgId = await createPcaCuratedCg(cgMinter, pcaOwner, accountId);

    // The author is authorized via the live `ownerOf` resolve; the payer is
    // neither the owner nor a registered agent.
    expect(await CGFacade.isAuthorizedPublisher(cgId, pcaOwner.address)).to.be
      .true;
    expect(await CGFacade.isAuthorizedPublisher(cgId, stranger.address)).to.be
      .false;

    await fundPayer(stranger);

    const p = await buildParams({
      author: pcaOwner,
      contextGraphId: cgId,
      label: 'r7-pca-owner-author-stranger-payer',
      curated: true,
    });

    await (await KAV10.connect(stranger).publish(p)).wait();

    const kaId = BigInt(p.reservedKaId);
    expect(await KAS.ownerOf(kaId)).to.equal(pcaOwner.address);
    const roots = await KAS.getMerkleRoots(kaId);
    expect(roots[0].publisher).to.equal(stranger.address);
  });

  // ------------------------------------------------------------------------
  // R8 — ordering: the attestation is verified BEFORE the authorization gate,
  // so a zero author can never reach it. Pins that #1689 did not turn an
  // unsigned `authorAddress` into an authorization principal.
  // ------------------------------------------------------------------------
  it('R8: curated CG — a zero authorAddress still reverts AuthorRequired (attestation precedes the authz gate)', async () => {
    const cgId = await createCuratedCg(authority, authority.address);
    await fundPayer(authority);

    const p = await buildParams({
      author: authority,
      contextGraphId: cgId,
      label: 'r8-zero-author',
      curated: true,
    });
    // Strip the author AFTER signing: the struct is otherwise fully valid, so
    // the only reason to revert is the zero-author guard itself.
    const zeroAuthor = { ...p, authorAddress: ethers.ZeroAddress };

    await expect(
      KAV10.connect(authority).publish(zeroAuthor),
    ).to.be.revertedWithCustomError(KAV10, 'AuthorRequired');
  });
});
