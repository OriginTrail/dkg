// OT-RFC-53 registration deposit: the full decision matrix of
// `ContextGraphs.createContextGraph` (10.0.5).
//
// Every combination of harness cell (access x publish policy), curator type,
// creator role, PCA state and deposit setting creates one graph and is checked
// against `expectedOutcome`, which states the rules directly:
//   - deposit off -> free, and no waiver slot is used;
//   - the covering PCA is the graph's curator PCA when it has one, otherwise
//     the PCA the creator is a registered agent of;
//   - the deposit is waived only if that PCA is live, at or above the
//     commitment floor, has quota left, and the creator is its owner or agent;
//   - everything else is charged into the graph's escrow.
// Every case also checks that the deposit decision never changes the graph's
// own config (owner, policies, curator, curator PCA).

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  ContextGraphs,
  ContextGraphStorage,
  ContextGraphWaiverStorage,
  ConvictionStakingStorage,
  DKGPublishingConvictionNFT,
  Hub,
  ParametersStorage,
  Token,
} from '../typechain';

// A 25k deposit gives a 50k PCA a quota of exactly 2, so "quota used up" costs
// two graphs. The waiver floor stays at its 25k default.
const DEPOSIT = ethers.parseEther('25000');
const PCA_COMMIT = ethers.parseEther('50000');
const BELOW_FLOOR_COMMIT = ethers.parseEther('10000');

const CELLS = ['00', '01', '10', '11'] as const; // access digit, publish digit
type Cell = (typeof CELLS)[number];
type Curator = 'none' | 'wallet' | 'pca';

// Creator roles, relative to A (the PCA under test) and B (another PCA that is
// always eligible).
const ROLES = [
  'noPca', // no PCA relation at all
  'owner', // owns A, not registered as an agent
  'ownerAsAgent', // owns A and is registered as A's agent
  'agent', // registered agent of A
  'agentOfOther', // registered agent of B
  'ownerAgentOfOther', // owns A and is registered as B's agent
] as const;
type Role = (typeof ROLES)[number];

const STATES = ['eligible', 'expired', 'swept', 'belowFloor', 'quotaUsedUp'] as const;
type PcaState = (typeof STATES)[number];

type Outcome = 'free' | 'waived' | 'charged';

// The PCA a role's wallet is bound to as an agent (drives the fallback).
const AGENT_BINDING: Record<Role, 'A' | 'B' | null> = {
  noPca: null,
  owner: null,
  ownerAsAgent: 'A',
  agent: 'A',
  agentOfOther: 'B',
  ownerAgentOfOther: 'B',
};

// Whether the role's wallet may use A's waiver (its owner or its agent).
const CONTROLS_A: Record<Role, boolean> = {
  noPca: false,
  owner: true,
  ownerAsAgent: true,
  agent: true,
  agentOfOther: false,
  ownerAgentOfOther: true,
};

function curatorsFor(cell: Cell): Curator[] {
  return cell[1] === '1' ? ['none'] : ['wallet', 'pca'];
}

function expectedOutcome(
  curator: Curator,
  role: Role,
  state: PcaState,
  depositOn: boolean,
): { outcome: Outcome; covering?: 'A' | 'B' } {
  if (!depositOn) return { outcome: 'free' };
  const covering = curator === 'pca' ? 'A' : AGENT_BINDING[role];
  if (covering === null) return { outcome: 'charged' };
  // B is always eligible, and the roles bound to B are its agents.
  const waivable = covering === 'B' || state === 'eligible';
  const allowed = covering === 'B' || CONTROLS_A[role];
  return waivable && allowed ? { outcome: 'waived', covering } : { outcome: 'charged' };
}

type Contracts = {
  Facade: ContextGraphs;
  CGS: ContextGraphStorage;
  Waiver: ContextGraphWaiverStorage;
  NFT: DKGPublishingConvictionNFT;
  Params: ParametersStorage;
  TokenC: Token;
  CSS: ConvictionStakingStorage;
  HubC: Hub;
  signers: SignerWithAddress[];
};

