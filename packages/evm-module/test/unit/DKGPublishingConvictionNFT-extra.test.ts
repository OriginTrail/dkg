/**
 * DKGPublishingConvictionNFT-extra.test.ts — audit coverage.
 *
 * Covers findings (see .test-audit/BUGS_FOUND.md, evm-module):
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

  async function advanceToTimestamp(targetTimestamp: bigint) {
    const block = await hre.ethers.provider.getBlock('latest');
    if (!block) {
      throw new Error('Latest block not found');
    }
    const now = BigInt(block.timestamp);
    if (targetTimestamp > now) {
      await time.increase(targetTimestamp - now);
    }
  }

  // ======================================================================
  // E-6 — topUp after expiry must revert with AccountExpired.
  // ======================================================================
  describe('E-6.a: topUp after account expiry', () => {
    it('reverts AccountExpired once block.timestamp reaches expiresAtTimestamp', async () => {
      const committed = hre.ethers.parseEther('50000');
      const acctId = await createAccount(accounts[0], committed);

      const info = await NFT.getAccountInfo(acctId);
      const expiresAt = BigInt(info.expiresAtEpoch);
      const expiresAtTs = BigInt(info.expiresAtTimestamp);

      // Hit expiry exactly (block.timestamp == expiresAtTimestamp). The
      // contract check is `>=`, so this boundary must revert.
      await advanceToTimestamp(expiresAtTs);

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
      const expiresAtTs = BigInt(info.expiresAtTimestamp);

      await advanceToTimestamp(expiresAtTs + 5n);

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
      const expiresAtTs = BigInt(info.expiresAtTimestamp);
      const bufferBefore = await NFT.topUpBalance(acctId);
      const publisherBalBefore = await TokenContract.balanceOf(accounts[0].address);

      await advanceToTimestamp(expiresAtTs);

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
      const expiresAtTs = BigInt(info.expiresAtTimestamp);

      // Keep enough headroom so the transaction-mined block cannot cross expiry.
      await advanceToTimestamp(expiresAtTs - 10n);

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
      const expiresAtTs = BigInt(info.expiresAtTimestamp);

      await advanceToTimestamp(expiresAtTs);

      const baseCost = hre.ethers.parseEther('100');
      const currentEpoch = await ChronosContract.getCurrentEpoch();
      await expect(
        NFT.connect(kav10).coverPublishingCost(
          agent.address,
          baseCost,
          currentEpoch,
          BigInt(LOCK_DURATION),
        ),
      )
        .to.be.revertedWithCustomError(NFT, 'AccountExpired')
        .withArgs(acctId, expiresAt);
    });

    it('reverts AccountExpired well AFTER expiresAtEpoch (epoch + 3)', async () => {
      const { kav10, agent, acctId } = await setupWithKAV10Signer();
      const info = await NFT.getAccountInfo(acctId);
      const expiresAt = BigInt(info.expiresAtEpoch);
      const expiresAtTs = BigInt(info.expiresAtTimestamp);

      await advanceToTimestamp(expiresAtTs + 3n);

      const baseCost = hre.ethers.parseEther('100');
      const currentEpoch = await ChronosContract.getCurrentEpoch();
      await expect(
        NFT.connect(kav10).coverPublishingCost(
          agent.address,
          baseCost,
          currentEpoch,
          BigInt(LOCK_DURATION),
        ),
      )
        .to.be.revertedWithCustomError(NFT, 'AccountExpired')
        .withArgs(acctId, expiresAt);
    });

    it('does NOT mutate windowSpent/topUpBalance when coverPublishingCost reverts post-expiry', async () => {
      const { kav10, agent, acctId } = await setupWithKAV10Signer();
      const info = await NFT.getAccountInfo(acctId);
      const expiresAt = BigInt(info.expiresAtEpoch);
      const expiresAtTs = BigInt(info.expiresAtTimestamp);

      await advanceToTimestamp(expiresAtTs);

      const bufferBefore = await NFT.topUpBalance(acctId);
      const spentBefore = await NFT.windowSpent(acctId, 0n);

      const currentEpoch = await ChronosContract.getCurrentEpoch();
      await expect(
        NFT.connect(kav10).coverPublishingCost(
          agent.address,
          hre.ethers.parseEther('10'),
          currentEpoch,
          BigInt(LOCK_DURATION),
        ),
      )
        .to.be.revertedWithCustomError(NFT, 'AccountExpired')
        .withArgs(acctId, expiresAt);

      expect(await NFT.topUpBalance(acctId)).to.equal(bufferBefore);
      expect(await NFT.windowSpent(acctId, 0n)).to.equal(spentBefore);
    });

    it('SANITY: coverPublishingCost in-lifetime (epoch < expiresAt) succeeds', async () => {
      const { kav10, agent, acctId } = await setupWithKAV10Signer();
      const info = await NFT.getAccountInfo(acctId);
      const expiresAtTs = BigInt(info.expiresAtTimestamp);

      // Keep enough headroom so the transaction-mined block cannot cross expiry.
      await advanceToTimestamp(expiresAtTs - 10n);

      const baseCost = hre.ethers.parseEther('10');
      // Pin the exact event payload so a future change to the discount
      // formula, drawnFromEpoch, or arg list fails loudly. CostCovered(id,
      // epoch, baseCost, discountedCost, drawnFromEpoch, drawnFromTopUp).
      const BPS_DENOMINATOR = 10_000n;
      const discountBps = BigInt(info.discountBps);
      const expectedDiscounted =
        (BigInt(baseCost) * (BPS_DENOMINATOR - discountBps)) / BPS_DENOMINATOR;
      const currentEpoch = await ChronosContract.getCurrentEpoch();

      await expect(
        NFT.connect(kav10).coverPublishingCost(
          agent.address,
          baseCost,
          currentEpoch,
          BigInt(LOCK_DURATION),
        ),
      )
        .to.emit(NFT, 'CostCovered')
        .withArgs(
          acctId,
          currentEpoch,
          baseCost,
          expectedDiscounted,
          expectedDiscounted,
          0n,
        );
    });

    it('account created AT epoch N still has a full LOCK_DURATION window before AccountExpired fires', async () => {
      // Pins the exact lifetime length asserted in the docstring: 12 epoch
      // lengths from creation timestamp.
      const { kav10, agent, acctId } = await setupWithKAV10Signer();
      const info = await NFT.getAccountInfo(acctId);
      const epochLength = await ChronosContract.epochLength();
      expect(BigInt(info.expiresAtTimestamp) - BigInt(info.createdAtTimestamp)).to.equal(
        BigInt(LOCK_DURATION) * epochLength,
      );

      // Walk through all 12 allowed billing windows; every call must succeed.
      for (let delta = 0n; delta < BigInt(LOCK_DURATION); delta++) {
        await advanceToTimestamp(
          BigInt(info.createdAtTimestamp) + delta * epochLength,
        );
        const currentEpoch = await ChronosContract.getCurrentEpoch();
        await expect(
          NFT.connect(kav10).coverPublishingCost(
            agent.address,
            1n,
            currentEpoch,
            1n,
          ),
        ).to.not.be.reverted;
      }

      // Then exactly at expiry timestamp it MUST revert.
      await advanceToTimestamp(BigInt(info.expiresAtTimestamp));
      const finalEpoch = await ChronosContract.getCurrentEpoch();
      await expect(
        NFT.connect(kav10).coverPublishingCost(agent.address, 1n, finalEpoch, 1n),
      ).to.be.revertedWithCustomError(NFT, 'AccountExpired');
    });
  });
});
