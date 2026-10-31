// QueryInferenceStorage: the policy-free state store of the query/inference
// reward pool (OT-RFC-27).
//
// Covers:
//   - the gates: every mutator is onlyContracts (a Hub-registered contract or
//     the Hub owner), every parameter setter is onlyHub (the Hub, through
//     forwardCall, or the Hub owner), and neither admits the other's callers;
//   - the parameters: defaults, bounds (a receipt grace below one epoch), the
//     pause, and an activation epoch set once and never to an ended epoch;
//   - the λ schedule: a change applies from the next epoch, at once while no
//     epoch from activation on has started, and a scheduled value is folded in
//     only once every epoch before it is closed;
//   - the receipt grace schedule: a change applies to the next epoch's periods,
//     at once while no epoch from activation on has started, and is refused in
//     the epoch where a scheduled value took effect;
//   - the due ledgers, wallet and Conviction Account: bookings accumulate per
//     epoch, each in its own ledger, and never land in a closed epoch;
//   - the settlement mutators: nonce bits are only ever set, a claim takes no
//     value once finalized and is finalized once, never into a closed epoch,
//     and epochs close one at a time, in order, from activation on;
//   - the views over the settlement state, and the compiler's storage layout
//     against the documented one.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import { Chronos, Hub, QueryInferenceStorage } from '../../typechain';

