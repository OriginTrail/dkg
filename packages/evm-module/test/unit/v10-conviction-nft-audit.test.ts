/**
 * DKG v10 conviction NFT audit coverage.
 *
 * Findings covered (see .test-audit/BUGS_FOUND.md):
 *   E-6  (HIGH, TEST-DEBT):     `DKGPublishingConvictionNFT` `AccountExpired`
 *         revert paths on `topUp` and `coverPublishingCost`. Boundary cases
 *         around `expiresAtEpoch` are also pinned so the off-by-one on the
 *         epoch comparison is impossible to miss in a future refactor.
 *
 * (E-2 / E-14 / E-16 staking-NFT cases live in the dedicated
 *  `DKGStakingConvictionNFT-extra.test.ts` and `v10-conviction-extra.test.ts`
 *  files — they were originally collocated here but the staking ladder and
 *  withdraw matrix are deep enough to warrant their own files.)
 */

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  Chronos,
  DKGPublishingConvictionNFT,
  Hub,
  Token,
} from '../../typechain';

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  PublishingNFT: DKGPublishingConvictionNFT;
  Token: Token;
  Chronos: Chronos;
};

describe('@unit v10 conviction NFT audit', () => {
  let accounts: SignerWithAddress[];
  let HubContract: Hub;
  let PublishingNFT: DKGPublishingConvictionNFT;
  let TokenContract: Token;
  let ChronosContract: Chronos;

  async function deployFixture(): Promise<Fixture> {
    await hre.deployments.fixture([
      'Hub',
      'Token',
      'Chronos',
      'EpochStorage',
      'DKGPublishingConvictionNFT',
    ]);
    const Hub = await hre.ethers.getContract<Hub>('Hub');
    const PublishingNFT = await hre.ethers.getContract<DKGPublishingConvictionNFT>(
      'DKGPublishingConvictionNFT',
    );
    const Token = await hre.ethers.getContract<Token>('Token');
    const Chronos = await hre.ethers.getContract<Chronos>('Chronos');
    const accounts = await hre.ethers.getSigners();
    await Hub.setContractAddress('HubOwner', accounts[0].address);
    await Token.mint(accounts[0].address, hre.ethers.parseEther('10000000'));
    await Token.mint(accounts[1].address, hre.ethers.parseEther('10000000'));
    return { accounts, Hub, PublishingNFT, Token, Chronos };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      Hub: HubContract,
      PublishingNFT,
      Token: TokenContract,
      Chronos: ChronosContract,
    } = await loadFixture(deployFixture));
  });

  // Advance block time past `n` full Chronos epochs.
  async function advanceEpochs(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      const remaining = await ChronosContract.timeUntilNextEpoch();
      await time.increase(remaining + 1n);
    }
  }

  // ========================================================================
  // E-6: DKGPublishingConvictionNFT.AccountExpired
  // ========================================================================

  describe('E-6 — DKGPublishingConvictionNFT AccountExpired guard', () => {
    const LOCK_DURATION = 12;

    async function openAccount(
      owner: SignerWithAddress,
      committed: bigint,
    ): Promise<bigint> {
      if (owner.address !== accounts[0].address) {
        await TokenContract.connect(accounts[0]).transfer(
          owner.address,
          committed,
        );
      }
      await TokenContract.connect(owner).approve(
        await PublishingNFT.getAddress(),
        committed,
      );
      await PublishingNFT.connect(owner).createAccount(committed);
      return await PublishingNFT.totalSupply();
    }

    it('topUp reverts with AccountExpired after the 12-epoch window elapses', async () => {
      const owner = accounts[0];
      const committed = hre.ethers.parseEther('100000');
      const accountId = await openAccount(owner, committed);

      // Advance past expiresAtEpoch (createdAt + 12). We're at createdAt now.
      await advanceEpochs(LOCK_DURATION);

      const topAmount = hre.ethers.parseEther('1000');
      await TokenContract.connect(owner).approve(
        await PublishingNFT.getAddress(),
        topAmount,
      );
      await expect(
        PublishingNFT.connect(owner).topUp(accountId, topAmount),
      ).to.be.revertedWithCustomError(PublishingNFT, 'AccountExpired');
    });

    it('topUp reverts with AccountExpired even many epochs past expiry', async () => {
      const owner = accounts[0];
      const committed = hre.ethers.parseEther('100000');
      const accountId = await openAccount(owner, committed);

      await advanceEpochs(LOCK_DURATION + 5);

      const topAmount = hre.ethers.parseEther('1000');
      await TokenContract.connect(owner).approve(
        await PublishingNFT.getAddress(),
        topAmount,
      );
      await expect(
        PublishingNFT.connect(owner).topUp(accountId, topAmount),
      ).to.be.revertedWithCustomError(PublishingNFT, 'AccountExpired');
    });

    it('coverPublishingCost reverts with AccountExpired after the window', async () => {
      // Register account and publishing agent, then impersonate the KAV10
      // caller via Hub's "KnowledgeAssetsV10" registration (same pattern as
      // DKGPublishingConvictionNFT.test.ts).
      const owner = accounts[0];
      const agent = accounts[2];
      const committed = hre.ethers.parseEther('100000');
      const accountId = await openAccount(owner, committed);
      await PublishingNFT.connect(owner).registerAgent(accountId, agent.address);

      const Kav10Signer = accounts[5];
      await HubContract.setContractAddress(
        'KnowledgeAssetsV10',
        Kav10Signer.address,
      );

      // Advance past expiry.
      await advanceEpochs(LOCK_DURATION);

      await expect(
        PublishingNFT.connect(Kav10Signer).coverPublishingCost(
          agent.address,
          hre.ethers.parseEther('1'),
        ),
      ).to.be.revertedWithCustomError(PublishingNFT, 'AccountExpired');
    });

    it('boundary: topUp succeeds at expiresAtEpoch - 1, reverts at expiresAtEpoch', async () => {
      const owner = accounts[0];
      const committed = hre.ethers.parseEther('100000');
      const accountId = await openAccount(owner, committed);
      const info = await PublishingNFT.getAccountInfo(accountId);
      const current = await ChronosContract.getCurrentEpoch();
      const last = BigInt(info.expiresAtEpoch) - 1n; // inclusive last live epoch
      const forward = Number(last - current);
      await advanceEpochs(forward);

      const topAmount = hre.ethers.parseEther('1000');
      await TokenContract.connect(owner).approve(
        await PublishingNFT.getAddress(),
        topAmount * 2n,
      );
      // Still live one epoch before expiry.
      await PublishingNFT.connect(owner).topUp(accountId, topAmount);

      // Advance one more epoch → now at expiresAtEpoch → must revert.
      await advanceEpochs(1);
      await expect(
        PublishingNFT.connect(owner).topUp(accountId, topAmount),
      ).to.be.revertedWithCustomError(PublishingNFT, 'AccountExpired');
    });
  });
});
