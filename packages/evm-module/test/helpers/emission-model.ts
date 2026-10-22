// Exact TypeScript model of the PublishingConviction emission math:
// PublishingMathLib.prorateActiveSink, EpochStorage.addTokensToEpochRange with
// its shard-global remainder carry, the treasury fee split, and the up-front
// per-window schedule that _scheduleRemaining writes. Shared by the emission
// schedule property tests and the ConvictionScheduleLib unit tests, so both
// check the contracts against one model.

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
 * Byte-exact mirror of EpochStorage.addTokensToEpochRange's per-epoch split
 * with the shard-global `accumulatedRemainder` carry. Call order matters and
 * is preserved by the callers below.
 */
export class PoolModel {
  perEpoch = new Map<bigint, bigint>();
  constructor(public remainder: bigint) {}

  add(r: Range): void {
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
 * Byte-exact mirror of _scheduleRemaining + _emitForwardFrom for an account:
 * windows [fromWindow, L) each split (B − spent_w [+ dust on last]) into
 * fee = feeOf(remainder, bps) → the treasury shard and net = remainder − fee
 * → the staker shard, both forward from the window's close on the same
 * curve. bps = 0 (treasury unwired at schedule time) degenerates to the
 * all-gross staker schedule.
 */
export async function scheduleModel(opts: {
  chronos: Chronos;
  model: PoolModel;
  committed: bigint;
  createdAtTimestamp: bigint;
  lock: bigint;
  epLen: bigint;
  fromWindow?: bigint;
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
  const spent = opts.spent ?? new Map<bigint, bigint>();
  const bps = opts.bps ?? 0n;
  const feeModel = opts.feeModel ?? new PoolModel(0n);

  const base = committed / lock;
  const dust = committed - base * lock;
  let scheduled = 0n;
  let treasuryFee = 0n;

  for (let w = fromWindow; w < lock; w++) {
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
