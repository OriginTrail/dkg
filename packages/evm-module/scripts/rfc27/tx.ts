// OT-RFC-27 script support: transactions. Each is estimated, checked against
// Base's per-transaction gas cap, given a gas limit set by hand, and sent only
// when the run sends; a dry run simulates it and prints what it would send.
// A journal records every transaction sent, so a phase resumes after a crash.

import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import type { Signer, TransactionReceipt } from 'ethers';

import { decodeError, errorData } from './contracts';
import { Report } from './report';

/** EIP-7825's per-transaction gas cap, which Base enforces. */
export const TX_GAS_CAP = 1n << 24n;

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
};

/** Where a run keeps the transactions it sent, by step key. */
export interface Journal {
  get(key: string): StepRecord | undefined;
  put(key: string, record: StepRecord): void;
}

/** One transaction of a phase. */
export type Step = {
  key: string;
  label: string;
  role: string;
  signer: Signer;
  /** The contract called; without it, `data` is a contract's creation code, deployed. */
  to?: string;
  data: string;
  value?: bigint;
  /** Earlier steps it needs: a dry run lists it, unsimulated, while one of them is unsent. */
  needs?: string[];
  /** Why the step is done already on chain, if it is. */
  done?: string;
};

/** What a step did; a step that was estimated also gives its estimate and the gas limit set from it. */
export type StepResult = { sent: boolean; skipped: boolean; receipt?: TransactionReceipt; estimate?: bigint; gasLimit?: bigint };

/** The gas limit set by hand: the estimate plus a quarter and 50,000, always under 2^24. */
export function gasLimitFor(estimate: bigint): bigint {
  const limit = (estimate * 5n) / 4n + 50_000n;
  return limit >= TX_GAS_CAP ? TX_GAS_CAP - 1n : limit;
}

export class TxRunner {
  private readonly unsent = new Set<string>();

  constructor(
    private readonly hre: HardhatRuntimeEnvironment,
    private readonly report: Report,
    readonly send: boolean,
    private readonly journal?: Journal,
  ) {}

  async receipt(hash: string): Promise<TransactionReceipt> {
    for (let i = 0; i < 900; i++) {
      const r = await this.hre.ethers.provider.getTransactionReceipt(hash);
      if (r) return r;
      await new Promise((res) => setTimeout(res, 1_000));
    }
    throw new Error(`no receipt for ${hash} after 15 minutes`);
  }

  /**
   * Run one step. The estimate is the transaction's smallest gas limit: a
   * step whose estimate does not fit under 2^24 fails its check, and is not
   * sent.
   */
  async run(s: Step): Promise<StepResult> {
    const earlier = this.journal?.get(s.key);
    if (earlier) {
      const receipt = await this.receipt(earlier.hash);
      if (receipt.status !== 1) throw new Error(`${s.label}: transaction ${earlier.hash} of an earlier run reverted`);
      if (earlier.status === 'sent') {
        this.journal?.put(s.key, { ...earlier, status: 'mined', block: receipt.blockNumber, gasUsed: receipt.gasUsed });
      }
      this.report.note(`=     ${s.label}: done earlier, tx ${earlier.hash}, gas ${receipt.gasUsed}`);
      this.report.tx({ key: s.key, label: s.label, role: s.role, status: 'done earlier', hash: earlier.hash, gasUsed: receipt.gasUsed });
      return { sent: true, skipped: false, receipt };
    }
    if (s.done) {
      this.report.note(`=     ${s.label}: already done (${s.done})`);
      this.report.tx({ key: s.key, label: s.label, role: s.role, status: 'already done', why: s.done });
      return { sent: true, skipped: true };
    }
    const blocked = (s.needs ?? []).filter((k) => this.unsent.has(k));
    if (!this.send && blocked.length) {
      this.unsent.add(s.key);
      this.report.note(`plan  ${s.label}: not simulated, as it needs ${blocked.join(', ')}, which this dry run does not send`);
      this.report.tx({ key: s.key, label: s.label, role: s.role, status: 'planned' });
      return { sent: false, skipped: false };
    }
    const from = await s.signer.getAddress();
    let estimate: bigint;
    try {
      estimate = await this.hre.ethers.provider.estimateGas({ from, to: s.to, data: s.data, value: s.value ?? 0n });
    } catch (e: unknown) {
      const why = await decodeError(this.hre, errorData(e));
      this.report.tx({ key: s.key, label: s.label, role: s.role, status: 'would revert', error: why });
      if (this.send) throw new Error(`${s.label} would revert: ${why}`);
      this.unsent.add(s.key);
      this.report.check(`${s.label} simulates`, false, why);
      return { sent: false, skipped: false };
    }
    const fits = this.report.check(
      `${s.label} fits the 2^24 gas cap`,
      estimate < TX_GAS_CAP,
      `smallest gas limit (the estimate) ${estimate} of ${TX_GAS_CAP}`,
    );
    if (!fits) {
      this.report.tx({ key: s.key, label: s.label, role: s.role, status: 'over the gas cap', estimate });
      if (this.send) throw new Error(`${s.label}: its estimate of ${estimate} gas does not fit under 2^24; not sending`);
      this.unsent.add(s.key);
      return { sent: false, skipped: false, estimate };
    }
    const gasLimit = gasLimitFor(estimate);
    if (!this.send) {
      this.unsent.add(s.key);
      this.report.note(`sim   ${s.label}: simulates; gas limit ${gasLimit}`);
      this.report.tx({ key: s.key, label: s.label, role: s.role, status: 'simulated', estimate, gasLimit });
      return { sent: false, skipped: false, estimate, gasLimit };
    }
    const tx = await s.signer.sendTransaction({ to: s.to, data: s.data, value: s.value ?? 0n, gasLimit });
    this.journal?.put(s.key, { status: 'sent', label: s.label, role: s.role, hash: tx.hash, estimate, gasLimit });
    const receipt = await this.receipt(tx.hash);
    if (receipt.status !== 1) {
      this.report.tx({ key: s.key, label: s.label, role: s.role, status: 'reverted', hash: tx.hash, gasUsed: receipt.gasUsed, gasLimit });
      throw new Error(`${s.label}: transaction ${tx.hash} reverted on chain, gas used ${receipt.gasUsed} of ${gasLimit}`);
    }
    this.journal?.put(s.key, {
      status: 'mined',
      label: s.label,
      role: s.role,
      hash: tx.hash,
      estimate,
      gasLimit,
      block: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
    });
    this.report.note(`sent  ${s.label}: gas ${receipt.gasUsed} (estimate ${estimate}, limit ${gasLimit}), tx ${tx.hash}`);
    this.report.tx({ key: s.key, label: s.label, role: s.role, status: 'mined', hash: tx.hash, block: receipt.blockNumber, estimate, gasLimit, gasUsed: receipt.gasUsed });
    return { sent: true, skipped: false, receipt, estimate, gasLimit };
  }

  /** A call that must revert, simulated with eth_call from `from` and never sent: its decoded error. */
  async refusal(from: string, to: string, data: string): Promise<string> {
    try {
      await this.hre.ethers.provider.call({ from, to, data });
    } catch (e: unknown) {
      return decodeError(this.hre, errorData(e));
    }
    return 'did not revert';
  }

  /** A call simulated with eth_call from `from`: its raw return data. */
  call(from: string, to: string, data: string): Promise<string> {
    return this.hre.ethers.provider.call({ from, to, data });
  }
}