type World = Contracts & {
  creators: Record<Role, SignerWithAddress>;
  pcaUnderTest: Record<Role, bigint>; // A, one per role, all in the fixture's state
  otherPca: bigint; // B
};

async function deployBase(): Promise<Contracts> {
  hre.helpers.resetDeploymentsJson();
  await hre.deployments.fixture([
    'Token',
    'ParametersStorage',
    'Chronos',
    'EpochStorage',
    'ConvictionStakingStorage',
    'ContextGraphStorage',
    'ContextGraphs',
    'ContextGraphWaiverStorage',
    'DKGPublishingConvictionNFT',
  ]);
  const signers = await hre.ethers.getSigners();
  const HubC = await hre.ethers.getContract<Hub>('Hub');
  await HubC.setContractAddress('HubOwner', signers[0].address);
  return {
    Facade: await hre.ethers.getContract<ContextGraphs>('ContextGraphs'),
    CGS: await hre.ethers.getContract<ContextGraphStorage>('ContextGraphStorage'),
    Waiver: await hre.ethers.getContract<ContextGraphWaiverStorage>('ContextGraphWaiverStorage'),
    NFT: await hre.ethers.getContract<DKGPublishingConvictionNFT>('DKGPublishingConvictionNFT'),
    Params: await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
    TokenC: await hre.ethers.getContract<Token>('Token'),
    CSS: await hre.ethers.getContract<ConvictionStakingStorage>('ConvictionStakingStorage'),
    HubC,
    signers,
  };
}

async function createPca(c: Contracts, owner: SignerWithAddress, amount: bigint): Promise<bigint> {
  await c.TokenC.mint(owner.address, amount);
  await c.TokenC.connect(owner).approve(await c.NFT.getAddress(), amount);
  await c.NFT.connect(owner).createAccount(amount, 0);
  return c.NFT.tokenOfOwnerByIndex(owner.address, 0);
}

// Builds a world where every A is in `state` and B is eligible. Each creator
// holds and has approved exactly one deposit, so a charged create succeeds.
async function buildWorld(state: PcaState): Promise<World> {
  const c = await loadFixture(deployBase);
  await c.Params.setContextGraphRegistrationDeposit(DEPOSIT);
  const s = c.signers;

  const creators: Record<Role, SignerWithAddress> = {
    noPca: s[20],
    owner: s[22],
    ownerAsAgent: s[23],
    agent: s[24],
    agentOfOther: s[26],
    ownerAgentOfOther: s[28],
  };
  const pcaOwners: Record<Role, SignerWithAddress> = {
    noPca: s[21],
    owner: s[22],
    ownerAsAgent: s[23],
    agent: s[25],
    agentOfOther: s[27],
    ownerAgentOfOther: s[28],
  };
  const commit = state === 'belowFloor' ? BELOW_FLOOR_COMMIT : PCA_COMMIT;

  const pcaUnderTest = {} as Record<Role, bigint>;
  for (const role of ROLES) {
    pcaUnderTest[role] = await createPca(c, pcaOwners[role], commit);
  }
  await c.NFT.connect(pcaOwners.ownerAsAgent).registerAgent(
    pcaUnderTest.ownerAsAgent,
    creators.ownerAsAgent.address,
  );
  await c.NFT.connect(pcaOwners.agent).registerAgent(pcaUnderTest.agent, creators.agent.address);

  if (state === 'quotaUsedUp') {
    // Each A's owner spends both slots on PCA-curated graphs.
    for (const role of ROLES) {
      const owner = pcaOwners[role];
      for (let i = 0; i < 2; i++) {
        await c.Facade.connect(owner).createContextGraph(
          [], 0, 1, 0, owner.address, pcaUnderTest[role], ethers.ZeroHash,
        );
      }
      expect(await c.Waiver.waivedCgCount(pcaUnderTest[role])).to.equal(2n);
    }
  }

  if (state === 'expired' || state === 'swept') {
    let latestExpiry = 0n;
    for (const role of ROLES) {
      const expiresAt = (await c.NFT.accounts(pcaUnderTest[role]))[4];
      if (expiresAt > latestExpiry) latestExpiry = expiresAt;
    }
    await time.increaseTo(latestExpiry + 1n);
    if (state === 'swept') {
      for (const role of ROLES) {
        await c.NFT.settle(pcaUnderTest[role]);
        expect((await c.NFT.accounts(pcaUnderTest[role]))[8]).to.equal(true); // fullySwept
      }
    }
  }

  // B is created after any time travel, so it is always live.
  const otherPca = await createPca(c, s[29], PCA_COMMIT);
  await c.NFT.connect(s[29]).registerAgent(otherPca, creators.agentOfOther.address);
  await c.NFT.connect(s[29]).registerAgent(otherPca, creators.ownerAgentOfOther.address);

  for (const role of ROLES) {
    const creator = creators[role];
    await c.TokenC.mint(creator.address, DEPOSIT);
    await c.TokenC.connect(creator).approve(await c.Facade.getAddress(), DEPOSIT);
  }

  return { ...c, creators, pcaUnderTest, otherPca };
}

