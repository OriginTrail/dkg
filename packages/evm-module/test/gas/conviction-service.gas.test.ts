// Gas of Conviction Account service spending (OT-RFC-27): the opt-in, an
// assignment, a cap update, the fundings and a top-up, each measured on the
// real account stack and held to its committed target. The targets are
// targets, not limits: a change that goes above one needs the figure reviewed
// and the target revised on purpose, in the same change.
//
// A funding draws the cost from the account's allowance through
// PublishingConviction.coverServiceCost and books it as due in
// QueryInferenceStorage (10.2.0, ServiceSubscriptions 1.2.0): the same slots
// whatever the lock, and nothing in the staker pool. A funding is the
// account's first touch of a billing window that has closed books that window
// on the way, so the later-period cases are measured both within the first
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
  QueryInferenceStorage,
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
  signTerms,
  subscriptionIdOf,
  valueFor,
} from '../helpers/conviction-service';

type Case = { target: bigint; measured: bigint; above?: true };

// The targets, and what this file measured against them.
const GAS: Record<string, Case> = {
  'setServiceSpending(…, true) on a use-time account': { target: 120_000n, measured: 101_856n },
  // An assignment is one limit and an expiry: two slots, the nonce, and the
  // assignee's list entry, list length and membership flag.
  'assign, one EOA signature': { target: 250_000n, measured: 197_696n },
  updateAssignmentCaps: { target: 100_000n, measured: 71_203n },
  // An account's first funding also creates its usage and period list, and
  // the epoch's due slot.
  'fundFromConviction, one bucket, base only, first period': { target: 600_000n, measured: 516_386n },
  'fundFromConviction, one bucket, with top-up overflow': { target: 600_000n, measured: 508_225n },
  // A later period of an account that has funded one before: the usage, the
  // period list and the epoch's due slot exist.
  'fundFromConviction, a later period, same window': { target: 500_000n, measured: 465_086n },
  // The same once the first window has closed: the funding books it, three
  // staker-pool ranges forward from its close, and the shard finalizes the
  // epochs since its last credit.
  'fundFromConviction, a later period, one window closed': { target: 700_000n, measured: 657_852n },
  'topUpFromConviction, one stored bucket': { target: 300_000n, measured: 205_488n },
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
  QIS: QueryInferenceStorage;
  CSS: ConvictionServiceStorage;
  SS: ServiceSubscriptions;
};

