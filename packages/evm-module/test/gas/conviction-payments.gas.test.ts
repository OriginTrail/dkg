// Gas of Conviction Account payments at use time (OT-RFC-27,
// PublishingConviction 10.2.0): a publish of a use-time account and of an
// account that 10.0.8 or 10.1.0 scheduled, each base only and with top-up
// overflow, and the booking of closed windows by settle, one window, six, and
// a batch of accounts. Plan fundings and their top-ups are measured in
// conviction-service.gas.test.ts. Each case is measured on the real account
// stack and held to its committed target. The targets are targets, not
// limits: a change that goes above one needs the figure reviewed and the
// target revised on purpose, in the same change.
//
// A publish is measured as KnowledgeAssetsLifecycle makes it, through the NFT's
// coverPublishingCost, from a Hub-registered stand-in. A window booking writes
// up to three staker-pool ranges forward from the window's close, and the
// first credit of an epoch finalizes the shard through the epoch before, so
// the per-window figure is the difference between six windows and one, over
// five.
//
// `measured` is the gas the transaction used when this file was written
// (Hardhat, the repository's compiler settings); the test prints the current
// figures beside it. A case measured above its target is held to that figure,
// rounded up to the next 5,000 gas, instead, and marked `above: true`.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ContractTransactionReceipt } from 'ethers';
import hre from 'hardhat';

import {
  Chronos,
  DKGPublishingConvictionNFT,
  Hub,
  ParametersStorage,
  PublishingConviction,
  PublishingConvictionScheduleHarness,
  Token,
} from '../../typechain';
import { ACCOUNT_STACK_TAGS, TRAC, valueFor } from '../helpers/conviction-service';
import { deployScheduleHarness } from '../helpers/scheduled-accounts';

type Case = { target: bigint; measured: bigint; above?: true };

// The targets, and what this file measured against them.
const GAS: Record<string, Case> = {
  // The whole draw over the KA's epochs: three staker-pool ranges, here into
  // epoch slots no credit has written yet.
  'coverPublishingCost, use-time account, base only, KA of 12 epochs': { target: 300_000n, measured: 257_965n },
  'coverPublishingCost, use-time account, with top-up overflow': { target: 300_000n, measured: 266_940n },
  // A budget gate only: no range.
  'coverPublishingCost, scheduled account, base only': { target: 150_000n, measured: 120_624n },
  // The overflow forward over the lock: three ranges, into epoch slots the
  // account's own schedule has written.
  'coverPublishingCost, scheduled account, with top-up overflow': { target: 250_000n, measured: 215_637n },
  // The first credit of the epoch also finalizes the shard.
  'settle, one closed window': { target: 250_000n, measured: 232_242n },
  'settle, six closed windows': { target: 700_000n, measured: 629_000n },
  'settle(uint256[]), ten accounts, one closed window each': { target: 1_000_000n, measured: 772_409n },
  'settle(uint256[]), ten accounts, nothing to book': { target: 150_000n, measured: 122_163n },
};

const ROUNDING = 5_000n;
/** What a case is held to: its target, or, above it, its measured figure rounded up. */
const limitOf = (c: Case): bigint => (c.above ? ((c.measured + ROUNDING - 1n) / ROUNDING) * ROUNDING : c.target);

// The 20 % tier.
const COMMITTED = 50_000n * TRAC;
const BPS = 2_000n;

async function deployFixture() {
  await hre.deployments.fixture(ACCOUNT_STACK_TAGS);
  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  const Harness = await deployScheduleHarness(Hub);
  await Hub.setContractAddress('KnowledgeAssetsLifecycle', accounts[5].address);
  return {
    accounts,
    Token: await hre.ethers.getContract<Token>('Token'),
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    Params: await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
    NFT: await hre.ethers.getContract<DKGPublishingConvictionNFT>('DKGPublishingConvictionNFT'),
    PC: await hre.ethers.getContract<PublishingConviction>('PublishingConviction'),
    Harness,
  };
}

// Instrumented coverage runs say nothing about deployed gas.
const skipUnderCoverage = process.argv.some((a) => a.includes('coverage'));