// loadFixture caches by function identity, so each state gets one named fixture.
const WORLD_FIXTURES: Record<PcaState, () => Promise<World>> = {
  eligible: async function eligibleWorld() {
    return buildWorld('eligible');
  },
  expired: async function expiredWorld() {
    return buildWorld('expired');
  },
  swept: async function sweptWorld() {
    return buildWorld('swept');
  },
  belowFloor: async function belowFloorWorld() {
    return buildWorld('belowFloor');
  },
  quotaUsedUp: async function quotaUsedUpWorld() {
    return buildWorld('quotaUsedUp');
  },
};

async function runCase(
  state: PcaState,
  cell: Cell,
  curator: Curator,
  role: Role,
  depositOn: boolean,
): Promise<void> {
  const w = await loadFixture(WORLD_FIXTURES[state]);
  if (!depositOn) await w.Params.setContextGraphRegistrationDeposit(0);

  const creator = w.creators[role];
  const pcaA = w.pcaUnderTest[role];
  const accessPolicy = Number(cell[0]);
  const publishPolicy = Number(cell[1]);
  const authority =
    curator === 'wallet'
      ? creator.address
      : curator === 'pca'
        ? await w.NFT.ownerOf(pcaA)
        : ethers.ZeroAddress;
  const accountId = curator === 'pca' ? pcaA : 0n;

  const cssAddr = await w.CSS.getAddress();
  const creatorBefore = await w.TokenC.balanceOf(creator.address);
  const vaultBefore = await w.TokenC.balanceOf(cssAddr);
  const usedABefore = await w.Waiver.waivedCgCount(pcaA);
  const usedBBefore = await w.Waiver.waivedCgCount(w.otherPca);
  const cgId = (await w.CGS.getLatestContextGraphId()) + 1n;

  const tx = await w.Facade.connect(creator).createContextGraph(
    [], 0, accessPolicy, publishPolicy, authority, accountId, ethers.ZeroHash,
  );

  // The graph and its config are the same whatever happens to the deposit.
  expect(await w.CGS.getLatestContextGraphId()).to.equal(cgId);
  expect(await w.CGS.getContextGraphOwner(cgId)).to.equal(creator.address);
  expect(await w.CGS.getAccessPolicy(cgId)).to.equal(BigInt(accessPolicy));
  const [storedPolicy, storedAuthority] = await w.CGS.getPublishPolicy(cgId);
  expect(storedPolicy).to.equal(BigInt(publishPolicy));
  expect(storedAuthority).to.equal(authority);
  expect(await w.CGS.getPublishAuthorityAccountId(cgId)).to.equal(accountId);

  const { outcome, covering } = expectedOutcome(curator, role, state, depositOn);
  const usedA = await w.Waiver.waivedCgCount(pcaA);
  const usedB = await w.Waiver.waivedCgCount(w.otherPca);

  if (outcome === 'charged') {
    await expect(tx)
      .to.emit(w.Facade, 'ContextGraphRegistrationDeposited')
      .withArgs(cgId, creator.address, DEPOSIT);
    await expect(tx).not.to.emit(w.Facade, 'ContextGraphRegistrationDepositWaived');
    expect(await w.CGS.getRegistrationEscrow(cgId)).to.equal(DEPOSIT);
    expect(await w.TokenC.balanceOf(creator.address)).to.equal(creatorBefore - DEPOSIT);
    expect(await w.TokenC.balanceOf(cssAddr)).to.equal(vaultBefore + DEPOSIT);
    expect(usedA).to.equal(usedABefore);
    expect(usedB).to.equal(usedBBefore);
    return;
  }

  await expect(tx).not.to.emit(w.Facade, 'ContextGraphRegistrationDeposited');
  expect(await w.CGS.getRegistrationEscrow(cgId)).to.equal(0n);
  expect(await w.TokenC.balanceOf(creator.address)).to.equal(creatorBefore);
  expect(await w.TokenC.balanceOf(cssAddr)).to.equal(vaultBefore);

  if (outcome === 'free') {
    await expect(tx).not.to.emit(w.Facade, 'ContextGraphRegistrationDepositWaived');
    expect(usedA).to.equal(usedABefore);
    expect(usedB).to.equal(usedBBefore);
    return;
  }

  const coveringId = covering === 'A' ? pcaA : w.otherPca;
  await expect(tx)
    .to.emit(w.Facade, 'ContextGraphRegistrationDepositWaived')
    .withArgs(cgId, coveringId, creator.address);
  expect(usedA).to.equal(usedABefore + (covering === 'A' ? 1n : 0n));
  expect(usedB).to.equal(usedBBefore + (covering === 'B' ? 1n : 0n));
}

