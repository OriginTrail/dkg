// PublishingConviction 10.1.0 — coverServiceCost, the allowance draw behind
// Conviction Account service spending (OT-RFC-27).
//
// Every call goes through MockServiceSubscriptions, a stub registered in the
// Hub as `ServiceSubscriptions`, the only caller the function admits. The stub
// keeps the ServiceDraw of the transaction that made it.
//
// Covered:
//   - the gate: only the contract the Hub names ServiceSubscriptions, looked up
//     on every call;
//   - the refusals and their order: a zero value, a wired treasury, an unknown
//     or expired account, and an allowance short of the cost, with no partial
//     effect;
//   - the draw, exactly as publishing draws: every discount tier, the 1-wei
//     floor, the window allowance first and then the top-up buffer, a window
//     shared with publishing, and a later window's own allowance;
//   - no TRAC moves: no Token log, an unchanged vault balance, an unchanged
//     staker pool for a base-only draw, and for an overflow exactly the ranges
//     publishing's overflow credits in the same block;
//   - the schedule of a pre-10.0.8 account is written before the draw.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ContractTransactionReceipt, ethers } from 'ethers';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionStakingStorage,
  DKGPublishingConvictionNFT,
  EpochStorage,
  Hub,
  MockServiceSubscriptions,
  ParametersStorage,
  PublishingConviction,
  PublishingConvictionStorage,
  Token,
} from '../typechain';
import { PoolModel, prorateActiveSink } from './helpers/emission-model';

const STAKER_SHARD_ID = 1n;
const BPS = 10_000n;
const TRAC = 10n ** 18n;
// 20% discount tier + 7 wei so the `committedTRAC % lock` dust path is live.
const COMMITTED_TRAC = ethers.parseEther('50000') + 7n;
const SUBSCRIPTION_ID = ethers.id('subscription-1');

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  Token: Token;
  Chronos: Chronos;
  EpochStorage: EpochStorage;
  ParametersStorage: ParametersStorage;
  ConvictionStakingStorage: ConvictionStakingStorage;
  NFT: DKGPublishingConvictionNFT;
  PublishingConviction: PublishingConviction;
  PCS: PublishingConvictionStorage;
  Stub: MockServiceSubscriptions;
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

  const StubFactory = await hre.ethers.getContractFactory('MockServiceSubscriptions');
  const Stub = (await StubFactory.deploy()) as unknown as MockServiceSubscriptions;
  await Stub.waitForDeployment();
  await Hub.setContractAddress('ServiceSubscriptions', await Stub.getAddress());

  return {
    accounts,
    Hub,
    Token: await hre.ethers.getContract<Token>('Token'),
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    EpochStorage: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
    ParametersStorage: await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
    ConvictionStakingStorage: await hre.ethers.getContract<ConvictionStakingStorage>('ConvictionStakingStorage'),
    NFT: await hre.ethers.getContract<DKGPublishingConvictionNFT>('DKGPublishingConvictionNFT'),
    PublishingConviction: await hre.ethers.getContract<PublishingConviction>('PublishingConviction'),
    PCS: await hre.ethers.getContract<PublishingConvictionStorage>('PublishingConvictionStorage'),
    Stub,
  };
}