const MAX_UINT96 = (1n << 96n) - 1n;

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
  const forward = async (fn: string, args: unknown[] = []) =>
    HubContract.forwardCall(await QIS.getAddress(), QIS.interface.encodeFunctionData(fn, args));
  const activateAt = async (epoch: bigint) => forward('setActivationEpoch', [epoch]);

  describe('metadata and initialization', () => {
    it('is named QueryInferenceStorage, version 1.0.0, with a 10,000 bps denominator', async () => {
      expect(await QIS.name()).to.equal('QueryInferenceStorage');
      expect(await QIS.version()).to.equal('1.0.0');
      expect(await QIS.BPS_DENOMINATOR()).to.equal(10_000n);
      expect(await QIS.hub()).to.equal(await HubContract.getAddress());
    });

    it('initialize seeds the bounds and leaves activation, λ, the pause and the ledger at zero', async () => {
      expect(await QIS.receiptGraceSeconds()).to.equal(3_600n);
      expect(await QIS.maxItemsPerBatch()).to.equal(256n);
      expect(await QIS.maxGroupsPerBatch()).to.equal(32n);
      expect(await QIS.maxCloseStepsPerClaim()).to.equal(32n);
      expect(await QIS.activationEpoch()).to.equal(0n);
      expect(await QIS.lambdaBps()).to.equal(0n);
      expect(await QIS.nextLambdaBps()).to.equal(0n);
      expect(await QIS.nextLambdaFromEpoch()).to.equal(0n);
      expect(await QIS.paused()).to.equal(false);
      expect(await QIS.closedThrough()).to.equal(0n);
      expect(await QIS.carry()).to.equal(0n);
      expect(await QIS.fundingState()).to.deep.equal([0n, false]);
    });

    it('initialize is idempotent: a tuned bound survives a re-initialization', async () => {
      await QIS.setReceiptGraceSeconds(600n);
      await QIS.setMaxItemsPerBatch(64n);
      await forward('initialize');
      expect(await QIS.receiptGraceSeconds()).to.equal(600n);
      expect(await QIS.maxItemsPerBatch()).to.equal(64n);
      expect(await QIS.maxGroupsPerBatch()).to.equal(32n);
    });

    it('initialize is onlyHub: a Hub contract and a stranger are refused', async () => {
      for (const caller of [logic, stranger]) {
        await expect(QIS.connect(caller).initialize())
          .to.be.revertedWithCustomError(QIS, 'UnauthorizedAccess')
          .withArgs('Only Hub');
      }
    });
  });

  describe('parameter setters (onlyHub)', () => {
    const setters: Array<[string, unknown[]]> = [
      ['setActivationEpoch', [1_000_000n]],
      ['setReceiptGraceSeconds', [600n]],
      ['setMaxItemsPerBatch', [128n]],
      ['setMaxGroupsPerBatch', [16n]],
      ['setMaxCloseStepsPerClaim', [8n]],
      ['setPaused', [true]],
      ['setLambdaBps', [5_000n]],
    ];

    it('the list below covers every setter', () => {
      const found: string[] = [];
      QIS.interface.forEachFunction((f) => {
        if (f.stateMutability === 'nonpayable' && f.name.startsWith('set')) found.push(f.name);
      });
      expect(found.sort()).to.deep.equal(setters.map(([n]) => n).sort());
    });

    for (const [setter, args] of setters) {
      it(`${setter} refuses a Hub contract and a stranger, and admits the Hub owner and Hub.forwardCall`, async () => {
        for (const caller of [logic, stranger]) {
          await expect(
            (QIS.connect(caller) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[setter](...args),
          )
            .to.be.revertedWithCustomError(QIS, 'UnauthorizedAccess')
            .withArgs('Only Hub');
        }
        await (QIS.connect(owner) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[setter](...args);
        if (setter !== 'setActivationEpoch') await forward(setter, args);
      });
    }

    it('setReceiptGraceSeconds accepts 1 second to one second less than an epoch, so a deadline stays in the next epoch', async () => {
      for (const bad of [0n, epLen, epLen + 1n]) {
        await expect(QIS.setReceiptGraceSeconds(bad))
          .to.be.revertedWithCustomError(QIS, 'InvalidParameter')
          .withArgs('receiptGraceSeconds');
      }
      const now = await currentEpoch();
      await expect(QIS.setReceiptGraceSeconds(1n)).to.emit(QIS, 'ReceiptGraceSecondsSet').withArgs(1n, now);
      await expect(QIS.setReceiptGraceSeconds(epLen - 1n))
        .to.emit(QIS, 'ReceiptGraceSecondsSet')
        .withArgs(epLen - 1n, now);
      expect(await QIS.receiptGraceSeconds()).to.equal(epLen - 1n);
    });

    it('setMaxItemsPerBatch accepts 1 to 1,024', async () => {
      for (const bad of [0n, 1_025n]) {
        await expect(QIS.setMaxItemsPerBatch(bad))
          .to.be.revertedWithCustomError(QIS, 'InvalidParameter')
          .withArgs('maxItemsPerBatch');
      }
      await expect(QIS.setMaxItemsPerBatch(1n)).to.emit(QIS, 'MaxItemsPerBatchSet').withArgs(256n, 1n);
      await expect(QIS.setMaxItemsPerBatch(1_024n)).to.emit(QIS, 'MaxItemsPerBatchSet').withArgs(1n, 1_024n);
    });

    it('setMaxGroupsPerBatch and setMaxCloseStepsPerClaim accept 1 to 255', async () => {
      await expect(QIS.setMaxGroupsPerBatch(0n))
        .to.be.revertedWithCustomError(QIS, 'InvalidParameter')
        .withArgs('maxGroupsPerBatch');
      await expect(QIS.setMaxCloseStepsPerClaim(0n))
        .to.be.revertedWithCustomError(QIS, 'InvalidParameter')
        .withArgs('maxCloseStepsPerClaim');
      await expect(QIS.setMaxGroupsPerBatch(255n)).to.emit(QIS, 'MaxGroupsPerBatchSet').withArgs(32n, 255n);
      await expect(QIS.setMaxCloseStepsPerClaim(1n)).to.emit(QIS, 'MaxCloseStepsPerClaimSet').withArgs(32n, 1n);
    });

    it('setPaused switches the pause either way and emits it, and fundingState reads it', async () => {
      await expect(QIS.setPaused(true)).to.emit(QIS, 'PausedSet').withArgs(true);
      expect(await QIS.paused()).to.equal(true);
      expect((await QIS.fundingState())[1]).to.equal(true);
      await expect(QIS.setPaused(false)).to.emit(QIS, 'PausedSet').withArgs(false);
      expect(await QIS.paused()).to.equal(false);
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
    it('refuses 0 and an epoch that has ended, accepts the current epoch, and starts closedThrough before it', async () => {
      await time.increase(3n * epLen);
      const now = await currentEpoch();
      for (const bad of [0n, now - 1n, 1n]) {
        await expect(QIS.setActivationEpoch(bad))
          .to.be.revertedWithCustomError(QIS, 'InvalidParameter')
          .withArgs('activationEpoch');
      }
      await expect(activateAt(now)).to.emit(QIS, 'ActivationEpochSet').withArgs(now);
      expect(await QIS.activationEpoch()).to.equal(now);
      expect(await QIS.closedThrough()).to.equal(now - 1n);
      expect(await QIS.fundingState()).to.deep.equal([now, false]);
    });

    it('accepts a later epoch, and is set once: neither an earlier nor a later epoch replaces it', async () => {
      const next = (await currentEpoch()) + 1n;
      await activateAt(next);
      expect(await QIS.closedThrough()).to.equal(next - 1n);
      for (const again of [next, next + 5n]) {
        await expect(QIS.setActivationEpoch(again))
          .to.be.revertedWithCustomError(QIS, 'ActivationEpochAlreadySet')
          .withArgs(next);
      }
    });
  });

  describe('the λ schedule', () => {
    it('refuses more than 10,000 basis points and accepts 0 to 10,000', async () => {
      await expect(QIS.setLambdaBps(10_001n))
        .to.be.revertedWithCustomError(QIS, 'InvalidParameter')
        .withArgs('lambdaBps');
      await QIS.setLambdaBps(10_000n);
      await QIS.setLambdaBps(0n);
    });

    it('applies at once while activation is unset, or still ahead', async () => {
      const now = await currentEpoch();
      await expect(QIS.setLambdaBps(5_000n)).to.emit(QIS, 'LambdaBpsSet').withArgs(5_000n, now);
      expect(await QIS.lambdaBps()).to.equal(5_000n);
      expect(await QIS.nextLambdaFromEpoch()).to.equal(0n);
      expect(await QIS.lambdaBpsAt(now)).to.equal(5_000n);

      await activateAt(now + 2n);
      await QIS.setLambdaBps(2_500n);
      expect(await QIS.lambdaBps()).to.equal(2_500n);
      expect(await QIS.lambdaBpsAt(now + 2n)).to.equal(2_500n);
    });

    it('from activation on, a change applies from the next epoch, and a second change in the same epoch replaces it', async () => {
      await QIS.setLambdaBps(5_000n);
      const now = await currentEpoch();
      await activateAt(now);

      await expect(QIS.setLambdaBps(2_000n)).to.emit(QIS, 'LambdaBpsSet').withArgs(2_000n, now + 1n);
      expect(await QIS.lambdaBps()).to.equal(5_000n);
      expect(await QIS.nextLambdaBps()).to.equal(2_000n);
      expect(await QIS.nextLambdaFromEpoch()).to.equal(now + 1n);
      expect(await QIS.lambdaBpsAt(now)).to.equal(5_000n);
      expect(await QIS.lambdaBpsAt(now + 1n)).to.equal(2_000n);

      await QIS.setLambdaBps(7_000n);
      expect(await QIS.lambdaBpsAt(now)).to.equal(5_000n);
      expect(await QIS.lambdaBpsAt(now + 1n)).to.equal(7_000n);
      expect(await QIS.nextLambdaFromEpoch()).to.equal(now + 1n);
    });

    it('across an epoch boundary, folds the scheduled value in only once every epoch before it is closed', async () => {
      await QIS.setLambdaBps(5_000n);
      const e = await currentEpoch();
      await activateAt(e);
      await QIS.setLambdaBps(2_000n); // from e + 1
      await time.increase(epLen);
      expect(await currentEpoch()).to.equal(e + 1n);

      // Epoch e is still open: folding 2,000 in would change its λ.
      await expect(QIS.setLambdaBps(3_000n))
        .to.be.revertedWithCustomError(QIS, 'LambdaScheduleAheadOfCloses')
        .withArgs(e - 1n, e + 1n);

      // Once epoch e is closed (slot 2 is `closedThrough`), the change goes on.
      await hre.network.provider.send('hardhat_setStorageAt', [
        await QIS.getAddress(),
        ethers.toBeHex(2n, 32),
        ethers.toBeHex(e, 32),
      ]);
      await expect(QIS.setLambdaBps(3_000n)).to.emit(QIS, 'LambdaBpsSet').withArgs(3_000n, e + 2n);
      expect(await QIS.lambdaBps()).to.equal(2_000n);
      expect(await QIS.lambdaBpsAt(e + 1n)).to.equal(2_000n);
      expect(await QIS.lambdaBpsAt(e + 2n)).to.equal(3_000n);
    });
  });

  describe('the receipt grace schedule', () => {
    it('applies at once while activation is unset, or still ahead', async () => {
      const now = await currentEpoch();
      await expect(QIS.setReceiptGraceSeconds(600n)).to.emit(QIS, 'ReceiptGraceSecondsSet').withArgs(600n, now);
      expect(await QIS.receiptGraceSecondsAt(now)).to.equal(600n);
      await activateAt(now + 2n);
      await QIS.setReceiptGraceSeconds(900n);
      expect([await QIS.receiptGraceSeconds(), await QIS.nextReceiptGraceFromEpoch()]).to.deep.equal([900n, 0n]);
      expect(await QIS.receiptGraceSecondsAt(now + 2n)).to.equal(900n);
    });

    it("from activation on, a change applies to the next epoch's periods, and a second change in the same epoch replaces it", async () => {
      const now = await currentEpoch();
      await activateAt(now);
      await expect(QIS.setReceiptGraceSeconds(600n))
        .to.emit(QIS, 'ReceiptGraceSecondsSet')
        .withArgs(600n, now + 1n);
      expect(await QIS.receiptGraceSeconds()).to.equal(3_600n);
      expect([await QIS.nextReceiptGraceSeconds(), await QIS.nextReceiptGraceFromEpoch()]).to.deep.equal([
        600n,
        now + 1n,
      ]);
      expect(await QIS.receiptGraceSecondsAt(now)).to.equal(3_600n);
      expect(await QIS.receiptGraceSecondsAt(now + 1n)).to.equal(600n);
      expect(await QIS.receiptGraceSecondsAt(now + 9n)).to.equal(600n);

      await QIS.setReceiptGraceSeconds(1_200n);
      expect(await QIS.receiptGraceSecondsAt(now)).to.equal(3_600n);
      expect(await QIS.receiptGraceSecondsAt(now + 1n)).to.equal(1_200n);
    });

    it('in the epoch where a scheduled value took effect a change is refused, and from the next epoch on it folds it in', async () => {
      const e = await currentEpoch();
      await activateAt(e);
      await QIS.setReceiptGraceSeconds(600n); // for the periods of e + 1 on
      await time.increase(epLen);
      expect(await currentEpoch()).to.equal(e + 1n);

      // The periods of e are finalized now, under 3,600; those of e + 1 run under 600.
      await expect(QIS.setReceiptGraceSeconds(1_200n))
        .to.be.revertedWithCustomError(QIS, 'ReceiptGraceScheduleInUse')
        .withArgs(e + 1n);
      expect(await QIS.receiptGraceSecondsAt(e)).to.equal(3_600n);

      await time.increase(epLen);
      await expect(QIS.setReceiptGraceSeconds(1_200n))
        .to.emit(QIS, 'ReceiptGraceSecondsSet')
        .withArgs(1_200n, e + 3n);
      expect(await QIS.receiptGraceSeconds()).to.equal(600n);
      expect(await QIS.receiptGraceSecondsAt(e + 1n)).to.equal(600n);
      expect(await QIS.receiptGraceSecondsAt(e + 2n)).to.equal(600n);
      expect(await QIS.receiptGraceSecondsAt(e + 3n)).to.equal(1_200n);
    });

    it('keeps every value below one epoch, scheduled or not', async () => {
      await activateAt(await currentEpoch());
      await expect(QIS.setReceiptGraceSeconds(epLen))
        .to.be.revertedWithCustomError(QIS, 'InvalidParameter')
        .withArgs('receiptGraceSeconds');
      await QIS.setReceiptGraceSeconds(epLen - 1n);
      expect(await QIS.nextReceiptGraceSeconds()).to.equal(epLen - 1n);
    });
  });

  describe('the due ledger (onlyContracts)', () => {
    it('the list below covers every state-changing function except initialize and the setters', () => {
      const stateChanging: string[] = [];
      QIS.interface.forEachFunction((f) => {
        if (f.stateMutability === 'nonpayable' && f.name !== 'initialize' && !f.name.startsWith('set')) {
          stateChanging.push(f.name);
        }
      });
      expect(stateChanging.sort()).to.deep.equal(
        ['addClaim', 'addConvictionDue', 'addWalletDue', 'closeEpoch', 'finalizeClaim', 'useNonces'].sort(),
      );
    });

    it('addWalletDue refuses a caller outside the Hub, and admits a Hub contract and the Hub owner', async () => {
      await expect(QIS.connect(stranger).addWalletDue(5n, 1n))
        .to.be.revertedWithCustomError(QIS, 'UnauthorizedAccess')
        .withArgs('Only Contracts in Hub');
      await QIS.connect(logic).addWalletDue(5n, 1n);
      await QIS.connect(owner).addWalletDue(5n, 2n);
      expect(await QIS.walletDue(5n)).to.equal(3n);
    });

    it('accumulates per epoch, and reverts on overflow instead of wrapping', async () => {
      await QIS.connect(logic).addWalletDue(7n, 10n);
      await QIS.connect(logic).addWalletDue(8n, 4n);
      await QIS.connect(logic).addWalletDue(7n, 5n);
      expect(await QIS.walletDue(7n)).to.equal(15n);
      expect(await QIS.walletDue(8n)).to.equal(4n);
      expect(await QIS.walletDue(9n)).to.equal(0n);

      await QIS.connect(logic).addWalletDue(20n, MAX_UINT96);
      await expect(QIS.connect(logic).addWalletDue(20n, 1n)).to.be.revertedWithPanic(0x11);
    });

    it('never books into a closed epoch, whose inputs are frozen', async () => {
      await time.increase(2n * epLen);
      const now = await currentEpoch();
      await activateAt(now);
      await expect(QIS.connect(logic).addWalletDue(now - 1n, 1n))
        .to.be.revertedWithCustomError(QIS, 'EpochClosed')
        .withArgs(now - 1n, now - 1n);
      await QIS.connect(logic).addWalletDue(now, 1n);
      await QIS.connect(logic).addWalletDue(now + 1n, 1n);
    });

    it('addConvictionDue refuses a caller outside the Hub, and admits a Hub contract and the Hub owner', async () => {
      await expect(QIS.connect(stranger).addConvictionDue(5n, 1n))
        .to.be.revertedWithCustomError(QIS, 'UnauthorizedAccess')
        .withArgs('Only Contracts in Hub');
      await QIS.connect(logic).addConvictionDue(5n, 1n);
      await QIS.connect(owner).addConvictionDue(5n, 2n);
      expect(await QIS.convictionDue(5n)).to.equal(3n);
    });

    it('the Conviction Account ledger accumulates per epoch apart from the wallet one, and reverts on overflow', async () => {
      await QIS.connect(logic).addConvictionDue(7n, 10n);
      await QIS.connect(logic).addWalletDue(7n, 3n);
      await QIS.connect(logic).addConvictionDue(8n, 4n);
      await QIS.connect(logic).addConvictionDue(7n, 5n);
      expect(await QIS.convictionDue(7n)).to.equal(15n);
      expect(await QIS.walletDue(7n)).to.equal(3n);
      expect(await QIS.convictionDue(8n)).to.equal(4n);
      expect(await QIS.walletDue(8n)).to.equal(0n);
      expect(await QIS.convictionDue(9n)).to.equal(0n);
      expect(await QIS.dueIn(7n)).to.deep.equal([3n, 15n]);
      expect(await QIS.dueIn(8n)).to.deep.equal([0n, 4n]);
      expect(await QIS.dueIn(9n)).to.deep.equal([0n, 0n]);

      await QIS.connect(logic).addConvictionDue(20n, MAX_UINT96);
      await expect(QIS.connect(logic).addConvictionDue(20n, 1n)).to.be.revertedWithPanic(0x11);
      // The two ledgers are separate words, so a full one leaves the other open.
      await QIS.connect(logic).addWalletDue(20n, MAX_UINT96);
      expect(await QIS.dueIn(20n)).to.deep.equal([MAX_UINT96, MAX_UINT96]);
    });

    it('never books Conviction Account cost into a closed epoch', async () => {
      await time.increase(2n * epLen);
      const now = await currentEpoch();
      await activateAt(now);
      await expect(QIS.connect(logic).addConvictionDue(now - 1n, 1n))
        .to.be.revertedWithCustomError(QIS, 'EpochClosed')
        .withArgs(now - 1n, now - 1n);
      await QIS.connect(logic).addConvictionDue(now, 1n);
      await QIS.connect(logic).addConvictionDue(now + 1n, 1n);
      await QIS.connect(logic).closeEpoch(now, 0n, 0n, 0n);
      await expect(QIS.connect(logic).addConvictionDue(now, 1n))
        .to.be.revertedWithCustomError(QIS, 'EpochClosed')
        .withArgs(now, now);
      expect(await QIS.dueIn(now)).to.deep.equal([0n, 1n]);
    });
  });

  describe('the settlement mutators (onlyContracts)', () => {
    const id = ethers.id('period');
    const calls = (): Array<[string, unknown[]]> => [
      ['useNonces', [id, 5n, 0n, 1n]],
      ['addClaim', [id, 0n, 5n, 10n, 7n]],
      ['finalizeClaim', [id, 1n, 5n, 1_000n, 10n, 7n]],
      ['closeEpoch', [1_000n, 1n, 0n, 0n]],
    ];

    it('each refuses a caller outside the Hub', async () => {
      for (const [fn, args] of calls()) {
        await expect(
          (QIS.connect(stranger) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[fn](...args),
          fn,
        )
          .to.be.revertedWithCustomError(QIS, 'UnauthorizedAccess')
          .withArgs('Only Contracts in Hub');
      }
    });

    it('useNonces only ever sets bits, per period, seller and word', async () => {
      await QIS.connect(logic).useNonces(id, 5n, 2n, 0b0101n);
      await QIS.connect(owner).useNonces(id, 5n, 2n, 0b0011n);
      await QIS.connect(logic).useNonces(id, 5n, 2n, 0n);
      expect(await QIS.nonceWord(id, 5n, 2n)).to.equal(0b0111n);
      expect(await QIS.nonceWord(id, 5n, 3n)).to.equal(0n);
      expect(await QIS.nonceWord(id, 6n, 2n)).to.equal(0n);
      expect(await QIS.nonceWord(ethers.id('other'), 5n, 2n)).to.equal(0n);
    });

    it('addClaim adds to the seller and the bucket, checked, and finalizeClaim credits the node and the epoch once', async () => {
      const now = await currentEpoch();
      await activateAt(now);
      await QIS.connect(logic).addClaim(id, 3n, 5n, 100n, 40n);
      await QIS.connect(logic).addClaim(id, 3n, 5n, 50n, 10n);
      await QIS.connect(logic).addClaim(id, 3n, 6n, 30n, 30n);
      expect(await QIS.getSellerClaim(id, 3n, 5n)).to.deep.equal([150n, 50n, false]);
      expect(await QIS.getSellerClaim(id, 3n, 6n)).to.deep.equal([30n, 30n, false]);
      expect(await QIS.bucketClaimed(id, 3n)).to.equal(180n);
      await expect(QIS.connect(logic).addClaim(id, 3n, 5n, MAX_UINT96, 0n)).to.be.revertedWithPanic(0x11);

      await QIS.connect(logic).finalizeClaim(id, 3n, 5n, now, 120n, 45n);
      await QIS.connect(logic).finalizeClaim(id, 3n, 6n, now, 30n, 30n);
      expect(await QIS.getSellerClaim(id, 3n, 5n)).to.deep.equal([150n, 50n, true]);
      expect(await QIS.getNodeEpoch(5n, now)).to.deep.equal([120n, 45n]);
      expect(await QIS.getNodeEpoch(6n, now)).to.deep.equal([30n, 30n]);
      expect(await QIS.getEpochTotals(now)).to.deep.equal([150n, 75n]);

      for (const call of [
        QIS.connect(logic).finalizeClaim(id, 3n, 5n, now, 1n, 1n),
        QIS.connect(logic).addClaim(id, 3n, 5n, 1n, 1n),
      ]) {
        await expect(call).to.be.revertedWithCustomError(QIS, 'ClaimFinalized').withArgs(id, 3n, 5n);
      }
      // Another bucket of the period, and another seller, are claims of their own.
      await QIS.connect(logic).addClaim(id, 4n, 5n, 1n, 1n);
      await QIS.connect(logic).addClaim(id, 3n, 7n, 1n, 1n);
    });

    it('finalizeClaim never credits a closed epoch', async () => {
      await time.increase(2n * epLen);
      const now = await currentEpoch();
      await activateAt(now);
      await expect(QIS.connect(logic).finalizeClaim(id, 0n, 5n, now - 1n, 1n, 1n))
        .to.be.revertedWithCustomError(QIS, 'EpochClosed')
        .withArgs(now - 1n, now - 1n);
    });

    it('closeEpoch closes one epoch at a time, in order from activation, and sets the record, the cursor and the carry', async () => {
      await expect(QIS.connect(logic).closeEpoch(1n, 0n, 0n, 0n))
        .to.be.revertedWithCustomError(QIS, 'CloseOutOfOrder')
        .withArgs(1n, 0n);
      const now = await currentEpoch();
      await activateAt(now);
      for (const e of [now - 1n, now + 1n]) {
        await expect(QIS.connect(logic).closeEpoch(e, 0n, 0n, 0n))
          .to.be.revertedWithCustomError(QIS, 'CloseOutOfOrder')
          .withArgs(e, now - 1n);
      }
      await QIS.connect(logic).closeEpoch(now, 0n, 5_000n, 77n);
      expect(await QIS.getEpochClose(now)).to.deep.equal([0n, 0n, 5_000n, true]);
      expect([await QIS.closedThrough(), await QIS.carry()]).to.deep.equal([now, 77n]);
      await QIS.connect(owner).closeEpoch(now + 1n, 77n, 2_500n, 0n);
      expect(await QIS.getEpochClose(now + 1n)).to.deep.equal([77n, 0n, 2_500n, true]);
      expect([await QIS.closedThrough(), await QIS.carry()]).to.deep.equal([now + 1n, 0n]);
      await expect(QIS.connect(logic).closeEpoch(now + 1n, 0n, 0n, 0n))
        .to.be.revertedWithCustomError(QIS, 'CloseOutOfOrder')
        .withArgs(now + 1n, now + 1n);
      // A closed epoch takes no booking and no credit.
      await expect(QIS.connect(logic).addWalletDue(now + 1n, 1n)).to.be.revertedWithCustomError(QIS, 'EpochClosed');
    });

    it('batchState and closeState read the parameters and the cursor in one call', async () => {
      await QIS.setMaxGroupsPerBatch(9n);
      await QIS.setMaxItemsPerBatch(99n);
      await QIS.setMaxCloseStepsPerClaim(7n);
      await QIS.setPaused(true);
      expect(await QIS.batchState()).to.deep.equal([0n, true, 9n, 99n]);
      expect(await QIS.closeState()).to.deep.equal([0n, 0n, 0n, 7n]);
      const now = await currentEpoch();
      await activateAt(now);
      expect(await QIS.batchState()).to.deep.equal([now, true, 9n, 99n]);
      expect(await QIS.closeState()).to.deep.equal([now, now - 1n, 0n, 7n]);
    });
  });

  describe('views over the settlement state', () => {
    const coder = ethers.AbiCoder.defaultAbiCoder();
    /** The slot of `key` in a mapping at `slot`. */
    const at = (keyType: string, key: unknown, slot: bigint | string) =>
      ethers.keccak256(coder.encode([keyType, 'uint256'], [key, slot]));
    const plant = async (slot: string, value: bigint) =>
      hre.network.provider.send('hardhat_setStorageAt', [await QIS.getAddress(), slot, ethers.toBeHex(value, 32)]);

    it('every view reads empty for keys never written', async () => {
      const id = ethers.id('period');
      expect((await QIS.getEpochClose(3n)).closed).to.equal(false);
      expect((await QIS.getEpochTotals(3n)).sumR).to.equal(0n);
      expect((await QIS.getNodeEpoch(1n, 3n)).score).to.equal(0n);
      expect(await QIS.bucketClaimed(id, 0n)).to.equal(0n);
      expect((await QIS.getSellerClaim(id, 0n, 1n)).finalized).to.equal(false);
      expect(await QIS.nonceWord(id, 1n, 0n)).to.equal(0n);
    });

    it('each view reads its documented slot', async () => {
      const id = ethers.id('period');
      // Slot 6 epochTotals, slot 7 nodeEpoch, slot 8 bucketClaimed, slot 9
      // sellerClaim and slot 10 nonceBitmap, each a packed word.
      await plant(at('uint256', 3n, 6n), (11n << 128n) | 7n);
      await plant(at('uint256', 3n, at('uint72', 5n, 7n)), (13n << 128n) | 9n);
      await plant(at('uint8', 2n, at('bytes32', id, 8n)), 21n);
      await plant(at('uint72', 5n, at('uint8', 2n, at('bytes32', id, 9n))), (1n << 192n) | (17n << 96n) | 19n);
      await plant(at('uint64', 4n, at('uint72', 5n, at('bytes32', id, 10n))), 0xf0n);

      expect(await QIS.getEpochTotals(3n)).to.deep.equal([7n, 11n]);
      expect(await QIS.getNodeEpoch(5n, 3n)).to.deep.equal([9n, 13n]);
      expect(await QIS.bucketClaimed(id, 2n)).to.equal(21n);
      expect(await QIS.getSellerClaim(id, 2n, 5n)).to.deep.equal([19n, 17n, true]);
      expect(await QIS.nonceWord(id, 5n, 4n)).to.equal(0xf0n);

      // Slot 5 epochClose: pool, label, lambdaBps and closed in one word.
      await plant(at('uint256', 3n, 5n), (1n << 208n) | (5_000n << 192n) | (2n << 96n) | 3n);
      expect(await QIS.getEpochClose(3n)).to.deep.equal([3n, 2n, 5_000n, true]);

      // Slot 4 walletDue and slot 11 convictionDue, read alone and together.
      await plant(at('uint256', 3n, 4n), 23n);
      await plant(at('uint256', 3n, 11n), 29n);
      expect(await QIS.walletDue(3n)).to.equal(23n);
      expect(await QIS.convictionDue(3n)).to.equal(29n);
      expect(await QIS.dueIn(3n)).to.deep.equal([23n, 29n]);
    });
  });

  describe('storage layout', () => {
    type LayoutEntry = { label: string; slot: string; offset: number; type: string };
    type LayoutType = { label: string; numberOfBytes: string };
    type StorageLayout = { storage: LayoutEntry[]; types: Record<string, LayoutType> };

    it('matches the documented layout: two packed parameter slots, closedThrough, carry, then the mappings', async () => {
      // Slot 1 holds 20 of 32 bytes: the item bound, the λ schedule and the
      // scheduled receipt grace.
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
        ['0', 25, 'receiptGraceSeconds', 'uint32'],
        ['0', 29, 'paused', 'bool'],
        ['0', 30, 'maxGroupsPerBatch', 'uint8'],
        ['0', 31, 'maxCloseStepsPerClaim', 'uint8'],
        ['1', 0, 'maxItemsPerBatch', 'uint16'],
        ['1', 2, 'lambdaBps', 'uint16'],
        ['1', 4, 'nextLambdaBps', 'uint16'],
        ['1', 6, 'nextLambdaFromEpoch', 'uint40'],
        ['1', 11, 'nextReceiptGraceSeconds', 'uint32'],
        ['1', 15, 'nextReceiptGraceFromEpoch', 'uint40'],
        ['2', 0, 'closedThrough', 'uint256'],
        ['3', 0, 'carry', 'uint96'],
        ['4', 0, 'walletDue', 'mapping(uint256 => uint96)'],
        ['5', 0, '_epochClose', 'mapping(uint256 => struct QueryInferenceStorage.EpochClose)'],
        ['6', 0, '_epochTotals', 'mapping(uint256 => struct QueryInferenceStorage.EpochTotals)'],
        [
          '7',
          0,
          '_nodeEpoch',
          'mapping(uint72 => mapping(uint256 => struct QueryInferenceStorage.NodeEpoch))',
        ],
        ['8', 0, '_bucketClaimed', 'mapping(bytes32 => mapping(uint8 => uint128))'],
        [
          '9',
          0,
          '_sellerClaim',
          'mapping(bytes32 => mapping(uint8 => mapping(uint72 => struct QueryInferenceStorage.SellerClaim)))',
        ],
        ['10', 0, '_nonceBitmap', 'mapping(bytes32 => mapping(uint72 => mapping(uint64 => uint256)))'],
        ['11', 0, 'convictionDue', 'mapping(uint256 => uint96)'],
      ]);

      // Each record fits one slot.
      for (const name of ['EpochClose', 'EpochTotals', 'NodeEpoch', 'SellerClaim']) {
        const t = Object.values(layout!.types).find((x) => x.label === `struct QueryInferenceStorage.${name}`)!;
        expect(t.numberOfBytes, name).to.equal('32');
      }
    });
  });
});
