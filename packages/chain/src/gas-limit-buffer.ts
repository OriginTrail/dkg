// SPDX-License-Identifier: Apache-2.0

/**
 * Gas headroom for a write whose cost depends on the block it is mined in.
 * The estimate runs against the latest block and the transaction is mined in a
 * later one; when that block takes a costlier path the transaction runs out of
 * gas and reverts with empty (`0x`) data. Unused gas is refunded, so headroom
 * costs nothing when it is not needed, but the wallet must hold the whole
 * limit times the fee before the transaction is accepted.
 */
export interface GasLimitBufferOptions {
  /** Headroom as a share of the estimate, in basis points (5_000 = +50%). */
  gasLimitBufferBps?: number;
  /**
   * Least headroom, in gas. For a cost gap that is a fixed amount of work and
   * not a share of the estimate, such as a branch only the mined block takes.
   */
  gasLimitMinBuffer?: bigint;
}

/** Whether the caller asked for a gas limit above the raw estimate. */
export function wantsGasLimitBuffer(opts: GasLimitBufferOptions | undefined): opts is GasLimitBufferOptions {
  return Boolean(opts?.gasLimitBufferBps) || (opts?.gasLimitMinBuffer ?? 0n) > 0n;
}

/** The estimate plus the larger of its proportional share and the least headroom. */
export function bufferedGasLimit(estimate: bigint, opts: GasLimitBufferOptions): bigint {
  const proportional = (estimate * BigInt(opts.gasLimitBufferBps ?? 0)) / 10_000n;
  const least = opts.gasLimitMinBuffer ?? 0n;
  return estimate + (proportional > least ? proportional : least);
}
