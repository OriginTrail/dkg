// The OT-RFC-27 fork rehearsal's own support, on what it must catch when the
// contracts or the fork misbehave. None of this needs a fork: the failures are
// fed to the code that has to notice them.

import { expect } from 'chai';
import hre from 'hardhat';

import { PoolModel, scheduleModel } from './helpers/emission-model';
import { ParametersConfig, contractParameters } from '../utils/helpers';
import { Fork } from '../scripts/rfc27/fork';
import { expectedParameterIn, requireParameter } from '../scripts/rfc27/parameters';
import { Report, Redactor } from '../scripts/rfc27/report';
import { TxReverted, TxRunner } from '../scripts/rfc27/tx';
import { Ctx, send } from '../scripts/rfc27/rehearsal/context';
import { checkLateBooking } from '../scripts/rfc27/rehearsal/late-booking';
import { claimAll } from '../scripts/rfc27/rehearsal/operations';
import { closedWindows } from '../scripts/rfc27/rehearsal/reads';
import type { Position } from '../scripts/rfc27/rehearsal/results';

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
        budget: B,
        epoch: E,
        emitted: { fromWindow: 0n, toWindow: 5n, scheduled: 5n * B },
        cursorAfter: 5n,
        credits: curves.flatMap((cv) => cv.booked),
      });
      expect(report.failed).to.equal(0);
      expect(report.checks).to.have.length(4);
    });

    it('fails when the settle books only one of the five closed windows, though its event and its credits agree', async () => {
      const report = new QuietReport();
      const { curves } = await model(0n, 5n);
      const one = (await model(0n, 1n)).curves;
      checkLateBooking(report, {
        expected,
        curves,
        budget: B,
        epoch: E,
        emitted: { fromWindow: 0n, toWindow: 1n, scheduled: B },
        cursorAfter: 1n,
        credits: one.flatMap((cv) => cv.booked),
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
        budget: B,
        epoch: E,
        emitted: { fromWindow: 0n, toWindow: 5n, scheduled: 5n * B },
        cursorAfter: 1n,
        credits: curves.flatMap((cv) => cv.booked),
      });
      expect(report.checks.filter((c) => !c.ok).map((c) => c.detail)).to.deep.equal(['emitted 0..4, cursor 1']);
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
      expect(requireParameter('QueryInferenceStorage', ['latestLambdaBps', 'lambdaBps'])).to.deep.equal({ key: 'latestLambdaBps', value: 5000n });
      expect(requireParameter('QueryInferenceStorage', ['latestReceiptGraceSeconds', 'receiptGraceSeconds'])).to.deep.equal({ key: 'latestReceiptGraceSeconds', value: 3600n });
      expect(requireParameter('ConvictionServiceStorage', ['maxBucketsPerPeriod']).value).to.equal(16n);
    });
  });
});
