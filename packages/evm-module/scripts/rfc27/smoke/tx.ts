// The smoke test's transactions, as steps on the shared runner. Each is sent only
// when the run sends; a dry run simulates it and prints what it would send. A
// journal records every transaction sent, so a phase resumes after a crash. A
// replay gets the step's own receipt, and what the step did is read from that, the
// same each time, whatever else its block held and whatever has happened since.

import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import type { TransactionReceipt } from 'ethers';

import type { Token } from '../../../typechain';
import { eventsIn } from '../contracts';
import { Report } from '../report';
import { Sized, Tx, TxOverGasCap, TxReverted, TxRunner, TxWouldRevert } from '../tx';

/** What is expected of a step, worked out before it is sent, by name. */
export type Expected = Record<string, bigint>;

/** A transaction a run sent, as its journal keeps it. */
export type StepRecord = {
  status: 'sent' | 'mined';
  label: string;
  role: string;
  hash: string;
  estimate: bigint;
  gasLimit: bigint;
  block?: number;
  gasUsed?: bigint;
  expected?: Expected;
};

/** Where a run keeps the transactions it sent, by step key. */
export interface Journal {
  get(key: string): StepRecord | undefined;
  put(key: string, record: StepRecord): void;
}

/** One transaction of a phase. */
export type Step = Tx & {
  key: string;
  role: string;
  /** Earlier steps it needs: a dry run lists it, unsimulated, while one of them is unsent. */
  needs?: string[];
  /** Why the step is done already on chain, if it is. */
  done?: string;
  /** What is expected of it, worked out before it is sent and journaled with it, for what it destroys. */
  expected?: Expected;
};

/**
 * What a step did; a step that was estimated also gives its estimate and the gas
 * limit set from it. `replayed`: its receipt is of an earlier run of the phase.
 */
export type StepResult = {
  sent: boolean;
  skipped: boolean;
  replayed?: boolean;
  receipt?: TransactionReceipt;
  estimate?: bigint;
  gasLimit?: bigint;
  expected?: Expected;
};

/**
 * What a transaction moved into `who`, less what it moved out, by its own TRAC
 * Transfer logs: no other transaction of its block can change that, and it reads
 * the same on a replay. A receipt that shows no transfer shows a movement of none.
 */
export function tracMoved(receipt: TransactionReceipt, token: Token, who: string): bigint {
  const account = who.toLowerCase();
  let moved = 0n;
  for (const ev of eventsIn(receipt, token, token.getEvent('Transfer'))) {
    if (ev.to.toLowerCase() === account) moved += ev.value;
    if (ev.from.toLowerCase() === account) moved -= ev.value;
  }
  return moved;
}

/**
 * FORK-ONLY: the journal, calling `stop` right after it records `at`, a step's
 * key once mined, or `<key>:sent` once sent: what a crash leaves to resume from.
 */
export const stoppingAt = (journal: Journal, at: string, stop: () => never): Journal => ({
  get: (key) => journal.get(key),
  put: (key, record) => {
    journal.put(key, record);
    if (at === `${key}:${record.status}` || (at === key && record.status === 'mined')) stop();
  },
});

export class SmokeTx extends TxRunner {
  private readonly notSent = new Set<string>();

  constructor(
    hre: HardhatRuntimeEnvironment,
    report: Report,
    readonly sending: boolean,
    private readonly log: Journal,
  ) {
    super(hre, report);
  }

  /**
   * Run one step. The estimate is the transaction's smallest gas limit: a
   * step whose estimate does not fit under 2^24 fails its check, and is not
   * sent.
   */
  async step(s: Step): Promise<StepResult> {
    const earlier = this.log.get(s.key);
    if (earlier) {
      const receipt = await this.receipt(earlier.hash);
      if (receipt.status !== 1) throw new Error(`${s.label}: transaction ${earlier.hash} of an earlier run reverted`);
      if (earlier.status === 'sent') {
        this.log.put(s.key, { ...earlier, status: 'mined', block: receipt.blockNumber, gasUsed: receipt.gasUsed });
      }
      this.report.note(`=     ${s.label}: done earlier, tx ${earlier.hash}, gas ${receipt.gasUsed}`);
      this.report.tx({ key: s.key, label: s.label, role: s.role, status: 'done earlier', hash: earlier.hash, gasUsed: receipt.gasUsed });
      return { sent: true, skipped: false, replayed: true, receipt, expected: earlier.expected };
    }
    if (s.done) {
      this.report.note(`=     ${s.label}: already done (${s.done})`);
      this.report.tx({ key: s.key, label: s.label, role: s.role, status: 'already done', why: s.done });
      return { sent: true, skipped: true };
    }
    const blocked = (s.needs ?? []).filter((k) => this.notSent.has(k));
    if (!this.sending && blocked.length) {
      this.notSent.add(s.key);
      this.report.note(`plan  ${s.label}: not simulated, as it needs ${blocked.join(', ')}, which this dry run does not send`);
      this.report.tx({ key: s.key, label: s.label, role: s.role, status: 'planned' });
      return { sent: false, skipped: false };
    }
    let sized: Sized;
    try {
      sized = await this.size(s);
    } catch (e: unknown) {
      if (e instanceof TxWouldRevert) {
        this.report.tx({ key: s.key, label: s.label, role: s.role, status: 'would revert', error: e.why });
        if (this.sending) throw e;
        this.notSent.add(s.key);
        this.report.check(`${s.label} simulates`, false, e.why);
        return { sent: false, skipped: false };
      }
      if (e instanceof TxOverGasCap) {
        this.report.tx({ key: s.key, label: s.label, role: s.role, status: 'over the gas cap', estimate: e.estimate });
        if (this.sending) throw e;
        this.notSent.add(s.key);
        return { sent: false, skipped: false, estimate: e.estimate };
      }
      throw e;
    }
    const { estimate, gasLimit } = sized;
    if (!this.sending) {
      this.notSent.add(s.key);
      this.report.note(`sim   ${s.label}: simulates; gas limit ${gasLimit}`);
      this.report.tx({ key: s.key, label: s.label, role: s.role, status: 'simulated', estimate, gasLimit });
      return { sent: false, skipped: false, estimate, gasLimit };
    }
    const hash = await this.broadcast(s, sized);
    const sent: StepRecord = { status: 'sent', label: s.label, role: s.role, hash, estimate, gasLimit, expected: s.expected };
    this.log.put(s.key, sent);
    let receipt: TransactionReceipt;
    try {
      receipt = await this.mined(s, hash, sized);
    } catch (e: unknown) {
      if (e instanceof TxReverted) this.report.tx({ key: s.key, label: s.label, role: s.role, status: 'reverted', hash, gasUsed: e.receipt.gasUsed, gasLimit });
      throw e;
    }
    this.log.put(s.key, { ...sent, status: 'mined', block: receipt.blockNumber, gasUsed: receipt.gasUsed });
    this.report.tx({ key: s.key, label: s.label, role: s.role, status: 'mined', hash, block: receipt.blockNumber, estimate, gasLimit, gasUsed: receipt.gasUsed });
    return { sent: true, skipped: false, receipt, estimate, gasLimit, expected: s.expected };
  }
}
