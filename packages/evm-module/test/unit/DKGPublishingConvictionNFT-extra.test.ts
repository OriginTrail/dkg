/**
 * DKGPublishingConvictionNFT-extra.test.ts — audit coverage.
 *
 * Covers findings (see .test-audit/, evm-module):
 *   - E-6 (HIGH, SPEC-GAP): both `topUp` and `coverPublishingCost` contain
 *     an `AccountExpired` revert when the current epoch crosses the account
 *     lifetime (`currentEpoch >= expiresAtEpoch`). Neither branch was
 *     covered. The spec is clear: the V10 flow-through model fixes expiry
 *     at creation (12 epochs) and forbids extension. Once expired, the
 *     account must NOT accept top-ups (would dilute a closed allocation)
 *     and must NOT authorize further publishing cost draws.
 *
 * Uses the real Chronos/EpochStorage/StakingStorage deploys. No mocks.
 */
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  Chronos,
  DKGPublishingConvictionNFT,
  EpochStorage,
  Hub,
  StakingStorage,
  Token,
} from '../../typechain';

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  NFT: DKGPublishingConvictionNFT;
  Token: Token;
  StakingStorage: StakingStorage;
  EpochStorage: EpochStorage;
  Chronos: Chronos;
};

const LOCK_DURATION = 12;

