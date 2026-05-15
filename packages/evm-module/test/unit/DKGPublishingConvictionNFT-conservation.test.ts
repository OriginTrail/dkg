/**
 * DKGPublishingConvictionNFT-conservation.test.ts — full-lifecycle TRAC
 * conservation invariant.
 *
 * V10 lazy-settlement model: over an account's complete lifetime the total
 * TRAC accounted to the staker pool MUST equal `committedTRAC +
 * sum(topUps)`. This integration test exercises the full path
 * (createAccount → mixed publishes across multiple billing windows →
 * topUps mid-lifetime → post-expiry settle), parses every
 * `WindowSettled`, `CostCovered`, and `AccountFinalSwept` event from
 * the NFT contract, and asserts the conservation invariant exactly.
 */
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionStakingStorage,
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
  ConvictionStakingStorage: ConvictionStakingStorage;
  EpochStorage: EpochStorage;
  Chronos: Chronos;
};

const LOCK_DURATION = 12;
const BPS = 10_000n;

/**
 * Returns the discount basis points that the contract's
 * `getDiscountBps` ladder applies to a given committed amount. Mirrors
 * the ladder (highest-tier-first) so the test can compute the expected
 * `discountedCost = baseCost * (BPS - discountBps) / BPS` independently
 * from the contract.
 */
function expectedBps(trac: bigint): bigint {
  const ether = (n: bigint) => n * 10n ** 18n;
  if (trac >= ether(1_000_000n)) return 7500n;
  if (trac >= ether(500_000n)) return 5000n;
  if (trac >= ether(250_000n)) return 4000n;
  if (trac >= ether(100_000n)) return 3000n;
  if (trac >= ether(50_000n)) return 2000n;
  if (trac >= ether(25_000n)) return 1000n;
  return 0n;
}

