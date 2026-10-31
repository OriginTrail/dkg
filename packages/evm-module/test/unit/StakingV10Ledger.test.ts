// StakingV10Ledger 1.0.0 runs the operator-fee withdrawal and the V8 drains
// into migration credit for StakingV10 (from 10.0.6), which keeps those entry
// points, their signatures and their caller gates, and forwards.
//
// Covered here: the ledger admits only the contract the Hub holds as
// StakingV10, looked up at each call; and the operator-fee withdrawal,
// reached through StakingV10 as before, keeps its checks, its custom errors
// as StakingV10 reports them, its cooldown and its payout to the calling
// admin key. The V8 drains are covered through DKGStakingConvictionNFT by the
// migration suites.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  ConvictionStakingStorage,
  DKGStakingConvictionNFT,
  Hub,
  ParametersStorage,
  Profile,
  StakingV10,
  StakingV10Ledger,
  Token,
} from '../../typechain';

const TRAC = 10n ** 18n;
const FEE = 1_000n * TRAC;

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  Token: Token;
  Profile: Profile;
  Params: ParametersStorage;
  StakingV10: StakingV10;
  Ledger: StakingV10Ledger;
  NFT: DKGStakingConvictionNFT;
  Vault: ConvictionStakingStorage;
};

async function deployFixture(): Promise<Fixture> {
  await hre.deployments.fixture(['DKGStakingConvictionNFT', 'StakingV10', 'Profile']);
  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  // The Hub owner passes the vault's `onlyContracts`, to seed an operator-fee
  // balance as a claim would leave it.
  await Hub.setContractAddress('HubOwner', accounts[0].address);
  return {
    accounts,
    Hub,
    Token: await hre.ethers.getContract<Token>('Token'),
    Profile: await hre.ethers.getContract<Profile>('Profile'),
    Params: await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
    StakingV10: await hre.ethers.getContract<StakingV10>('StakingV10'),
    Ledger: await hre.ethers.getContract<StakingV10Ledger>('StakingV10Ledger'),
    NFT: await hre.ethers.getContract<DKGStakingConvictionNFT>('DKGStakingConvictionNFT'),
    Vault: await hre.ethers.getContract<ConvictionStakingStorage>('ConvictionStakingStorage'),
  };
}

