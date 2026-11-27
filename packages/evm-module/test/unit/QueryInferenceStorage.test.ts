// QueryInferenceStorage: the policy-free state store of the query/inference
// reward pool (OT-RFC-27).
//
// Covers:
//   - the gates: every mutator is onlyContracts (a Hub-registered contract or
//     the Hub owner), every parameter setter is onlyHub (the Hub, through
//     forwardCall, or the Hub owner), and neither admits the other's callers;
//   - the parameters: defaults, bounds, the pause, and an activation epoch set
//     once, never to an ended epoch, and only once the Hub's settlement and
//     StakingV10 read this storage;
//   - λ: one value, which a change replaces at once, and which an epoch copies
//     while it has no value and keeps once a value has counted in it;
//   - the money, wallet and Conviction Account: bookings accumulate per epoch,
//     each in its own ledger;
//   - countReceipts: the budget's fill and the node's and the epoch's totals,
//     every sum checked;
//   - the rule that an epoch that has ended takes no write, on every write keyed
//     by an epoch, to the second of its boundary;
//   - the nonce bits, which are only ever set;
//   - the narrow setters, one field each: round trips with the other fields left
//     as they were, and the storage's rules kept;
//   - the views, the slots they read, and the compiler's storage layout against
//     the documented one.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import { Chronos, Hub, QueryInferenceStorage } from '../../typechain';

const MAX_UINT96 = (1n << 96n) - 1n;
const MAX_UINT120 = (1n << 120n) - 1n;
const MAX_UINT128 = (1n << 128n) - 1n;
/** The setters that write one field of the settlement state, onlyContracts as the other mutators are. */
const NARROW_SETTERS = ['setBudgetUsed', 'setEpochTotals', 'setNodeEpoch'];
/** The other functions that write that state. */
const MUTATORS = ['addAccountFunding', 'addWalletFunding', 'countReceipts', 'useNonces'];
/** The parameters' setters, onlyHub. */
const PARAMETER_SETTERS = ['setActivationEpoch', 'setLambdaBps', 'setMaxGroupsPerBatch', 'setMaxItemsPerBatch', 'setPaused'];

const ID = ethers.id('subscription');

type Fixture = {
  Hub: Hub;
  Chronos: Chronos;
  QIS: QueryInferenceStorage;
  owner: SignerWithAddress;
  logic: SignerWithAddress;
  stranger: SignerWithAddress;
};

async function deployFixture(): Promise<Fixture> {
  await hre.deployments.fixture(['Hub', 'Chronos']);
  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  const Chronos = await hre.ethers.getContract<Chronos>('Chronos');

  const Factory = await hre.ethers.getContractFactory('QueryInferenceStorage');
  const QIS = (await Factory.deploy(await Hub.getAddress())) as unknown as QueryInferenceStorage;
  await QIS.waitForDeployment();
  await Hub.setContractAddress('QueryInferenceStorage', await QIS.getAddress());
  // A Hub-registered contract stands in for the logic contracts.
  await Hub.setContractAddress('QueryInferenceLogicStandIn', accounts[1].address);
  await Hub.forwardCall(await QIS.getAddress(), QIS.interface.encodeFunctionData('initialize'));
  // The settlement and StakingV10 the activation needs reading this storage.
  const Reader = await hre.ethers.getContractFactory('MockQueryInferenceReader');
  for (const name of ['QueryInferenceSettlement', 'StakingV10']) {
    const reader = await Reader.deploy(await QIS.getAddress());
    await reader.waitForDeployment();
    await Hub.setContractAddress(name, await reader.getAddress());
  }

  return { Hub, Chronos, QIS, owner: accounts[0], logic: accounts[1], stranger: accounts[2] };
}

