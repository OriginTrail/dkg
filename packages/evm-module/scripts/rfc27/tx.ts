// OT-RFC-27 script support: transactions. Each is estimated, checked against
// Base's per-transaction gas cap, given a gas limit set by hand, and sent.

import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import type { Signer, TransactionReceipt } from 'ethers';

import { decodeError, errorData } from './contracts';
import { Report } from './report';

/** EIP-7825's per-transaction gas cap, which Base enforces. */
export const TX_GAS_CAP = 1n << 24n;

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

/** A transaction the chain took, and how it was sized. */
export type Mined = Sized & { receipt: TransactionReceipt };

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
  constructor(
    protected readonly hre: HardhatRuntimeEnvironment,
    protected readonly report: Report,
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

  /** One transaction: sized, sent, and its receipt. It throws if it is not to be sent, or the chain reverted it. */
  async run(s: Tx): Promise<Mined> {
    const sized = await this.size(s);
    const hash = await this.broadcast(s, sized);
    return { ...sized, receipt: await this.mined(s, hash, sized) };
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