describe('@unit DKGPublishingConvictionNFT — TRAC conservation across full lifecycle', function () {
  let accounts: SignerWithAddress[];
  let HubContract: Hub;
  let NFT: DKGPublishingConvictionNFT;
  let TokenContract: Token;
  let CSS: ConvictionStakingStorage;
  let ChronosContract: Chronos;

  async function deployFixture(): Promise<Fixture> {
    await hre.deployments.fixture([
      'DKGPublishingConvictionNFT',
      'Token',
      'StakingStorage',
      'ConvictionStakingStorage',
      'EpochStorage',
      'Chronos',
    ]);
    const Hub = await hre.ethers.getContract<Hub>('Hub');
    const NFT = await hre.ethers.getContract<DKGPublishingConvictionNFT>('DKGPublishingConvictionNFT');
    const Token = await hre.ethers.getContract<Token>('Token');
    const SS = await hre.ethers.getContract<StakingStorage>('StakingStorage');
    const CSS = await hre.ethers.getContract<ConvictionStakingStorage>('ConvictionStakingStorage');
    const ES = await hre.ethers.getContract<EpochStorage>('EpochStorageV8');
    const Chronos = await hre.ethers.getContract<Chronos>('Chronos');
    const accounts = await hre.ethers.getSigners();
    await Hub.setContractAddress('HubOwner', accounts[0].address);
    await Token.mint(accounts[0].address, hre.ethers.parseEther('10000000'));
    return {
      accounts,
      Hub,
      NFT,
      Token,
      StakingStorage: SS,
      ConvictionStakingStorage: CSS,
      EpochStorage: ES,
      Chronos,
    };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      Hub: HubContract,
      NFT,
      Token: TokenContract,
      ConvictionStakingStorage: CSS,
      Chronos: ChronosContract,
    } = await loadFixture(deployFixture));
  });

  afterEach(async () => {
    // Flow-through invariant: the NFT contract must NEVER hold TRAC.
    expect(await TokenContract.balanceOf(await NFT.getAddress())).to.equal(0n);
  });

  type Distribution = {
    passive: bigint;
    active: bigint;
    tail: bigint;
  };

  async function tally(
    tx: Awaited<ReturnType<typeof NFT.settle>>,
  ): Promise<Distribution> {
    const receipt = await tx.wait();
    const nftAddr = (await NFT.getAddress()).toLowerCase();
    let passive = 0n;
    let active = 0n;
    let tail = 0n;
    for (const log of receipt!.logs) {
      if (log.address.toLowerCase() !== nftAddr) continue;
      let parsed: ReturnType<DKGPublishingConvictionNFT['interface']['parseLog']> = null;
      try {
        parsed = NFT.interface.parseLog({ topics: [...log.topics], data: log.data });
      } catch {
        continue;
      }
      if (parsed === null) continue;
      if (parsed.name === 'WindowSettled') {
        passive += BigInt(parsed.args.remainderSwept);
      } else if (parsed.name === 'CostCovered') {
        active += BigInt(parsed.args.drawnFromEpoch) + BigInt(parsed.args.drawnFromTopUp);
      } else if (parsed.name === 'AccountFinalSwept') {
        tail += BigInt(parsed.args.topUpSwept) + BigInt(parsed.args.dustSwept);
      }
    }
    return { passive, active, tail };
  }

  it('createAccount + mixed publishes across N windows + topUp + post-expiry settle: total accounted == committed + topUps', async () => {
    // ---- Setup: impersonate KAV10 and register an agent ----
    const Kav10Signer = accounts[5];
    const agent = accounts[6];
    await HubContract.setContractAddress('KnowledgeAssetsV10', Kav10Signer.address);

    // Use committedTRAC NOT divisible by 12 to exercise the dust path.
    const committed = hre.ethers.parseEther('120000') + 7n; // 30% tier, ~10K per window
    const discountBps = expectedBps(committed);
    expect(discountBps).to.equal(3000n);
    const baseAllowance = committed / 12n;
    const dust = committed - baseAllowance * 12n;
    const top1 = hre.ethers.parseEther('5000');
    const top2 = hre.ethers.parseEther('10000');

    await TokenContract.approve(await NFT.getAddress(), committed + top1 + top2);
    await NFT.createAccount(committed);
    await NFT.registerAgent(1, agent.address);

    const epochLength = await ChronosContract.epochLength();
    let totalAccounted = 0n;

    // ---- Window 0: partial publish (uses base only) ----
    {
      const targetDisc = baseAllowance / 4n; // a quarter of base
      const baseCost = (targetDisc * BPS) / (BPS - discountBps);
      const expected = (baseCost * (BPS - discountBps)) / BPS;
      const startEpoch = await ChronosContract.getCurrentEpoch();
      const tx = await NFT.connect(Kav10Signer).coverPublishingCost(
        agent.address,
        baseCost,
        startEpoch,
        LOCK_DURATION,
      );
      const d = await tally(tx);
      expect(d.active).to.equal(expected);
      expect(d.passive).to.equal(0n);
      totalAccounted += d.active + d.passive + d.tail;
    }

    // ---- Window 1: advance + partial publish (settles window 0) ----
    await time.increase(epochLength + 1n);
    {
      const targetDisc = baseAllowance / 2n;
      const baseCost = (targetDisc * BPS) / (BPS - discountBps);
      const expected = (baseCost * (BPS - discountBps)) / BPS;
      const startEpoch = await ChronosContract.getCurrentEpoch();
      const tx = await NFT.connect(Kav10Signer).coverPublishingCost(
        agent.address,
        baseCost,
        startEpoch,
        LOCK_DURATION,
      );
      const d = await tally(tx);
      expect(d.active).to.equal(expected);
      // Window 0 passive sink = baseAllowance - actualDisc(w0). w0 used
      // baseAllowance / 4 (with floor-division rounding), so remainder
      // is baseAllowance - that.
      expect(d.passive).to.be.gt(0n);
      totalAccounted += d.active + d.passive + d.tail;
    }

    // ---- topUp mid-lifetime (lazy-settles, no new accounting) ----
    {
      const tx = await NFT.topUp(1, top1);
      const d = await tally(tx);
      // No new passive sweep here — the current window (w1) is still
      // active, and w0 is already settled by the previous publish.
      expect(d.active).to.equal(0n);
      expect(d.passive).to.equal(0n);
      totalAccounted += d.active + d.passive + d.tail;
    }

    // ---- Window 3: advance 2 more windows + drain base + topUp ----
    await time.increase(epochLength * 2n + 1n);
    {
      // Cover an amount large enough to drain w3 base and dip into
      // topUp. Currently w1's base allowance is still half-spent.
      const drainW1 = baseAllowance; // way more than needed
      const baseCost = (drainW1 * BPS) / (BPS - discountBps) + 10n;
      const expected = (baseCost * (BPS - discountBps)) / BPS;
      const startEpoch = await ChronosContract.getCurrentEpoch();
      const tx = await NFT.connect(Kav10Signer).coverPublishingCost(
        agent.address,
        baseCost,
        startEpoch,
        LOCK_DURATION,
      );
      const d = await tally(tx);
      expect(d.active).to.equal(expected);
      // w1 + w2 passive sweep (w0 was already settled before).
      expect(d.passive).to.be.gt(0n);
      totalAccounted += d.active + d.passive + d.tail;
    }

    // ---- Second top-up; advance to mid-expiry; settle (no expiry yet) ----
    {
      const tx = await NFT.topUp(1, top2);
      const d = await tally(tx);
      // top-up itself only lazy-settles; advance was 2 windows + ~now we
      // are in window 3. Window 3 was just touched (active), so the
      // settle only covers up to window 2 — but w0..w2 should already
      // be flushed by the prior publish.
      expect(d.passive).to.equal(0n);
      totalAccounted += d.active + d.passive + d.tail;
    }

    // ---- Advance past expiry; post-expiry settle ----
    await time.increase(epochLength * BigInt(LOCK_DURATION + 1));
    {
      const tx = await NFT.settle(1);
      const d = await tally(tx);
      // Remaining windows + tail (topUp leftover + dust). The exact
      // tail value depends on whether earlier publishes overflowed
      // into `topUpBalance` (due to floor-division rounding in
      // discountedCost) — the conservation invariant below covers
      // the bookkeeping precisely.
      expect(d.passive).to.be.gte(0n);
      expect(d.tail).to.be.gte(dust);
      totalAccounted += d.active + d.passive + d.tail;
    }

    // ---- Final conservation invariant: every wei in == every wei accounted ----
    expect(totalAccounted).to.equal(committed + top1 + top2);

    // Sanity: account is fully swept and the CSS escrow received every
    // wei the user committed/topped-up.
    const info = await NFT.getAccountInfo(1);
    expect(info.fullySwept).to.equal(true);
    expect(info.topUpBuffer).to.equal(0n);
    expect(info.lastSettledWindow).to.equal(LOCK_DURATION);

    // Idempotency: subsequent settles do nothing.
    const txNoop = await NFT.settle(1);
    const noop = await tally(txNoop);
    expect(noop.active + noop.passive + noop.tail).to.equal(0n);
  });
});
