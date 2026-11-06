// Gas of Conviction Account service spending (OT-RFC-27): the opt-in, a
// grant, a limit update, the fundings and a top-up, each measured on the
// real account stack and held to its committed target. The targets are
// targets, not limits: a change that goes above one needs the figure explained
// and the target revised on purpose, in the same change.
//
// A funding spends the cost from the account's allowance through
// PublishingConviction.coverServiceCost and books it under the subscription's epoch
// in QueryInferenceStorage (10.2.0, ServiceSubscriptions 1.2.0): the same slots
// whatever the lock, and nothing in the staker pool. A funding is the
// account's first touch of a billing window that has closed books that window
// on the way, so the later-subscription cases are measured both within the first
// window and after it has closed.
//
// `measured` is the gas the transaction used when this file was written
// (Hardhat, the repository's compiler settings); the test prints the current
// figures beside it. A case measured above its target is held to that figure,
// rounded up to the next 5,000 gas, instead, and marked `above: true`: its
// target has not been met, and is to be revised, or the cost brought down,
// deliberately.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ContractTransactionReceipt } from 'ethers';
import hre from 'hardhat';

import {
  Chronos,
  ServiceSubscriptionsStorage,
  DKGPublishingConvictionNFT,
  ParametersStorage,
  PublishingConviction,
  PublishingConvictionStorage,
  QueryInferenceStorage,
  ServiceSubscriptions,
  Token,
} from '../../typechain';
import { deployAccountStack, eventsOf } from '../helpers/account-stack';
import {
  CLASS_INFERENCE,
  DAY,
  TRAC,
  Terms,
  budget,
  limitsOf,
  registerServiceContracts,
  requestOf,
  signTerms,
  subscriptionIdOf,
  valueFor,
} from '../helpers/conviction-service';

type Case = { target: bigint; measured: bigint; above?: true };

// The targets, and what this file measured against them.
const GAS: Record<string, Case> = {
  'setServiceSpending(…, true) on a use-time account': { target: 120_000n, measured: 103_378n },
  // A grant is one limit and an expiry: two slots, the nonce, and the
  // buyer's list entry, list length and membership flag.
  'addBuyer, one EOA signature': { target: 250_000n, measured: 219_935n },
  setBuyerLimits: { target: 100_000n, measured: 71_492n },
  // An account's first funding also creates its usage and subscription list, and
  // the epoch's funding slot.
  'fundFromAccount, one budget, base only, first subscription': { target: 600_000n, measured: 519_903n },
  'fundFromAccount, one budget, with top-up overflow': { target: 600_000n, measured: 511_742n },
  // A later subscription of an account that has funded one before: the usage and the
  // subscription list exist, and the funding slot of the subscription's epoch is new.
  'fundFromAccount, a later subscription, same window': { target: 500_000n, measured: 468_603n },
  // The same once the first window has closed: the funding books it, three
  // staker-pool ranges forward from its close, and the shard finalizes the
  // epochs since its last credit.
  'fundFromAccount, a later subscription, one window closed': { target: 700_000n, measured: 662_306n },
  'topUpFromAccount, one stored budget': { target: 300_000n, measured: 231_914n },
};

const ROUNDING = 5_000n;
/** What a case is held to: its target, or, above it, its measured figure rounded up. */
const limitOf = (c: Case): bigint =>
  c.above ? ((c.measured + ROUNDING - 1n) / ROUNDING) * ROUNDING : c.target;

const COMMITTED = 100_000n * TRAC + 11n; // the 30 % tier
const BPS = 3_000n;

async function deployFixture() {
  const stack = await deployAccountStack();
  const { QIS, SSS, SS } = await registerServiceContracts(stack.Hub);
  return { ...stack, QIS, SSS, SS };
}

// Instrumented coverage runs say nothing about deployed gas.
const skipUnderCoverage = process.argv.some((a) => a.includes('coverage'));