describe('@unit QueryInferenceStorage', () => {
  let HubContract: Hub;
  let ChronosContract: Chronos;
  let QIS: QueryInferenceStorage;
  let owner: SignerWithAddress;
  let logic: SignerWithAddress;
  let stranger: SignerWithAddress;
  let epLen: bigint;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({ Hub: HubContract, Chronos: ChronosContract, QIS, owner, logic, stranger } = await loadFixture(deployFixture));
    epLen = await ChronosContract.epochLength();
  });

  const currentEpoch = async () => ChronosContract.getCurrentEpoch();
  const startOf = async (epoch: bigint) => ChronosContract.timestampForEpoch(epoch);
  const forward = async (fn: string, args: unknown[] = []) =>
    HubContract.forwardCall(await QIS.getAddress(), QIS.interface.encodeFunctionData(fn, args));
  const activateAt = async (epoch: bigint) => forward('setActivationEpoch', [epoch]);
  type Call = (...a: unknown[]) => Promise<ethers.ContractTransactionResponse>;
  const callerOf = (signer: SignerWithAddress) => QIS.connect(signer) as unknown as Record<string, Call>;
  /** A count from the logic contracts: by default node 5 on budget 3 of the subscription. */
  const count = (epoch: bigint, counted: bigint, r: bigint, score: bigint, seller = 5n, budgetIndex = 3n, subscriptionId = ID) =>
    QIS.connect(logic).countReceipts(subscriptionId, budgetIndex, seller, epoch, counted, r, score);

  describe('metadata and initialization', () => {
    it('is named QueryInferenceStorage, version 1.0.0, with a 10,000 bps denominator', async () => {
      expect(await QIS.name()).to.equal('QueryInferenceStorage');
      expect(await QIS.version()).to.equal('1.0.0');
      expect(await QIS.BPS_DENOMINATOR()).to.equal(10_000n);
      expect(await QIS.hub()).to.equal(await HubContract.getAddress());
    });

    it('refuses a zero Hub address at deployment', async () => {
      const Factory = await hre.ethers.getContractFactory('QueryInferenceStorage');
      await expect(Factory.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(QIS, 'ZeroAddressHub');
    });

    it('initialize seeds the bounds and leaves activation, λ, the pause and the money at zero', async () => {
      expect(await QIS.maxItemsPerBatch()).to.equal(256n);
      expect(await QIS.maxGroupsPerBatch()).to.equal(32n);
      expect(await QIS.activationEpoch()).to.equal(0n);
      expect(await QIS.lambdaBps()).to.equal(0n);
      expect(await QIS.paused()).to.equal(false);
      expect(await QIS.fundingState()).to.deep.equal([0n, false]);
      expect(await QIS.batchState()).to.deep.equal([0n, false, 32n, 256n]);
      expect(await QIS.fundingIn(await currentEpoch())).to.deep.equal([0n, 0n]);
    });

    it('initialize seeds each bound only while it is unset', async () => {
      const fresh = (await (
        await hre.ethers.getContractFactory('QueryInferenceStorage')
      ).deploy(await HubContract.getAddress())) as unknown as QueryInferenceStorage;
      await fresh.waitForDeployment();
      expect(await fresh.batchState()).to.deep.equal([0n, false, 0n, 0n]);

      // The Hub owner sets one bound ahead of the first initialize.
      await fresh.setMaxItemsPerBatch(64n);
      await fresh.initialize();
      expect(await fresh.batchState()).to.deep.equal([0n, false, 32n, 64n]);
    });

    it('initialize is idempotent: tuned bounds, λ, the pause and the activation epoch survive a re-initialization', async () => {
      const now = await currentEpoch();
      await QIS.setMaxItemsPerBatch(64n);
      await QIS.setMaxGroupsPerBatch(8n);
      await QIS.setLambdaBps(5_000n);
      await QIS.setPaused(true);
      await activateAt(now);
      await forward('initialize');
      expect(await QIS.batchState()).to.deep.equal([now, true, 8n, 64n]);
      expect(await QIS.lambdaBps()).to.equal(5_000n);
    });

    it('initialize is idempotent over the money and the counts too', async () => {
      const e = await currentEpoch();
      await QIS.connect(logic).addWalletFunding(e, 3n);
      await count(e, 100n, 70n, 40n);
      await forward('initialize');
      expect(await QIS.walletFunding(e)).to.equal(3n);
      expect(await QIS.budgetUsed(ID, 3n)).to.equal(100n);
      expect(await QIS.getNodeEpoch(5n, e)).to.deep.equal([70n, 40n]);
    });

    it('initialize is onlyHub: a Hub contract and a stranger are refused, and the Hub owner is admitted', async () => {
      for (const caller of [logic, stranger]) {
        await expect(QIS.connect(caller).initialize())
          .to.be.revertedWithCustomError(QIS, 'UnauthorizedAccess')
          .withArgs('Only Hub');
      }
      await QIS.connect(owner).initialize();
    });
  });

  describe('parameter setters (onlyHub)', () => {
    const setters: Array<[string, unknown[]]> = [
      ['setActivationEpoch', [1_000_000n]],
      ['setMaxItemsPerBatch', [128n]],
      ['setMaxGroupsPerBatch', [16n]],
      ['setPaused', [true]],
      ['setLambdaBps', [5_000n]],
    ];

    it('the list below covers every setter but the narrow ones, which are onlyContracts', () => {
      const found: string[] = [];
      QIS.interface.forEachFunction((f) => {
        if (f.stateMutability === 'nonpayable' && f.name.startsWith('set') && !NARROW_SETTERS.includes(f.name)) {
          found.push(f.name);
        }
      });
      expect(found.sort()).to.deep.equal(setters.map(([n]) => n).sort());
    });

    for (const [setter, args] of setters) {
      it(`${setter} refuses a Hub contract and a stranger, and admits the Hub owner and Hub.forwardCall`, async () => {
        for (const caller of [logic, stranger]) {
          await expect(callerOf(caller)[setter](...args))
            .to.be.revertedWithCustomError(QIS, 'UnauthorizedAccess')
            .withArgs('Only Hub');
        }
        await callerOf(owner)[setter](...args);
        if (setter !== 'setActivationEpoch') await forward(setter, args);
      });
    }

    it('setMaxItemsPerBatch accepts 1 to 1,024, and the event carries the old value and the new', async () => {
      for (const bad of [0n, 1_025n]) {
        await expect(QIS.setMaxItemsPerBatch(bad))
          .to.be.revertedWithCustomError(QIS, 'InvalidParameter')
          .withArgs('maxItemsPerBatch');
      }
      await expect(QIS.setMaxItemsPerBatch(1n)).to.emit(QIS, 'MaxItemsPerBatchSet').withArgs(256n, 1n);
      await expect(QIS.setMaxItemsPerBatch(1_024n)).to.emit(QIS, 'MaxItemsPerBatchSet').withArgs(1n, 1_024n);
      expect(await QIS.maxItemsPerBatch()).to.equal(1_024n);
    });

    it('setMaxGroupsPerBatch accepts 1 to 255, and the event carries the old value and the new', async () => {
      await expect(QIS.setMaxGroupsPerBatch(0n))
        .to.be.revertedWithCustomError(QIS, 'InvalidParameter')
        .withArgs('maxGroupsPerBatch');
      await expect(QIS.setMaxGroupsPerBatch(255n)).to.emit(QIS, 'MaxGroupsPerBatchSet').withArgs(32n, 255n);
      await expect(QIS.setMaxGroupsPerBatch(1n)).to.emit(QIS, 'MaxGroupsPerBatchSet').withArgs(255n, 1n);
      expect(await QIS.maxGroupsPerBatch()).to.equal(1n);
    });

    it('setPaused switches the pause either way and emits it, and fundingState and batchState read it', async () => {
      await expect(QIS.setPaused(true)).to.emit(QIS, 'PausedSet').withArgs(true);
      expect(await QIS.paused()).to.equal(true);
      expect((await QIS.fundingState())[1]).to.equal(true);
      expect((await QIS.batchState())[1]).to.equal(true);
      await expect(QIS.setPaused(false)).to.emit(QIS, 'PausedSet').withArgs(false);
      expect(await QIS.paused()).to.equal(false);
      expect((await QIS.fundingState())[1]).to.equal(false);
      expect((await QIS.batchState())[1]).to.equal(false);
    });

    it('Hub.forwardCall reaches the setters only once the storage is registered in the Hub', async () => {
      const unregistered = await (
        await hre.ethers.getContractFactory('QueryInferenceStorage')
      ).deploy(await HubContract.getAddress());
      await unregistered.waitForDeployment();
      const data = QIS.interface.encodeFunctionData('setPaused', [true]);
      await expect(HubContract.forwardCall(await unregistered.getAddress(), data))
        .to.be.revertedWithCustomError(HubContract, 'InvalidTargetContract')
        .withArgs(await unregistered.getAddress());
      await expect(HubContract.forwardCall(await QIS.getAddress(), data)).to.emit(QIS, 'PausedSet').withArgs(true);
    });
  });

  describe('activation', () => {
    it('refuses 0 and an epoch that has ended, and accepts the current epoch, which fundingState and batchState read', async () => {
      await time.increase(3n * epLen);
      const now = await currentEpoch();
      for (const bad of [0n, now - 1n, 1n]) {
        await expect(QIS.setActivationEpoch(bad))
          .to.be.revertedWithCustomError(QIS, 'InvalidParameter')
          .withArgs('activationEpoch');
      }
      await expect(activateAt(now)).to.emit(QIS, 'ActivationEpochSet').withArgs(now);
      expect(await QIS.activationEpoch()).to.equal(now);
      expect(await QIS.fundingState()).to.deep.equal([now, false]);
      expect(await QIS.batchState()).to.deep.equal([now, false, 32n, 256n]);
    });

    it('accepts an epoch through its last second', async () => {
      const e = await currentEpoch();
      await time.setNextBlockTimestamp((await startOf(e + 1n)) - 1n);
      await expect(QIS.setActivationEpoch(e)).to.emit(QIS, 'ActivationEpochSet').withArgs(e);
    });

    it('refuses an epoch from the first second of the next, when it has ended, and accepts the next', async () => {
      const e = await currentEpoch();
      await time.setNextBlockTimestamp(await startOf(e + 1n));
      await expect(QIS.setActivationEpoch(e))
        .to.be.revertedWithCustomError(QIS, 'InvalidParameter')
        .withArgs('activationEpoch');
      await expect(QIS.setActivationEpoch(e + 1n)).to.emit(QIS, 'ActivationEpochSet').withArgs(e + 1n);
    });

    it('refuses until the Hub holds a settlement over this storage and a StakingV10 that reads it, as 10.0.4 does not', async () => {
      const now = await currentEpoch();
      const settlement = await HubContract.getContractAddress('QueryInferenceSettlement');
      const staking = await HubContract.getContractAddress('StakingV10');
      const Reader = await hre.ethers.getContractFactory('MockQueryInferenceReader');
      const elsewhere = async () => (await Reader.deploy(stranger.address)).getAddress();
      // A contract with no queryInferenceStorage(), as StakingV10 10.0.4 has none.
      const noView = await (await (await hre.ethers.getContractFactory('Chronos')).deploy(1n, epLen)).getAddress();
      const refused = async (reason: string) =>
        expect(activateAt(now)).to.be.revertedWithCustomError(QIS, 'PoolNotWired').withArgs(reason);

      // No settlement in the Hub, then one over another storage.
      await HubContract.removeContractByName('QueryInferenceSettlement');
      await refused('QueryInferenceSettlement');
      await HubContract.setContractAddress('QueryInferenceSettlement', await elsewhere());
      await refused('QueryInferenceSettlement');
      await HubContract.setContractAddress('QueryInferenceSettlement', settlement);

      // No StakingV10; one without the view; an address with no code; one that
      // reads another storage.
      await HubContract.removeContractByName('StakingV10');
      await refused('StakingV10');
      await HubContract.setContractAddress('StakingV10', noView);
      await refused('StakingV10');
      await HubContract.setContractAddress('StakingV10', stranger.address);
      await refused('StakingV10');
      await HubContract.setContractAddress('StakingV10', await elsewhere());
      await refused('StakingV10');
      expect(await QIS.activationEpoch()).to.equal(0n);

      await HubContract.setContractAddress('StakingV10', staking);
      await expect(activateAt(now)).to.emit(QIS, 'ActivationEpochSet').withArgs(now);
    });

    it('accepts a later epoch, and is set once: neither an earlier nor a later epoch replaces it', async () => {
      const next = (await currentEpoch()) + 1n;
      await activateAt(next);
      expect(await QIS.activationEpoch()).to.equal(next);
      for (const again of [next, next + 5n, next - 1n]) {
        await expect(QIS.setActivationEpoch(again))
          .to.be.revertedWithCustomError(QIS, 'ActivationEpochAlreadySet')
          .withArgs(next);
      }
      expect(await QIS.activationEpoch()).to.equal(next);
    });
  });

  describe('λ', () => {
    it('refuses more than 10,000 basis points and accepts 0 to 10,000', async () => {
      await QIS.setLambdaBps(3_000n);
      await expect(QIS.setLambdaBps(10_001n))
        .to.be.revertedWithCustomError(QIS, 'InvalidParameter')
        .withArgs('lambdaBps');
      expect(await QIS.lambdaBps()).to.equal(3_000n);
      await QIS.setLambdaBps(10_000n);
      expect(await QIS.lambdaBps()).to.equal(10_000n);
      await QIS.setLambdaBps(0n);
      expect(await QIS.lambdaBps()).to.equal(0n);
    });

    it('a change applies at once, and the event carries the old value and the new', async () => {
      await expect(QIS.setLambdaBps(5_000n)).to.emit(QIS, 'LambdaBpsSet').withArgs(0n, 5_000n);
      expect(await QIS.lambdaBps()).to.equal(5_000n);
      await expect(forward('setLambdaBps', [2_000n])).to.emit(QIS, 'LambdaBpsSet').withArgs(5_000n, 2_000n);
      expect(await QIS.lambdaBps()).to.equal(2_000n);
      await expect(QIS.setLambdaBps(2_000n)).to.emit(QIS, 'LambdaBpsSet').withArgs(2_000n, 2_000n);
    });

    it('applies at once whether the activation epoch is unset, ahead or reached, and an epoch boundary changes nothing', async () => {
      const now = await currentEpoch();
      await QIS.setLambdaBps(1_000n);
      expect(await QIS.lambdaBps()).to.equal(1_000n);

      await activateAt(now + 2n);
      await QIS.setLambdaBps(2_000n);
      expect(await QIS.lambdaBps()).to.equal(2_000n);

      await time.increaseTo(await startOf(now + 2n));
      expect(await QIS.lambdaBps()).to.equal(2_000n);
      await QIS.setLambdaBps(3_000n);
      expect(await QIS.lambdaBps()).to.equal(3_000n);

      await time.increaseTo(await startOf(now + 3n));
      expect(await QIS.lambdaBps()).to.equal(3_000n);
      await expect(QIS.setLambdaBps(4_000n)).to.emit(QIS, 'LambdaBpsSet').withArgs(3_000n, 4_000n);
    });
  });

  describe('the money (onlyContracts)', () => {
    it('the list below covers every state-changing function except initialize and the setters', () => {
      const stateChanging: string[] = [];
      QIS.interface.forEachFunction((f) => {
        if (f.stateMutability === 'nonpayable' && f.name !== 'initialize' && !f.name.startsWith('set')) {
          stateChanging.push(f.name);
        }
      });
      expect(stateChanging.sort()).to.deep.equal([...MUTATORS].sort());
    });

    it('addWalletFunding refuses a caller outside the Hub, and admits a Hub contract and the Hub owner', async () => {
      await expect(QIS.connect(stranger).addWalletFunding(5n, 1n))
        .to.be.revertedWithCustomError(QIS, 'UnauthorizedAccess')
        .withArgs('Only Contracts in Hub');
      await QIS.connect(logic).addWalletFunding(5n, 1n);
      await QIS.connect(owner).addWalletFunding(5n, 2n);
      expect(await QIS.walletFunding(5n)).to.equal(3n);
    });

    it('accumulates per epoch, and reverts on overflow instead of wrapping', async () => {
      await QIS.connect(logic).addWalletFunding(7n, 10n);
      await QIS.connect(logic).addWalletFunding(8n, 4n);
      await QIS.connect(logic).addWalletFunding(7n, 5n);
      expect(await QIS.walletFunding(7n)).to.equal(15n);
      expect(await QIS.walletFunding(8n)).to.equal(4n);
      expect(await QIS.walletFunding(9n)).to.equal(0n);

      await QIS.connect(logic).addWalletFunding(20n, MAX_UINT96);
      await expect(QIS.connect(logic).addWalletFunding(20n, 1n)).to.be.revertedWithPanic(0x11);
      expect(await QIS.walletFunding(20n)).to.equal(MAX_UINT96);
    });

    it('addAccountFunding refuses a caller outside the Hub, and admits a Hub contract and the Hub owner', async () => {
      await expect(QIS.connect(stranger).addAccountFunding(5n, 1n))
        .to.be.revertedWithCustomError(QIS, 'UnauthorizedAccess')
        .withArgs('Only Contracts in Hub');
      await QIS.connect(logic).addAccountFunding(5n, 1n);
      await QIS.connect(owner).addAccountFunding(5n, 2n);
      expect(await QIS.accountFunding(5n)).to.equal(3n);
    });

    it('the Conviction Account ledger accumulates per epoch apart from the wallet one, and reverts on overflow', async () => {
      await QIS.connect(logic).addAccountFunding(7n, 10n);
      await QIS.connect(logic).addWalletFunding(7n, 3n);
      await QIS.connect(logic).addAccountFunding(8n, 4n);
      await QIS.connect(logic).addAccountFunding(7n, 5n);
      expect(await QIS.accountFunding(7n)).to.equal(15n);
      expect(await QIS.walletFunding(7n)).to.equal(3n);
      expect(await QIS.accountFunding(8n)).to.equal(4n);
      expect(await QIS.walletFunding(8n)).to.equal(0n);
      expect(await QIS.accountFunding(9n)).to.equal(0n);
      expect(await QIS.fundingIn(7n)).to.deep.equal([3n, 15n]);
      expect(await QIS.fundingIn(8n)).to.deep.equal([0n, 4n]);
      expect(await QIS.fundingIn(9n)).to.deep.equal([0n, 0n]);

      await QIS.connect(logic).addAccountFunding(20n, MAX_UINT96);
      await expect(QIS.connect(logic).addAccountFunding(20n, 1n)).to.be.revertedWithPanic(0x11);
      // The two ledgers are separate words, so a full one leaves the other open.
      await QIS.connect(logic).addWalletFunding(20n, MAX_UINT96);
      expect(await QIS.fundingIn(20n)).to.deep.equal([MAX_UINT96, MAX_UINT96]);
    });

    it('takes money and counts with the activation epoch unset: the refusals before activation are for the logic contracts to make', async () => {
      const e = await currentEpoch();
      expect(await QIS.activationEpoch()).to.equal(0n);
      await QIS.connect(logic).addWalletFunding(e, 1n);
      await QIS.connect(logic).addAccountFunding(e, 2n);
      await count(e, 3n, 3n, 3n);
      expect(await QIS.fundingIn(e)).to.deep.equal([1n, 2n]);
      expect(await QIS.activationEpoch()).to.equal(0n);
    });
  });

  describe('countReceipts (onlyContracts)', () => {
    it('refuses a caller outside the Hub, and admits a Hub contract and the Hub owner', async () => {
      const e = await currentEpoch();
      await expect(QIS.connect(stranger).countReceipts(ID, 3n, 5n, e, 1n, 1n, 1n))
        .to.be.revertedWithCustomError(QIS, 'UnauthorizedAccess')
        .withArgs('Only Contracts in Hub');
      await QIS.connect(logic).countReceipts(ID, 3n, 5n, e, 1n, 1n, 1n);
      await QIS.connect(owner).countReceipts(ID, 3n, 5n, e, 2n, 2n, 2n);
      expect(await QIS.budgetUsed(ID, 3n)).to.equal(3n);
      expect(await QIS.getNodeEpoch(5n, e)).to.deep.equal([3n, 3n]);
    });

    it('fills the budget at face value, and adds the value and the score to the node and the epoch', async () => {
      const e = await currentEpoch();
      await QIS.setLambdaBps(5_000n);
      await count(e, 100n, 70n, 40n);
      expect(await QIS.budgetUsed(ID, 3n)).to.equal(100n);
      expect(await QIS.getNodeEpoch(5n, e)).to.deep.equal([70n, 40n]);
      expect(await QIS.getEpochTotals(e)).to.deep.equal([70n, 40n, 5_000n]);
    });

    it("adds up: a budget's fill over its sellers, a node's totals over its budgets and subscriptions, and an epoch's over its nodes", async () => {
      const e = await currentEpoch();
      const other = ethers.id('other');
      await count(e, 100n, 70n, 40n);
      await count(e, 30n, 30n, 10n, 6n);
      await count(e, 5n, 4n, 2n, 5n, 4n);
      await count(e, 8n, 8n, 1n, 5n, 3n, other);
      expect(await QIS.budgetUsed(ID, 3n)).to.equal(130n);
      expect(await QIS.budgetUsed(ID, 4n)).to.equal(5n);
      expect(await QIS.budgetUsed(other, 3n)).to.equal(8n);
      expect(await QIS.getNodeEpoch(5n, e)).to.deep.equal([82n, 43n]);
      expect(await QIS.getNodeEpoch(6n, e)).to.deep.equal([30n, 10n]);
      expect(await QIS.getEpochTotals(e)).to.deep.equal([112n, 53n, 0n]);
    });

    it('writes only what it names: another budget, subscription, node or epoch reads as it was', async () => {
      const e = await currentEpoch();
      await count(e, 100n, 70n, 40n);
      expect(await QIS.budgetUsed(ID, 4n)).to.equal(0n);
      expect(await QIS.budgetUsed(ethers.id('other'), 3n)).to.equal(0n);
      expect(await QIS.getNodeEpoch(6n, e)).to.deep.equal([0n, 0n]);
      expect(await QIS.getNodeEpoch(5n, e + 1n)).to.deep.equal([0n, 0n]);
      expect(await QIS.getEpochTotals(e + 1n)).to.deep.equal([0n, 0n, 0n]);
      // Counting touches no money.
      expect(await QIS.fundingIn(e)).to.deep.equal([0n, 0n]);
    });

    it("the budget's fill has no epoch, while the node's and the epoch's totals are the named epoch's", async () => {
      const e = await currentEpoch();
      await count(e, 100n, 70n, 40n);
      await count(e + 1n, 10n, 7n, 4n);
      expect(await QIS.budgetUsed(ID, 3n)).to.equal(110n);
      expect(await QIS.getNodeEpoch(5n, e)).to.deep.equal([70n, 40n]);
      expect(await QIS.getNodeEpoch(5n, e + 1n)).to.deep.equal([7n, 4n]);
      expect((await QIS.getEpochTotals(e)).totalServed).to.equal(70n);
      expect((await QIS.getEpochTotals(e + 1n)).totalServed).to.equal(7n);
    });

    it('takes λ with the first value to count in an epoch, and the epoch keeps it whatever λ becomes', async () => {
      const e = await currentEpoch();
      await QIS.setLambdaBps(5_000n);
      // Changed before the epoch's first value, which takes the latest.
      await QIS.setLambdaBps(2_000n);
      await count(e, 100n, 70n, 40n);
      expect(await QIS.getEpochTotals(e)).to.deep.equal([70n, 40n, 2_000n]);

      // Changed after it: the epoch keeps its own, through a second count too.
      await QIS.setLambdaBps(7_000n);
      expect((await QIS.getEpochTotals(e)).lambdaBps).to.equal(2_000n);
      await count(e, 30n, 30n, 10n, 6n);
      expect(await QIS.getEpochTotals(e)).to.deep.equal([100n, 50n, 2_000n]);
      expect(await QIS.lambdaBps()).to.equal(7_000n);

      // The next epoch takes λ as it stands at its own first value.
      await time.increaseTo(await startOf(e + 1n));
      await count(e + 1n, 1n, 1n, 1n);
      expect(await QIS.getEpochTotals(e + 1n)).to.deep.equal([1n, 1n, 7_000n]);
      expect((await QIS.getEpochTotals(e)).lambdaBps).to.equal(2_000n);
    });

    it('takes λ again while the epoch has no value: a first count of no receipt value fixes nothing', async () => {
      const e = await currentEpoch();
      await QIS.setLambdaBps(5_000n);
      await count(e, 1n, 0n, 0n);
      expect(await QIS.getEpochTotals(e)).to.deep.equal([0n, 0n, 5_000n]);

      await QIS.setLambdaBps(2_000n);
      await count(e, 1n, 0n, 0n);
      expect(await QIS.getEpochTotals(e)).to.deep.equal([0n, 0n, 2_000n]);

      // The first value fixes it, and a later count of no value does not move it.
      await QIS.setLambdaBps(7_000n);
      await count(e, 100n, 70n, 40n);
      expect(await QIS.getEpochTotals(e)).to.deep.equal([70n, 40n, 7_000n]);
      await QIS.setLambdaBps(9_000n);
      await count(e, 1n, 0n, 0n);
      expect(await QIS.getEpochTotals(e)).to.deep.equal([70n, 40n, 7_000n]);
      // The counts of no value still filled the budget.
      expect(await QIS.budgetUsed(ID, 3n)).to.equal(103n);
    });

    it('a λ of 0 is a value like any other: an epoch takes it and keeps it', async () => {
      const e = await currentEpoch();
      expect(await QIS.lambdaBps()).to.equal(0n);
      await count(e, 100n, 70n, 40n);
      await QIS.setLambdaBps(5_000n);
      await count(e, 30n, 30n, 10n);
      expect(await QIS.getEpochTotals(e)).to.deep.equal([100n, 50n, 0n]);
    });

    it('takes value with no score: ΣR grows and fixes λ while ΣQIS stays 0', async () => {
      const e = await currentEpoch();
      await QIS.setLambdaBps(5_000n);
      await count(e, 100n, 70n, 0n);
      expect(await QIS.getEpochTotals(e)).to.deep.equal([70n, 0n, 5_000n]);
      expect(await QIS.getNodeEpoch(5n, e)).to.deep.equal([70n, 0n]);
    });

    const sums: Array<[string, (e: bigint) => Promise<unknown>, [bigint, bigint, bigint]]> = [
      ["the budget's fill, a uint96", () => QIS.connect(logic).setBudgetUsed(ID, 3n, MAX_UINT96 - 1n), [1n, 0n, 0n]],
      ["the node's R, a uint128", (e) => QIS.connect(logic).setNodeEpoch(5n, e, { servedValue: MAX_UINT128 - 1n, weightedValue: 0n }), [0n, 1n, 0n]],
      ["the node's score, a uint128", (e) => QIS.connect(logic).setNodeEpoch(5n, e, { servedValue: 0n, weightedValue: MAX_UINT128 - 1n }), [0n, 0n, 1n]],
      ["the epoch's ΣR, a uint120", (e) => QIS.connect(logic).setEpochTotals(e, { totalServed: MAX_UINT120 - 1n, totalWeighted: 0n, lambdaBps: 0n }), [0n, 1n, 0n]],
      ["the epoch's ΣQIS, a uint120", (e) => QIS.connect(logic).setEpochTotals(e, { totalServed: 0n, totalWeighted: MAX_UINT120 - 1n, lambdaBps: 0n }), [0n, 0n, 1n]],
    ];
    for (const [sum, seed, [counted, r, score]] of sums) {
      it(`checks ${sum}: a count reaches its maximum, and the next reverts instead of wrapping`, async () => {
        const e = await currentEpoch();
        await seed(e);
        await count(e, counted, r, score);
        await expect(count(e, counted, r, score)).to.be.revertedWithPanic(0x11);
      });
    }
  });

  describe('an epoch that has ended takes no write', () => {
    const writes: Array<[string, (e: bigint, by?: SignerWithAddress) => Promise<unknown>]> = [
      ['addWalletFunding', (e, by = logic) => QIS.connect(by).addWalletFunding(e, 7n)],
      ['addAccountFunding', (e, by = logic) => QIS.connect(by).addAccountFunding(e, 7n)],
      ['countReceipts', (e, by = logic) => QIS.connect(by).countReceipts(ID, 3n, 5n, e, 7n, 7n, 7n)],
      ['setNodeEpoch', (e, by = logic) => QIS.connect(by).setNodeEpoch(5n, e, { servedValue: 7n, weightedValue: 7n })],
      ['setEpochTotals', (e, by = logic) => QIS.connect(by).setEpochTotals(e, { totalServed: 7n, totalWeighted: 7n, lambdaBps: 7n })],
    ];
    /** All that the writes above touch in `e`, but the budget's fill, which has no epoch. */
    const stateOf = async (e: bigint): Promise<bigint[]> => [
      ...(await QIS.fundingIn(e)),
      ...(await QIS.getEpochTotals(e)),
      ...(await QIS.getNodeEpoch(5n, e)),
    ];
    const NOTHING = [0n, 0n, 0n, 0n, 0n, 0n, 0n];

    it('the list below covers every write that names an epoch, which the activation epoch is not', () => {
      const found: string[] = [];
      QIS.interface.forEachFunction((f) => {
        if (f.stateMutability === 'nonpayable' && f.name !== 'setActivationEpoch' && f.inputs.some((i) => i.name === 'epoch')) {
          found.push(f.name);
        }
      });
      expect(found.sort()).to.deep.equal(writes.map(([n]) => n).sort());
    });

    for (const [fn, write] of writes) {
      it(`${fn} takes a write through the last second of the epoch, and refuses one from the first second of the next, with nothing written`, async () => {
        const e = await currentEpoch();
        const boundary = await startOf(e + 1n);

        await time.setNextBlockTimestamp(boundary - 1n);
        await write(e);
        const written = await stateOf(e);
        const filled = await QIS.budgetUsed(ID, 3n);
        expect(written).to.not.deep.equal(NOTHING);

        await time.setNextBlockTimestamp(boundary);
        await expect(write(e)).to.be.revertedWithCustomError(QIS, 'EpochEnded').withArgs(e, e + 1n);
        expect(await stateOf(e)).to.deep.equal(written);
        expect(await QIS.budgetUsed(ID, 3n)).to.equal(filled);

        // The epoch that has just begun takes it.
        await write(e + 1n);
        expect(await stateOf(e + 1n)).to.not.deep.equal(NOTHING);
      });

      it(`${fn} refuses every earlier epoch, from the Hub owner too, and takes the current epoch and later ones`, async () => {
        await time.increase(3n * epLen);
        const now = await currentEpoch();
        for (const ended of [0n, 1n, now - 1n]) {
          for (const by of [logic, owner]) {
            await expect(write(ended, by)).to.be.revertedWithCustomError(QIS, 'EpochEnded').withArgs(ended, now);
          }
        }
        expect(await stateOf(now - 1n)).to.deep.equal(NOTHING);
        expect(await QIS.budgetUsed(ID, 3n)).to.equal(0n);
        for (const open of [now, now + 1n, now + 40n]) {
          await write(open);
          expect(await stateOf(open)).to.not.deep.equal(NOTHING);
        }
      });
    }

    it('reads no activation epoch: an epoch before it that has not ended takes a write, and one at or after it that has ended takes none', async () => {
      const now = await currentEpoch();
      await activateAt(now + 2n);
      await QIS.connect(logic).addWalletFunding(now, 1n);
      await count(now, 1n, 1n, 1n);

      await time.increaseTo(await startOf(now + 3n));
      for (const ended of [now, now + 2n]) {
        await expect(QIS.connect(logic).addWalletFunding(ended, 1n))
          .to.be.revertedWithCustomError(QIS, 'EpochEnded')
          .withArgs(ended, now + 3n);
        await expect(count(ended, 1n, 1n, 1n))
          .to.be.revertedWithCustomError(QIS, 'EpochEnded')
          .withArgs(ended, now + 3n);
      }
    });

    it('useNonces and setBudgetUsed name no epoch, so they stay open however many epochs end', async () => {
      await QIS.connect(logic).useNonces(ID, 5n, 0n, 0b01n);
      await QIS.connect(logic).setBudgetUsed(ID, 3n, 10n);
      await time.increase(3n * epLen);
      await QIS.connect(logic).useNonces(ID, 5n, 0n, 0b10n);
      await QIS.connect(logic).setBudgetUsed(ID, 3n, 20n);
      expect(await QIS.nonceWord(ID, 5n, 0n)).to.equal(0b11n);
      expect(await QIS.budgetUsed(ID, 3n)).to.equal(20n);
    });
  });

  describe('the nonce bits (onlyContracts)', () => {
    it('useNonces refuses a caller outside the Hub, and admits a Hub contract and the Hub owner', async () => {
      await expect(QIS.connect(stranger).useNonces(ID, 5n, 0n, 1n))
        .to.be.revertedWithCustomError(QIS, 'UnauthorizedAccess')
        .withArgs('Only Contracts in Hub');
      await QIS.connect(logic).useNonces(ID, 5n, 0n, 1n);
      await QIS.connect(owner).useNonces(ID, 5n, 0n, 2n);
      expect(await QIS.nonceWord(ID, 5n, 0n)).to.equal(3n);
    });

    it('useNonces only ever sets bits, per subscription, seller and word', async () => {
      await QIS.connect(logic).useNonces(ID, 5n, 2n, 0b0101n);
      await QIS.connect(owner).useNonces(ID, 5n, 2n, 0b0011n);
      await QIS.connect(logic).useNonces(ID, 5n, 2n, 0n);
      expect(await QIS.nonceWord(ID, 5n, 2n)).to.equal(0b0111n);
      expect(await QIS.nonceWord(ID, 5n, 3n)).to.equal(0n);
      expect(await QIS.nonceWord(ID, 6n, 2n)).to.equal(0n);
      expect(await QIS.nonceWord(ethers.id('other'), 5n, 2n)).to.equal(0n);
    });

    it('useNonces takes the whole word, and the largest word index', async () => {
      const maxWord = (1n << 64n) - 1n;
      await QIS.connect(logic).useNonces(ID, 5n, maxWord, ethers.MaxUint256);
      expect(await QIS.nonceWord(ID, 5n, maxWord)).to.equal(ethers.MaxUint256);
      await QIS.connect(logic).useNonces(ID, 5n, maxWord, 1n);
      expect(await QIS.nonceWord(ID, 5n, maxWord)).to.equal(ethers.MaxUint256);
    });
  });

  describe('the narrow setters (onlyContracts)', () => {
    const calls = (): Array<[string, unknown[]]> => [
      ['setBudgetUsed', [ID, 0n, 10n]],
      ['setNodeEpoch', [5n, 1_000n, { servedValue: 10n, weightedValue: 7n }]],
      ['setEpochTotals', [1_000n, { totalServed: 10n, totalWeighted: 7n, lambdaBps: 5_000n }]],
    ];

    it('with the parameter setters and the mutators, they are every state-changing function', () => {
      const found: string[] = [];
      QIS.interface.forEachFunction((f) => {
        if (f.stateMutability === 'nonpayable') found.push(f.name);
      });
      expect(calls().map(([n]) => n).sort()).to.deep.equal([...NARROW_SETTERS].sort());
      expect(found.sort()).to.deep.equal(['initialize', ...PARAMETER_SETTERS, ...MUTATORS, ...NARROW_SETTERS].sort());
    });

    it('each refuses a caller outside the Hub, and admits a Hub contract and the Hub owner', async () => {
      for (const [fn, args] of calls()) {
        await expect(callerOf(stranger)[fn](...args), fn)
          .to.be.revertedWithCustomError(QIS, 'UnauthorizedAccess')
          .withArgs('Only Contracts in Hub');
        await callerOf(logic)[fn](...args);
        await callerOf(owner)[fn](...args);
      }
    });

    it('setBudgetUsed writes the fill alone, which countReceipts adds to, and may lower it', async () => {
      const e = await currentEpoch();
      await count(e, 100n, 70n, 40n);
      await QIS.connect(logic).setBudgetUsed(ID, 3n, 30n);
      expect(await QIS.budgetUsed(ID, 3n)).to.equal(30n);
      expect(await QIS.budgetUsed(ID, 4n)).to.equal(0n);
      expect(await QIS.budgetUsed(ethers.id('other'), 3n)).to.equal(0n);
      expect(await QIS.getNodeEpoch(5n, e)).to.deep.equal([70n, 40n]);
      expect((await QIS.getEpochTotals(e)).totalServed).to.equal(70n);

      await count(e, 5n, 1n, 1n);
      expect(await QIS.budgetUsed(ID, 3n)).to.equal(35n);
      await QIS.connect(owner).setBudgetUsed(ID, 3n, MAX_UINT96);
      expect(await QIS.budgetUsed(ID, 3n)).to.equal(MAX_UINT96);
    });

    it("setNodeEpoch writes a node's values in an epoch alone, which countReceipts adds to", async () => {
      const e = await currentEpoch();
      await QIS.connect(logic).setNodeEpoch(5n, e, { servedValue: 120n, weightedValue: 45n });
      expect(await QIS.getNodeEpoch(5n, e)).to.deep.equal([120n, 45n]);
      expect(await QIS.getNodeEpoch(6n, e)).to.deep.equal([0n, 0n]);
      expect(await QIS.getNodeEpoch(5n, e + 1n)).to.deep.equal([0n, 0n]);
      expect(await QIS.getEpochTotals(e)).to.deep.equal([0n, 0n, 0n]);

      await count(e, 10n, 10n, 4n);
      expect(await QIS.getNodeEpoch(5n, e)).to.deep.equal([130n, 49n]);
      // It replaces, and takes the most a uint128 holds.
      await QIS.connect(owner).setNodeEpoch(5n, e, { servedValue: MAX_UINT128, weightedValue: 1n });
      expect(await QIS.getNodeEpoch(5n, e)).to.deep.equal([MAX_UINT128, 1n]);
    });

    it("setEpochTotals writes an epoch's totals and λ alone, which countReceipts adds to", async () => {
      const e = await currentEpoch();
      await QIS.connect(logic).setEpochTotals(e, { totalServed: 150n, totalWeighted: 75n, lambdaBps: 2_500n });
      expect(await QIS.getEpochTotals(e)).to.deep.equal([150n, 75n, 2_500n]);
      expect(await QIS.getEpochTotals(e + 1n)).to.deep.equal([0n, 0n, 0n]);
      expect(await QIS.getNodeEpoch(5n, e)).to.deep.equal([0n, 0n]);
      expect(await QIS.lambdaBps()).to.equal(0n);

      await count(e, 10n, 10n, 4n);
      expect(await QIS.getEpochTotals(e)).to.deep.equal([160n, 79n, 2_500n]);
      // It replaces, and takes the most a uint120 holds.
      await QIS.connect(owner).setEpochTotals(e, { totalServed: MAX_UINT120, totalWeighted: MAX_UINT120, lambdaBps: 10_000n });
      expect(await QIS.getEpochTotals(e)).to.deep.equal([MAX_UINT120, MAX_UINT120, 10_000n]);
    });

    it('setEpochTotals refuses a λ above 10,000, at which no gross of the epoch could be read', async () => {
      const e = await currentEpoch();
      await expect(QIS.connect(logic).setEpochTotals(e, { totalServed: 1n, totalWeighted: 1n, lambdaBps: 10_001n }))
        .to.be.revertedWithCustomError(QIS, 'InvalidParameter')
        .withArgs('lambdaBps');
      expect(await QIS.getEpochTotals(e)).to.deep.equal([0n, 0n, 0n]);
    });

    it('a count reads totalServed for λ, whatever wrote it: it keeps the λ of totals with value, and takes λ over totals with none', async () => {
      const e = await currentEpoch();
      await QIS.setLambdaBps(5_000n);

      await QIS.connect(logic).setEpochTotals(e, { totalServed: 1n, totalWeighted: 1n, lambdaBps: 2_500n });
      await count(e, 1n, 1n, 1n);
      expect(await QIS.getEpochTotals(e)).to.deep.equal([2n, 2n, 2_500n]);

      await QIS.connect(logic).setEpochTotals(e, { totalServed: 0n, totalWeighted: 0n, lambdaBps: 2_500n });
      await count(e, 1n, 1n, 1n);
      expect(await QIS.getEpochTotals(e)).to.deep.equal([1n, 1n, 5_000n]);
    });
  });

  describe('the mutators together', () => {
    const calls = (): Array<[string, unknown[]]> => [
      ['addWalletFunding', [1_000n, 1n]],
      ['addAccountFunding', [1_000n, 1n]],
      ['useNonces', [ID, 5n, 0n, 1n]],
      ['countReceipts', [ID, 0n, 5n, 1_000n, 1n, 1n, 1n]],
      ['setBudgetUsed', [ID, 0n, 10n]],
      ['setNodeEpoch', [5n, 1_000n, { servedValue: 10n, weightedValue: 7n }]],
      ['setEpochTotals', [1_000n, { totalServed: 10n, totalWeighted: 7n, lambdaBps: 5_000n }]],
    ];

    it('the list below covers every one of them', () => {
      expect(calls().map(([n]) => n).sort()).to.deep.equal([...MUTATORS, ...NARROW_SETTERS].sort());
    });

    it('a contract the Hub no longer holds is refused, as it would be with the settlement out of the Hub, and the Hub owner is still admitted', async () => {
      await HubContract.removeContractByName('QueryInferenceLogicStandIn');
      for (const [fn, args] of calls()) {
        await expect(callerOf(logic)[fn](...args), fn)
          .to.be.revertedWithCustomError(QIS, 'UnauthorizedAccess')
          .withArgs('Only Contracts in Hub');
        await callerOf(owner)[fn](...args);
      }
    });

    it('none emits an event: this contract emits events only for its parameters', async () => {
      for (const [fn, args] of calls()) {
        const receipt = await (await callerOf(logic)[fn](...args)).wait();
        expect(receipt!.logs, fn).to.have.length(0);
      }
    });
  });

  describe('views over the state', () => {
    const coder = ethers.AbiCoder.defaultAbiCoder();
    /** The slot of `key` in a mapping at `slot`. */
    const at = (keyType: string, key: unknown, slot: bigint | string) =>
      ethers.keccak256(coder.encode([keyType, 'uint256'], [key, slot]));
    const plant = async (slot: string, value: bigint) =>
      hre.network.provider.send('hardhat_setStorageAt', [await QIS.getAddress(), slot, ethers.toBeHex(value, 32)]);

    it('the list below covers every view', () => {
      const found: string[] = [];
      QIS.interface.forEachFunction((f) => {
        if (f.stateMutability === 'view' || f.stateMutability === 'pure') found.push(f.name);
      });
      expect(found.sort()).to.deep.equal(
        [
          'BPS_DENOMINATOR',
          'activationEpoch',
          'batchState',
          'budgetUsed',
          'accountFunding',
          'fundingIn',
          'fundingState',
          'getEpochTotals',
          'getNodeEpoch',
          'hub',
          'lambdaBps',
          'maxGroupsPerBatch',
          'maxItemsPerBatch',
          'name',
          'nonceWord',
          'paused',
          'version',
          'walletFunding',
        ].sort(),
      );
    });

    it('every view reads empty for keys never written', async () => {
      expect(await QIS.walletFunding(3n)).to.equal(0n);
      expect(await QIS.accountFunding(3n)).to.equal(0n);
      expect(await QIS.fundingIn(3n)).to.deep.equal([0n, 0n]);
      expect(await QIS.getEpochTotals(3n)).to.deep.equal([0n, 0n, 0n]);
      expect(await QIS.getNodeEpoch(1n, 3n)).to.deep.equal([0n, 0n]);
      expect(await QIS.budgetUsed(ID, 0n)).to.equal(0n);
      expect(await QIS.nonceWord(ID, 1n, 0n)).to.equal(0n);
    });

    it('fundingState and batchState read the parameters in one call', async () => {
      await QIS.setMaxGroupsPerBatch(9n);
      await QIS.setMaxItemsPerBatch(99n);
      await QIS.setPaused(true);
      expect(await QIS.fundingState()).to.deep.equal([0n, true]);
      expect(await QIS.batchState()).to.deep.equal([0n, true, 9n, 99n]);
      const now = await currentEpoch();
      await activateAt(now);
      expect(await QIS.fundingState()).to.deep.equal([now, true]);
      expect(await QIS.batchState()).to.deep.equal([now, true, 9n, 99n]);
    });

    it('slot 0 packs the hub with the activation epoch, the pause, the batch bounds and λ, in 31 of 32 bytes', async () => {
      const now = await currentEpoch();
      await QIS.setPaused(true);
      await QIS.setMaxGroupsPerBatch(9n);
      await QIS.setMaxItemsPerBatch(1_000n);
      await QIS.setLambdaBps(5_000n);
      await activateAt(now);
      const word = BigInt(await hre.ethers.provider.getStorage(await QIS.getAddress(), 0n));
      const field = (offset: bigint, bytes: bigint) => (word >> (offset * 8n)) & ((1n << (bytes * 8n)) - 1n);
      expect(field(0n, 20n)).to.equal(BigInt(await HubContract.getAddress()));
      expect(field(20n, 5n)).to.equal(now);
      expect(field(25n, 1n)).to.equal(1n);
      expect(field(26n, 1n)).to.equal(9n);
      expect(field(27n, 2n)).to.equal(1_000n);
      expect(field(29n, 2n)).to.equal(5_000n);
      expect(field(31n, 1n)).to.equal(0n);
    });

    it('each view reads its documented slot, 1 to 6, each record packed in one word', async () => {
      // Slot 1 walletFunding and slot 2 accountFunding, read alone and together.
      await plant(at('uint256', 3n, 1n), 23n);
      await plant(at('uint256', 3n, 2n), 29n);
      expect(await QIS.walletFunding(3n)).to.equal(23n);
      expect(await QIS.accountFunding(3n)).to.equal(29n);
      expect(await QIS.fundingIn(3n)).to.deep.equal([23n, 29n]);

      // Slot 3 epochTotals: ΣR, then ΣQIS after 120 bits, then λ after 240.
      await plant(at('uint256', 3n, 3n), (5_000n << 240n) | (11n << 120n) | 7n);
      expect(await QIS.getEpochTotals(3n)).to.deep.equal([7n, 11n, 5_000n]);

      // Slot 4 nodeEpoch: R, then the score after 128 bits.
      await plant(at('uint256', 3n, at('uint72', 5n, 4n)), (13n << 128n) | 9n);
      expect(await QIS.getNodeEpoch(5n, 3n)).to.deep.equal([9n, 13n]);

      // Slot 5 budgetUsed and slot 6 the nonce bitmap.
      await plant(at('uint8', 2n, at('bytes32', ID, 5n)), 21n);
      await plant(at('uint64', 4n, at('uint72', 5n, at('bytes32', ID, 6n))), 0xf0n);
      expect(await QIS.budgetUsed(ID, 2n)).to.equal(21n);
      expect(await QIS.nonceWord(ID, 5n, 4n)).to.equal(0xf0n);
    });

    it('countReceipts writes the records as the views read them', async () => {
      const e = await currentEpoch();
      await QIS.setLambdaBps(5_000n);
      await count(e, 100n, 70n, 40n);
      const read = async (slot: string) => BigInt(await hre.ethers.provider.getStorage(await QIS.getAddress(), slot));
      expect(await read(at('uint256', e, 3n))).to.equal((5_000n << 240n) | (40n << 120n) | 70n);
      expect(await read(at('uint256', e, at('uint72', 5n, 4n)))).to.equal((40n << 128n) | 70n);
      expect(await read(at('uint8', 3n, at('bytes32', ID, 5n)))).to.equal(100n);
    });
  });

  describe('storage layout', () => {
    type LayoutEntry = { label: string; slot: string; offset: number; type: string };
    type LayoutType = { label: string; numberOfBytes: string; members?: LayoutEntry[] };
    type StorageLayout = { storage: LayoutEntry[]; types: Record<string, LayoutType> };

    it('matches the documented layout: one packed parameter slot, then the mappings', async () => {
      const sourceName = 'contracts/storage/QueryInferenceStorage.sol';
      const buildInfo = await hre.artifacts.getBuildInfo(`${sourceName}:QueryInferenceStorage`);
      const layout = (
        buildInfo?.output.contracts[sourceName]?.QueryInferenceStorage as { storageLayout?: StorageLayout } | undefined
      )?.storageLayout;
      expect(layout, 'the build info has no storageLayout').to.not.equal(undefined);

      const rows = layout!.storage.map((s) => [s.slot, s.offset, s.label, layout!.types[s.type].label]);
      expect(rows).to.deep.equal([
        ['0', 0, 'hub', 'contract Hub'],
        ['0', 20, 'activationEpoch', 'uint40'],
        ['0', 25, 'paused', 'bool'],
        ['0', 26, 'maxGroupsPerBatch', 'uint8'],
        ['0', 27, 'maxItemsPerBatch', 'uint16'],
        ['0', 29, 'lambdaBps', 'uint16'],
        ['1', 0, 'walletFunding', 'mapping(uint256 => uint96)'],
        ['2', 0, 'accountFunding', 'mapping(uint256 => uint96)'],
        ['3', 0, '_epochTotals', 'mapping(uint256 => struct QueryInferenceStorage.EpochTotals)'],
        [
          '4',
          0,
          '_nodeEpoch',
          'mapping(uint72 => mapping(uint256 => struct QueryInferenceStorage.NodeEpoch))',
        ],
        ['5', 0, '_budgetUsed', 'mapping(bytes32 => mapping(uint8 => uint96))'],
        ['6', 0, '_nonceBitmap', 'mapping(bytes32 => mapping(uint72 => mapping(uint64 => uint256)))'],
      ]);

      // Slot 0 holds 31 of its 32 bytes.
      const last = layout!.storage.find((s) => s.label === 'lambdaBps')!;
      expect(last.offset + Number(layout!.types[last.type].numberOfBytes)).to.equal(31);

      // Each record fits one slot.
      const record = (name: string) =>
        Object.values(layout!.types).find((x) => x.label === `struct QueryInferenceStorage.${name}`)!;
      for (const name of ['EpochTotals', 'NodeEpoch']) {
        expect(record(name).numberOfBytes, name).to.equal('32');
      }
      expect(record('EpochTotals').members!.map((m) => [m.label, m.slot, m.offset])).to.deep.equal([
        ['totalServed', '0', 0],
        ['totalWeighted', '0', 15],
        ['lambdaBps', '0', 30],
      ]);
      expect(record('NodeEpoch').members!.map((m) => [m.label, m.slot, m.offset])).to.deep.equal([
        ['servedValue', '0', 0],
        ['weightedValue', '0', 16],
      ]);
    });
  });
});
