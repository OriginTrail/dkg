// Gas of Conviction Account service spending (OT-RFC-27): the opt-in, an
// assignment, a cap update and the fundings, each measured on the real account
// stack and held to its committed target. The targets are targets, not limits:
// a change that goes above one needs the figure reviewed and the target revised
// on purpose, in the same change.
//
// Every case but the two "later period" ones is measured cold: the first such
// transaction on its account, so each storage slot it writes goes from zero to
// non-zero. A funding writes one base label slot per epoch it labels, and a
// top-up funding a label slot in each of the `lock + 1` epochs its overflow
// emits in. The later-period cases fund an account's next period, after a
// first one, which is the usual funding.
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
import { BaseContract, ContractTransactionReceipt, Result } from 'ethers';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionServiceStorage,
  DKGPublishingConvictionNFT,
  Hub,
  ParametersStorage,
  PublishingConviction,
  PublishingConvictionStorage,
  ServiceSubscriptions,
  Token,
} from '../../typechain';
import {
  ACCOUNT_STACK_TAGS,
  CLASS_INFERENCE,
  DAY,
  TRAC,
  Terms,
  bucket,
  capsOf,
  registerServiceContracts,
  requestOf,
  setExactScheduleFrom,
  signTerms,
  valueFor,
  writeLegacyAccount,
} from '../helpers/conviction-service';
import { PoolModel, scheduleModel } from '../helpers/emission-model';

type Case = { target: bigint; measured: bigint; above?: true };

// The targets, and what this file measured against them.
const GAS: Record<string, Case> = {
  'setServiceSpending(…, true) on a scheduled account': { target: 120_000n, measured: 103_170n },
  // Above its target: the assignment's four slots, the nonce, and the
  // assignee's list entry, list length and membership flag are seven new slots.
  'assign, one EOA signature': { target: 250_000n, measured: 251_941n, above: true },
  updateAssignmentCaps: { target: 100_000n, measured: 89_411n },
  // Above its target: an account's first funding also creates its service
  // spend, usage, label total, cursor and period list.
  'fundFromConviction, one bucket, base only, labels within 3 epochs': {
    target: 700_000n,
    measured: 758_691n,
    above: true,
  },
  'the same on an account from before the cut-over, lock 12': { target: 900_000n, measured: 823_251n },
  // Above its target, as the first base-only funding is.
  'fundFromConviction, one bucket, with top-up overflow, lock 12': {
    target: 1_300_000n,
    measured: 1_328_911n,
    above: true,
  },
  'fundFromConviction, one bucket, with top-up overflow, lock 60': { target: 4_500_000n, measured: 3_656_045n },
  // The same fundings for a later period of an account that has funded one
  // before: the account's usage, label total, cursor and period list exist.
  'base only, labels within 3 epochs, a later period': { target: 700_000n, measured: 638_994n },
  'with top-up overflow, lock 12, a later period': { target: 1_300_000n, measured: 1_217_679n },
};

const ROUNDING = 5_000n;
/** What a case is held to: its target, or, above it, its measured figure rounded up. */
const limitOf = (c: Case): bigint =>
  c.above ? ((c.measured + ROUNDING - 1n) / ROUNDING) * ROUNDING : c.target;

const COMMITTED = 100_000n * TRAC + 11n; // the 30 % tier
const BPS = 3_000n;

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  Token: Token;
  Chronos: Chronos;
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
    Params: await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
    NFT: await hre.ethers.getContract<DKGPublishingConvictionNFT>('DKGPublishingConvictionNFT'),
    PC: await hre.ethers.getContract<PublishingConviction>('PublishingConviction'),
    PCS: await hre.ethers.getContract<PublishingConvictionStorage>('PublishingConvictionStorage'),
    CSS,
    SS,
  };
}

// Instrumented coverage runs say nothing about deployed gas.
const skipUnderCoverage = process.argv.some((a) => a.includes('coverage'));

