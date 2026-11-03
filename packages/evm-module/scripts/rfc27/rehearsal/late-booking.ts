// PHASE late-booking: an account no one touched for several epochs, booked by
// one settle: each window with its on-time curve, shifted to start in the
// current epoch, as test/helpers' emission model books it.

import { PoolModel, curveStart, scheduleModel } from '../../../test/helpers/emission-model';
import { eventsIn } from '../contracts';
import { fmt, sum } from '../report';
import { Ctx, saveResults, send, withPool } from './context';
import { sameRanges, stakerCredits } from './reads';
import { loadCycle } from './results';

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

  const settled = await send(ctx, `keeper: settle(${id})`, keeper, await c.pc.getAddress(), c.pc.interface.encodeFunctionData('settle', [id]));
  const [sched] = eventsIn(settled.receipt, c.pc, c.pc.getEvent('EmissionScheduled'));
  if (!sched) throw new Error(`settle(${id}) emitted no EmissionScheduled`);
  const fromW = sched.fromWindow;
  const toW = sched.toWindow;
  const credits = stakerCredits(settled.receipt, c);
  // The model of each window's booking: its budget less what it drew (and the
  // commitment's dust on the last), spread from the epoch it closed in with
  // the time left in that epoch, shifted to start in the current one.
  const spent = new Map<bigint, bigint>();
  for (let w = fromW; w < toW; w++) spent.set(w, await c.pcs.windowSpent(id, w));
  const model = await scheduleModel({ chronos: c.chronos, model: new PoolModel(0n), committed, createdAtTimestamp: created, lock, epLen, currentEpoch: E, fromWindow: fromW, toWindow: toW, spent });
  const windows = model.curves.map((cv) => {
    const start = curveStart(cv.anchorEpoch, E);
    return { window: cv.window, closeEpoch: cv.anchorEpoch, startEpoch: start, shiftedBy: start - cv.anchorEpoch, remainder: sum(cv.booked.map((r) => r.amount)), ranges: cv.booked };
  });
  const shapeKept = model.curves.every((cv) => {
    const shift = curveStart(cv.anchorEpoch, E) - cv.anchorEpoch;
    return (
      cv.booked.length === cv.onTime.length &&
      cv.booked.every((r, i) => r.amount === cv.onTime[i].amount && r.start - cv.onTime[i].start === shift && r.end - cv.onTime[i].end === shift)
    );
  });
  const expected = model.curves.flatMap((cv) => cv.booked);
  report.say(`  windows ${fromW}..${toW - 1n} booked, each closed in epochs ${windows.map((x) => x.closeEpoch).join(', ')}`);
  check(
    'each late window is booked with its on-time curve, shifted to start in the current epoch',
    shapeKept && sameRanges(credits, expected),
    `${credits.length} credits from epoch ${credits[0]?.start} to ${credits[credits.length - 1]?.end}`,
  );
  check('no late booking credits an epoch that has ended', credits.every((x) => x.start >= E));
  check(
    'the money is conserved: the booked windows\' whole budget, and nothing else',
    sum(credits.map((x) => x.amount)) === sched.scheduled && sched.scheduled === B * (toW - fromW),
    `${fmt(sum(credits.map((x) => x.amount)))} TRAC = ${toW - fromW} × ${fmt(B)}`,
  );
  saveResults(ctx, 'late-booking', { epoch: E, accountId: id, fromWindow: fromW, toWindow: toW, windows, credits, gasUsed: settled.gasUsed });
}