describe('@gas Conviction Account service spending', () => {
  before(function () {
    if (skipUnderCoverage) this.skip();
  });

  let accounts: SignerWithAddress[];
  let Token: Token;
  let ChronosContract: Chronos;
  let Params: ParametersStorage;
  let NFT: DKGPublishingConvictionNFT;
  let PC: PublishingConviction;
  let PCS: PublishingConvictionStorage;
  let QIS: QueryInferenceStorage;
  let SSS: ServiceSubscriptionsStorage;
  let SS: ServiceSubscriptions;
  let owner: SignerWithAddress;
  let buyer: SignerWithAddress;
  let agent: SignerWithAddress;
  let epLen: bigint;
  const measured: Array<[string, bigint]> = [];

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      Token,
      Chronos: ChronosContract,
      Params,
      NFT,
      PC,
      PCS,
      QIS,
      SSS,
      SS,
    } = await loadFixture(deployFixture));
    owner = accounts[20];
    buyer = accounts[21];
    agent = accounts[22];
    epLen = await ChronosContract.epochLength();
  });

  after(() => {
    const rows = measured.map(([name, gas]) => ({
      case: name,
      gas: Number(gas),
      measured: Number(GAS[name].measured),
      target: Number(GAS[name].target),
      'held to': Number(limitOf(GAS[name])),
    }));
    console.table(rows);
  });

  it('marks exactly the cases measured above their target', () => {
    for (const [name, c] of Object.entries(GAS)) {
      expect(c.above === true, name).to.equal(c.measured > c.target);
    }
  });

  const latest = async () => BigInt(await time.latest());

  const record = (name: string, receipt: ContractTransactionReceipt) => {
    const gas = receipt.gasUsed;
    measured.push([name, gas]);
    const limit = limitOf(GAS[name]);
    expect(gas, `${name}: ${gas} gas against ${limit} (target ${GAS[name].target})`).to.be.at.most(limit);
  };

  const createAccount = async (committed: bigint = COMMITTED) => {
    await Token.mint(owner.address, committed);
    await Token.connect(owner).approve(await NFT.getAddress(), committed);
    const receipt = (await (await NFT.connect(owner).createAccount(committed, 0)).wait())!;
    const createdAt = BigInt((await hre.ethers.provider.getBlock(receipt.blockNumber))!.timestamp);
    return { accountId: await NFT.totalSupply(), createdAt };
  };

  const termsFor = async (accountId: bigint, overrides: Partial<Terms> = {}): Promise<Terms> => ({
    accountId,
    buyer: buyer.address,
    maxCostPerEpoch: 50_000n * TRAC,
    expiresAt: (await latest()) + 400n * DAY,
    nonce: await SSS.grantNonce(accountId),
    ...overrides,
  });

  const optInAndAddBuyer = async (accountId: bigint) => {
    await SS.connect(owner).setServiceSpending(accountId, true);
    const terms = await termsFor(accountId);
    await SS.connect(owner).addBuyer(terms, '0x', await signTerms(buyer, SS, terms));
    return terms;
  };

  /** Fund the subscription of `epoch` (the current one by default): one per buyer and epoch. */
  const fundBase = async (accountId: bigint, cost: bigint, epoch?: bigint) => {
    const r = requestOf(accountId, epoch ?? (await ChronosContract.getCurrentEpoch()), {
      budgets: [budget(0, CLASS_INFERENCE, valueFor(cost, BPS))],
    });
    return (await (await SS.connect(buyer).fundFromAccount(r)).wait())!;
  };

  /** The transaction spent `cost` and booked it under its subscription's epoch, which then holds `total`. */
  const expectBooked = async (receipt: ContractTransactionReceipt, cost: bigint, epoch: bigint, total = cost) => {
    const [covered] = await eventsOf(receipt, PC, 'ServiceCostCovered');
    expect(covered.cost).to.equal(cost);
    expect(await QIS.accountFunding(epoch)).to.equal(total);
  };

  /** Publishing spends all but `left` of the current window, through the account's agent. */
  const publishAllBut = async (accountId: bigint, lock: bigint, left: bigint) => {
    if ((await PCS.agentToAccountId(agent.address)) !== accountId) {
      await NFT.connect(owner).registerAgent(accountId, agent.address);
    }
    const nftAddress = await NFT.getAddress();
    await hre.network.provider.send('hardhat_setBalance', [nftAddress, '0x1000000000000000000']);
    const nft = await hre.ethers.getImpersonatedSigner(nftAddress);
    const [, baseRemaining] = await SS.currentWindowAllowance(accountId);
    await PC.connect(nft).coverPublishingCost(
      agent.address,
      valueFor(baseRemaining - left, BPS),
      await ChronosContract.getCurrentEpoch(),
      lock,
    );
  };

  const topUpBy = async (accountId: bigint, amount: bigint) => {
    await Token.mint(owner.address, amount);
    await Token.connect(owner).approve(await NFT.getAddress(), amount);
    await NFT.connect(owner).topUp(accountId, amount);
  };

  it('setServiceSpending(…, true) on a use-time account', async () => {
    const { accountId } = await createAccount();
    const receipt = (await (await SS.connect(owner).setServiceSpending(accountId, true)).wait())!;
    record('setServiceSpending(…, true) on a use-time account', receipt);
  });

  it('addBuyer, one EOA signature', async () => {
    const { accountId } = await createAccount();
    await SS.connect(owner).setServiceSpending(accountId, true);
    const terms = await termsFor(accountId);
    const receipt = (await (await SS.connect(owner).addBuyer(terms, '0x', await signTerms(buyer, SS, terms))).wait())!;
    record('addBuyer, one EOA signature', receipt);
  });

  it('setBuyerLimits', async () => {
    const { accountId } = await createAccount();
    const terms = await optInAndAddBuyer(accountId);
    // Both limits change.
    const limits = { ...limitsOf(terms), maxCostPerEpoch: 25n * TRAC, expiresAt: terms.expiresAt - DAY };
    const receipt = (await (await SS.connect(owner).setBuyerLimits(accountId, buyer.address, limits)).wait())!;
    record('setBuyerLimits', receipt);
  });

  it('fundFromAccount, one budget, base only, first subscription', async () => {
    const { accountId } = await createAccount();
    await optInAndAddBuyer(accountId);
    const epoch = await ChronosContract.getCurrentEpoch();
    const receipt = await fundBase(accountId, 100n * TRAC);
    await expectBooked(receipt, 100n * TRAC, epoch);
    record('fundFromAccount, one budget, base only, first subscription', receipt);
  });

  it('fundFromAccount, one budget, with top-up overflow', async () => {
    const lock = await Params.publishingConvictionEpochs();
    const { accountId } = await createAccount();
    await optInAndAddBuyer(accountId);
    // Publishing spends all but 10 TRAC of the window, and the owner tops up:
    // the funding is the account's first, and overflows into the buffer.
    await publishAllBut(accountId, lock, 10n * TRAC);
    await topUpBy(accountId, 1_000n * TRAC);
    const epoch = await ChronosContract.getCurrentEpoch();
    const receipt = await fundBase(accountId, 500n * TRAC);
    const [covered] = await eventsOf(receipt, PC, 'ServiceCostCovered');
    expect([covered.spentFromWindow, covered.spentFromTopUp]).to.deep.equal([10n * TRAC, 490n * TRAC]);
    await expectBooked(receipt, 500n * TRAC, epoch);
    record('fundFromAccount, one budget, with top-up overflow', receipt);
  });

  it('fundFromAccount, a later subscription, same window', async () => {
    const { accountId } = await createAccount();
    await optInAndAddBuyer(accountId);
    const epoch = await ChronosContract.getCurrentEpoch();
    await fundBase(accountId, 100n * TRAC, epoch + 1n);
    // The current epoch's subscription, after the next one's: each books under its
    // own epoch, and no window has closed.
    const receipt = await fundBase(accountId, 100n * TRAC);
    await expectBooked(receipt, 100n * TRAC, epoch);
    expect(await QIS.accountFunding(epoch + 1n)).to.equal(100n * TRAC);
    expect(await eventsOf(receipt, PC, 'EmissionScheduled')).to.have.length(0);
    record('fundFromAccount, a later subscription, same window', receipt);
  });

  it('fundFromAccount, a later subscription, one window closed', async () => {
    const { accountId, createdAt } = await createAccount();
    await optInAndAddBuyer(accountId);
    await fundBase(accountId, 100n * TRAC);
    // The next subscription, in the next window and the next epoch: the funding
    // books window 0 first.
    await time.increaseTo(createdAt + epLen + 60n);
    const epoch = await ChronosContract.getCurrentEpoch();
    const receipt = await fundBase(accountId, 100n * TRAC);
    const [booked] = await eventsOf(receipt, PC, 'EmissionScheduled');
    expect([booked.fromWindow, booked.toWindow]).to.deep.equal([0n, 1n]);
    await expectBooked(receipt, 100n * TRAC, epoch);
    record('fundFromAccount, a later subscription, one window closed', receipt);
  });

  it('topUpFromAccount, one stored budget', async () => {
    const { accountId } = await createAccount();
    await optInAndAddBuyer(accountId);
    const epoch = await ChronosContract.getCurrentEpoch();
    await fundBase(accountId, 100n * TRAC);
    const subscriptionId = subscriptionIdOf(buyer.address, epoch);
    const receipt = (await (
      await SS.connect(buyer).topUpFromAccount(
        subscriptionId,
        [budget(0, CLASS_INFERENCE, valueFor(50n * TRAC, BPS))],
        hre.ethers.id('plan-2'),
      )
    ).wait())!;
    await expectBooked(receipt, 50n * TRAC, epoch, 150n * TRAC);
    record('topUpFromAccount, one stored budget', receipt);
  });
});
