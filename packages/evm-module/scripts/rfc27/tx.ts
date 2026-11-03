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

/** One transaction. */
export type Tx = {
  label: string;
  signer: Signer;
  /** The contract called; without it, `data` is a contract's creation code, deployed. */
  to?: string;
  data: string;
  value?: bigint;
};

/** A transaction's estimate, its smallest gas limit, and the gas limit set from it. */
export type Sized = { estimate: bigint; gasLimit: bigint };

/** One transaction of a phase. */
export type Step = Tx & {
  key: string;
  role: string;
  /** Earlier steps it needs: a dry run lists it, unsimulated, while one of them is unsent. */
  needs?: string[];
  /** Why the step is done already on chain, if it is. */
  done?: string;
};

/** What a step did; a step that was estimated also gives its estimate and the gas limit set from it. */
export type StepResult = { sent: boolean; skipped: boolean; receipt?: TransactionReceipt; estimate?: bigint; gasLimit?: bigint };

/** A transaction not sent, as its estimate reverts: `why` is the decoded error. */
export class TxWouldRevert extends Error {
  constructor(
    readonly label: string,
    readonly why: string,
  ) {
    super(`${label} would revert: ${why}`);
    this.name = 'TxWouldRevert';
  }
}

/** A transaction not sent, as its estimate does not fit under Base's gas cap. */
export class TxOverGasCap extends Error {
  constructor(
    readonly label: string,
    readonly estimate: bigint,
  ) {
    super(`${label}: its estimate of ${estimate} gas does not fit under 2^24; not sending`);
    this.name = 'TxOverGasCap';
  }
}

/** A transaction the chain included and reverted: its receipt gives its hash and its gas. */
export class TxReverted extends Error {
  constructor(
    readonly label: string,
    readonly receipt: TransactionReceipt,
    readonly gasLimit: bigint,
  ) {
    super(`${label}: transaction ${receipt.hash} reverted on chain, gas used ${receipt.gasUsed} of ${gasLimit}`);
    this.name = 'TxReverted';
  }
}

/** The gas limit set by hand: the estimate plus a quarter and 50,000, always under 2^24. */
export function gasLimitFor(estimate: bigint): bigint {
  const limit = (estimate * 5n) / 4n + 50_000n;
  return limit >= TX_GAS_CAP ? TX_GAS_CAP - 1n : limit;
}

export class TxRunner {
  private readonly unsent = new Set<string>();

  constructor(
    protected readonly hre: HardhatRuntimeEnvironment,
    protected readonly report: Report,
    readonly send: boolean = true,
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
   * The estimate, the transaction's smallest gas limit, as a check of its own
   * against 2^24, and the gas limit set from it. A transaction whose estimate
   * reverts, or does not fit, throws: it is not to be sent.
   */
  async size(s: Tx): Promise<Sized> {
    const from = await s.signer.getAddress();
    let estimate: bigint;
    try {
      estimate = await this.hre.ethers.provider.estimateGas({ from, to: s.to, data: s.data, value: s.value ?? 0n });
    } catch (e: unknown) {
      throw new TxWouldRevert(s.label, await decodeError(this.hre, errorData(e)));
    }
    const fits = this.report.check(`${s.label} fits the 2^24 gas cap`, estimate < TX_GAS_CAP, `smallest gas limit (the estimate) ${estimate} of ${TX_GAS_CAP}`);
    if (!fits) throw new TxOverGasCap(s.label, estimate);
    return { estimate, gasLimit: gasLimitFor(estimate) };
  }

  /** Sends the transaction with its gas limit set by hand: its hash. */
  async broadcast(s: Tx, sized: Sized): Promise<string> {
    const tx = await s.signer.sendTransaction({ to: s.to, data: s.data, value: s.value ?? 0n, gasLimit: sized.gasLimit });
    return tx.hash;
  }

  /** The receipt of a transaction sent, which throws TxReverted if the chain reverted it. */
  async mined(s: Tx, hash: string, sized: Sized): Promise<TransactionReceipt> {
    const receipt = await this.receipt(hash);
    if (receipt.status !== 1) throw new TxReverted(s.label, receipt, sized.gasLimit);
    this.report.note(`sent  ${s.label}: gas ${receipt.gasUsed} (estimate ${sized.estimate}, limit ${sized.gasLimit}), tx ${hash}`);
    return receipt;
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
    let sized: Sized;
    try {
      sized = await this.size(s);
    } catch (e: unknown) {
      if (e instanceof TxWouldRevert) {
        this.report.tx({ key: s.key, label: s.label, role: s.role, status: 'would revert', error: e.why });
        if (this.send) throw e;
        this.unsent.add(s.key);
        this.report.check(`${s.label} simulates`, false, e.why);
        return { sent: false, skipped: false };
      }
      if (e instanceof TxOverGasCap) {
        this.report.tx({ key: s.key, label: s.label, role: s.role, status: 'over the gas cap', estimate: e.estimate });
        if (this.send) throw e;
        this.unsent.add(s.key);
        return { sent: false, skipped: false, estimate: e.estimate };
      }
      throw e;
    }
    const { estimate, gasLimit } = sized;
    if (!this.send) {
      this.unsent.add(s.key);
      this.report.note(`sim   ${s.label}: simulates; gas limit ${gasLimit}`);
      this.report.tx({ key: s.key, label: s.label, role: s.role, status: 'simulated', estimate, gasLimit });
      return { sent: false, skipped: false, estimate, gasLimit };
    }
    const hash = await this.broadcast(s, sized);
    this.journal?.put(s.key, { status: 'sent', label: s.label, role: s.role, hash, estimate, gasLimit });
    let receipt: TransactionReceipt;
    try {
      receipt = await this.mined(s, hash, sized);
    } catch (e: unknown) {
      if (e instanceof TxReverted) this.report.tx({ key: s.key, label: s.label, role: s.role, status: 'reverted', hash, gasUsed: e.receipt.gasUsed, gasLimit });
      throw e;
    }
    this.journal?.put(s.key, {
      status: 'mined',
      label: s.label,
      role: s.role,
      hash,
      estimate,
      gasLimit,
      block: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
    });
    this.report.tx({ key: s.key, label: s.label, role: s.role, status: 'mined', hash, block: receipt.blockNumber, estimate, gasLimit, gasUsed: receipt.gasUsed });
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
