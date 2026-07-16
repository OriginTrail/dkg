import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  ContextGraphs,
  ContextGraphStorage,
  ConvictionStakingStorage,
  EpochStorage,
  Hub,
  ParametersStorage,
  Token,
} from '../typechain';

/**
 * OT-RFC-53 — Context-Graph registration deposit (anti-spam).
 *
 * Execution-verifies the NEW paths (creation pull, admin sweep, param,
 * storage accounting) end to end. Treasury fee is dormant (treasury unset),
 * so net == gross == the deposit here. The consume-on-publish path
 * (`_useCgEscrow`) is covered separately against the full publish harness.
 */
const DEPOSIT = ethers.parseEther('100'); // constructor default

describe('@unit OT-RFC-53 — CG registration deposit', () => {
  let accounts: SignerWithAddress[];
  let Facade: ContextGraphs;
  let CGS: ContextGraphStorage;
  let Params: ParametersStorage;
  let TokenC: Token;
  let CSS: ConvictionStakingStorage;
  let Epoch: EpochStorage;
  let HubC: Hub;
  let owner: SignerWithAddress;
  let creator: SignerWithAddress;
  let stranger: SignerWithAddress;

  async function deployFixture() {
    await hre.deployments.fixture([
      'Token',
      'ParametersStorage',
      'Chronos',
      'EpochStorage',
      'ConvictionStakingStorage',
      'ContextGraphStorage',
      'ContextGraphs',
    ]);
    const signers = await hre.ethers.getSigners();
    const hub = await hre.ethers.getContract<Hub>('Hub');
    // Register accounts[0] as HubOwner so it can call the onlyHubOwner sweep.
    await hub.setContractAddress('HubOwner', signers[0].address);
    return {
      accounts: signers,
      Facade: await hre.ethers.getContract<ContextGraphs>('ContextGraphs'),
      CGS: await hre.ethers.getContract<ContextGraphStorage>('ContextGraphStorage'),
      Params: await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
      TokenC: await hre.ethers.getContract<Token>('Token'),
      CSS: await hre.ethers.getContract<ConvictionStakingStorage>('ConvictionStakingStorage'),
      Epoch: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
      HubC: hub,
    };
  }

  beforeEach(async () => {
    const f = await loadFixture(deployFixture);
    accounts = f.accounts;
    Facade = f.Facade;
    CGS = f.CGS;
    Params = f.Params;
    TokenC = f.TokenC;
    CSS = f.CSS;
    Epoch = f.Epoch;
    HubC = f.HubC;
    owner = accounts[0];
    creator = accounts[1];
    stranger = accounts[2];
    // 054 only activates the deposit on real networks; on hardhat we set it
    // explicitly via governance so these tests exercise the active path.
    await Params.connect(owner).setContextGraphRegistrationDeposit(DEPOSIT);
  });

  const fundAndApprove = async (who: SignerWithAddress, amount: bigint) => {
    await TokenC.mint(who.address, amount);
    await TokenC.connect(who).approve(await Facade.getAddress(), amount);
  };

  const createOpenCG = async (who: SignerWithAddress): Promise<bigint> => {
    await Facade.connect(who).createContextGraph(
      [],
      0,
      0, // accessPolicy public
      1, // publishPolicy open
      ethers.ZeroAddress,
      0,
      ethers.ZeroHash,
    );
    return CGS.getLatestContextGraphId();
  };

  it('is active at 100 TRAC once governance sets it', async () => {
    expect(await Params.contextGraphRegistrationDeposit()).to.equal(DEPOSIT);
  });

  it('deposit setter is governance-gated, updates value, emits ParameterChanged', async () => {
    await expect(
      Params.connect(stranger).setContextGraphRegistrationDeposit(ethers.parseEther('5')),
    ).to.be.reverted;

    await expect(
      Params.connect(owner).setContextGraphRegistrationDeposit(ethers.parseEther('5')),
    ).to.emit(Params, 'ParameterChanged');

    expect(await Params.contextGraphRegistrationDeposit()).to.equal(ethers.parseEther('5'));
  });

  it('pulls the deposit into the CSS vault and records it as the CG escrow', async () => {
    await fundAndApprove(creator, DEPOSIT);
    const creatorBefore = await TokenC.balanceOf(creator.address);
    const cssBefore = await TokenC.balanceOf(await CSS.getAddress());

    await expect(
      Facade.connect(creator).createContextGraph([], 0, 0, 1, ethers.ZeroAddress, 0, ethers.ZeroHash),
    ).to.emit(Facade, 'ContextGraphRegistrationDeposited');

    const cgId = await CGS.getLatestContextGraphId();
    // Treasury dormant ⇒ net == gross == DEPOSIT.
    expect(await CGS.getRegistrationEscrow(cgId)).to.equal(DEPOSIT);
    expect(await TokenC.balanceOf(await CSS.getAddress())).to.equal(cssBefore + DEPOSIT);
    expect(await TokenC.balanceOf(creator.address)).to.equal(creatorBefore - DEPOSIT);
  });

  it('reverts createContextGraph when the deposit is not approved', async () => {
    await TokenC.mint(creator.address, DEPOSIT); // minted but not approved
    await expect(createOpenCG(creator)).to.be.reverted;
  });

  it('disabling the deposit (set 0) restores fee-free CG creation', async () => {
    await Params.connect(owner).setContextGraphRegistrationDeposit(0);
    // No funding/approval needed when dormant.
    const cgId = await createOpenCG(creator);
    expect(await CGS.getRegistrationEscrow(cgId)).to.equal(0n);
  });

  it('admin sweeps residual escrow into the reward pool and clears it', async () => {
    await fundAndApprove(creator, DEPOSIT);
    const cgId = await createOpenCG(creator);
    expect(await CGS.getRegistrationEscrow(cgId)).to.equal(DEPOSIT);
    expect(await CGS.isContextGraphActive(cgId)).to.equal(true);

    // Non-owner cannot sweep.
    await expect(Facade.connect(stranger).sweepContextGraphEscrow(cgId)).to.be.reverted;

    // Read the staker reward pool (shard 1) at the sweep epoch before/after so
    // the test fails if the sweep ever stops crediting EpochStorage.
    const ChronosC = await hre.ethers.getContract('Chronos');
    const epoch = await (ChronosC as unknown as { getCurrentEpoch(): Promise<bigint> }).getCurrentEpoch();
    const poolBefore = await Epoch.getEpochPool(1n, epoch);

    // HubOwner sweep credits the current-epoch pool and clears the escrow.
    await expect(Facade.connect(owner).sweepContextGraphEscrow(cgId)).to.emit(
      Facade,
      'ContextGraphEscrowSwept',
    );
    expect(await CGS.getRegistrationEscrow(cgId)).to.equal(0n);
    // Sweep retires the CG (atomic deactivate + sweep); a regression that stopped
    // deactivating an active CG would otherwise still pass this test.
    expect(await CGS.isContextGraphActive(cgId)).to.equal(false);
    // The swept escrow actually landed in the reward pool.
    expect(await Epoch.getEpochPool(1n, epoch)).to.equal(poolBefore + DEPOSIT);

    // Nothing left to sweep ⇒ revert.
    await expect(Facade.connect(owner).sweepContextGraphEscrow(cgId)).to.be.reverted;
  });
});