describe('@gas Conviction Account payments at use time', () => {
  before(function () {
    if (skipUnderCoverage) this.skip();
  });

  let accounts: SignerWithAddress[];
  let Token: Token;
  let ChronosContract: Chronos;
  let Params: ParametersStorage;
  let NFT: DKGPublishingConvictionNFT;
  let PC: PublishingConviction;
  let Harness: PublishingConvictionScheduleHarness;
  let epLen: bigint;
  let lock: bigint;
  const measured: Array<[string, bigint]> = [];

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({ accounts, Token, Chronos: ChronosContract, Params, NFT, PC, Harness } = await loadFixture(deployFixture));
    epLen = await ChronosContract.epochLength();
    lock = await Params.publishingConvictionEpochs();
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
    const one = measured.find(([n]) => n === 'settle, one closed window');
    const six = measured.find(([n]) => n === 'settle, six closed windows');
    if (one && six) console.log(`Booking one more window: ${(six[1] - one[1]) / 5n} gas`);
  });

  it('marks exactly the cases measured above their target', () => {
    for (const [name, c] of Object.entries(GAS)) {
      expect(c.above === true, name).to.equal(c.measured > c.target);
    }
  });

  const record = (name: string, receipt: ContractTransactionReceipt) => {
    const gas = receipt.gasUsed;
    measured.push([name, gas]);
    const limit = limitOf(GAS[name]);
    expect(gas, `${name}: ${gas} gas against ${limit} (target ${GAS[name].target})`).to.be.at.most(limit);
  };

  /** A PCA of `holder` with `agent` registered; returns its id and creation time. */
  const createAccount = async (holder: SignerWithAddress, agent?: SignerWithAddress) => {
    await Token.mint(holder.address, COMMITTED);
    await Token.connect(holder).approve(await NFT.getAddress(), COMMITTED);
    const receipt = (await (await NFT.connect(holder).createAccount(COMMITTED, 0)).wait())!;
    const accountId = await NFT.totalSupply();
    if (agent) await NFT.connect(holder).registerAgent(accountId, agent.address);
    const createdAt = BigInt((await hre.ethers.provider.getBlock(receipt.blockNumber))!.timestamp);
    return { accountId, createdAt };
  };

  const topUp = async (holder: SignerWithAddress, accountId: bigint, amount: bigint) => {
    await Token.mint(holder.address, amount);
    await Token.connect(holder).approve(await NFT.getAddress(), amount);
    await NFT.connect(holder).topUp(accountId, amount);
  };

  const publish = async (agent: SignerWithAddress, cost: bigint, kaEpochs: bigint) =>
    (await (
      await NFT.connect(accounts[5]).coverPublishingCost(
        agent.address,
        valueFor(cost, BPS),
        await ChronosContract.getCurrentEpoch(),
        kaEpochs,
      )
    ).wait())!;

  for (const scheduled of [false, true]) {
    const who = scheduled ? 'scheduled account' : 'use-time account';
    const baseName = scheduled
      ? 'coverPublishingCost, scheduled account, base only'
      : 'coverPublishingCost, use-time account, base only, KA of 12 epochs';
    it(baseName, async () => {
      const { accountId } = await createAccount(accounts[20], accounts[21]);
      if (scheduled) await Harness.scheduleInFull(accountId);
      const receipt = await publish(accounts[21], 1_000n * TRAC, lock);
      record(baseName, receipt);
    });

    const overflowName = `coverPublishingCost, ${who}, with top-up overflow`;
    it(overflowName, async () => {
      const { accountId } = await createAccount(accounts[20], accounts[21]);
      if (scheduled) await Harness.scheduleInFull(accountId);
      await topUp(accounts[20], accountId, 2_000n * TRAC);
      const receipt = await publish(accounts[21], COMMITTED / lock + 500n * TRAC, lock);
      record(overflowName, receipt);
    });
  }

  for (const [name, windows] of [
    ['settle, one closed window', 1n],
    ['settle, six closed windows', 6n],
  ] as const) {
    it(name, async () => {
      const { accountId, createdAt } = await createAccount(accounts[20]);
      await time.setNextBlockTimestamp(createdAt + windows * epLen);
      const receipt = (await (await PC['settle(uint256)'](accountId)).wait())!;
      const ev = (await PC.queryFilter(PC.filters.EmissionScheduled(accountId)))[0];
      expect([ev.args.fromWindow, ev.args.toWindow]).to.deep.equal([0n, windows]);
      record(name, receipt);
    });
  }

  it('settle(uint256[]), ten accounts, one closed window each', async () => {
    const ids: bigint[] = [];
    let last = 0n;
    for (let i = 0; i < 10; i++) {
      const { accountId, createdAt } = await createAccount(accounts[20 + i]);
      ids.push(accountId);
      last = createdAt;
    }
    await time.setNextBlockTimestamp(last + epLen);
    const receipt = (await (await PC['settle(uint256[])'](ids)).wait())!;
    expect(await PC.queryFilter(PC.filters.EmissionScheduled(), receipt.blockNumber, receipt.blockNumber)).to.have.length(10);
    record('settle(uint256[]), ten accounts, one closed window each', receipt);
  });

  it('settle(uint256[]), ten accounts, nothing to book', async () => {
    const ids: bigint[] = [];
    for (let i = 0; i < 10; i++) ids.push((await createAccount(accounts[20 + i])).accountId);
    const receipt = (await (await PC['settle(uint256[])'](ids)).wait())!;
    expect(receipt.logs).to.have.length(0);
    record('settle(uint256[]), ten accounts, nothing to book', receipt);
  });
});