describe('@unit StakingV10Ledger', () => {
  let f: Fixture;
  let admin: SignerWithAddress;
  let stranger: SignerWithAddress;
  let identityId: bigint;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    f = await loadFixture(deployFixture);
    admin = f.accounts[5];
    stranger = f.accounts[6];
    const nodeId = hre.ethers.keccak256(hre.ethers.toUtf8Bytes('ledger node'));
    const receipt = await (
      await f.Profile.connect(f.accounts[4]).createProfile(admin.address, [], 'ledger node', nodeId, 0)
    ).wait();
    identityId = BigInt(receipt!.logs[0].topics[1]);
    // An operator-fee balance, backed by TRAC in the vault.
    await f.Vault.increaseOperatorFeeBalance(identityId, FEE);
    await f.Token.mint(await f.Vault.getAddress(), FEE);
  });

  it('is named StakingV10Ledger at 1.0.0, and StakingV10 wires it', async () => {
    expect(await f.Ledger.name()).to.equal('StakingV10Ledger');
    expect(await f.Ledger.version()).to.equal('1.0.0');
    expect(await f.Ledger.stakingStorage()).to.equal(await f.Hub.getContractAddress('StakingStorage'));
    expect(await f.Ledger.convictionStorage()).to.equal(await f.Vault.getAddress());
    expect(await f.Ledger.identityStorage()).to.equal(await f.Hub.getContractAddress('IdentityStorage'));
    expect(await f.Ledger.parametersStorage()).to.equal(await f.Params.getAddress());
  });

  it('refuses every caller but StakingV10, the Hub owner and the staking wrapper included', async () => {
    for (const caller of [stranger, f.accounts[0]]) {
      const ledger = f.Ledger.connect(caller);
      await expect(ledger.requestOperatorFeeWithdrawal(identityId, 1n)).to.be.revertedWithCustomError(
        f.Ledger,
        'OnlyStakingV10',
      );
      await expect(ledger.finalizeOperatorFeeWithdrawal(identityId, caller.address)).to.be.revertedWithCustomError(
        f.Ledger,
        'OnlyStakingV10',
      );
      await expect(ledger.cancelOperatorFeeWithdrawal(identityId)).to.be.revertedWithCustomError(
        f.Ledger,
        'OnlyStakingV10',
      );
      await expect(ledger.drainV8ToCredit(caller.address, identityId)).to.be.revertedWithCustomError(
        f.Ledger,
        'OnlyStakingV10',
      );
      await expect(ledger.drainOperatorFeeToCredit(identityId, caller.address)).to.be.revertedWithCustomError(
        f.Ledger,
        'OnlyStakingV10',
      );
    }
    // The wrapper reaches the drains only through StakingV10.
    const wrapper = await hre.ethers.getImpersonatedSigner(await f.NFT.getAddress());
    await hre.network.provider.send('hardhat_setBalance', [await f.NFT.getAddress(), '0x56BC75E2D63100000']);
    await expect(f.Ledger.connect(wrapper).drainV8ToCredit(stranger.address, identityId)).to.be.revertedWithCustomError(
      f.Ledger,
      'OnlyStakingV10',
    );
  });

  it('admits the StakingV10 the Hub holds now, so a replaced one is refused', async () => {
    const before = await f.StakingV10.getAddress();
    await f.Hub.setContractAddress('StakingV10', stranger.address);
    await expect(
      f.StakingV10.connect(admin).requestOperatorFeeWithdrawal(identityId, 1n),
    ).to.be.revertedWithCustomError(f.Ledger, 'OnlyStakingV10');
    await f.Hub.setContractAddress('StakingV10', before);
    await f.StakingV10.connect(admin).requestOperatorFeeWithdrawal(identityId, 1n);
    expect(await f.Vault.getOperatorFeeWithdrawalRequestAmount(identityId)).to.equal(1n);
  });

  describe('the operator-fee withdrawal through StakingV10', () => {
    it('checks the admin key in StakingV10 before anything else', async () => {
      await expect(f.StakingV10.connect(stranger).requestOperatorFeeWithdrawal(identityId, 0n))
        .to.be.revertedWithCustomError(f.StakingV10, 'OnlyProfileAdminFunction')
        .withArgs(stranger.address);
      await expect(f.StakingV10.connect(stranger).finalizeOperatorFeeWithdrawal(identityId))
        .to.be.revertedWithCustomError(f.StakingV10, 'OnlyProfileAdminFunction')
        .withArgs(stranger.address);
      await expect(f.StakingV10.connect(stranger).cancelOperatorFeeWithdrawal(identityId))
        .to.be.revertedWithCustomError(f.StakingV10, 'OnlyProfileAdminFunction')
        .withArgs(stranger.address);
    });

    it('reports its errors as StakingV10 errors', async () => {
      const staking = f.StakingV10.connect(admin);
      await expect(staking.requestOperatorFeeWithdrawal(identityId, 0n)).to.be.revertedWithCustomError(
        f.StakingV10,
        'ZeroTokenAmount',
      );
      await expect(staking.requestOperatorFeeWithdrawal(identityId, FEE + 1n))
        .to.be.revertedWithCustomError(f.StakingV10, 'AmountExceedsOperatorFeeBalance')
        .withArgs(FEE, FEE + 1n);
      await expect(staking.finalizeOperatorFeeWithdrawal(identityId)).to.be.revertedWithCustomError(
        f.StakingV10,
        'WithdrawalWasntInitiated',
      );
      await expect(staking.cancelOperatorFeeWithdrawal(identityId)).to.be.revertedWithCustomError(
        f.StakingV10,
        'WithdrawalWasntInitiated',
      );

      await staking.requestOperatorFeeWithdrawal(identityId, FEE);
      const [, , releaseAt] = await f.Vault.getOperatorFeeWithdrawalRequest(identityId);
      await expect(staking.finalizeOperatorFeeWithdrawal(identityId)).to.be.revertedWithCustomError(
        f.StakingV10,
        'WithdrawalPeriodPending',
      );
      expect(releaseAt).to.be.greaterThan(BigInt(await time.latest()));
    });

    it('queues the request, augments it, cancels it back into the balance, and pays the finalized amount to the admin', async () => {
      const staking = f.StakingV10.connect(admin);
      const delay = await f.Params.stakeWithdrawalDelay();

      await staking.requestOperatorFeeWithdrawal(identityId, FEE / 4n);
      expect(await f.Vault.getOperatorFeeBalance(identityId)).to.equal(FEE - FEE / 4n);
      expect(await f.Vault.getOperatorFeeWithdrawalRequestAmount(identityId)).to.equal(FEE / 4n);

      // A second request adds to the first and restarts the cooldown.
      await staking.requestOperatorFeeWithdrawal(identityId, FEE / 4n);
      const [amount, , releaseAt] = await f.Vault.getOperatorFeeWithdrawalRequest(identityId);
      expect(amount).to.equal(FEE / 2n);
      expect(releaseAt).to.equal(BigInt(await time.latest()) + delay);
      expect(await f.Vault.getOperatorFeeBalance(identityId)).to.equal(FEE / 2n);

      await staking.cancelOperatorFeeWithdrawal(identityId);
      expect(await f.Vault.getOperatorFeeWithdrawalRequestAmount(identityId)).to.equal(0n);
      expect(await f.Vault.getOperatorFeeBalance(identityId)).to.equal(FEE);

      await staking.requestOperatorFeeWithdrawal(identityId, FEE);
      await time.increase(delay + 1n);
      const vault = await f.Vault.getAddress();
      await expect(staking.finalizeOperatorFeeWithdrawal(identityId)).to.changeTokenBalances(
        f.Token,
        [admin.address, vault, await f.Ledger.getAddress(), await f.StakingV10.getAddress()],
        [FEE, -FEE, 0n, 0n],
      );
      expect(await f.Vault.getOperatorFeeBalance(identityId)).to.equal(0n);
      expect(await f.Vault.getOperatorFeeWithdrawalRequestAmount(identityId)).to.equal(0n);
    });
  });
});