describe('@gas Conviction Account service spending', () => {
  before(function () {
    if (skipUnderCoverage) this.skip();
  });

  let accounts: SignerWithAddress[];
  let HubContract: Hub;
  let Token: Token;
  let ChronosContract: Chronos;
  let Params: ParametersStorage;
  let NFT: DKGPublishingConvictionNFT;
  let PC: PublishingConviction;
  let PCS: PublishingConvictionStorage;
  let CSS: ConvictionServiceStorage;
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
      Hub: HubContract,
      Token,
      Chronos: ChronosContract,
      Params,
      NFT,
      PC,
      PCS,
      CSS,
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

  const createAccount = async (committed: bigint = COMMITTED) => {
    await Token.mint(owner.address, committed);
    await Token.connect(owner).approve(await NFT.getAddress(), committed);
    const receipt = (await (await NFT.connect(owner).createAccount(committed, 0)).wait())!;
    const createdAt = BigInt((await hre.ethers.provider.getBlock(receipt.blockNumber))!.timestamp);
    return { accountId: await NFT.totalSupply(), createdAt };
  };

  const termsFor = async (accountId: bigint, overrides: Partial<Terms> = {}): Promise<Terms> => ({
    accountId,
    assignee: buyer.address,
    maxCostPerPeriod: 50_000n * TRAC,
    maxInferenceCostPerPeriod: 50_000n * TRAC,
    maxQueryCostPerPeriod: 50_000n * TRAC,
    maxCostPerWindow: 0n,
    maxTotalCost: 1_000_000n * TRAC,
    maxPeriodSeconds: 31n * DAY,
    expiresAt: (await latest()) + 400n * DAY,
    nonce: await CSS.assignmentNonce(accountId),
    ...overrides,
  });

  const optInAndAssign = async (accountId: bigint) => {
    await SS.connect(owner).setServiceSpending(accountId, true);
    const terms = await termsFor(accountId);
    await SS.connect(owner).assign(terms, '0x', await signTerms(buyer, SS, terms));
    return terms;
  };

  /** A base-only cost that labels exactly three epochs, nearest first from `firstEpoch`. */
  const threeEpochCost = async (committed: bigint, createdAt: bigint, lock: bigint, spent?: Map<bigint, bigint>) => {
    const model = new PoolModel(0n);
    await scheduleModel({ chronos: ChronosContract, model, committed, createdAtTimestamp: createdAt, lock, epLen, spent });
    const first = await ChronosContract.epochAtTimestamp(createdAt + epLen);
    const S = (e: bigint) => model.perEpoch.get(e) ?? 0n;
    return S(first) + S(first + 1n) + S(first + 2n) / 2n;
  };

  const fundBase = async (accountId: bigint, cost: bigint) => {
    const r = requestOf(accountId, { buckets: [bucket(0, CLASS_INFERENCE, valueFor(cost, BPS))] });
    return (await (await SS.connect(buyer).fundFromConviction(r)).wait())!;
  };

  const expectThreeLabelledEpochs = async (receipt: ContractTransactionReceipt) => {
    const [label] = await eventsOf(receipt, SS, 'ServiceEmissionLabelled');
    expect(label.fromTopUp).to.equal(false);
    expect(label.toEpoch - label.fromEpoch).to.equal(2n);
  };

  /** From the contract's own views: a base-only cost that labels exactly three epochs from where labelling resumes. */
  const threeEpochCostNow = async (accountId: bigint) => {
    const [first] = await SS.emissionSpan(accountId);
    const cursor = await CSS.labelCursor(accountId);
    const current = await ChronosContract.getCurrentEpoch();
    let start = first;
    if (cursor > start) start = cursor;
    if (current > start) start = current;
    const free = async (e: bigint) => (await SS.scheduledEmission(accountId, e)) - (await CSS.baseLabel(accountId, e));
    return (await free(start)) + (await free(start + 1n)) + (await free(start + 2n)) / 2n;
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

  const expectOverflow = async (receipt: ContractTransactionReceipt, lock: bigint) => {
    const [covered] = await eventsOf(receipt, PC, 'ServiceCostCovered');
    expect([covered.drawnFromWindow, covered.drawnFromTopUp]).to.deep.equal([10n * TRAC, 490n * TRAC]);
    const topUp = (await eventsOf(receipt, SS, 'ServiceEmissionLabelled')).find((l) => l.fromTopUp)!;
    expect((topUp.toEpoch as bigint) - (topUp.fromEpoch as bigint) + 1n).to.equal(lock + 1n);
  };

  it('setServiceSpending(…, true) on a scheduled account', async () => {
    await setExactScheduleFrom(HubContract, CSS);
    const { accountId } = await createAccount();
    const receipt = (await (await SS.connect(owner).setServiceSpending(accountId, true)).wait())!;
    record('setServiceSpending(…, true) on a scheduled account', receipt);
  });

  it('assign, one EOA signature', async () => {
    await setExactScheduleFrom(HubContract, CSS);
    const { accountId } = await createAccount();
    await SS.connect(owner).setServiceSpending(accountId, true);
    const terms = await termsFor(accountId);
    const receipt = (await (await SS.connect(owner).assign(terms, '0x', await signTerms(buyer, SS, terms))).wait())!;
    record('assign, one EOA signature', receipt);
  });

  it('updateAssignmentCaps', async () => {
    await setExactScheduleFrom(HubContract, CSS);
    const { accountId } = await createAccount();
    const terms = await optInAndAssign(accountId);
    // Every limit changes.
    const caps = {
      ...capsOf(terms),
      maxCostPerPeriod: 25n * TRAC,
      maxInferenceCostPerPeriod: 20n * TRAC,
      maxQueryCostPerPeriod: 5n * TRAC,
      maxCostPerWindow: 100n * TRAC,
      maxTotalCost: 1_000n * TRAC,
      maxPeriodSeconds: 7n * DAY,
      expiresAt: terms.expiresAt - DAY,
    };
    const receipt = (await (await SS.connect(owner).updateAssignmentCaps(accountId, buyer.address, caps)).wait())!;
    record('updateAssignmentCaps', receipt);
  });

  it('fundFromConviction, one bucket, base only, labels within 3 epochs', async () => {
    await setExactScheduleFrom(HubContract, CSS);
    const { accountId, createdAt } = await createAccount();
    await optInAndAssign(accountId);
    const lock = await Params.publishingConvictionEpochs();
    const receipt = await fundBase(accountId, await threeEpochCost(COMMITTED, createdAt, lock));
    await expectThreeLabelledEpochs(receipt);
    record('fundFromConviction, one bucket, base only, labels within 3 epochs', receipt);
  });

  it('the same on an account from before the cut-over, lock 12', async () => {
    const lock = await Params.publishingConvictionEpochs();
    expect(lock).to.equal(12n);
    // An older account half a window old with some of window 0 spent; the
    // cut-over follows its creation, and its opt-in writes its schedule.
    const accountId = 5_000n;
    const createdAt = (await latest()) - epLen / 2n;
    const spent = new Map<bigint, bigint>([[0n, 1_000n * TRAC]]);
    await writeLegacyAccount({
      pcs: PCS,
      nft: NFT,
      chronosEpochAt: (ts) => ChronosContract.epochAtTimestamp(ts),
      accountId,
      owner: owner.address,
      committed: COMMITTED,
      createdAt,
      lock,
      epLen,
      discountBps: BPS,
      spent,
    });
    await setExactScheduleFrom(HubContract, CSS);
    await optInAndAssign(accountId);
    const receipt = await fundBase(accountId, await threeEpochCost(COMMITTED, createdAt, lock, spent));
    await expectThreeLabelledEpochs(receipt);
    record('the same on an account from before the cut-over, lock 12', receipt);
  });

  for (const [lockName, lock] of [
    ['lock 12', 12n],
    ['lock 60', 60n],
  ] as const) {
    const name = `fundFromConviction, one bucket, with top-up overflow, ${lockName}`;
    it(name, async () => {
      if ((await Params.publishingConvictionEpochs()) !== lock) await Params.setPublishingConvictionEpochs(lock);
      await setExactScheduleFrom(HubContract, CSS);
      const { accountId } = await createAccount();
      await optInAndAssign(accountId);
      // Publishing spends all but 10 TRAC of the window, and the owner tops up:
      // the funding is the account's first, and overflows into the buffer.
      await publishAllBut(accountId, lock, 10n * TRAC);
      await topUpBy(accountId, 1_000n * TRAC);

      const receipt = await fundBase(accountId, 500n * TRAC);
      await expectOverflow(receipt, lock);
      record(name, receipt);
    });
  }

  it('base only, labels within 3 epochs, a later period', async () => {
    await setExactScheduleFrom(HubContract, CSS);
    const { accountId, createdAt } = await createAccount();
    await optInAndAssign(accountId);
    await fundBase(accountId, 100n * TRAC);
    // The next period, in the next window.
    await time.increaseTo(createdAt + epLen + 60n);
    const receipt = await fundBase(accountId, await threeEpochCostNow(accountId));
    await expectThreeLabelledEpochs(receipt);
    record('base only, labels within 3 epochs, a later period', receipt);
  });

  it('with top-up overflow, lock 12, a later period', async () => {
    const lock = await Params.publishingConvictionEpochs();
    await setExactScheduleFrom(HubContract, CSS);
    const { accountId, createdAt } = await createAccount();
    await optInAndAssign(accountId);
    await fundBase(accountId, 100n * TRAC);
    await time.increaseTo(createdAt + epLen + 60n);
    await publishAllBut(accountId, lock, 10n * TRAC);
    await topUpBy(accountId, 1_000n * TRAC);
    const receipt = await fundBase(accountId, 500n * TRAC);
    await expectOverflow(receipt, lock);
    record('with top-up overflow, lock 12, a later period', receipt);
  });
});
