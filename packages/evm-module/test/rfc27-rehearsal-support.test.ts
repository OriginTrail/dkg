// The OT-RFC-27 fork rehearsal's own support, on what it must catch when the
// contracts or the fork misbehave. None of this needs a fork: the failures are
// fed to the code that has to notice them.

import { expect } from 'chai';
import hre from 'hardhat';

import { PoolModel, scheduleModel } from './helpers/emission-model';
import { ParametersConfig, contractParameters } from '../utils/helpers';
import { Fork } from '../scripts/rfc27/fork';
import { expectedParameterIn, requireParameter } from '../scripts/rfc27/parameters';
import { capturedFactorHolds, groupFault, grossOf, poolsFromMoney, receiptFault, stakeFactorFrom } from '../scripts/rfc27/reads';
import { Report, Redactor } from '../scripts/rfc27/report';
import { TX_GAS_CAP, TxOverGasCap, TxReverted, TxRunner, gasLimitFor } from '../scripts/rfc27/tx';
import { Ctx, send } from '../scripts/rfc27/rehearsal/context';
import { StoredAccount, bookedBy1020, checkClaims, checkSettleMany, checkSettledAccounts } from '../scripts/rfc27/rehearsal/existing';
import { checkLateBooking } from '../scripts/rfc27/rehearsal/late-booking';
import { claimAll } from '../scripts/rfc27/rehearsal/operations';
import { closedWindows } from '../scripts/rfc27/rehearsal/reads';
import { checkQuietClaim } from '../scripts/rfc27/rehearsal/unused';
import { passedResults } from '../scripts/rfc27/rehearsal/results';
import type { ClaimResult, Position } from '../scripts/rfc27/rehearsal/results';

/** A report that keeps its checks and prints nothing. */
class QuietReport extends Report {
  constructor() {
    super(new Redactor());
  }
  override say(): void {}
}

const HASH = `0x${'ab'.repeat(32)}`;

