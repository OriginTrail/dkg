// The service labels of Conviction Account service spending (OT-RFC-27), as a
// property test: seeded random sequences of publishes, fundings, top-ups and
// time jumps over whole locks, on accounts scheduled at creation and on
// accounts from before the schedule cut-over.
//
// After every step, for every account and epoch:
//   - the base label is at most the account's scheduled emission in that epoch,
//     by the shared emission model: the exact schedule of an account scheduled
//     at creation, and for an older account the schedule its opt-in wrote, the
//     window budget less what was spent per window; for an older account the
//     label basis itself never exceeds that schedule either;
//   - the top-up label equals the top-up emission the service draws credited;
//   - the epoch's service label is the sum of the accounts' labels, and at most
//     its staker pool;
//   - conservation: an account's base and top-up labels sum to the costs of its
//     periods and to its label total, and its base labels to the service spend
//     of its windows; each period's two parts sum to its cost;
//   - the label cursor never moves back.
// At every funding: the labels start no earlier than the cursor, the current
// epoch and the span, and every epoch from that start to the last one labelled,
// that last one aside, is full (nearest first). Every funding the allowance
// covers is funded, so the label basis never runs out of capacity.
//
// The patterns: the whole window at the start of every window, at its end,
// only late in the lock, and random mixes. The lock is 12 epochs; with
// CA_LONG=1, a lock of 60 runs as well.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { BaseContract, ContractTransactionReceipt, Result } from 'ethers';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionServiceStorage,
  DKGPublishingConvictionNFT,
  EpochStorage,
  Hub,
  ParametersStorage,
  PublishingConviction,
  PublishingConvictionStorage,
  ServiceSubscriptions,
  Token,
} from '../typechain';
import {
  ACCOUNT_STACK_TAGS,
  CLASS_INFERENCE,
  DAY,
  TRAC,
  Terms,
  bucket,
  costOf,
  registerServiceContracts,
  requestOf,
  setExactScheduleFrom,
  signTerms,
  valueFor,
  writeLegacyAccount,
} from './helpers/conviction-service';
import { PoolModel, prorateActiveSink, scheduleModel } from './helpers/emission-model';

const STAKER_SHARD_ID = 1n;
const HUGE = 1n << 95n;
// Caps no sequence reaches: the property is about the allowance and the labels.
const CAPS: Partial<Terms> = {
  maxCostPerPeriod: HUGE,
  maxInferenceCostPerPeriod: HUGE,
  maxQueryCostPerPeriod: HUGE,
  maxCostPerWindow: 0n,
  maxTotalCost: HUGE,
  maxPeriodSeconds: 31n * DAY,
};
const LOCKS = process.env.CA_LONG === '1' ? [12n, 60n] : [12n];

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  Token: Token;
  Chronos: Chronos;
  ES: EpochStorage;
  Params: ParametersStorage;
  NFT: DKGPublishingConvictionNFT;
  PC: PublishingConviction;
  PCS: PublishingConvictionStorage;
  CSS: ConvictionServiceStorage;
  SS: ServiceSubscriptions;
};

async function deployFixture(): Promise<Fixture> {
  await hre.deployments.fixture(ACCOUNT_STACK_TAGS);
  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  const { CSS, SS } = await registerServiceContracts(Hub);
  return {
    accounts,
    Hub,
    Token: await hre.ethers.getContract<Token>('Token'),
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    ES: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
    Params: await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
    NFT: await hre.ethers.getContract<DKGPublishingConvictionNFT>('DKGPublishingConvictionNFT'),
    PC: await hre.ethers.getContract<PublishingConviction>('PublishingConviction'),
    PCS: await hre.ethers.getContract<PublishingConvictionStorage>('PublishingConvictionStorage'),
    CSS,
    SS,
  };
}

/** A small seeded PRNG (mulberry32), so every sequence replays exactly. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A pseudo-random amount in [0, max), with arbitrary low digits. */
const fractionOf = (rand: () => number, max: bigint): bigint =>
  max <= 0n ? 0n : (max * BigInt(Math.floor(rand() * 1_000_000_007))) / 1_000_000_007n;