describe('@integration PublishingConviction 10.1.0 coverServiceCost', function () {
  let accounts: SignerWithAddress[];
  let HubContract: Hub;
  let Token: Token;
  let ChronosContract: Chronos;
  let ES: EpochStorage;
  let Params: ParametersStorage;
  let Vault: ConvictionStakingStorage;
  let NFT: DKGPublishingConvictionNFT;
  let Logic: PublishingConviction;
  let PCS: PublishingConvictionStorage;
  let Stub: MockServiceSubscriptions;

  let epLen: bigint;
  let lock: bigint;
  let owner: SignerWithAddress;
  let assignee: SignerWithAddress;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      Hub: HubContract,
      Token,
      Chronos: ChronosContract,
      EpochStorage: ES,
      ParametersStorage: Params,
      ConvictionStakingStorage: Vault,
      NFT,
      PublishingConviction: Logic,
      PCS,
      Stub,
    } = await loadFixture(deployFixture));
    epLen = await ChronosContract.epochLength();
    lock = await Params.publishingConvictionEpochs();
    owner = accounts[5];
    assignee = accounts[9];
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Mint, approve and create a Conviction Account; returns its id and creation time. */
  const createAccountFor = async (
    holder: SignerWithAddress,
    committed: bigint = COMMITTED_TRAC,
  ): Promise<{ accountId: bigint; createdAt: bigint }> => {
    await Token.mint(holder.address, committed);
    await Token.connect(holder).approve(await NFT.getAddress(), committed);
    const rc = await (await NFT.connect(holder).createAccount(committed, 0)).wait();
    const block = await hre.ethers.provider.getBlock(rc!.blockNumber);
    return { accountId: await NFT.totalSupply(), createdAt: BigInt(block!.timestamp) };
  };

  const topUp = async (holder: SignerWithAddress, accountId: bigint, amount: bigint): Promise<void> => {
    await Token.mint(holder.address, amount);
    await Token.connect(holder).approve(await NFT.getAddress(), amount);
    await NFT.connect(holder).topUp(accountId, amount);
  };

  /** Fund through the stub; returns the receipt and the draw that transaction made. */
  const cover = async (
    accountId: bigint,
    value: bigint,
    subscriptionId: string = SUBSCRIPTION_ID,
  ): Promise<{ receipt: ContractTransactionReceipt; draw: Awaited<ReturnType<MockServiceSubscriptions['lastDraw']>> }> => {
    const tx = await Stub.cover(await Logic.getAddress(), accountId, assignee.address, subscriptionId, value);
    const receipt = (await tx.wait())!;
    return { receipt, draw: await Stub.lastDraw() };
  };

  const coverCall = async (accountId: bigint, value: bigint) =>
    Stub.cover(await Logic.getAddress(), accountId, assignee.address, SUBSCRIPTION_ID, value);

  const impersonatedNFT = async () => {
    const nftAddress = await NFT.getAddress();
    await hre.network.provider.send('hardhat_setBalance', [nftAddress, '0x1000000000000000000']);
    return hre.ethers.getImpersonatedSigner(nftAddress);
  };

  const blockTimestamp = async (receipt: ContractTransactionReceipt): Promise<bigint> =>
    BigInt((await hre.ethers.provider.getBlock(receipt.blockNumber))!.timestamp);

  /** The staker-shard ranges a receipt credited, as [start, end, amount]. */
  const creditedRanges = async (receipt: ContractTransactionReceipt): Promise<bigint[][]> => {
    const esAddress = (await ES.getAddress()).toLowerCase();
    const out: bigint[][] = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== esAddress) continue;
      const parsed = ES.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === 'TokensAddedToEpochRange' && BigInt(parsed.args.shardId) === STAKER_SHARD_ID) {
        out.push([BigInt(parsed.args.startEpoch), BigInt(parsed.args.endEpoch), BigInt(parsed.args.tokenAmount)]);
      }
    }
    return out;
  };

  const tokenLogCount = async (receipt: ContractTransactionReceipt): Promise<number> => {
    const tokenAddress = (await Token.getAddress()).toLowerCase();
    return receipt.logs.filter((l) => l.address.toLowerCase() === tokenAddress).length;
  };

  const poolSnapshot = async (from: bigint, to: bigint): Promise<Map<bigint, bigint>> => {
    const out = new Map<bigint, bigint>();
    for (let e = from; e <= to; e++) out.set(e, await ES.getEpochPool(STAKER_SHARD_ID, e));
    return out;
  };

  const costOf = (value: bigint, bps: bigint): bigint => {
    const cost = (value * (BPS - bps)) / BPS;
    return cost === 0n ? 1n : cost;
  };

  /** The smallest value whose discounted cost is exactly `cost` (rounds up). */
  const valueFor = (cost: bigint, bps: bigint = 2_000n): bigint =>
    (cost * BPS + (BPS - bps) - 1n) / (BPS - bps);

  const ZERO_RANGE = [0n, 0n, 0n];
  const rangesOf = (draw: { topUpRanges: Array<{ startEpoch: bigint; endEpoch: bigint; tokenAmount: bigint }> }) =>
    draw.topUpRanges.map((r) => [r.startEpoch, r.endEpoch, r.tokenAmount]);

  // -------------------------------------------------------------------------
  // The gate
  // -------------------------------------------------------------------------

  describe('gate', () => {
    it('admits only the contract the Hub names ServiceSubscriptions', async () => {
      const { accountId } = await createAccountFor(owner);
      const nft = await impersonatedNFT();
      for (const caller of [accounts[3], assignee, owner, accounts[0], nft]) {
        await expect(
          Logic.connect(caller).coverServiceCost(accountId, assignee.address, SUBSCRIPTION_ID, TRAC),
        )
          .to.be.revertedWithCustomError(Logic, 'OnlyServiceSubscriptions')
          .withArgs(caller.address);
      }
      await cover(accountId, TRAC);
    });

    it('follows the Hub: a re-registered ServiceSubscriptions is admitted and the previous one refused', async () => {
      const { accountId } = await createAccountFor(owner);
      const Factory = await hre.ethers.getContractFactory('MockServiceSubscriptions');
      const next = (await Factory.deploy()) as unknown as MockServiceSubscriptions;
      await next.waitForDeployment();
      await HubContract.setContractAddress('ServiceSubscriptions', await next.getAddress());

      await expect(coverCall(accountId, TRAC))
        .to.be.revertedWithCustomError(Logic, 'OnlyServiceSubscriptions')
        .withArgs(await Stub.getAddress());
      await expect(
        next.cover(await Logic.getAddress(), accountId, assignee.address, SUBSCRIPTION_ID, TRAC),
      ).to.emit(Logic, 'ServiceCostCovered');
    });

    it('with no ServiceSubscriptions registered, the Hub lookup itself reverts', async () => {
      const { accountId } = await createAccountFor(owner);
      await HubContract.removeContractByName('ServiceSubscriptions');
      await expect(coverCall(accountId, TRAC))
        .to.be.revertedWithCustomError(HubContract, 'ContractDoesNotExist')
        .withArgs('ServiceSubscriptions');
    });
  });

  // -------------------------------------------------------------------------
  // Refusals
  // -------------------------------------------------------------------------

  describe('refusals', () => {
    it('a value of 0 reverts ZeroServiceValue, before any other check', async () => {
      const { accountId } = await createAccountFor(owner);
      await expect(coverCall(accountId, 0n)).to.be.revertedWithCustomError(Logic, 'ZeroServiceValue');
      // Even with a treasury wired, for an account that does not exist.
      await Params.setProtocolTreasury(accounts[12].address);
      await expect(coverCall(424242n, 0n)).to.be.revertedWithCustomError(Logic, 'ZeroServiceValue');
    });

    it('a wired treasury pauses it with ServiceFundingPausedTreasuryWired, before the account is read', async () => {
      const { accountId } = await createAccountFor(owner);
      const treasury = accounts[12].address;
      await Params.setProtocolTreasury(treasury);
      for (const id of [accountId, 424242n]) {
        await expect(coverCall(id, TRAC))
          .to.be.revertedWithCustomError(Logic, 'ServiceFundingPausedTreasuryWired')
          .withArgs(treasury);
      }
      // Unwiring the treasury lifts the pause.
      await Params.setProtocolTreasury(ethers.ZeroAddress);
      await expect(coverCall(accountId, TRAC)).to.emit(Logic, 'ServiceCostCovered');
    });

    it('an unknown account reverts UnknownAccount', async () => {
      await expect(coverCall(424242n, TRAC))
        .to.be.revertedWithCustomError(PCS, 'UnknownAccount')
        .withArgs(424242n);
    });

    it('an expired account reverts AccountExpired', async () => {
      const { accountId } = await createAccountFor(owner);
      const acct = await PCS.getAccount(accountId);
      await time.increaseTo(acct.expiresAtTimestamp);
      await expect(coverCall(accountId, TRAC))
        .to.be.revertedWithCustomError(Logic, 'AccountExpired')
        .withArgs(accountId, acct.expiresAtEpoch);
    });

    it('a cost above the window allowance plus the top-up buffer reverts InsufficientAllowance, with no partial effect', async () => {
      const { accountId } = await createAccountFor(owner);
      const buffer = 100n * TRAC;
      await topUp(owner, accountId, buffer);
      const B = COMMITTED_TRAC / lock;

      // Part of the window is already spent.
      const first = await cover(accountId, 1_000n * TRAC);
      const spent = first.draw.cost;
      const available = B - spent + buffer;

      // A cost one wei above what is left.
      const value = valueFor(available + 1n);
      const cost = costOf(value, 2_000n);
      expect(cost).to.equal(available + 1n);
      const epoch = await ChronosContract.getCurrentEpoch();
      await expect(coverCall(accountId, value))
        .to.be.revertedWithCustomError(Logic, 'InsufficientAllowance')
        .withArgs(accountId, epoch, cost, available);

      expect(await PCS.windowSpent(accountId, 0n)).to.equal(spent);
      expect(await PCS.topUpBalance(accountId)).to.equal(buffer);

      // Exactly what is left still goes through.
      const exact = await cover(accountId, valueFor(available), ethers.id('subscription-2'));
      expect(exact.draw.cost).to.equal(available);
      expect(await PCS.topUpBalance(accountId)).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------
  // The draw
  // -------------------------------------------------------------------------

  describe('draw', () => {
    const TIERS: Array<[bigint, bigint]> = [
      [10_000n, 0n],
      [25_000n, 1_000n],
      [50_000n, 2_000n],
      [100_000n, 3_000n],
      [250_000n, 4_000n],
      [500_000n, 5_000n],
      [1_000_000n, 7_500n],
    ];

    it('at every discount tier: the cost, the draw, the event and windowSpent, with no TRAC moved and nothing emitted', async () => {
      const value = 10n * TRAC + 3n;
      const vaultAddress = await Vault.getAddress();
      for (const [committedTrac, bps] of TIERS) {
        const { accountId } = await createAccountFor(owner, committedTrac * TRAC);
        expect((await PCS.getAccount(accountId)).discountBps).to.equal(bps);
        const cost = costOf(value, bps);
        const vaultBefore = await Token.balanceOf(vaultAddress);
        const epoch = await ChronosContract.getCurrentEpoch();

        const { receipt, draw } = await cover(accountId, value);

        expect(draw.cost, `cost at ${bps} bps`).to.equal(cost);
        expect(draw.drawnFromWindow).to.equal(cost);
        expect(draw.drawnFromTopUp).to.equal(0n);
        expect(draw.window).to.equal(0n);
        expect(draw.epoch).to.equal(epoch);
        expect(draw.discountBps).to.equal(bps);
        expect(rangesOf(draw)).to.deep.equal([ZERO_RANGE, ZERO_RANGE, ZERO_RANGE]);

        await expect(receipt)
          .to.emit(Logic, 'ServiceCostCovered')
          .withArgs(accountId, assignee.address, SUBSCRIPTION_ID, value, cost, epoch, 0n, cost, 0n);

        expect(await PCS.windowSpent(accountId, 0n)).to.equal(cost);
        expect(await PCS.topUpBalance(accountId)).to.equal(0n);
        expect(await tokenLogCount(receipt)).to.equal(0);
        expect(await creditedRanges(receipt)).to.deep.equal([]);
        expect(await Token.balanceOf(vaultAddress)).to.equal(vaultBefore);
      }
    });

    it('the cost is floored at 1 wei when the discount rounds it to 0', async () => {
      const { accountId: tenPct } = await createAccountFor(owner, 25_000n * TRAC);
      expect((await cover(tenPct, 1n)).draw.cost).to.equal(1n);
      expect(await PCS.windowSpent(tenPct, 0n)).to.equal(1n);

      const { accountId: top } = await createAccountFor(owner, 1_000_000n * TRAC);
      // 3 wei at 7,500 bps is 0.75 wei before the floor.
      const { draw, receipt } = await cover(top, 3n);
      expect(draw.cost).to.equal(1n);
      expect(draw.drawnFromWindow).to.equal(1n);
      await expect(receipt).to.emit(Logic, 'ServiceCostCovered').withArgs(
        top,
        assignee.address,
        SUBSCRIPTION_ID,
        3n,
        1n,
        draw.epoch,
        0n,
        1n,
        0n,
      );
    });

    it('a base-only draw leaves every staker pool of the account span and the shard carry unchanged', async () => {
      const { accountId } = await createAccountFor(owner);
      const e0 = await ChronosContract.getCurrentEpoch();
      const from = e0;
      const to = e0 + 2n * lock + 3n;
      const before = await poolSnapshot(from, to);
      const carryBefore = await ES.accumulatedRemainder(STAKER_SHARD_ID);

      const B = COMMITTED_TRAC / lock;
      const { draw } = await cover(accountId, valueFor(B)); // the whole window, nothing more
      expect(draw.drawnFromWindow).to.equal(B);
      expect(draw.drawnFromTopUp).to.equal(0n);

      const after = await poolSnapshot(from, to);
      for (let e = from; e <= to; e++) expect(after.get(e), `epoch ${e}`).to.equal(before.get(e));
      expect(await ES.accumulatedRemainder(STAKER_SHARD_ID)).to.equal(carryBefore);
    });

    it('an overflow beyond the window draws the top-up buffer and emits it forward over the lock from the current epoch', async () => {
      const { accountId } = await createAccountFor(owner);
      const buffer = 1_000n * TRAC;
      await topUp(owner, accountId, buffer);

      const B = COMMITTED_TRAC / lock;
      const value = ((B + 500n * TRAC) * BPS) / 8_000n;
      const cost = costOf(value, 2_000n);
      const overflow = cost - B;

      const e0 = await ChronosContract.getCurrentEpoch();
      const from = e0;
      const to = e0 + lock + 2n;
      const before = await poolSnapshot(from, to);
      const carryBefore = await ES.accumulatedRemainder(STAKER_SHARD_ID);
      const vaultBefore = await Token.balanceOf(await Vault.getAddress());

      const { receipt, draw } = await cover(accountId, value);

      expect(draw.cost).to.equal(cost);
      expect(draw.drawnFromWindow).to.equal(B);
      expect(draw.drawnFromTopUp).to.equal(overflow);
      expect(draw.epoch).to.equal(e0);
      await expect(receipt)
        .to.emit(Logic, 'ServiceCostCovered')
        .withArgs(accountId, assignee.address, SUBSCRIPTION_ID, value, cost, e0, 0n, B, overflow);

      // The ranges are prorateActiveSink's from the current epoch, with the
      // time left in it at the transaction.
      const timeRemaining = (await ChronosContract.timestampForEpoch(e0 + 1n)) - (await blockTimestamp(receipt));
      const expected = prorateActiveSink(overflow, e0, lock, epLen, timeRemaining);
      const nonEmpty = rangesOf(draw).filter((r) => r[2] > 0n);
      expect(nonEmpty).to.deep.equal(expected.map((r) => [r.start, r.end, r.amount]));
      // Every slot the overflow did not use stays zero.
      for (const r of rangesOf(draw)) if (r[2] === 0n) expect(r).to.deep.equal(ZERO_RANGE);
      // The receipt credited exactly those ranges, and the pool moved by them.
      expect(await creditedRanges(receipt)).to.deep.equal(nonEmpty);
      const model = new PoolModel(carryBefore);
      for (const r of expected) model.add(r);
      const after = await poolSnapshot(from, to);
      for (let e = from; e <= to; e++) {
        expect((after.get(e) ?? 0n) - (before.get(e) ?? 0n), `epoch ${e}`).to.equal(model.perEpoch.get(e) ?? 0n);
      }

      expect(await PCS.windowSpent(accountId, 0n)).to.equal(B);
      expect(await PCS.topUpBalance(accountId)).to.equal(buffer - overflow);
      expect(await tokenLogCount(receipt)).to.equal(0);
      expect(await Token.balanceOf(await Vault.getAddress())).to.equal(vaultBefore);

      // With the window spent, the next draw comes from the buffer alone.
      const next = await cover(accountId, 100n * TRAC, ethers.id('subscription-2'));
      expect(next.draw.drawnFromWindow).to.equal(0n);
      expect(next.draw.drawnFromTopUp).to.equal(80n * TRAC);
      expect(await PCS.topUpBalance(accountId)).to.equal(buffer - overflow - 80n * TRAC);
    });

    it('in one block, a service draw and a publishing draw of the same overflow credit identical ranges', async () => {
      const agent = accounts[8];
      const { accountId: publishingId } = await createAccountFor(owner);
      const { accountId: serviceId } = await createAccountFor(owner);
      await topUp(owner, publishingId, 1_000n * TRAC);
      await topUp(owner, serviceId, 1_000n * TRAC);
      await NFT.connect(owner).registerAgent(publishingId, agent.address);

      const B = COMMITTED_TRAC / lock;
      const value = ((B + 500n * TRAC) * BPS) / 8_000n;
      const nft = await impersonatedNFT();
      const e0 = await ChronosContract.getCurrentEpoch();

      await hre.network.provider.send('evm_setAutomine', [false]);
      let publishTx;
      let serviceTx;
      try {
        publishTx = await Logic.connect(nft).coverPublishingCost(agent.address, value, e0, lock, {
          gasLimit: 5_000_000,
        });
        serviceTx = await Stub.cover(await Logic.getAddress(), serviceId, assignee.address, SUBSCRIPTION_ID, value, {
          gasLimit: 5_000_000,
        });
        await hre.network.provider.send('evm_mine', []);
      } finally {
        await hre.network.provider.send('evm_setAutomine', [true]);
      }
      const publishRc = (await publishTx.wait())!;
      const serviceRc = (await serviceTx.wait())!;
      expect(serviceRc.blockNumber).to.equal(publishRc.blockNumber);

      // The same discounted cost and the same split.
      const covered = publishRc.logs
        .map((l) => {
          try {
            return Logic.interface.parseLog({ topics: [...l.topics], data: l.data });
          } catch {
            return null;
          }
        })
        .find((p) => p?.name === 'CostCovered');
      const draw = await Stub.lastDraw();
      expect(draw.cost).to.equal(covered!.args.discountedCost);
      expect(draw.drawnFromWindow).to.equal(covered!.args.drawnFromEpoch);
      expect(draw.drawnFromTopUp).to.equal(covered!.args.drawnFromTopUp);
      expect(draw.drawnFromTopUp).to.be.greaterThan(0n);

      // The same staker-pool credits, range by range.
      const serviceRanges = await creditedRanges(serviceRc);
      expect(serviceRanges.length).to.be.greaterThan(0);
      expect(serviceRanges).to.deep.equal(await creditedRanges(publishRc));
      expect(rangesOf(draw).filter((r) => r[2] > 0n)).to.deep.equal(serviceRanges);
      expect(await PCS.windowSpent(serviceId, 0n)).to.equal(await PCS.windowSpent(publishingId, 0n));
      expect(await PCS.topUpBalance(serviceId)).to.equal(await PCS.topUpBalance(publishingId));
    });

    it('publishing and service draws share one window allowance, first come first served', async () => {
      const agent = accounts[8];
      const { accountId } = await createAccountFor(owner);
      await NFT.connect(owner).registerAgent(accountId, agent.address);
      const nft = await impersonatedNFT();
      const e0 = await ChronosContract.getCurrentEpoch();
      const B = COMMITTED_TRAC / lock;

      await Logic.connect(nft).coverPublishingCost(agent.address, 1_000n * TRAC, e0, lock); // 800 TRAC drawn
      const { draw } = await cover(accountId, 2_000n * TRAC); // 1,600 TRAC drawn
      expect(draw.drawnFromWindow).to.equal(1_600n * TRAC);
      await Logic.connect(nft).coverPublishingCost(agent.address, 500n * TRAC, e0, lock); // 400 TRAC drawn

      expect(await PCS.windowSpent(accountId, 0n)).to.equal(2_800n * TRAC);
      expect(await Logic.getRemainingAllowance(accountId, e0)).to.equal(B - 2_800n * TRAC);

      // Once services have spent the rest of the window, a publish finds no
      // allowance left (KnowledgeAssetsLifecycle then falls through to direct spend).
      const rest = B - 2_800n * TRAC;
      const last = await cover(accountId, valueFor(rest), ethers.id('subscription-2'));
      expect(last.draw.cost).to.equal(rest);
      await expect(Logic.connect(nft).coverPublishingCost(agent.address, 10n * TRAC, e0, lock))
        .to.be.revertedWithCustomError(Logic, 'InsufficientAllowance')
        .withArgs(accountId, e0, 8n * TRAC, 0n);
    });

    it('a later billing window draws its own allowance', async () => {
      const { accountId } = await createAccountFor(owner);
      const B = COMMITTED_TRAC / lock;
      await cover(accountId, valueFor(B)); // window 0 spent
      await time.increase(epLen);
      const { draw, receipt } = await cover(accountId, 100n * TRAC, ethers.id('subscription-2'));
      expect(draw.window).to.equal(1n);
      expect(draw.drawnFromWindow).to.equal(80n * TRAC);
      expect(await PCS.windowSpent(accountId, 1n)).to.equal(80n * TRAC);
      expect(await PCS.windowSpent(accountId, 0n)).to.equal(B);
      await expect(receipt)
        .to.emit(Logic, 'ServiceCostCovered')
        .withArgs(accountId, assignee.address, ethers.id('subscription-2'), 100n * TRAC, 80n * TRAC, draw.epoch, 1n, 80n * TRAC, 0n);
    });

    it('writes the schedule of an account created before 10.0.8 before it draws', async () => {
      // A synthetic pre-10.0.8 account, planted in storage by the Hub owner:
      // nothing scheduled yet, and a window-0 spend made under the old rules.
      const synthId = 777n;
      const committed = ethers.parseEther('12000') + 5n;
      const createdAt = BigInt(await time.latest()) - epLen / 3n;
      const createdEpoch = await ChronosContract.epochAtTimestamp(createdAt);
      const expiresAt = createdAt + lock * epLen;
      const expiresEpoch = (await ChronosContract.epochAtTimestamp(expiresAt - 1n)) + 1n;
      await PCS.createAccount(synthId, {
        committedTRAC: committed,
        createdAtEpoch: createdEpoch,
        expiresAtEpoch: expiresEpoch,
        createdAtTimestamp: createdAt,
        expiresAtTimestamp: expiresAt,
        lockDurationEpochs: lock,
        discountBps: 0,
        lastSettledWindow: 0,
        fullySwept: false,
        primaryNode: 0,
        lastPrimaryNodeChangeEpoch: createdEpoch,
      });
      const spent0 = ethers.parseEther('111');
      await PCS.increaseWindowSpent(synthId, 0n, spent0);

      const { receipt, draw } = await cover(synthId, 10n * TRAC);
      await expect(receipt)
        .to.emit(Logic, 'EmissionScheduled')
        .withArgs(synthId, 0n, lock, committed - spent0, 0n);
      expect((await PCS.getAccount(synthId)).lastSettledWindow).to.equal(lock);
      expect(draw.cost).to.equal(10n * TRAC);
      expect(await PCS.windowSpent(synthId, 0n)).to.equal(spent0 + 10n * TRAC);
    });
  });
});