describe('@unit DKGPublishingConvictionNFT — extra audit coverage (E-6)', function () {
  let accounts: SignerWithAddress[];
  let HubContract: Hub;
  let NFT: DKGPublishingConvictionNFT;
  let TokenContract: Token;
  let ChronosContract: Chronos;

  async function deployFixture(): Promise<Fixture> {
    await hre.deployments.fixture([
      'DKGPublishingConvictionNFT',
      'Token',
      'StakingStorage',
      'EpochStorage',
      'Chronos',
    ]);
    const Hub = await hre.ethers.getContract<Hub>('Hub');
    const NFT = await hre.ethers.getContract<DKGPublishingConvictionNFT>('DKGPublishingConvictionNFT');
    const Token = await hre.ethers.getContract<Token>('Token');
    const StakingStorageC = await hre.ethers.getContract<StakingStorage>('StakingStorage');
    const EpochStorageC = await hre.ethers.getContract<EpochStorage>('EpochStorageV8');
    const ChronosC = await hre.ethers.getContract<Chronos>('Chronos');
    const signers = await hre.ethers.getSigners();
    await Hub.setContractAddress('HubOwner', signers[0].address);
    return {
      accounts: signers,
      Hub,
      NFT,
      Token,
      StakingStorage: StakingStorageC,
      EpochStorage: EpochStorageC,
      Chronos: ChronosC,
    };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      Hub: HubContract,
      NFT,
      Token: TokenContract,
      Chronos: ChronosContract,
    } = await loadFixture(deployFixture));
  });

  afterEach(async () => {
    // Flow-through invariant — the NFT must NEVER hold TRAC.
    expect(await TokenContract.balanceOf(await NFT.getAddress())).to.equal(0n);
  });

  async function createAccount(signer: SignerWithAddress, committed: bigint) {
    await TokenContract.connect(signer).approve(await NFT.getAddress(), committed);
    await NFT.connect(signer).createAccount(committed);
    return await NFT.totalSupply();
  }

  async function advanceToEpoch(targetEpoch: bigint) {
    while ((await ChronosContract.getCurrentEpoch()) < targetEpoch) {
      await time.increase((await ChronosContract.timeUntilNextEpoch()) + 1n);
    }
  }

  // ======================================================================
  // E-6 — topUp after expiry must revert with AccountExpired.
  // ======================================================================
  describe('E-6.a: topUp after account expiry', () => {
    it('reverts AccountExpired once currentEpoch === expiresAtEpoch', async () => {
      const committed = hre.ethers.parseEther('50000');
      const acctId = await createAccount(accounts[0], committed);

      const info = await NFT.getAccountInfo(acctId);
      const expiresAt = BigInt(info.expiresAtEpoch);

      // Hit expiry exactly (currentEpoch == expiresAtEpoch). The contract
      // check is `>=`, so this boundary must revert.
      await advanceToEpoch(expiresAt);

      const topUpAmount = hre.ethers.parseEther('1000');
      await TokenContract.connect(accounts[0]).approve(await NFT.getAddress(), topUpAmount);

      await expect(NFT.connect(accounts[0]).topUp(acctId, topUpAmount))
        .to.be.revertedWithCustomError(NFT, 'AccountExpired')
        .withArgs(acctId, expiresAt);
    });

    it('reverts AccountExpired well AFTER expiresAtEpoch (epoch + 5)', async () => {
      const committed = hre.ethers.parseEther('50000');
      const acctId = await createAccount(accounts[0], committed);
      const info = await NFT.getAccountInfo(acctId);
      const expiresAt = BigInt(info.expiresAtEpoch);

      await advanceToEpoch(expiresAt + 5n);

      const topUpAmount = hre.ethers.parseEther('500');
      await TokenContract.connect(accounts[0]).approve(await NFT.getAddress(), topUpAmount);

      await expect(NFT.connect(accounts[0]).topUp(acctId, topUpAmount))
        .to.be.revertedWithCustomError(NFT, 'AccountExpired')
        .withArgs(acctId, expiresAt);
    });

    it('does NOT mutate topUpBalance or move TRAC when topUp reverts post-expiry', async () => {
      const committed = hre.ethers.parseEther('50000');
      const acctId = await createAccount(accounts[0], committed);
      const info = await NFT.getAccountInfo(acctId);
      const expiresAt = BigInt(info.expiresAtEpoch);
      const bufferBefore = await NFT.topUpBalance(acctId);
      const publisherBalBefore = await TokenContract.balanceOf(accounts[0].address);

      await advanceToEpoch(expiresAt);

      const topUpAmount = hre.ethers.parseEther('2000');
      await TokenContract.connect(accounts[0]).approve(await NFT.getAddress(), topUpAmount);
      // Pin AccountExpired + args so a regression that reverts for the
      // wrong reason (e.g. allowance/balance check) — but still leaves
      // state unchanged — doesn't silently pass this "no-mutation" test.
      await expect(NFT.connect(accounts[0]).topUp(acctId, topUpAmount))
        .to.be.revertedWithCustomError(NFT, 'AccountExpired')
        .withArgs(acctId, expiresAt);

      expect(await NFT.topUpBalance(acctId)).to.equal(bufferBefore);
      expect(await TokenContract.balanceOf(accounts[0].address)).to.equal(publisherBalBefore);
    });

    it('SANITY: topUp at currentEpoch < expiresAtEpoch succeeds (no false positive on E-6)', async () => {
      const committed = hre.ethers.parseEther('50000');
      const acctId = await createAccount(accounts[0], committed);
      const info = await NFT.getAccountInfo(acctId);
      const expiresAt = BigInt(info.expiresAtEpoch);

      // One epoch below expiry (currentEpoch == expiresAtEpoch - 1): allowed.
      await advanceToEpoch(expiresAt - 1n);

      const topUpAmount = hre.ethers.parseEther('1000');
      await TokenContract.connect(accounts[0]).approve(await NFT.getAddress(), topUpAmount);

      await expect(NFT.connect(accounts[0]).topUp(acctId, topUpAmount))
        .to.emit(NFT, 'ToppedUp')
        .withArgs(acctId, topUpAmount, topUpAmount);
      expect(await NFT.topUpBalance(acctId)).to.equal(topUpAmount);
    });
  });

  // ======================================================================
  // E-6 — coverPublishingCost after expiry must revert with AccountExpired.
  // The function is gated to KnowledgeAssetsV10. We register the kav10
  // signer in the Hub so the gate passes and the expiry check is the one
  // under test.
  // ======================================================================
  describe('E-6.b: coverPublishingCost after account expiry', () => {
    async function setupWithKAV10Signer() {
      // Point the Hub's "KnowledgeAssetsV10" entry at an EOA we control so
      // we can call coverPublishingCost directly from it.
      const kav10 = accounts[2];
      await HubContract.setContractAddress('KnowledgeAssetsV10', kav10.address);

      const committed = hre.ethers.parseEther('100000');
      const owner = accounts[0];
      const agent = accounts[3];

      await TokenContract.connect(owner).approve(await NFT.getAddress(), committed);
      await NFT.connect(owner).createAccount(committed);
      const acctId = await NFT.totalSupply();

      // Bind the agent so `agentToAccountId[agent] != 0` and we reach the
      // expiry check (instead of NoConvictionAccount).
      await NFT.connect(owner).registerAgent(acctId, agent.address);

      return { kav10, owner, agent, acctId };
    }

    it('reverts AccountExpired at currentEpoch === expiresAtEpoch', async () => {
      const { kav10, agent, acctId } = await setupWithKAV10Signer();
      const info = await NFT.getAccountInfo(acctId);
      const expiresAt = BigInt(info.expiresAtEpoch);

      await advanceToEpoch(expiresAt);

      const baseCost = hre.ethers.parseEther('100');
      await expect(
        NFT.connect(kav10).coverPublishingCost(agent.address, baseCost),
      )
        .to.be.revertedWithCustomError(NFT, 'AccountExpired')
        .withArgs(acctId, expiresAt);
    });

    it('reverts AccountExpired well AFTER expiresAtEpoch (epoch + 3)', async () => {
      const { kav10, agent, acctId } = await setupWithKAV10Signer();
      const info = await NFT.getAccountInfo(acctId);
      const expiresAt = BigInt(info.expiresAtEpoch);

      await advanceToEpoch(expiresAt + 3n);

      const baseCost = hre.ethers.parseEther('100');
      await expect(
        NFT.connect(kav10).coverPublishingCost(agent.address, baseCost),
      )
        .to.be.revertedWithCustomError(NFT, 'AccountExpired')
        .withArgs(acctId, expiresAt);
    });

    it('does NOT mutate epochSpent/topUpBalance when coverPublishingCost reverts post-expiry', async () => {
      const { kav10, agent, acctId } = await setupWithKAV10Signer();
      const info = await NFT.getAccountInfo(acctId);
      const expiresAt = BigInt(info.expiresAtEpoch);

      await advanceToEpoch(expiresAt);

      const bufferBefore = await NFT.topUpBalance(acctId);
      const spentBefore = await NFT.epochSpent(acctId, BigInt(info.createdAtEpoch));

      // Post-expiry coverPublishingCost reverts with
      // `AccountExpired(accountId, expiresAtEpoch)`. Pinning both the error
      // selector and its args catches regressions that accidentally ingest
      // token value at or past the expiry boundary (the exact class of
      // bug the no-op-on-failure assertions below guard against).
      await expect(
        NFT.connect(kav10).coverPublishingCost(agent.address, hre.ethers.parseEther('10')),
      )
        .to.be.revertedWithCustomError(NFT, 'AccountExpired')
        .withArgs(acctId, expiresAt);

      expect(await NFT.topUpBalance(acctId)).to.equal(bufferBefore);
      expect(await NFT.epochSpent(acctId, BigInt(info.createdAtEpoch))).to.equal(spentBefore);
    });

    it('SANITY: coverPublishingCost in-lifetime (epoch < expiresAt) succeeds', async () => {
      const { kav10, agent, acctId } = await setupWithKAV10Signer();
      const info = await NFT.getAccountInfo(acctId);
      const expiresAt = BigInt(info.expiresAtEpoch);

      // One epoch below expiry: allowed.
      await advanceToEpoch(expiresAt - 1n);

      const baseCost = hre.ethers.parseEther('10');
      // Compute the expected discounted cost from the on-chain discountBps
      // so this check pins the exact event payload: if a future change
      // changes the discount formula, drawnFromEpoch, or drops any arg,
      // this fails. CostCovered(id, epoch, baseCost, discountedCost,
      // drawnFromEpoch, drawnFromTopUp).
      const BPS_DENOMINATOR = 10_000n;
      const discountBps = BigInt(info.discountBps);
      const expectedDiscounted =
        (BigInt(baseCost) * (BPS_DENOMINATOR - discountBps)) / BPS_DENOMINATOR;
      const currentEpoch = await ChronosContract.getCurrentEpoch();

      await expect(
        NFT.connect(kav10).coverPublishingCost(agent.address, baseCost),
      )
        .to.emit(NFT, 'CostCovered')
        .withArgs(
          acctId,
          currentEpoch,
          baseCost,
          expectedDiscounted,
          expectedDiscounted, // drawnFromEpoch: fully covered from baseAllowance
          0n, // drawnFromTopUp: no buffer used
        );
    });

    it('account created AT epoch N still has a full LOCK_DURATION window before AccountExpired fires', async () => {
      // Pins the exact lifetime length asserted in the docstring: 12 epochs
      // from creation. Any off-by-one in expiresAtEpoch math would surface
      // as this test emitting AccountExpired inside the allowed window.
      const { kav10, agent, acctId } = await setupWithKAV10Signer();
      const info = await NFT.getAccountInfo(acctId);
      expect(BigInt(info.expiresAtEpoch) - BigInt(info.createdAtEpoch)).to.equal(
        BigInt(LOCK_DURATION),
      );

      // Walk through all 12 allowed epochs; every call must succeed.
      for (let delta = 0n; delta < BigInt(LOCK_DURATION); delta++) {
        await advanceToEpoch(BigInt(info.createdAtEpoch) + delta);
        await expect(
          NFT.connect(kav10).coverPublishingCost(agent.address, 1n),
        ).to.not.be.reverted;
      }

      // Then on epoch == expiresAt (13th) it MUST revert.
      await advanceToEpoch(BigInt(info.expiresAtEpoch));
      await expect(
        NFT.connect(kav10).coverPublishingCost(agent.address, 1n),
      ).to.be.revertedWithCustomError(NFT, 'AccountExpired');
    });
  });
});