describe('@integration OT-RFC-53 createContextGraph deposit decision matrix', function () {
  for (const state of STATES) {
    // Deposit off: the waiver is never consulted, so one PCA state is enough.
    const depositSettings = state === 'eligible' ? [true, false] : [true];
    for (const depositOn of depositSettings) {
      describe(`PCA ${state}, deposit ${depositOn ? 'on' : 'off'}`, () => {
        for (const cell of CELLS) {
          for (const curator of curatorsFor(cell)) {
            for (const role of ROLES) {
              const { outcome, covering } = expectedOutcome(curator, role, state, depositOn);
              const result = outcome === 'waived' ? `waived against ${covering}` : outcome;
              it(`cell ${cell}, curator ${curator}, creator ${role} → ${result}`, async () => {
                await runCase(state, cell, curator, role, depositOn);
              });
            }
          }
        }
      });
    }
  }
});

describe('@integration OT-RFC-53 createContextGraph deposit edge cases', function () {
  const setDeposit = async (c: Contracts) => c.Params.setContextGraphRegistrationDeposit(DEPOSIT);
  const createOpen = (c: Contracts, who: SignerWithAddress) =>
    c.Facade.connect(who).createContextGraph([], 0, 0, 1, ethers.ZeroAddress, 0, ethers.ZeroHash);
  // The dev token deploy pre-mints 10M TRAC to every signer; leave `keep`.
  const drainTrac = async (c: Contracts, who: SignerWithAddress, keep: bigint) => {
    const balance = await c.TokenC.balanceOf(who.address);
    await c.TokenC.connect(who).transfer(c.signers[0].address, balance - keep);
  };

  it('charged without an approval reverts TooLowAllowance and creates no graph', async () => {
    const c = await loadFixture(deployBase);
    await setDeposit(c);
    const creator = c.signers[40];
    await c.TokenC.mint(creator.address, DEPOSIT); // funded, not approved
    const latest = await c.CGS.getLatestContextGraphId();

    await expect(createOpen(c, creator))
      .to.be.revertedWithCustomError(c.Facade, 'TooLowAllowance')
      .withArgs(await c.TokenC.getAddress(), 0n, DEPOSIT);
    expect(await c.CGS.getLatestContextGraphId()).to.equal(latest);
  });

  it('charged with an approval but too little TRAC reverts TooLowBalance and creates no graph', async () => {
    const c = await loadFixture(deployBase);
    await setDeposit(c);
    const creator = c.signers[41];
    const short = DEPOSIT - 1n;
    await drainTrac(c, creator, short);
    await c.TokenC.connect(creator).approve(await c.Facade.getAddress(), DEPOSIT);
    const latest = await c.CGS.getLatestContextGraphId();

    await expect(createOpen(c, creator))
      .to.be.revertedWithCustomError(c.Facade, 'TooLowBalance')
      .withArgs(await c.TokenC.getAddress(), short, DEPOSIT);
    expect(await c.CGS.getLatestContextGraphId()).to.equal(latest);
  });

  it('an agent with no TRAC whose PCA quota is used up cannot create an open graph', async () => {
    const w = await loadFixture(WORLD_FIXTURES.quotaUsedUp);
    const agent = w.signers[42];
    await w.NFT.connect(w.signers[25]).registerAgent(w.pcaUnderTest.agent, agent.address);
    await drainTrac(w, agent, 0n);
    const latest = await w.CGS.getLatestContextGraphId();

    await expect(createOpen(w, agent)).to.be.revertedWithCustomError(w.Facade, 'TooLowAllowance');
    expect(await w.CGS.getLatestContextGraphId()).to.equal(latest);
    expect(await w.Waiver.waivedCgCount(w.pcaUnderTest.agent)).to.equal(2n);
  });

  it('fail-closed: ContextGraphWaiverStorage unregistered → an agent\'s open graph is charged', async () => {
    const w = await loadFixture(WORLD_FIXTURES.eligible);
    await w.HubC.removeContractByName('ContextGraphWaiverStorage');
    const agent = w.creators.agent;
    const cgId = (await w.CGS.getLatestContextGraphId()) + 1n;

    await expect(createOpen(w, agent))
      .to.emit(w.Facade, 'ContextGraphRegistrationDeposited')
      .withArgs(cgId, agent.address, DEPOSIT);
    expect(await w.CGS.getRegistrationEscrow(cgId)).to.equal(DEPOSIT);
  });

  it('fail-closed: a waiver check that reverts → an agent\'s open graph is charged', async () => {
    const w = await loadFixture(WORLD_FIXTURES.eligible);
    // The facade reads the deposit through its cached ParametersStorage, while
    // the waiver storage resolves it through the Hub, so this makes only the
    // waiver check revert.
    await w.HubC.removeContractByName('ParametersStorage');
    const agent = w.creators.agent;
    const cgId = (await w.CGS.getLatestContextGraphId()) + 1n;

    await expect(createOpen(w, agent))
      .to.emit(w.Facade, 'ContextGraphRegistrationDeposited')
      .withArgs(cgId, agent.address, DEPOSIT);
    expect(await w.Waiver.waivedCgCount(w.pcaUnderTest.agent)).to.equal(0n);
  });

  it('a deregistered agent no longer draws on the PCA and its slots stay used', async () => {
    const w = await loadFixture(WORLD_FIXTURES.eligible);
    const agent = w.creators.agent;
    const pca = w.pcaUnderTest.agent;
    await expect(createOpen(w, agent)).to.emit(w.Facade, 'ContextGraphRegistrationDepositWaived');
    expect(await w.Waiver.waivedCgCount(pca)).to.equal(1n);

    await w.NFT.connect(w.signers[25]).deregisterAgent(pca, agent.address);
    const cgId = (await w.CGS.getLatestContextGraphId()) + 1n;
    await expect(createOpen(w, agent))
      .to.emit(w.Facade, 'ContextGraphRegistrationDeposited')
      .withArgs(cgId, agent.address, DEPOSIT);
    // Deregistering stops future use; the slot already used is not returned.
    expect(await w.Waiver.waivedCgCount(pca)).to.equal(1n);
  });
});