type Tracked = {
  name: string;
  id: bigint;
  createdAt: bigint;
  expiresAt: bigint;
  bps: bigint;
  first: bigint;
  last: bigint;
  budget: bigint;
  /** The schedule the base labels must stay within, per epoch. */
  bound: Map<bigint, bigint>;
  /** The expected top-up labels, per epoch. */
  topUp: Map<bigint, bigint>;
  costs: bigint;
  cursor: bigint;
  agent: SignerWithAddress;
  legacy: boolean;
  fundings: number;
  /** Allowance an older account could not label: the rounding of its basis. */
  shortfall: bigint;
};

describe('@integration Conviction service labels: whole-lock property test', function () {
  let accounts: SignerWithAddress[];
  let HubContract: Hub;
  let Token: Token;
  let ChronosContract: Chronos;
  let ES: EpochStorage;
  let Params: ParametersStorage;
  let NFT: DKGPublishingConvictionNFT;
  let PC: PublishingConviction;
  let PCS: PublishingConvictionStorage;
  let CSS: ConvictionServiceStorage;
  let SS: ServiceSubscriptions;

  let epLen: bigint;
  let lock: bigint;
  let owner: SignerWithAddress;
  let buyer: SignerWithAddress;
  let nftSigner: SignerWithAddress;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      Hub: HubContract,
      Token,
      Chronos: ChronosContract,
      ES,
      Params,
      NFT,
      PC,
      PCS,
      CSS,
      SS,
    } = await loadFixture(deployFixture));
    epLen = await ChronosContract.epochLength();
    owner = accounts[20];
    buyer = accounts[21];
    const nftAddress = await NFT.getAddress();
    await hre.network.provider.send('hardhat_setBalance', [nftAddress, '0x1000000000000000000']);
    nftSigner = await hre.ethers.getImpersonatedSigner(nftAddress);
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const latest = async () => BigInt(await time.latest());
  const blockTime = async (receipt: ContractTransactionReceipt) =>
    BigInt((await hre.ethers.provider.getBlock(receipt.blockNumber))!.timestamp);
  const max = (...xs: bigint[]) => xs.reduce((a, b) => (a > b ? a : b));
  const min = (...xs: bigint[]) => xs.reduce((a, b) => (a < b ? a : b));

  const eventsOf = async (receipt: ContractTransactionReceipt, contract: BaseContract, name: string) => {
    const address = (await contract.getAddress()).toLowerCase();
    const out: Result[] = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== address) continue;
      const parsed = contract.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === name) out.push(parsed.args);
    }
    return out;
  };

  const timeLeftAt = async (ts: bigint) => epLen - ((ts - (await ChronosContract.startTime())) % epLen);

  const scheduleOf = async (committed: bigint, createdAt: bigint, spent?: Map<bigint, bigint>) => {
    const model = new PoolModel(0n);
    await scheduleModel({ chronos: ChronosContract, model, committed, createdAtTimestamp: createdAt, lock, epLen, spent });
    return model.perEpoch;
  };

  const assignBuyer = async (accountId: bigint) => {
    const terms: Terms = {
      accountId,
      assignee: buyer.address,
      maxCostPerPeriod: CAPS.maxCostPerPeriod!,
      maxInferenceCostPerPeriod: CAPS.maxInferenceCostPerPeriod!,
      maxQueryCostPerPeriod: CAPS.maxQueryCostPerPeriod!,
      maxCostPerWindow: CAPS.maxCostPerWindow!,
      maxTotalCost: CAPS.maxTotalCost!,
      maxPeriodSeconds: CAPS.maxPeriodSeconds!,
      expiresAt: (await latest()) + 10_000n * DAY,
      nonce: await CSS.assignmentNonce(accountId),
    };
    await SS.connect(owner).assign(terms, '0x', await signTerms(buyer, SS, terms));
  };

  const track = async (
    name: string,
    id: bigint,
    agent: SignerWithAddress,
    bound: Map<bigint, bigint>,
    legacy: boolean,
  ): Promise<Tracked> => {
    const acct = await PCS.getAccount(id);
    const [first, last] = await SS.emissionSpan(id);
    return {
      name,
      id,
      createdAt: acct.createdAtTimestamp,
      expiresAt: acct.expiresAtTimestamp,
      bps: acct.discountBps,
      first,
      last,
      budget: acct.committedTRAC / lock,
      bound,
      topUp: new Map(),
      costs: 0n,
      cursor: 0n,
      agent,
      legacy,
      fundings: 0,
      shortfall: 0n,
    };
  };

  /** An account scheduled at creation: opted in, the buyer assigned, `agent` its publishing agent. */
  const openExact = async (name: string, committed: bigint, agent: SignerWithAddress): Promise<Tracked> => {
    await Token.mint(owner.address, committed);
    await Token.connect(owner).approve(await NFT.getAddress(), committed);
    const receipt = (await (await NFT.connect(owner).createAccount(committed, 0)).wait())!;
    const id = await NFT.totalSupply();
    await SS.connect(owner).setServiceSpending(id, true);
    await assignBuyer(id);
    await NFT.connect(owner).registerAgent(id, agent.address);
    return track(name, id, agent, await scheduleOf(committed, await blockTime(receipt)), false);
  };

  /**
   * An account an older build created 2.5 windows ago, with random spends in
   * its first three windows and no schedule. Its opt-in, after the cut-over,
   * writes the schedule: the budget less what was spent, per window.
   */
  const writeLegacy = async (id: bigint, committed: bigint, rand: () => number) => {
    const createdAt = (await latest()) - (5n * epLen) / 2n;
    const budget = committed / lock;
    const spent = new Map<bigint, bigint>([
      [0n, fractionOf(rand, budget)],
      [1n, fractionOf(rand, budget)],
      [2n, fractionOf(rand, budget / 2n)],
    ]);
    await writeLegacyAccount({
      pcs: PCS,
      nft: NFT,
      chronosEpochAt: (ts) => ChronosContract.epochAtTimestamp(ts),
      accountId: id,
      owner: owner.address,
      committed,
      createdAt,
      lock,
      epLen,
      spent,
    });
    return { createdAt, spent };
  };

  const openLegacy = async (
    name: string,
    id: bigint,
    committed: bigint,
    written: { createdAt: bigint; spent: Map<bigint, bigint> },
    agent: SignerWithAddress,
  ): Promise<Tracked> => {
    await SS.connect(owner).setServiceSpending(id, true);
    await assignBuyer(id);
    await NFT.connect(owner).registerAgent(id, agent.address);
    return track(name, id, agent, await scheduleOf(committed, written.createdAt, written.spent), true);
  };

  const allowanceOf = async (a: Tracked) => {
    const [, baseRemaining, topUpBuffer, expired] = await SS.currentWindowAllowance(a.id);
    return { baseRemaining, topUpBuffer, expired };
  };

  /**
   * Fund `cost`, which the allowance covers, and check the funding and its
   * labels. The base label capacity must cover the part the window pays: for
   * an account scheduled at creation always, which is the property. For an
   * older account the basis rounds each window amount down to a multiple of
   * the lock, so draining its allowance to the last wei can leave fewer than
   * `lock` wei per window without capacity: the guard must then refuse exactly
   * that excess, with no partial effect, and the rest is funded.
   */
  const fundCost = async (a: Tracked, cost: bigint, where: string) => {
    if (cost === 0n) return;
    const { baseRemaining } = await allowanceOf(a);
    const basePart = cost < baseRemaining ? cost : baseRemaining;
    const capacity = await SS.baseLabelCapacity(a.id);
    if (basePart > capacity) {
      const short = basePart - capacity;
      expect(a.legacy, `${where}: ${a.name}, scheduled at creation, ran out of label capacity by ${short}`).to.equal(true);
      expect(short, `${where}: ${a.name} label shortfall`).to.be.lessThan(lock * lock);
      const value = valueFor(cost, a.bps);
      await expect(SS.connect(buyer).fundFromConviction(requestOf(a.id, { buckets: [bucket(0, CLASS_INFERENCE, value)] })))
        .to.be.revertedWithCustomError(SS, 'LabelCapacityExceeded')
        .withArgs(a.id, short);
      a.shortfall += short;
      cost -= short;
      if (cost === 0n) return;
    }
    const value = valueFor(cost, a.bps);
    expect(costOf(value, a.bps)).to.equal(cost);
    const cursorBefore = await CSS.labelCursor(a.id);
    const r = requestOf(a.id, { buckets: [bucket(0, CLASS_INFERENCE, value)] });

    let receipt: ContractTransactionReceipt;
    try {
      receipt = (await (await SS.connect(buyer).fundFromConviction(r)).wait())!;
    } catch (err) {
      throw new Error(`${where}: a funding of ${cost} on ${a.name}, which the allowance covers, was refused: ${err}`);
    }

    const [covered] = await eventsOf(receipt, PC, 'ServiceCostCovered');
    expect(covered.cost, where).to.equal(cost);
    expect(covered.drawnFromWindow + covered.drawnFromTopUp, where).to.equal(cost);
    const s = await CSS.getSubscription(await SS.subscriptionIdOf(buyer.address, r.periodId));
    expect(s.drawnFromWindow + s.drawnFromTopUp, where).to.equal(s.cost);
    expect(s.periodStart, where).to.equal(await blockTime(receipt));
    const epoch: bigint = covered.epoch;

    if (covered.drawnFromTopUp > 0n) {
      const ranges = prorateActiveSink(covered.drawnFromTopUp, epoch, lock, epLen, await timeLeftAt(await blockTime(receipt)));
      const credited = (await eventsOf(receipt, ES, 'TokensAddedToEpochRange'))
        .filter((x) => x.shardId === STAKER_SHARD_ID)
        .map((x) => [x.startEpoch, x.endEpoch, x.tokenAmount]);
      expect(credited, where).to.deep.equal(ranges.map((x) => [x.start, x.end, x.amount]));
      for (const range of ranges) {
        const per = range.amount / (range.end - range.start + 1n);
        for (let e = range.start; e <= range.end; e++) a.topUp.set(e, (a.topUp.get(e) ?? 0n) + per);
      }
    }

    if (covered.drawnFromWindow > 0n) {
      const [labelled] = (await eventsOf(receipt, SS, 'ServiceEmissionLabelled')).filter((x) => !x.fromTopUp);
      expect(labelled.amount, where).to.equal(covered.drawnFromWindow);
      const start = max(cursorBefore, epoch, a.first);
      expect(labelled.fromEpoch, where).to.be.at.least(start);
      // Nearest first: every epoch before the last one labelled is full.
      for (let e = start; e < labelled.toEpoch; e++) {
        expect(await CSS.baseLabel(a.id, e), `${where}: epoch ${e} before the last labelled`).to.be.at.least(
          await SS.scheduledEmission(a.id, e),
        );
      }
    }

    a.costs += cost;
    a.fundings += 1;
  };

  /** Publish so that the account's allowance pays exactly `drawn`. */
  const publishCost = async (a: Tracked, drawn: bigint) => {
    if (drawn === 0n) return;
    await PC.connect(nftSigner).coverPublishingCost(
      a.agent.address,
      valueFor(drawn, a.bps),
      await ChronosContract.getCurrentEpoch(),
      lock,
    );
  };

  const topUpBy = async (a: Tracked, amount: bigint) => {
    if (amount === 0n) return;
    await Token.mint(owner.address, amount);
    await Token.connect(owner).approve(await NFT.getAddress(), amount);
    await NFT.connect(owner).topUp(a.id, amount);
  };

  /** Every invariant, for every tracked account and every epoch they emit in. */
  const check = async (all: Tracked[], where: string) => {
    const from = min(...all.map((a) => a.first)) - 1n;
    const to = max(...all.map((a) => a.last)) + 1n;
    const epochs: bigint[] = [];
    for (let e = from; e <= to; e++) epochs.push(e);
    const perEpoch = new Map<bigint, bigint>();

    for (const a of all) {
      const labels = await Promise.all(epochs.map((e) => CSS.accountLabel(a.id, e)));
      let base = 0n;
      let top = 0n;
      labels.forEach(([b, t], i) => {
        const e = epochs[i];
        expect(b, `${where}: ${a.name} base label in epoch ${e}`).to.be.at.most(a.bound.get(e) ?? 0n);
        expect(t, `${where}: ${a.name} top-up label in epoch ${e}`).to.equal(a.topUp.get(e) ?? 0n);
        perEpoch.set(e, (perEpoch.get(e) ?? 0n) + b + t);
        base += b;
        top += t;
      });
      if (a.legacy) {
        const basis = await Promise.all(epochs.map((e) => SS.scheduledEmission(a.id, e)));
        basis.forEach((s, i) => {
          expect(s, `${where}: ${a.name} label basis in epoch ${epochs[i]}`).to.be.at.most(a.bound.get(epochs[i]) ?? 0n);
        });
      }
      expect(base + top, `${where}: ${a.name} labels against its costs`).to.equal(a.costs);
      expect(await CSS.accountServiceLabelTotal(a.id), `${where}: ${a.name} label total`).to.equal(a.costs);
      const windows: bigint[] = [];
      for (let w = 0n; w < lock; w++) windows.push(w);
      const serviced = (await Promise.all(windows.map((w) => CSS.serviceSpent(a.id, w)))).reduce((x, y) => x + y, 0n);
      expect(base, `${where}: ${a.name} base labels against its service spend`).to.equal(serviced);
      const cursor = await CSS.labelCursor(a.id);
      expect(cursor, `${where}: ${a.name} cursor`).to.be.at.least(a.cursor);
      a.cursor = cursor;
    }

    const [labels, pools] = await Promise.all([
      Promise.all(epochs.map((e) => CSS.serviceLabel(e))),
      Promise.all(epochs.map((e) => ES.getEpochPool(STAKER_SHARD_ID, e))),
    ]);
    epochs.forEach((e, i) => {
      expect(labels[i], `${where}: service label of epoch ${e}`).to.equal(perEpoch.get(e) ?? 0n);
      expect(labels[i], `${where}: service label of epoch ${e} against its pool`).to.be.at.most(pools[i]);
    });
  };

  /** After the lock: no funding, and the labels stand. */
  const finish = async (all: Tracked[], where: string) => {
    const end = max(...all.map((a) => a.expiresAt));
    if (end > (await latest())) await time.increaseTo(end);
    for (const a of all) {
      const acct = await PCS.getAccount(a.id);
      await expect(SS.connect(buyer).fundFromConviction(requestOf(a.id)))
        .to.be.revertedWithCustomError(SS, 'AccountExpired')
        .withArgs(a.id, acct.expiresAtEpoch);
      expect(a.fundings, `${where}: ${a.name} fundings`).to.be.greaterThan(0);
      expect(a.shortfall, `${where}: ${a.name} label shortfall over the lock`).to.be.lessThan(lock * lock);
    }
    await check(all, `${where}, after the lock`);
  };

  // -------------------------------------------------------------------------
  // The sequences
  // -------------------------------------------------------------------------

  /** The whole window allowance in each window: at its start, at its end, or only late in the lock. */
  const windowPattern = async (pattern: 'start' | 'end' | 'late', seed: number) => {
    const rand = prng(seed);
    // Create the account at a pseudo-random time of the epoch.
    await time.increase(BigInt(Math.floor(rand() * Number(epLen))));
    await setExactScheduleFrom(HubContract, CSS);
    const a = await openExact('the account', 100_000n * TRAC + 11n, accounts[30]);
    await check([a], 'opened');
    for (let w = 0n; w < lock; w++) {
      const where = `window ${w}`;
      if (pattern === 'late' && w < (2n * lock) / 3n) {
        // An idle window still spends some allowance on publishing.
        await publishCost(a, fractionOf(rand, a.budget / 4n));
      } else {
        const at = pattern === 'end' ? a.createdAt + (w + 1n) * epLen - 3_600n : a.createdAt + w * epLen + 60n;
        if (at > (await latest())) await time.increaseTo(at);
        if (w % 3n === 1n) await topUpBy(a, fractionOf(rand, a.budget));
        const { baseRemaining, topUpBuffer } = await allowanceOf(a);
        await fundCost(a, baseRemaining, where);
        await check([a], `${where}, the window funded`);
        if (topUpBuffer > 0n) {
          await fundCost(a, topUpBuffer, `${where}, the top-up`);
        }
      }
      await check([a], where);
      await time.increaseTo(a.createdAt + (w + 1n) * epLen + 1n);
    }
    await finish([a], pattern);
  };

  /** Random publishes, fundings, top-ups and time jumps on two accounts whose spans overlap. */
  const randomMix = async (seed: number, withLegacy: boolean) => {
    const rand = prng(seed);
    const all: Tracked[] = [];
    if (withLegacy) {
      // An older account, then the cut-over, then its opt-in (which writes its schedule).
      await time.increase(3n * epLen + BigInt(Math.floor(rand() * Number(epLen))));
      const committed = 60_000n * TRAC + 7n;
      const written = await writeLegacy(7_000n + BigInt(seed), committed, rand);
      await setExactScheduleFrom(HubContract, CSS);
      all.push(await openLegacy('the older account', 7_000n + BigInt(seed), committed, written, accounts[31]));
    } else {
      await time.increase(BigInt(Math.floor(rand() * Number(epLen))));
      await setExactScheduleFrom(HubContract, CSS);
    }
    all.push(await openExact('the 30 % account', 100_000n * TRAC + 11n, accounts[32]));
    await time.increase(BigInt(Math.floor(rand() * Number(epLen))));
    all.push(await openExact('the account without discount', 12_000n * TRAC + 5n, accounts[33]));
    await check(all, 'opened');

    let step = 0;
    let olderWindow = -1n;
    while ((await latest()) < max(...all.map((x) => x.expiresAt))) {
      step += 1;
      const where = `step ${step}`;
      const live = [];
      for (const x of all) if (!(await allowanceOf(x)).expired) live.push(x);

      // When an older account enters a window, it usually first publishes just
      // enough to take that window's amount below the next lower multiple of
      // the lock: the case in which the window's final credit would grow if
      // the basis did not round.
      const older = live.find((x) => x.legacy);
      if (older) {
        const [w] = await SS.currentWindowAllowance(older.id);
        if (w !== olderWindow) {
          olderWindow = w;
          if (rand() < 0.7) {
            const published = (await PCS.windowSpent(older.id, w)) - (await CSS.serviceSpent(older.id, w));
            const amount = older.budget > published ? older.budget - published : 0n;
            if (amount > lock) {
              await publishCost(older, (amount % lock) + 1n);
              await check(all, `${where}, a publish across a multiple of the lock`);
            }
          }
        }
      }
      const pick = rand();
      if (live.length === 0 || pick < 0.35) {
        await time.increase(BigInt(Math.floor(rand() * Number(epLen))) + 1n);
        continue;
      }
      // An older account, while live, takes half of the actions: its basis is the one that moves.
      const a = older && rand() < 0.5 ? older : live[Math.floor(rand() * live.length)];
      const { baseRemaining, topUpBuffer } = await allowanceOf(a);
      const available = baseRemaining + topUpBuffer;
      if (pick < 0.7) {
        // Fund a part of what is left, or all of it.
        const cost = rand() < 0.2 ? available : fractionOf(rand, available) + 1n;
        if (available > 0n) await fundCost(a, cost > available ? available : cost, `${where}, a funding`);
      } else if (pick < 0.88) {
        // Now and then a publish of a few wei.
        const drawn = rand() < 0.3 ? fractionOf(rand, 2n * lock) + 1n : fractionOf(rand, available);
        await publishCost(a, drawn > available ? available : drawn);
      } else {
        await topUpBy(a, fractionOf(rand, a.budget / 2n));
      }
      await check(all, where);
    }
    await finish(all, `seed ${seed}`);
  };

  for (const L of LOCKS) {
    describe(`a lock of ${L} epochs`, function () {
      // A lock of 60 checks five times the epochs over five times the windows.
      if (L > 12n) this.timeout(30 * 60_000);

      beforeEach(async () => {
        lock = L;
        if (L !== (await Params.publishingConvictionEpochs())) await Params.setPublishingConvictionEpochs(L);
      });

      it('the whole window at the start of every window', async () => {
        await windowPattern('start', 11);
      });

      it('the whole window at the end of every window', async () => {
        await windowPattern('end', 12);
      });

      it('the whole window, only late in the lock', async () => {
        await windowPattern('late', 13);
      });

      const seeds = L === 12n ? [1, 2] : [1];
      for (const seed of seeds) {
        it(`random publishes, fundings, top-ups and time jumps, seed ${seed}`, async () => {
          await randomMix(seed, false);
        });
      }

      const legacySeeds = L === 12n ? [3, 4] : [3];
      for (const seed of legacySeeds) {
        it(`random activity with an account from before the cut-over, seed ${seed}`, async () => {
          await randomMix(seed, true);
        });
      }
    });
  }

  it('an older account whose window publishing lowers below a multiple of the lock never counts more than its schedule', async () => {
    lock = await Params.publishingConvictionEpochs();
    // A window budget divisible by the lock, scheduled whole at the opt-in:
    // each window's final credit holds no remainder. One wei of publishing
    // then leaves the largest remainder there is, lock − 1.
    await time.increase(3n * epLen);
    const committed = 1_200n * TRAC * lock;
    const id = 6_000n;
    const written = { createdAt: (await latest()) - epLen / 2n, spent: new Map<bigint, bigint>() };
    await writeLegacyAccount({
      pcs: PCS,
      nft: NFT,
      chronosEpochAt: (ts) => ChronosContract.epochAtTimestamp(ts),
      accountId: id,
      owner: owner.address,
      committed,
      createdAt: written.createdAt,
      lock,
      epLen,
    });
    await setExactScheduleFrom(HubContract, CSS);
    const a = await openLegacy('the older account', id, committed, written, accounts[34]);
    expect(a.budget % lock).to.equal(0n);
    await publishCost(a, 1n);
    expect(await PCS.windowSpent(id, 0n)).to.equal(1n);

    // The label basis stays within the schedule in every epoch, the final
    // credit of window 0 included.
    const finalOfWindow0 = a.first + lock;
    expect(await SS.scheduledEmission(id, finalOfWindow0)).to.be.at.most(a.bound.get(finalOfWindow0)!);
    await check([a], 'after the publish');

    // Fund the whole allowance, so the labels reach the final epochs too. The
    // rounding of window 0 leaves lock − 1 wei of it without capacity, and the
    // guard refuses exactly that much, at the end.
    let { baseRemaining } = await allowanceOf(a);
    await fundCost(a, baseRemaining, 'window 0');
    for (let w = 1n; w < lock; w++) {
      await time.increaseTo(a.createdAt + w * epLen + 60n);
      ({ baseRemaining } = await allowanceOf(a));
      await fundCost(a, baseRemaining, `window ${w}`);
      await check([a], `window ${w}`);
    }
    expect(a.shortfall).to.equal(lock - 1n);
    expect(await CSS.baseLabel(id, finalOfWindow0)).to.be.at.most(a.bound.get(finalOfWindow0)!);
    await finish([a], 'the older account');
  });
});
