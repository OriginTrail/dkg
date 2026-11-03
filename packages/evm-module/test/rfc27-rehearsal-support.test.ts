// The OT-RFC-27 fork rehearsal's own support, on what it must catch when the
// contracts or the fork misbehave. None of this needs a fork: the failures are
// fed to the code that has to notice them.

import { expect } from 'chai';

import { Report, Redactor } from '../scripts/rfc27/report';
import { TxReverted, TxRunner } from '../scripts/rfc27/tx';
import { Ctx, send } from '../scripts/rfc27/rehearsal/context';

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
      return { hre, report, txs: [], tx: new TxRunner(hre as unknown as Ctx['hre'], report, true) } as unknown as Ctx;
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
});
