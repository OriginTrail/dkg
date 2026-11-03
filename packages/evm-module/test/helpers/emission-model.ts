// Exact TypeScript model of the PublishingConviction emission math:
// PublishingMathLib.prorateActiveSink, a late window's curve shifted to start
// at the current epoch (_emitForwardFrom), EpochStorage.addTokensToEpochRange
// with its shard-global remainder carry, the treasury fee split, and the
// per-window booking of _bookWindows (which 10.0.8 and 10.1.0 ran over every
// window at once, as their schedule). PublishingConviction never books into an
// epoch that has ended, so EpochStorage's clamp to its first unfinalized epoch
// never moves one of these credits, and the model has none. Shared by the
// suites that check these bookings, so all check the contracts against one
// model.

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
 * The epoch a window's curve starts in, as PublishingConviction._emitForwardFrom
 * books it: the epoch its window closed in, `anchorEpoch`, when it is booked in
 * that epoch, and otherwise the epoch of the booking, `currentEpoch`. A late
 * window keeps the very shape of its on-time curve, shifted later: no ended
 * epoch is credited, and no epoch takes more of the window than its on-time
 * slice.
 */
export const curveStart = (anchorEpoch: bigint, currentEpoch: bigint): bigint =>
  anchorEpoch < currentEpoch ? currentEpoch : anchorEpoch;

/** The largest amount one epoch takes of `ranges`: a window's slice. */
export function largestSlice(ranges: Range[]): bigint {
  let max = 0n;
  for (const r of ranges) {
    const per = r.amount / (r.end - r.start + 1n);
    if (per > max) max = per;
  }
  return max;
}

/**
 * Byte-exact mirror of EpochStorage.addTokensToEpochRange's per-epoch split
 * with the shard-global `accumulatedRemainder` carry. Call order matters and is
 * preserved by the callers below. `credited` holds the ranges as the storage
 * credits them.
 */
export class PoolModel {
  perEpoch = new Map<bigint, bigint>();
  credited: Range[] = [];
  constructor(public remainder: bigint) {}

  add(r: Range): void {
    this.credited.push({ ...r });
    const num = r.end - r.start + 1n;
    const total = r.amount + this.remainder;
    const per = total / num;
    this.remainder = total % num;
    for (let e = r.start; e <= r.end; e++) {
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
 * curve, which a window booked after its close epoch has ended starts in
 * `currentEpoch`, the epoch of the booking transaction (`curveStart`). bps = 0
 * (treasury unwired at booking time) degenerates to the all-gross staker
 * booking. `curves` collects each window's staker curve, in window order.
 */
export async function scheduleModel(opts: {
  chronos: Chronos;
  model: PoolModel;
  committed: bigint;
  createdAtTimestamp: bigint;
  lock: bigint;
  epLen: bigint;
  currentEpoch: bigint;
  fromWindow?: bigint;
  toWindow?: bigint;
  spent?: Map<bigint, bigint>;
  bps?: bigint;
  feeModel?: PoolModel;
}): Promise<{
  scheduled: bigint;
  treasuryFee: bigint;
  curves: Array<{ window: bigint; anchorEpoch: bigint; onTime: Range[]; booked: Range[] }>;
}> {
  const {
    chronos,
    model,
    committed,
    createdAtTimestamp,
    lock,
    epLen,
    currentEpoch,
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
  const curves: Array<{ window: bigint; anchorEpoch: bigint; onTime: Range[]; booked: Range[] }> = [];

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
    const start = curveStart(anchorEpoch, currentEpoch);
    if (net > 0n) {
      scheduled += net;
      const booked = prorateActiveSink(net, start, lock, epLen, timeRemaining);
      for (const r of booked) model.add(r);
      curves.push({ window: w, anchorEpoch, onTime: prorateActiveSink(net, anchorEpoch, lock, epLen, timeRemaining), booked });
    }
    if (fee > 0n) {
      treasuryFee += fee;
      for (const r of prorateActiveSink(fee, start, lock, epLen, timeRemaining)) feeModel.add(r);
    }
  }
  return { scheduled, treasuryFee, curves };
}