async function deployFixture(): Promise<Fixture> {
  await hre.deployments.fixture(ACCOUNT_STACK_TAGS);
  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  const { QIS, CSS, SS } = await registerServiceContracts(Hub);
  return {
    accounts,
    Hub,
    Token: await hre.ethers.getContract<Token>('Token'),
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    Params: await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
    NFT: await hre.ethers.getContract<DKGPublishingConvictionNFT>('DKGPublishingConvictionNFT'),
    PC: await hre.ethers.getContract<PublishingConviction>('PublishingConviction'),
    PCS: await hre.ethers.getContract<PublishingConvictionStorage>('PublishingConvictionStorage'),
    QIS,
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
  let Token: Token;
  let ChronosContract: Chronos;
  let Params: ParametersStorage;
  let NFT: DKGPublishingConvictionNFT;
  let PC: PublishingConviction;
  let PCS: PublishingConvictionStorage;
  let QIS: QueryInferenceStorage;
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
      Token,
      Chronos: ChronosContract,
      Params,
      NFT,
      PC,
      PCS,
      QIS,
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

  /** Fund the period of `epoch` (the current one by default): one per buyer key and epoch. */
  const fundBase = async (accountId: bigint, cost: bigint, epoch?: bigint) => {
    const r = requestOf(accountId, epoch ?? (await ChronosContract.getCurrentEpoch()), {
      buckets: [bucket(0, CLASS_INFERENCE, valueFor(cost, BPS))],
    });
    return (await (await SS.connect(buyer).fundFromConviction(r)).wait())!;
  };

  /** The funding booked its cost as due after its period, and nothing to the staker pool. */
  const expectDue = async (receipt: ContractTransactionReceipt, cost: bigint, dueEpoch: bigint) => {
    const [covered] = await eventsOf(receipt, PC, 'ServiceCostCovered');
    expect(covered.cost).to.equal(cost);
    expect(await QIS.convictionDue(dueEpoch)).to.be.at.least(cost);
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

  it('assign, one EOA signature', async () => {
    const { accountId } = await createAccount();
    await SS.connect(owner).setServiceSpending(accountId, true);
    const terms = await termsFor(accountId);
    const receipt = (await (await SS.connect(owner).assign(terms, '0x', await signTerms(buyer, SS, terms))).wait())!;
    record('assign, one EOA signature', receipt);
  });

  it('updateAssignmentCaps', async () => {
    const { accountId } = await createAccount();
    const terms = await optInAndAssign(accountId);
    // Both limits change.
    const caps = { ...capsOf(terms), maxCostPerPeriod: 25n * TRAC, expiresAt: terms.expiresAt - DAY };
    const receipt = (await (await SS.connect(owner).updateAssignmentCaps(accountId, buyer.address, caps)).wait())!;
    record('updateAssignmentCaps', receipt);
  });

  it('fundFromConviction, one bucket, base only, first period', async () => {
    const { accountId } = await createAccount();
    await optInAndAssign(accountId);
    const epoch = await ChronosContract.getCurrentEpoch();
    const receipt = await fundBase(accountId, 100n * TRAC);
    await expectDue(receipt, 100n * TRAC, epoch + 1n);
    record('fundFromConviction, one bucket, base only, first period', receipt);
  });

  it('fundFromConviction, one bucket, with top-up overflow', async () => {
    const lock = await Params.publishingConvictionEpochs();
    const { accountId } = await createAccount();
    await optInAndAssign(accountId);
    // Publishing spends all but 10 TRAC of the window, and the owner tops up:
    // the funding is the account's first, and overflows into the buffer.
    await publishAllBut(accountId, lock, 10n * TRAC);
    await topUpBy(accountId, 1_000n * TRAC);
    const epoch = await ChronosContract.getCurrentEpoch();
    const receipt = await fundBase(accountId, 500n * TRAC);
    const [covered] = await eventsOf(receipt, PC, 'ServiceCostCovered');
    expect([covered.drawnFromWindow, covered.drawnFromTopUp]).to.deep.equal([10n * TRAC, 490n * TRAC]);
    await expectDue(receipt, 500n * TRAC, epoch + 1n);
    record('fundFromConviction, one bucket, with top-up overflow', receipt);
  });

  it('fundFromConviction, a later period, same window', async () => {
    const { accountId } = await createAccount();
    await optInAndAssign(accountId);
    const epoch = await ChronosContract.getCurrentEpoch();
    await fundBase(accountId, 100n * TRAC, epoch + 1n);
    // The current epoch's period, after the next one's: the due slot of the
    // next epoch exists, and no window has closed.
    const receipt = await fundBase(accountId, 100n * TRAC);
    await expectDue(receipt, 100n * TRAC, epoch + 1n);
    expect(await eventsOf(receipt, PC, 'EmissionScheduled')).to.have.length(0);
    record('fundFromConviction, a later period, same window', receipt);
  });

  it('fundFromConviction, a later period, one window closed', async () => {
    const { accountId, createdAt } = await createAccount();
    await optInAndAssign(accountId);
    await fundBase(accountId, 100n * TRAC);
    // The next period, in the next window and the next epoch: the funding
    // books window 0 first.
    await time.increaseTo(createdAt + epLen + 60n);
    const epoch = await ChronosContract.getCurrentEpoch();
    const receipt = await fundBase(accountId, 100n * TRAC);
    const [booked] = await eventsOf(receipt, PC, 'EmissionScheduled');
    expect([booked.fromWindow, booked.toWindow]).to.deep.equal([0n, 1n]);
    await expectDue(receipt, 100n * TRAC, epoch + 1n);
    record('fundFromConviction, a later period, one window closed', receipt);
  });

  it('topUpFromConviction, one stored bucket', async () => {
    const { accountId } = await createAccount();
    await optInAndAssign(accountId);
    const epoch = await ChronosContract.getCurrentEpoch();
    await fundBase(accountId, 100n * TRAC);
    const subscriptionId = subscriptionIdOf(buyer.address, epoch);
    const receipt = (await (
      await SS.connect(buyer).topUpFromConviction(
        subscriptionId,
        [bucket(0, CLASS_INFERENCE, valueFor(50n * TRAC, BPS))],
        hre.ethers.id('plan-2'),
      )
    ).wait())!;
    await expectDue(receipt, 50n * TRAC, epoch + 1n);
    record('topUpFromConviction, one stored bucket', receipt);
  });
});
