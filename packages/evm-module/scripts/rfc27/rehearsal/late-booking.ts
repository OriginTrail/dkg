// PHASE late-booking: an account no one touched for several epochs, booked by
// one settle: each window with its on-time curve, shifted to start in the
// current epoch, as test/helpers' emission model books it.

import { PoolModel, Range, curveStart, scheduleModel } from '../../../test/helpers/emission-model';
import { eventsIn } from '../contracts';
import { Report, fmt, sum } from '../report';
import { Ctx, saveResults, send, withPool } from './context';
import { StoredPools, WindowRange, closedWindows, poolsHold, sameRanges, stakerCredits, stakerPools } from './reads';
import { loadCycle } from './results';

/** What one settle had to book, worked out without it, and what it did. */
export type LateBooking = {
  /** The account's closed windows that were not booked yet, from its cursor and the settle block's time. */
  expected: WindowRange;
  /** The model of each expected window's booking. */
  curves: Awaited<ReturnType<typeof scheduleModel>>['curves'];
  /** Each window's allowance. */
  allowance: bigint;
  /** The epoch of the settle. */
  epoch: bigint;
  emitted: WindowRange & { scheduled: bigint };
  cursorAfter: bigint;
  credits: Range[];
  /** The staker pools as storage holds them around the settle, and what the model has them gain. */
  stored: { before: StoredPools; after: StoredPools; model: PoolModel };
};

/** The late booking's checks, each against what the settlement did not get to choose. */
export function checkLateBooking(report: Report, b: LateBooking): void {
  const { expected, emitted, credits, epoch: E } = b;
  report.check(
    `settle books every closed window, ${expected.fromWindow}..${expected.toWindow - 1n}, and moves the cursor past them`,
    emitted.fromWindow === expected.fromWindow && emitted.toWindow === expected.toWindow && b.cursorAfter === expected.toWindow,
    `emitted ${emitted.fromWindow}..${emitted.toWindow - 1n}, cursor ${b.cursorAfter}`,
  );
  const shapeKept = b.curves.every((cv) => {
    const shift = curveStart(cv.anchorEpoch, E) - cv.anchorEpoch;
    return (
      cv.booked.length === cv.onTime.length &&
      cv.booked.every((r, i) => r.amount === cv.onTime[i].amount && r.start - cv.onTime[i].start === shift && r.end - cv.onTime[i].end === shift)
    );
  });
  report.check(
    'each late window is booked with its on-time curve, shifted to start in the current epoch',
    shapeKept && sameRanges(credits, b.curves.flatMap((cv) => cv.booked)),
    `${credits.length} credits from epoch ${credits[0]?.start} to ${credits[credits.length - 1]?.end}`,
  );
  report.check('no late booking credits an epoch that has ended', credits.every((x) => x.start >= E));
  const windows = expected.toWindow - expected.fromWindow;
  report.check(
    'the money is conserved: the closed windows\' whole allowance, and nothing else',
    sum(credits.map((x) => x.amount)) === emitted.scheduled && emitted.scheduled === b.allowance * windows,
    `${fmt(sum(credits.map((x) => x.amount)))} TRAC = ${windows} × ${fmt(b.allowance)}`,
  );
  report.check(
    'the staker pools in storage gained what the model books, epoch by epoch, with the remainder it carries',
    poolsHold(b.stored.before, b.stored.after, b.stored.model),
    `${b.stored.model.perEpoch.size} epochs; remainder ${b.stored.after.remainder}`,
  );
}

export async function phaseLateBooking(ctx: Ctx): Promise<void> {
  const { report } = ctx;
  const check = report.check.bind(report);
  const cyc = loadCycle();
  const c = await withPool(ctx);
  const [, , , , , , keeper] = await ctx.hre.ethers.getSigners();
  const id = cyc.lateAccount.accountId;
  const acct = await c.pcs.getAccount(id);
  const created = acct.createdAtTimestamp;
  const lock = acct.lockDurationEpochs;
  const epLen = await c.chronos.epochLength();
  const committed = acct.committedTRAC;
  const B = committed / lock;
  await ctx.fork.warpTo((await c.chronos.timestampForEpoch(cyc.activation + 6n)) + 60n);
  const E = await c.chronos.getCurrentEpoch();
  report.say(`\nEpoch ${E}: account ${id}, created in epoch ${await c.chronos.epochAtTimestamp(created)}, untouched since`);
  check(`account ${id} has booked no window yet`, acct.lastSettledWindow === 0n);

  // No window booked now reaches past one lock from this epoch.
  const before = await stakerPools(c, E, E + lock + 1n);
  const settled = await send(ctx, `keeper: settle(${id})`, keeper, await c.pc.getAddress(), c.pc.interface.encodeFunctionData('settle', [id]));
  const [sched] = eventsIn(settled.receipt, c.pc, c.pc.getEvent('EmissionScheduled'));
  if (!sched) throw new Error(`settle(${id}) emitted no EmissionScheduled`);
  const block = await ctx.hre.ethers.provider.getBlock(settled.receipt.blockNumber);
  if (!block) throw new Error(`no block ${settled.receipt.blockNumber}`);
  const expected = closedWindows({ cursor: acct.lastSettledWindow, createdAt: created, epLen, lock, at: BigInt(block.timestamp) });
  const credits = stakerCredits(settled.receipt, c);
  // The model of each window's booking: its allowance less what it spent (and the
  // commitment's dust on the last), spread from the epoch it closed in with
  // the time left in that epoch, shifted to start in the current one.
  const spent = new Map<bigint, bigint>();
  for (let w = expected.fromWindow; w < expected.toWindow; w++) spent.set(w, await c.pcs.windowSpent(id, w));
  const pool = new PoolModel(before.remainder);
  const model = await scheduleModel({ chronos: c.chronos, model: pool, committed, createdAtTimestamp: created, lock, epLen, currentEpoch: E, fromWindow: expected.fromWindow, toWindow: expected.toWindow, spent });
  const windows = model.curves.map((cv) => {
    const start = curveStart(cv.anchorEpoch, E);
    return { window: cv.window, closeEpoch: cv.anchorEpoch, startEpoch: start, shiftedBy: start - cv.anchorEpoch, remainder: sum(cv.booked.map((r) => r.amount)), ranges: cv.booked };
  });
  report.say(`  windows ${expected.fromWindow}..${expected.toWindow - 1n} closed, in epochs ${windows.map((x) => x.closeEpoch).join(', ')}`);
  const cursorAfter = (await c.pcs.getAccount(id)).lastSettledWindow;
  const emitted = { fromWindow: sched.fromWindow, toWindow: sched.toWindow, scheduled: sched.scheduled };
  const after = await stakerPools(c, E, E + lock + 1n);
  checkLateBooking(report, { expected, curves: model.curves, allowance: B, epoch: E, emitted, cursorAfter, credits, stored: { before, after, model: pool } });
  saveResults(ctx, 'late-booking', { epoch: E, accountId: id, fromWindow: expected.fromWindow, toWindow: expected.toWindow, emitted, cursorAfter, windows, credits, gasUsed: settled.gasUsed });
}
