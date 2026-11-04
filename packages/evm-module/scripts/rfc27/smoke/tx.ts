// The smoke test's transactions, as steps on the shared runner. Each is sent only
// when the run sends; a dry run simulates it and prints what it would send. A
// journal records every transaction sent, so a phase resumes after a crash, and
// what the step moved, read around it when it was first mined, so that a replay
// of its receipt reports what it did then rather than comparing it with now.

import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import type { TransactionReceipt } from 'ethers';

import { errorMessage } from '../contracts';
import { Report, fmt } from '../report';
import { Sized, Tx, TxOverGasCap, TxReverted, TxRunner, TxWouldRevert } from '../tx';

/** What a step reads of the chain at one block, by name. */
export type Reads = Record<string, bigint>;

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
  before?: Reads;
  after?: Reads;
  expected?: Reads;
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
  /** What the step moves, read at a block: at the block before its own and at its own, then journaled. */
  reads?: (blockTag: number) => Promise<Reads>;
  /** What is expected of it, worked out before it is sent and journaled with it, for what it destroys. */
  expected?: Reads;
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
  before?: Reads;
  after?: Reads;
  expected?: Reads;
};

/** Whether the step moved what it reads as `key` by `want`; true if the endpoint no longer serves the state of its block, which `movement` says. */
export const movedBy = (r: StepResult, key: string, want: bigint): boolean => !r.before || !r.after || r.after[key] - r.before[key] === want;

/** What the step moved, for a check's detail. */
export const movement = (r: StepResult, key: string): string =>
  r.before && r.after ? `${fmt(r.before[key])} → ${fmt(r.after[key])} TRAC` : 'not read: this endpoint no longer serves the state of its block';

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

  /** The step's reads around its transaction, a few tries as an endpoint may lag behind the receipt it gave. */
  private async around(s: Step, receipt: TransactionReceipt): Promise<{ before: Reads; after: Reads } | undefined> {
    if (!s.reads) return undefined;
    for (let i = 0; ; i++) {
      try {
        return { before: await s.reads(receipt.blockNumber - 1), after: await s.reads(receipt.blockNumber) };
      } catch (e: unknown) {
        if (i >= 4) {
          this.report.note(`      ${s.label}: what it moved cannot be read at its block ${receipt.blockNumber}: ${errorMessage(e)}`);
          return undefined;
        }
        await new Promise((res) => setTimeout(res, 2_000 * (i + 1)));
      }
    }
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
      // Read once, around the transaction: at its first run, or now if that run stopped before it could.
      const around = earlier.before && earlier.after ? { before: earlier.before, after: earlier.after } : await this.around(s, receipt);
      if (earlier.status === 'sent' || (around && !earlier.before)) {
        this.log.put(s.key, { ...earlier, ...around, status: 'mined', block: receipt.blockNumber, gasUsed: receipt.gasUsed });
      }
      this.report.note(`=     ${s.label}: done earlier, tx ${earlier.hash}, gas ${receipt.gasUsed}`);
      this.report.tx({ key: s.key, label: s.label, role: s.role, status: 'done earlier', hash: earlier.hash, gasUsed: receipt.gasUsed });
      return { sent: true, skipped: false, replayed: true, receipt, expected: earlier.expected, ...around };
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
    const around = await this.around(s, receipt);
    this.log.put(s.key, { ...sent, ...around, status: 'mined', block: receipt.blockNumber, gasUsed: receipt.gasUsed });
    this.report.tx({ key: s.key, label: s.label, role: s.role, status: 'mined', hash, block: receipt.blockNumber, estimate, gasLimit, gasUsed: receipt.gasUsed });
    return { sent: true, skipped: false, receipt, estimate, gasLimit, expected: s.expected, ...around };
  }
}
