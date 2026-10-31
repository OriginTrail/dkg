/**
 * DKGPublishingConvictionNFT-conservation.test.ts — full-lifecycle TRAC
 * conservation invariant.
 *
 * 10.2.0 use-time model: over an account's complete lifetime the total TRAC
 * accounted to the staker pool MUST equal `committedTRAC + sum(topUps)`
 * (with no service draws, which would be due in the query/inference pool),
 * composed as
 *
 *   Σ publishing draws at use time (`CostCovered.discountedCost`, window part
 *     and topUp overflow alike)
 *   + Σ closed windows' unused budget (`EmissionScheduled.scheduled`, each
 *     window booked once, dust with the last)
 *   + post-expiry topUp tail (`AccountFinalSwept.topUpSwept`)
 *
 * `WindowSettled` never fires. This integration test exercises the full path
 * (createAccount → mixed publishes across multiple billing windows → topUps
 * mid-lifetime → post-expiry settle) and asserts the invariant exactly.
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
  PublishingConviction,
  StakingStorage,
  Token,
} from '../../typechain';

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  NFT: DKGPublishingConvictionNFT;
  Logic: PublishingConviction;
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
  let LogicContract: PublishingConviction;
  let TokenContract: Token;
  let CSS: ConvictionStakingStorage;
  let ChronosContract: Chronos;

  async function deployFixture(): Promise<Fixture> {
    await hre.deployments.fixture([
      // V10 split — pull storage + logic + wrapper trio.
      'PublishingConvictionStorage',
      'PublishingConviction',
      'DKGPublishingConvictionNFT',
      'Token',
      'StakingStorage',
      'ConvictionStakingStorage',
      'EpochStorage',
      'Chronos',
    ]);
    const Hub = await hre.ethers.getContract<Hub>('Hub');
    const NFT = await hre.ethers.getContract<DKGPublishingConvictionNFT>('DKGPublishingConvictionNFT');
    const Logic = await hre.ethers.getContract<PublishingConviction>('PublishingConviction');
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
      Logic,
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
      Logic: LogicContract,
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
    scheduled: bigint;
    scheduledFee: bigint;
    drawn: bigint;
    budgetDraw: bigint;
    topUpDraw: bigint;
    tail: bigint;
    windowSettledCount: number;
  };

  async function tally(
    tx: Awaited<ReturnType<typeof NFT.settle>>,
  ): Promise<Distribution> {
    const receipt = await tx.wait();
    // Post-split: state-change events fire on `PublishingConviction`.
    const logicAddr = (await LogicContract.getAddress()).toLowerCase();
    let scheduled = 0n;
    let scheduledFee = 0n;
    let drawn = 0n;
    let budgetDraw = 0n;
    let topUpDraw = 0n;
    let tail = 0n;
    let windowSettledCount = 0;
    for (const log of receipt!.logs) {
      if (log.address.toLowerCase() !== logicAddr) continue;
      let parsed: ReturnType<PublishingConviction['interface']['parseLog']> = null;
      try {
        parsed = LogicContract.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
      } catch {
        continue;
      }
      if (parsed === null) continue;
      if (parsed.name === 'EmissionScheduled') {
        scheduled += BigInt(parsed.args.scheduled);
        scheduledFee += BigInt(parsed.args.treasuryFee);
      } else if (parsed.name === 'WindowSettled') {
        windowSettledCount += 1;
      } else if (parsed.name === 'CostCovered') {
        drawn += BigInt(parsed.args.discountedCost);
        budgetDraw += BigInt(parsed.args.drawnFromEpoch);
        topUpDraw += BigInt(parsed.args.drawnFromTopUp);
      } else if (parsed.name === 'AccountFinalSwept') {
        tail += BigInt(parsed.args.topUpSwept) + BigInt(parsed.args.dustSwept);
      }
    }
    return { scheduled, scheduledFee, drawn, budgetDraw, topUpDraw, tail, windowSettledCount };
  }

  it('createAccount + mixed publishes across N windows + topUp + post-expiry settle: total accounted == committed + topUps', async () => {
    // ---- Setup: impersonate KAV10 and register an agent ----
    const Kav10Signer = accounts[5];
    const agent = accounts[6];
    await HubContract.setContractAddress('KnowledgeAssetsLifecycle', Kav10Signer.address);

    // Use committedTRAC NOT divisible by 12 to exercise the dust path.
    const committed = hre.ethers.parseEther('120000') + 7n; // 30% tier, ~10K per window
    const discountBps = expectedBps(committed);
    expect(discountBps).to.equal(3000n);
    const baseAllowance = committed / 12n;
    const top1 = hre.ethers.parseEther('5000');
    const top2 = hre.ethers.parseEther('10000');

    await TokenContract.approve(await NFT.getAddress(), committed + top1 + top2);
    // RFC-51: createAccount(committedTRAC, primaryNode); conservation tests
    // don't assert allocation seeding → inert node = 0.
    // 10.2.0: the creation books nothing — the account pays at use time.
    const txCreate = await NFT.createAccount(committed, 0);
    const dCreate = await tally(txCreate);
    expect(dCreate.scheduled + dCreate.drawn + dCreate.tail).to.equal(0n);
    let totalAccounted = 0n;
    await NFT.registerAgent(1, agent.address);

    const epochLength = await ChronosContract.epochLength();
    let topUpDrawTotal = 0n;
    const publish = async (baseCost: bigint) =>
      tally(
        await NFT.connect(Kav10Signer).coverPublishingCost(
          agent.address,
          baseCost,
          await ChronosContract.getCurrentEpoch(),
          LOCK_DURATION,
        ),
      );

    // ---- Window 0: partial publish — booked at once ----
    const w0 = baseAllowance / 4n; // a quarter of base
    {
      const baseCost = (w0 * BPS) / (BPS - discountBps);
      const expected = (baseCost * (BPS - discountBps)) / BPS;
      const d = await publish(baseCost);
      expect(d.drawn).to.equal(expected);
      expect(d.budgetDraw).to.equal(expected);
      expect(d.topUpDraw).to.equal(0n);
      expect(d.scheduled).to.equal(0n);
      expect(d.windowSettledCount).to.equal(0);
      totalAccounted += d.drawn;
    }
    const spent0 = (((w0 * BPS) / (BPS - discountBps)) * (BPS - discountBps)) / BPS;

    // ---- Window 1: advance + partial publish; window 0's rest is booked ----
    await time.increase(epochLength + 1n);
    const w1 = baseAllowance / 2n;
    let spent1: bigint;
    {
      const baseCost = (w1 * BPS) / (BPS - discountBps);
      const expected = (baseCost * (BPS - discountBps)) / BPS;
      const d = await publish(baseCost);
      expect(d.drawn).to.equal(expected);
      expect(d.topUpDraw).to.equal(0n);
      expect(d.windowSettledCount).to.equal(0);
      // Window 0 closed: its unused budget, once.
      expect(d.scheduled).to.equal(baseAllowance - spent0);
      totalAccounted += d.drawn + d.scheduled;
      spent1 = expected;
    }

    // ---- topUp mid-lifetime (window 1 still open: nothing to book) ----
    {
      const tx = await NFT.topUp(1, top1);
      const d = await tally(tx);
      expect(d.drawn + d.scheduled + d.tail).to.equal(0n);
    }

    // ---- Window 3: advance 2 more windows + drain base + dip into topUp ----
    await time.increase(epochLength * 2n + 1n);
    {
      // Cover an amount large enough to drain w3's base and dip into topUp.
      const drainW3 = baseAllowance;
      const baseCost = (drainW3 * BPS) / (BPS - discountBps) + 10n;
      const expected = (baseCost * (BPS - discountBps)) / BPS;
      const d = await publish(baseCost);
      // The whole draw is booked, window part and overflow alike.
      expect(d.budgetDraw).to.equal(baseAllowance);
      expect(d.topUpDraw).to.equal(expected - baseAllowance);
      expect(d.topUpDraw).to.be.gt(0n);
      expect(d.drawn).to.equal(expected);
      // Windows 1 and 2 closed: window 1's rest and all of window 2.
      expect(d.scheduled).to.equal(baseAllowance - spent1 + baseAllowance);
      expect(d.windowSettledCount).to.equal(0);
      topUpDrawTotal += d.topUpDraw;
      totalAccounted += d.drawn + d.scheduled;
    }

    // ---- Second top-up (again no accounting side effects) ----
    {
      const tx = await NFT.topUp(1, top2);
      const d = await tally(tx);
      expect(d.drawn + d.scheduled + d.tail).to.equal(0n);
    }

    // ---- Advance past expiry; post-expiry settle ----
    await time.increase(epochLength * BigInt(LOCK_DURATION + 1));
    {
      const tx = await NFT.settle(1);
      const d = await tally(tx);
      // Windows 3 to 11: window 3 was drained, the other 8 are unused, and
      // the dust rides the last; then the leftover topUp tail.
      const dust = committed - baseAllowance * 12n;
      expect(d.scheduled).to.equal(8n * baseAllowance + dust);
      expect(d.tail).to.equal(top1 + top2 - topUpDrawTotal);
      expect(d.windowSettledCount).to.equal(0);
      totalAccounted += d.scheduled + d.tail;
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
    expect(noop.scheduled + noop.drawn + noop.tail).to.equal(0n);
  });

  it('protocol treasury fee: each window splits net/fee when it is booked; the fee pays out via collectTreasuryEmission; the topUp tail keeps the immediate skim', async () => {
    const treasury = accounts[7];
    const ParametersStorageContract =
      await hre.ethers.getContract('ParametersStorage');
    await HubContract.forwardCall(
      await ParametersStorageContract.getAddress(),
      ParametersStorageContract.interface.encodeFunctionData(
        'setProtocolTreasury',
        [treasury.address],
      ),
    );
    expect(await ParametersStorageContract.protocolTreasuryFee()).to.equal(300n);

    // Fee basis: with a treasury wired when a window is booked, its budget
    // splits fee → the treasury emission shard / net → the staker shard as
    // pure ACCOUNTING. The physical payout is the deferred,
    // per-elapsed-epoch collectTreasuryEmission.
    const committed = hre.ethers.parseEther('120000'); // divisible by 12 — no dust
    const top = hre.ethers.parseEther('10000');
    const baseAllowance = committed / BigInt(LOCK_DURATION);
    const feePerWindow = (baseAllowance * 300n) / BPS;
    const expectedBaseFee = feePerWindow * BigInt(LOCK_DURATION); // 3600 ether
    const expectedTailFee = (top * 300n) / BPS; // 300 ether

    await TokenContract.approve(await NFT.getAddress(), committed + top);
    // createAccount MUST NOT revert with a wired treasury: it books nothing.
    const txCreate = await NFT.createAccount(committed, 0);
    const dCreate = await tally(txCreate);
    expect(dCreate.scheduled + dCreate.scheduledFee).to.equal(0n);
    const treasuryBefore = await TokenContract.balanceOf(treasury.address);
    await NFT.topUp(1, top);

    const cssAddr = await CSS.getAddress();
    const cssBefore = await TokenContract.balanceOf(cssAddr);

    // Advance past expiry and settle: every window is booked, split net/fee
    // with no TRAC moving, then the topUp tail sweeps net of its immediate
    // fee — the window fee sits on the treasury shard, not yet paid.
    const epochLength = await ChronosContract.epochLength();
    await time.increase(epochLength * BigInt(LOCK_DURATION + 1));
    const dSettle = await tally(await NFT.settle(1));
    expect(dSettle.scheduled).to.equal(committed - expectedBaseFee);
    expect(dSettle.scheduledFee).to.equal(expectedBaseFee);
    expect(dSettle.scheduled + dSettle.scheduledFee).to.equal(committed);
    expect(dSettle.tail).to.equal(top);

    // Treasury physically receives exactly the tail fee — nothing more yet.
    expect(
      (await TokenContract.balanceOf(treasury.address)) - treasuryBefore,
    ).to.equal(expectedTailFee);
    // Only the tail fee leaves the CSS vault at settle.
    expect(cssBefore - (await TokenContract.balanceOf(cssAddr))).to.equal(
      expectedTailFee,
    );

    const info = await NFT.getAccountInfo(1);
    expect(info.fullySwept).to.equal(true);

    // Idempotency + settle() reentrancy-safety: a second settle moves no
    // further TRAC (fullySwept is persisted before any pay).
    const treasuryAfterFirst = await TokenContract.balanceOf(treasury.address);
    await NFT.settle(1);
    expect(await TokenContract.balanceOf(treasury.address)).to.equal(
      treasuryAfterFirst,
    );

    // Advance past the emission span end (window closes + lock epochs) and
    // collect: the treasury receives the whole scheduled base fee except the
    // few wei still riding the shard's accumulatedRemainder carry.
    await time.increase(epochLength * BigInt(LOCK_DURATION + 2));
    const ES = await hre.ethers.getContract('EpochStorageV8');
    const cur = await (await hre.ethers.getContract('Chronos')).getCurrentEpoch();
    let expectedCollect = 0n;
    for (let e = 1n; e <= cur - 1n; e++) {
      expectedCollect += await ES.getEpochRemainingPool(2n, e);
    }
    const feeCarry = await ES.accumulatedRemainder(2n);
    expect(expectedCollect + feeCarry).to.equal(expectedBaseFee);

    await LogicContract.collectTreasuryEmission(1n, cur - 1n);
    expect(
      (await TokenContract.balanceOf(treasury.address)) - treasuryAfterFirst,
    ).to.equal(expectedCollect);

    // Idempotent: re-collecting the same range moves nothing further.
    const treasuryAfterCollect = await TokenContract.balanceOf(treasury.address);
    await LogicContract.collectTreasuryEmission(1n, cur - 1n);
    expect(await TokenContract.balanceOf(treasury.address)).to.equal(
      treasuryAfterCollect,
    );
  });

  it('protocol treasury fee dormant by default: no treasury wired ⇒ full amount swept to the pool', async () => {
    // No setProtocolTreasury call — default recipient is the zero address.
    const committed = hre.ethers.parseEther('120000');
    await TokenContract.approve(await NFT.getAddress(), committed);
    // RFC-51: createAccount(committedTRAC, primaryNode); inert node = 0.
    await NFT.createAccount(committed, 0);

    const cssAddr = await CSS.getAddress();
    const cssBefore = await TokenContract.balanceOf(cssAddr);

    const epochLength = await ChronosContract.epochLength();
    await time.increase(epochLength * BigInt(LOCK_DURATION + 1));
    await NFT.settle(1);

    // No fee leaves the vault — every wei stays escrowed for stakers.
    expect(await TokenContract.balanceOf(cssAddr)).to.equal(cssBefore);
  });
});
