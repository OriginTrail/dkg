// Exact TypeScript model of the PublishingConviction emission math:
// PublishingMathLib.prorateActiveSink, EpochStorage.addTokensToEpochRange with
// its shard-global remainder carry and its clamp of elapsed epochs, the
// treasury fee split, and the per-window booking of _bookWindows (which
// 10.0.8 and 10.1.0 ran over every window at once, as their schedule). Shared
// by the emission, sweep and conservation suites, so all check the contracts
// against one model.

import { Chronos } from '../../typechain';

export interface Range {
  start: bigint;
  end: bigint;
  amount: bigint;
}

/** Byte-exact mirror of PublishingMathLib.prorateActiveSink. */
export function prorateActiveSink(
  tokenAmount: bigint,
  anchorEpoch: bigint,
  epochs: bigint,
  epLen: bigint,
  timeRemaining: bigint,
): Range[] {
  const base = tokenAmount / epochs;
  const cur = (base * timeRemaining) / epLen;
  let fin = base - cur;
  const fulls = epochs - 1n;
  const totFull = base * fulls;
  const totalAllocated = cur + totFull + fin;
  if (totalAllocated < tokenAmount) fin += tokenAmount - totalAllocated;

  const out: Range[] = [];
  if (cur > 0n) out.push({ start: anchorEpoch, end: anchorEpoch, amount: cur });
  if (fulls > 0n && totFull > 0n) {
    out.push({ start: anchorEpoch + 1n, end: anchorEpoch + fulls, amount: totFull });
  }
  if (fin > 0n) {
    out.push({ start: anchorEpoch + epochs, end: anchorEpoch + epochs, amount: fin });
  }
  return out;
}

/**
 * EpochStorage's clamp of one shard: a credit that starts before the first
 * epoch not yet finalized (`lastFinalizedEpoch + 1`) starts there instead, its
 * end moved up with it if needed, and every credit then finalizes the shard
 * through the epoch before the current one. Read `firstOpen` from
 * `lastFinalizedEpoch(shard) + 1` before the transaction.
 */
export type Clamp = { firstOpen: bigint; currentEpoch: bigint };

/**
 * Byte-exact mirror of EpochStorage.addTokensToEpochRange's per-epoch split
 * with the shard-global `accumulatedRemainder` carry, and, given a `clamp`,
 * its clamp of elapsed epochs. Call order matters and is preserved by the
 * callers below. `credited` holds the ranges as the storage credits them.
 */
export class PoolModel {
  perEpoch = new Map<bigint, bigint>();
  credited: Range[] = [];
  constructor(
    public remainder: bigint,
    public clamp?: Clamp,
  ) {}

  add(r: Range): void {
    let { start, end } = r;
    if (this.clamp) {
      if (start < this.clamp.firstOpen) {
        start = this.clamp.firstOpen;
        if (end < start) end = start;
      }
      if (this.clamp.currentEpoch > 1n) this.clamp.firstOpen = this.clamp.currentEpoch;
    }
    this.credited.push({ start, end, amount: r.amount });
    const num = end - start + 1n;
    const total = r.amount + this.remainder;
    const per = total / num;
    this.remainder = total % num;
    for (let e = start; e <= end; e++) {
      this.perEpoch.set(e, (this.perEpoch.get(e) ?? 0n) + per);
    }
  }
}

/** _feeOf mirror (BPS_DENOMINATOR = 10_000). */
export const feeOf = (amount: bigint, bps: bigint): bigint =>
  bps === 0n ? 0n : (amount * bps) / 10_000n;

/**
 * Byte-exact mirror of _bookWindows + _emitForwardFrom for an account:
 * windows [fromWindow, toWindow) — every window, L, by default, as the 10.0.8
 * schedule booked them — each split (B − spent_w [+ dust on last]) into
 * fee = feeOf(remainder, bps) → the treasury shard and net = remainder − fee
 * → the staker shard, both forward from the window's close on the same
 * curve. bps = 0 (treasury unwired at booking time) degenerates to the
 * all-gross staker booking.
 */
export async function scheduleModel(opts: {
  chronos: Chronos;
  model: PoolModel;
  committed: bigint;
  createdAtTimestamp: bigint;
  lock: bigint;
  epLen: bigint;
  fromWindow?: bigint;
  toWindow?: bigint;
  spent?: Map<bigint, bigint>;
  bps?: bigint;
  feeModel?: PoolModel;
}): Promise<{ scheduled: bigint; treasuryFee: bigint }> {
  const {
    chronos,
    model,
    committed,
    createdAtTimestamp,
    lock,
    epLen,
  } = opts;
  const fromWindow = opts.fromWindow ?? 0n;
  const toWindow = opts.toWindow ?? lock;
  const spent = opts.spent ?? new Map<bigint, bigint>();
  const bps = opts.bps ?? 0n;
  const feeModel = opts.feeModel ?? new PoolModel(0n);

  const base = committed / lock;
  const dust = committed - base * lock;
  let scheduled = 0n;
  let treasuryFee = 0n;

  for (let w = fromWindow; w < toWindow; w++) {
    const s = spent.get(w) ?? 0n;
    let remainder = s < base ? base - s : 0n;
    if (w === lock - 1n) remainder += dust;
    if (remainder === 0n) continue;
    const fee = feeOf(remainder, bps);
    const net = remainder - fee;

    const fromTs = createdAtTimestamp + (w + 1n) * epLen;
    const anchorEpoch = await chronos.epochAtTimestamp(fromTs);
    const nextBoundary = await chronos.timestampForEpoch(anchorEpoch + 1n);
    const timeRemaining = nextBoundary > fromTs ? nextBoundary - fromTs : 0n;
    if (net > 0n) {
      scheduled += net;
      for (const r of prorateActiveSink(net, anchorEpoch, lock, epLen, timeRemaining)) {
        model.add(r);
      }
    }
    if (fee > 0n) {
      treasuryFee += fee;
      for (const r of prorateActiveSink(fee, anchorEpoch, lock, epLen, timeRemaining)) {
        feeModel.add(r);
      }
    }
  }
  return { scheduled, treasuryFee };
}