describe('@unit the OT-RFC-27 rehearsal support', () => {
  describe('a transaction that fails', () => {
    /** A context over stubs: the chain answers `chain`, and anything else is a failure of the test. */
    const contextOver = (chain: { estimateGas: () => Promise<bigint>; receipt?: { hash: string; status: number; gasUsed: bigint; blockNumber: number } }, traces: string[]) => {
      const report = new QuietReport();
      const hre = {
        ethers: { provider: { estimateGas: chain.estimateGas, getTransactionReceipt: async () => chain.receipt } },
        network: {
          provider: {
            send: async (method: string, params: unknown[]) => {
              if (method !== 'debug_traceTransaction') throw new Error(`unexpected ${method}`);
              traces.push(String(params[0]));
              return { error: 'execution reverted', to: '0x00000000000000000000000000000000000000aa', input: '0x12345678ff', gas: '0x10' };
            },
          },
        },
      };
      return { hre, report, txs: [], tx: new TxRunner(hre as unknown as Ctx['hre'], report) } as unknown as Ctx;
    };
    const signer = { getAddress: async () => '0x00000000000000000000000000000000000000bb', sendTransaction: async () => ({ hash: HASH }) } as unknown as Parameters<typeof send>[2];

    it('carries its receipt to the wrapper, which asks for the failing frame from its fields, not its message', async () => {
      const traces: string[] = [];
      const ctx = contextOver({ estimateGas: async () => 21_000n, receipt: { hash: HASH, status: 0, gasUsed: 7n, blockNumber: 1 } }, traces);
      let thrown: unknown;
      await send(ctx, 'someone: something', signer, '0x00000000000000000000000000000000000000aa', '0x').catch((e: unknown) => {
        thrown = e;
      });
      expect(thrown).to.be.instanceOf(TxReverted);
      const reverted = thrown as TxReverted;
      expect(reverted.receipt.hash).to.equal(HASH);
      expect(reverted.gasLimit).to.equal(76_250n);
      expect(reverted.message).to.equal(`someone: something: transaction ${HASH} reverted on chain, gas used 7 of 76250`);
      expect(traces).to.deep.equal([HASH]);
      expect(ctx.txs).to.deep.equal([
        { label: 'someone: something', hash: HASH, status: 0, error: 'execution reverted in a call to 0x00000000000000000000000000000000000000aa (0x12345678) with 16 gas' },
      ]);
    });

    it('asks for no trace of a transaction that was never included', async () => {
      const traces: string[] = [];
      const ctx = contextOver({ estimateGas: async () => Promise.reject(new Error('refused')) }, traces);
      let thrown: unknown;
      await send(ctx, 'someone: something', signer, '0x00000000000000000000000000000000000000aa', '0x').catch((e: unknown) => {
        thrown = e;
      });
      expect(thrown).to.not.be.instanceOf(TxReverted);
      expect(traces).to.deep.equal([]);
      expect(ctx.txs).to.have.length(1);
      expect(ctx.txs[0].status).to.equal('reverted before inclusion');
      expect(ctx.txs[0].hash).to.equal(undefined);
    });
  });

  describe("Base's 2^24 gas cap, which anvil does not enforce", () => {
    /** A runner over a chain that estimates `estimate`, and a signer that keeps what it is asked to send. */
    const over = (estimate: bigint) => {
      const report = new QuietReport();
      const hre = {
        ethers: { provider: { estimateGas: async () => estimate, getTransactionReceipt: async () => ({ hash: HASH, status: 1, gasUsed: 7n, blockNumber: 1 }) } },
      };
      const sent: { gasLimit?: bigint }[] = [];
      const signer = {
        getAddress: async () => '0x00000000000000000000000000000000000000bb',
        sendTransaction: async (t: { gasLimit?: bigint }) => {
          sent.push(t);
          return { hash: HASH };
        },
      };
      const tx = { label: 'someone: something', signer: signer as unknown as Parameters<TxRunner['run']>[0]['signer'], to: '0x00000000000000000000000000000000000000aa', data: '0x' };
      return { report, sent, tx, runner: new TxRunner(hre as unknown as Ctx['hre'], report) };
    };

    for (const estimate of [TX_GAS_CAP, TX_GAS_CAP + 1n]) {
      it(`sends nothing with an estimate of ${estimate}, fails the check, and says why`, async () => {
        const { report, sent, tx, runner } = over(estimate);
        let thrown: unknown;
        await runner.run(tx).catch((e: unknown) => {
          thrown = e;
        });
        expect(thrown).to.be.instanceOf(TxOverGasCap);
        expect((thrown as TxOverGasCap).estimate).to.equal(estimate);
        expect(sent).to.deep.equal([]);
        expect(report.checks.filter((c) => !c.ok).map((c) => c.label)).to.deep.equal(['someone: something fits the 2^24 gas cap']);
      });
    }

    it('sends an estimate just under the cap, with a gas limit still under it', async () => {
      const { report, sent, tx, runner } = over(TX_GAS_CAP - 1n);
      const mined = await runner.run(tx);
      expect(mined.gasLimit).to.equal(TX_GAS_CAP - 1n);
      expect(sent.map((s) => s.gasLimit)).to.deep.equal([TX_GAS_CAP - 1n]);
      expect(report.checks.filter((c) => !c.ok)).to.deep.equal([]);
    });

    it('pads an estimate by a quarter and 50,000, and never above the cap', () => {
      expect(gasLimitFor(1_000_000n)).to.equal(1_300_000n);
      const paddedToTheCap = ((TX_GAS_CAP - 50_000n) * 4n) / 5n;
      expect(gasLimitFor(paddedToTheCap - 1n)).to.be.lessThan(TX_GAS_CAP);
      expect(gasLimitFor(paddedToTheCap + 1n)).to.equal(TX_GAS_CAP - 1n);
    });
  });

  describe('a snapshot', () => {
    const address = '0x00000000000000000000000000000000000000cc';
    const fork = () => new Fork(hre, { chainId: 31337n, client: 'test', local: true, name: 'the in-process chain' }, new QuietReport());
    const change = async (wei: bigint) => {
      await hre.network.provider.send('hardhat_setBalance', [address, hre.ethers.toQuantity(wei)]);
      await hre.network.provider.send('evm_mine', []);
    };
    const state = async () => [await hre.ethers.provider.getBlockNumber(), await hre.ethers.provider.getBalance(address)];

    it('is reverted when its body succeeds, and gives back what the body returned', async () => {
      const before = await state();
      expect(await fork().inSnapshot(async () => (await change(5n), 'out'))).to.equal('out');
      expect(await state()).to.deep.equal(before);
    });

    it('is reverted when its body throws, and the body\'s error is the one that reaches the caller', async () => {
      const before = await state();
      let thrown: unknown;
      await fork()
        .inSnapshot(async () => {
          await change(5n);
          throw new Error('the deploy failed');
        })
        .catch((e: unknown) => {
          thrown = e;
        });
      expect((thrown as Error).message).to.equal('the deploy failed');
      expect(await state()).to.deep.equal(before);
    });

    it('nested, restores each level when the inner body throws', async () => {
      const f = fork();
      const before = await state();
      let outerSaw: bigint | undefined;
      await f
        .inSnapshot(async () => {
          await change(5n);
          const mid = await state();
          await f
            .inSnapshot(async () => {
              await change(9n);
              throw new Error('inner');
            })
            .catch(() => undefined);
          expect(await state()).to.deep.equal(mid);
          outerSaw = await hre.ethers.provider.getBalance(address);
          throw new Error('outer');
        })
        .catch((e: unknown) => {
          expect((e as Error).message).to.equal('outer');
        });
      expect(outerSaw).to.equal(5n);
      expect(await state()).to.deep.equal(before);
    });

    it('a failed revert does not hide the body\'s error, and fails the call when the body succeeded', async () => {
      class Stale extends Fork {
        override async revert(): Promise<void> {
          throw new Error('evm_revert failed');
        }
      }
      const f = new Stale(hre, { chainId: 31337n, client: 'test', local: true, name: 'the in-process chain' }, new QuietReport());
      const message = (p: Promise<unknown>) => p.then(() => 'no error', (e: unknown) => (e as Error).message);
      expect(await message(f.inSnapshot(async () => Promise.reject(new Error('the body failed'))))).to.equal('the body failed');
      expect(await message(f.inSnapshot(async () => 'fine'))).to.equal('evm_revert failed');
    });
  });

  describe('a phase, run in a snapshot that stays only if it succeeds', () => {
    const address = '0x00000000000000000000000000000000000000cd';
    const local = { chainId: 31337n, client: 'test', local: true, name: 'the in-process chain' };
    const change = async (wei: bigint) => {
      await hre.network.provider.send('hardhat_setBalance', [address, hre.ethers.toQuantity(wei)]);
      await hre.network.provider.send('evm_mine', []);
    };
    const state = async () => [await hre.ethers.provider.getBlockNumber(), await hre.ethers.provider.getBalance(address)];

    it('keeps what a successful phase did, for the next one', async () => {
      const before = await state();
      await new Fork(hre, local, new QuietReport()).undoIfFailed(() => change(5n), () => false);
      expect(await hre.ethers.provider.getBalance(address)).to.equal(5n);
      expect((await state())[0]).to.equal((before[0] as number) + 1);
    });

    it('undoes a phase that throws, and passes its error on, so a retry starts clean', async () => {
      const report = new QuietReport();
      const f = new Fork(hre, local, report);
      await change(1n);
      const before = await state();
      let thrown: unknown;
      await f
        .undoIfFailed(async () => {
          await change(5n);
          throw new Error('REHEARSAL_FAIL_AT: stopping');
        }, () => false)
        .catch((e: unknown) => {
          thrown = e;
        });
      expect((thrown as Error).message).to.equal('REHEARSAL_FAIL_AT: stopping');
      expect(await state()).to.deep.equal(before);
      await f.undoIfFailed(() => change(6n), () => false);
      expect(await hre.ethers.provider.getBalance(address)).to.equal(6n);
    });

    it('undoes a phase that ended with a failed check, without an error of its own', async () => {
      const report = new QuietReport();
      await change(1n);
      const before = await state();
      await new Fork(hre, local, report).undoIfFailed(async () => {
        await change(5n);
        report.check('something', false);
      }, () => report.failed > 0);
      expect(await state()).to.deep.equal(before);
      expect(report.failed).to.equal(1);
    });

    it('survives a failed revert: the phase\'s error stands, and without one the revert\'s reaches the caller', async () => {
      class Stale extends Fork {
        override async revert(): Promise<void> {
          throw new Error('evm_revert failed');
        }
      }
      const f = new Stale(hre, local, new QuietReport());
      const message = (p: Promise<unknown>) => p.then(() => 'no error', (e: unknown) => (e as Error).message);
      expect(await message(f.undoIfFailed(async () => Promise.reject(new Error('the phase failed')), () => false))).to.equal('the phase failed');
      expect(await message(f.undoIfFailed(async () => undefined, () => true))).to.equal('evm_revert failed');
    });

    it('later phases refuse the results file of a phase that failed its checks', () => {
      const passed = { activation: '660', checks: [['a', true, 'x'], ['b', true]] };
      expect(passedResults('hub', 'hub.json', passed)).to.equal(passed);
      const none = { activation: '660' };
      expect(passedResults('hub', 'hub.json', none)).to.equal(none);
      expect(() => passedResults('hub', 'hub.json', { checks: [['a', true], ['b', false, 'why']] })).to.throw('hub.json records 1 failed check, whose phase was undone: run PHASE=hub again');
    });
  });

  describe('a claim', () => {
    const position = { tokenId: 7n, owner: '0x00000000000000000000000000000000000000dd', node: 3n } as Position;
    /** One claim on stubs: the position's fields before it, and after it. */
    const claim = async (before: { raw: bigint; cumulativeRewardsClaimed: bigint }, after: { raw: bigint; cumulativeRewardsClaimed: bigint }) => {
      const report = new QuietReport();
      const reads = [before, after];
      const ctx = {
        report,
        txs: [],
        fork: { impersonate: async () => ({}), setEth: async () => undefined },
        tx: { run: async () => ({ receipt: { hash: HASH, blockNumber: 1, from: '0x', to: '0x', gasUsed: 1n, status: 1 }, estimate: 1n, gasLimit: 1n }) },
        base: {
          snft: { getAddress: async () => '0x00000000000000000000000000000000000000ee', interface: { encodeFunctionData: () => '0x' } },
          css: { getPosition: async () => ({ ...reads.shift(), lastClaimedEpoch: 5n }) },
        },
      } as unknown as Ctx;
      const [out] = await claimAll(ctx, [position], 'test');
      return { out, report };
    };

    it('passes when the reward reaches the raw stake', async () => {
      const { out, report } = await claim({ raw: 100n, cumulativeRewardsClaimed: 0n }, { raw: 110n, cumulativeRewardsClaimed: 10n });
      expect(out.reward).to.equal(10n);
      expect(out.rawDelta).to.equal(10n);
      expect(report.failed).to.equal(0);
    });

    it('fails when a claim moves the statistic and credits no stake', async () => {
      const { out, report } = await claim({ raw: 100n, cumulativeRewardsClaimed: 0n }, { raw: 100n, cumulativeRewardsClaimed: 10n });
      expect(out.reward).to.equal(10n);
      expect(out.rawDelta).to.equal(0n);
      expect(report.failed).to.equal(1);
    });
  });

  describe('a late booking', () => {
    const DAY = 86_400n;
    const LOCK = 12n;
    const B = 1_000n * 10n ** 18n;
    const CREATED = 100n * DAY + 3_000n;
    /** A settle in the epoch that holds 5.5 billing windows after the account's creation. */
    const AT = CREATED + 5n * DAY + DAY / 2n;
    const E = AT / DAY;
    const chronos = { epochAtTimestamp: async (t: bigint) => t / DAY, timestampForEpoch: async (e: bigint) => e * DAY };
    const model = (fromWindow: bigint, toWindow: bigint) =>
      scheduleModel({
        chronos: chronos as unknown as Parameters<typeof scheduleModel>[0]['chronos'],
        model: new PoolModel(0n),
        committed: B * LOCK,
        createdAtTimestamp: CREATED,
        lock: LOCK,
        epLen: DAY,
        currentEpoch: E,
        fromWindow,
        toWindow,
      });
    const expected = closedWindows({ cursor: 0n, createdAt: CREATED, epLen: DAY, lock: LOCK, at: AT });
    /** The pools around a settle that books `curves`, storage holding what the model has it hold. */
    const storedFor = (curves: Awaited<ReturnType<typeof model>>['curves']) => {
      const pool = new PoolModel(0n);
      for (const r of curves.flatMap((cv) => cv.booked)) pool.add(r);
      return { before: { pools: new Map<bigint, bigint>(), remainder: 0n }, after: { pools: new Map(pool.perEpoch), remainder: pool.remainder }, model: pool };
    };

    it('works out the closed windows from the cursor, the creation, the epoch length, the lock and the time', () => {
      expect(expected).to.deep.equal({ fromWindow: 0n, toWindow: 5n });
      expect(closedWindows({ cursor: 2n, createdAt: CREATED, epLen: DAY, lock: LOCK, at: AT })).to.deep.equal({ fromWindow: 2n, toWindow: 5n });
      expect(closedWindows({ cursor: 0n, createdAt: CREATED, epLen: DAY, lock: LOCK, at: CREATED + 100n * DAY })).to.deep.equal({ fromWindow: 0n, toWindow: LOCK });
      expect(closedWindows({ cursor: 0n, createdAt: CREATED, epLen: DAY, lock: LOCK, at: CREATED - 1n })).to.deep.equal({ fromWindow: 0n, toWindow: 0n });
      expect(closedWindows({ cursor: 5n, createdAt: CREATED, epLen: DAY, lock: LOCK, at: AT })).to.deep.equal({ fromWindow: 5n, toWindow: 5n });
    });

    it('passes when the settle books every closed window', async () => {
      const report = new QuietReport();
      const { curves } = await model(0n, 5n);
      checkLateBooking(report, {
        expected,
        curves,
        allowance: B,
        epoch: E,
        emitted: { fromWindow: 0n, toWindow: 5n, scheduled: 5n * B },
        cursorAfter: 5n,
        credits: curves.flatMap((cv) => cv.booked),
        stored: storedFor(curves),
      });
      expect(report.failed).to.equal(0);
      expect(report.checks).to.have.length(5);
    });

    it('fails when the events are all right and the staker pools in storage are not', async () => {
      const { curves } = await model(0n, 5n);
      const failedWith = (edit: (s: ReturnType<typeof storedFor>) => void) => {
        const report = new QuietReport();
        const stored = storedFor(curves);
        edit(stored);
        checkLateBooking(report, {
          expected,
          curves,
          allowance: B,
          epoch: E,
          emitted: { fromWindow: 0n, toWindow: 5n, scheduled: 5n * B },
          cursorAfter: 5n,
          credits: curves.flatMap((cv) => cv.booked),
          stored,
        });
        return report.checks.filter((c) => !c.ok).map((c) => c.label);
      };
      const POOLS = ['the staker pools in storage gained what the model books, epoch by epoch, with the remainder it carries'];
      const [first] = storedFor(curves).model.perEpoch.keys();

      expect(failedWith(() => {})).to.deep.equal([]);
      expect(failedWith((s) => s.after.pools.set(first, s.after.pools.get(first)! - 1n))).to.deep.equal(POOLS);
      expect(failedWith((s) => s.after.pools.set(first + 10_000n, 1n))).to.deep.equal(POOLS);
      expect(failedWith((s) => s.after.pools.delete(first))).to.deep.equal(POOLS);
      expect(failedWith((s) => (s.after.remainder += 1n))).to.deep.equal(POOLS);
    });

    it('fails when the settle books only one of the five closed windows, though its event and its credits agree', async () => {
      const report = new QuietReport();
      const { curves } = await model(0n, 5n);
      const one = (await model(0n, 1n)).curves;
      checkLateBooking(report, {
        expected,
        curves,
        allowance: B,
        epoch: E,
        emitted: { fromWindow: 0n, toWindow: 1n, scheduled: B },
        cursorAfter: 1n,
        credits: one.flatMap((cv) => cv.booked),
        stored: storedFor(curves),
      });
      const failed = report.checks.filter((c) => !c.ok).map((c) => c.label);
      expect(failed).to.have.length(3);
      expect(failed[0]).to.contain('settle books every closed window, 0..4');
    });

    it('fails when the event names every window and the cursor stays behind', async () => {
      const report = new QuietReport();
      const { curves } = await model(0n, 5n);
      checkLateBooking(report, {
        expected,
        curves,
        allowance: B,
        epoch: E,
        emitted: { fromWindow: 0n, toWindow: 5n, scheduled: 5n * B },
        cursorAfter: 1n,
        credits: curves.flatMap((cv) => cv.booked),
        stored: storedFor(curves),
      });
      expect(report.checks.filter((c) => !c.ok).map((c) => c.detail)).to.deep.equal(['emitted 0..4, cursor 1']);
    });
  });

  describe('the pool, worked out without the contract', () => {
    it('leaves an epoch with no value no pool, and its money waiting for the next epoch with value', () => {
      const rows = [
        { money: 5n, totalServed: 3n },
        { money: 2n, totalServed: 0n },
        { money: 0n, totalServed: 0n },
        { money: 1n, totalServed: 0n },
        { money: 4n, totalServed: 1n },
        { money: 7n, totalServed: 0n },
      ];
      expect(poolsFromMoney(rows)).to.deep.equal({ pools: [5n, 0n, 0n, 0n, 7n, 0n], waiting: 7n });
    });

    it('holds nothing back with value in every epoch, and everything back with value in none', () => {
      expect(poolsFromMoney([{ money: 5n, totalServed: 1n }, { money: 2n, totalServed: 1n }])).to.deep.equal({ pools: [5n, 2n], waiting: 0n });
      expect(poolsFromMoney([{ money: 5n, totalServed: 0n }, { money: 2n, totalServed: 0n }])).to.deep.equal({ pools: [0n, 0n], waiting: 7n });
      expect(poolsFromMoney([])).to.deep.equal({ pools: [], waiting: 0n });
    });

    it('pays a gross by the formula, each term floored on its own', () => {
      // Half the pool by R, half by score: 100 × (1/2 × 1/3) + 100 × (1/2 × 3/4), floored apart.
      expect(grossOf(100n, 5_000n, { servedValue: 1n, weightedValue: 3n }, { totalServed: 3n, totalWeighted: 4n })).to.equal(16n + 37n);
      expect(grossOf(100n, 0n, { servedValue: 1n, weightedValue: 3n }, { totalServed: 3n, totalWeighted: 4n })).to.equal(33n);
      expect(grossOf(100n, 10_000n, { servedValue: 1n, weightedValue: 3n }, { totalServed: 3n, totalWeighted: 4n })).to.equal(75n);
    });

    it('gives the second term the R share when no node has a score, and a node with no value nothing', () => {
      expect(grossOf(100n, 5_000n, { servedValue: 1n, weightedValue: 0n }, { totalServed: 2n, totalWeighted: 0n })).to.equal(25n + 25n);
      expect(grossOf(100n, 5_000n, { servedValue: 0n, weightedValue: 0n }, { totalServed: 2n, totalWeighted: 1n })).to.equal(0n);
    });

    it('words a refusal of a batch as a decoded revert does, by the fault\'s place in the enum', () => {
      expect(groupFault(0, 'OutsideEpoch')).to.equal('GroupFault(0, 3)');
      expect(groupFault(1, 'BelowMinCounted')).to.equal('GroupFault(1, 5)');
      expect(receiptFault(0, 2, 'DuplicateNonce')).to.equal('ReceiptFault(0, 2, 8)');
    });
  });

  describe('the stake factor a batch should capture, worked out without the batch', () => {
    const MAX = 10_000_000n * 10n ** 18n;
    const QUARTER = stakeFactorFrom({ live: MAX / 4n, snapshotSet: false, snapshot: 0n, maximumStake: MAX });

    it('is the square root of the stake over the maximum', () => {
      expect(QUARTER).to.equal(5n * 10n ** 17n);
      expect(stakeFactorFrom({ live: MAX * 2n, snapshotSet: false, snapshot: 0n, maximumStake: MAX })).to.equal(10n ** 18n);
    });

    it("takes the challenge's snapshot only if it took one and it is lower", () => {
      expect(stakeFactorFrom({ live: MAX, snapshotSet: true, snapshot: MAX / 4n, maximumStake: MAX })).to.equal(QUARTER);
      expect(stakeFactorFrom({ live: MAX / 4n, snapshotSet: true, snapshot: MAX, maximumStake: MAX })).to.equal(QUARTER);
      expect(stakeFactorFrom({ live: MAX / 4n, snapshotSet: false, snapshot: 1n, maximumStake: MAX })).to.equal(QUARTER);
    });

    it('fails a batch and the scores built on it that agree on 0, when the stake gives more', () => {
      expect(capturedFactorHolds(0n, QUARTER)).to.equal(false);
      expect(capturedFactorHolds(QUARTER - 1n, QUARTER)).to.equal(false);
      expect(capturedFactorHolds(QUARTER, QUARTER)).to.equal(true);
    });

    it('fails when the stake gives 0 too, since nothing then vouches for either side', () => {
      expect(capturedFactorHolds(0n, 0n)).to.equal(false);
    });
  });

  describe('parameters.json, as the deploy helper and the scripts read it', () => {
    const config = {
      testnet: {
        Thing: {
          plain: '5',
          structured: { setter: 'setStructuredNow', setterArgs: ['7'] },
          noSetter: { setterArgs: ['8'] },
          withGetterArgs: { getterArgs: [3], setter: 'setPair', setterArgs: [3, '9'], desiredValue: '9' },
          listed: [{ setter: 'setA', setterArgs: ['1'] }, '2', { setter: 'setB', setterArgs: ['3'] }],
          overridden: '100',
          overriddenFrom: { setter: 'setFrom', setterArgs: ['100'] },
        },
        overrides: {
          base_sepolia_v10: { Thing: { overridden: '200', overriddenFrom: '201', added: '202' } },
          other_network: { Thing: { plain: '999' } },
        },
      },
    } as unknown as ParametersConfig;
    const entries = contractParameters(config, 'testnet', 'base_sepolia_v10', 'Thing');

    it('reads a plain value, naming its setter after the getter', () => {
      expect(entries.plain).to.deep.equal([{ getterArgs: [], desiredValue: '5', setter: 'setPlain', setterArgs: ['5'] }]);
    });

    it('reads a structured value, its one setter argument being the value', () => {
      expect(entries.structured).to.deep.equal([{ getterArgs: [], desiredValue: '7', setter: 'setStructuredNow', setterArgs: ['7'] }]);
      expect(entries.noSetter).to.deep.equal([{ getterArgs: [], desiredValue: '8', setter: 'setNoSetter', setterArgs: ['8'] }]);
    });

    it('reads a structured value of several setter arguments, its value being desiredValue', () => {
      expect(entries.withGetterArgs).to.deep.equal([{ getterArgs: [3], desiredValue: '9', setter: 'setPair', setterArgs: [3, '9'] }]);
    });

    it('reads a list in order', () => {
      expect(entries.listed.map((e) => [e.setter, e.desiredValue])).to.deep.equal([
        ['setA', '1'],
        ['setListed', '2'],
        ['setB', '3'],
      ]);
    });

    it('lets the network\'s overrides replace the environment\'s values, and add their own, and no other network\'s', () => {
      expect(entries.overridden.map((e) => e.desiredValue)).to.deep.equal(['200']);
      expect(entries.overriddenFrom).to.deep.equal([{ getterArgs: [], desiredValue: '201', setter: 'setOverriddenFrom', setterArgs: ['201'] }]);
      expect(entries.added.map((e) => e.desiredValue)).to.deep.equal(['202']);
      expect(entries.plain.map((e) => e.desiredValue)).to.deep.equal(['5']);
    });

    it('holds nothing for a contract or an environment it does not set', () => {
      expect(contractParameters(config, 'testnet', 'base_sepolia_v10', 'Other')).to.deep.equal({});
      expect(contractParameters(config, 'mainnet', 'base_sepolia_v10', 'Thing')).to.deep.equal({});
    });

    it('gives the scripts the first key it holds, as a number, the last of a list', () => {
      expect(expectedParameterIn(config, 'Thing', ['missing', 'structured', 'plain'])).to.deep.equal({ key: 'structured', value: 7n });
      expect(expectedParameterIn(config, 'Thing', ['listed'])).to.deep.equal({ key: 'listed', value: 3n });
      expect(expectedParameterIn(config, 'Thing', ['overridden'])).to.deep.equal({ key: 'overridden', value: 200n });
      expect(expectedParameterIn(config, 'Thing', ['missing'])).to.equal(undefined);
    });

    it('reads the tracked file\'s query/inference parameters', () => {
      expect(requireParameter('QueryInferenceStorage', ['lambdaBps'])).to.deep.equal({ key: 'lambdaBps', value: 5000n });
      expect(requireParameter('QueryInferenceStorage', ['maxItemsPerBatch']).value).to.equal(256n);
      expect(requireParameter('QueryInferenceStorage', ['maxGroupsPerBatch']).value).to.equal(32n);
      expect(requireParameter('ServiceSubscriptionsStorage', ['maxBudgetsPerSubscription']).value).to.equal(16n);
    });
  });

  describe('the existing accounts and positions, against what the old contracts did', () => {
    const TRAC = 10n ** 18n;
    const old = [
      { id: 8n, stakerCredits: [], events: ['AccountFinalSwept'] },
      { id: 9n, stakerCredits: [{ start: 659n, end: 659n, amount: 500n * TRAC }], events: ['TokensAddedToEpochRange', 'AccountFinalSwept'] },
      { id: 10n, stakerCredits: [{ start: 659n, end: 659n, amount: 200n * TRAC }], events: ['TokensAddedToEpochRange', 'AccountFinalSwept'] },
    ];
    const credits = () => old.flatMap((s) => s.stakerCredits).map((r) => ({ ...r }));
    const swept = [8n, 9n, 10n];
    const settleMany = (c: ReturnType<typeof credits>, s = swept) => {
      const report = new QuietReport();
      checkSettleMany(report, { credits: c, swept: s }, old, 659n);
      return report;
    };

    it('passes when settleMany books the same ranges in the same order', () => {
      expect(settleMany(credits()).failed).to.equal(0);
    });

    it('fails when a credit moves to another epoch, whose amount and count stay the same', () => {
      const c = credits();
      c[0] = { ...c[0], start: 660n, end: 660n };
      const report = settleMany(c);
      expect(report.failed).to.equal(1);
      expect(report.checks[0].ok).to.equal(false);
      expect(report.checks[0].detail).to.contain('700.0 TRAC in 2 credits (10.0.8: 700.0 in 2)');
      expect(report.checks[0].detail).to.contain('credit 0: 500.0 TRAC over epochs 660..660, 10.0.8: 500.0 TRAC over epochs 659..659');
    });

    it('fails when a credit only ends in another epoch', () => {
      const c = credits();
      c[1] = { ...c[1], end: 660n };
      expect(settleMany(c).failed).to.equal(1);
    });

    it('fails when the same credits come in another order', () => {
      expect(settleMany(credits().reverse()).failed).to.equal(1);
    });

    it('fails when an amount moves between credits, whose sum stays the same', () => {
      const c = credits();
      c[0] = { ...c[0], amount: c[0].amount - 1n };
      c[1] = { ...c[1], amount: c[1].amount + 1n };
      expect(settleMany(c).failed).to.equal(1);
    });

    it('fails an expired account its events call swept when storage does not', () => {
      const settled: StoredAccount = { id: 9n, fullySwept: true, topUp: 0n, lastSettledWindow: 12n, lock: 12n };
      const run = (accounts: StoredAccount[]) => {
        const report = new QuietReport();
        checkSettledAccounts(report, accounts);
        return report;
      };
      expect(run([settled]).failed).to.equal(0);
      expect(run([{ ...settled, fullySwept: false }]).failed).to.equal(1);
      expect(run([{ ...settled, topUp: 1n }]).checks[0].detail).to.contain('account 9');
      expect(run([{ ...settled, lastSettledWindow: 11n }]).failed).to.equal(1);
      expect(run([]).failed).to.equal(1);
    });

    it('fails a claim after a quiet spell that went through without paying its share of the pool', () => {
      const run = (claimed: { reward: bigint; rawDelta: bigint }, expected: bigint, poolShare: bigint) => {
        const report = new QuietReport();
        checkQuietClaim(report, { ...claimed, gasUsed: 1n }, expected, poolShare);
        return report;
      };
      expect(run({ reward: 7n, rawDelta: 7n }, 7n, 2n).failed).to.equal(0);
      expect(run({ reward: 5n, rawDelta: 5n }, 7n, 2n).failed).to.equal(1);
      expect(run({ reward: 7n, rawDelta: 5n }, 7n, 2n).failed).to.equal(1);
      expect(run({ reward: 7n, rawDelta: 7n }, 7n, 0n).failed).to.equal(1);
    });

    it('fails when a credit is missing or added', () => {
      expect(settleMany(credits().slice(0, 1)).checks[0].detail).to.contain('credit 1: none, 10.0.8: 200.0 TRAC over epochs 659..659');
      expect(settleMany([...credits(), { start: 659n, end: 659n, amount: 1n }]).failed).to.equal(1);
    });

    it('passes when a booking 10.0.8 put into an ended epoch comes shifted to the current one, and fails when it does not', () => {
      const late = [{ id: 9n, stakerCredits: [{ start: 658n, end: 658n, amount: 500n * TRAC }], events: ['TokensAddedToEpochRange', 'AccountFinalSwept'] }];
      const run = (start: bigint) => {
        const report = new QuietReport();
        checkSettleMany(report, { credits: [{ start, end: start, amount: 500n * TRAC }], swept: [9n] }, late, 659n);
        return report;
      };
      expect(run(659n).failed).to.equal(0);
      expect(run(658n).checks[0].detail).to.contain('credit 0: 500.0 TRAC over epochs 658..658, 10.0.8: 500.0 TRAC over epochs 659..659');
      expect(run(660n).failed).to.equal(1);
    });

    it('shifts a late booking as one, keeping its shape, and leaves a booking of the current epoch or a later one as it is', () => {
      const curve = [
        { start: 656n, end: 656n, amount: 1n },
        { start: 657n, end: 667n, amount: 2n },
        { start: 668n, end: 668n, amount: 3n },
      ];
      expect(bookedBy1020(curve, 659n)).to.deep.equal([
        { start: 659n, end: 659n, amount: 1n },
        { start: 660n, end: 670n, amount: 2n },
        { start: 671n, end: 671n, amount: 3n },
      ]);
      expect(bookedBy1020(curve, 656n)).to.deep.equal(curve);
      expect(bookedBy1020([], 659n)).to.deep.equal([]);
    });

    it('fails when settleMany sweeps other accounts than 10.0.8 settle did', () => {
      const report = settleMany(credits(), [8n, 9n]);
      expect(report.checks.filter((c) => !c.ok).map((c) => c.label)).to.deep.equal(['settleMany sweeps the accounts 10.0.8 settle swept']);
      expect(settleMany(credits(), [8n, 10n, 9n]).failed).to.equal(1);
    });

    const claim = (tokenId: bigint, reward: bigint, rawDelta = reward): ClaimResult => ({ tokenId, node: 3n, reward, rawDelta, lastClaimedEpoch: 658n, gasUsed: 1n });
    const oldClaims = [claim(1n, 5n), claim(2n, 7n)];
    const claims = (c: ClaimResult[]) => {
      const report = new QuietReport();
      checkClaims(report, c, oldClaims);
      return report;
    };

    it('passes when every position is claimed for what 10.0.4 paid', () => {
      expect(claims([claim(1n, 5n), claim(2n, 7n)]).failed).to.equal(0);
    });

    it('fails when a position the 10.0.4 claims paid is left out', () => {
      const report = claims([claim(1n, 5n)]);
      expect(report.checks.filter((c) => !c.ok).map((c) => c.label)).to.deep.equal(['the claims are of the positions the 10.0.4 claims were of']);
    });

    it('fails when a claim credits another raw stake, whose statistic matches', () => {
      expect(claims([claim(1n, 5n, 4n), claim(2n, 7n)]).checks.filter((c) => !c.ok).map((c) => c.label)).to.deep.equal(['token 1: the 10.1.0 claim pays what the 10.0.4 claim paid']);
    });
  });
});
