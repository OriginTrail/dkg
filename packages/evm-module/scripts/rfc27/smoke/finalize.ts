// PHASE finalize, in E+1 after end(E) + the receipt grace: finalizeClaims, with
// refs from the ReceiptsClaimed events of the serve batches. finalizeClaims
// does not revert for a ref it cannot finalize: it skips it with ClaimSkipped
// and a reason, and the transaction succeeds. So the outcome of every ref is
// read from the receipts. A ref skipped NoScore, while the seller has no node
// score in E+1, waits for the seller's next proof and is retried; once E+1 has
// ended the claim is void.

import type { TransactionReceipt } from 'ethers';

import { eventsIn } from '../contracts';
import { fmt, iso, sum } from '../report';
import { ClaimRef, finalizedValueOf, predictSkip, skipReasonOf } from '../reads';
import { PoolCtx, complete, doneEarlier, epochStart, now, opensAt, runState, standInProof } from './context';
import { need } from './roles';
import { RefRecord, SmokeState } from './state';

const PREFIX = 'finalize.finalize-claims.';

const sameRef = (a: ClaimRef, b: ClaimRef): boolean =>
  a.subscriptionId.toLowerCase() === b.subscriptionId.toLowerCase() && a.bucketIndex === b.bucketIndex && a.seller === b.seller;

const settled = (r: RefRecord): boolean => r.status === 'finalized' || r.status === 'finalized by another caller';

/** The refs of the serve batches, from their ReceiptsClaimed events, with what became of each so far. */
async function refsOf(ctx: PoolCtx, s: SmokeState): Promise<RefRecord[]> {
  const period = (id: string) => (id === s.periods.ca ? 'account' : id === s.periods.wallet ? 'wallet' : id === s.periods.edge ? 'edge' : id);
  const out: RefRecord[] = [];
  for (const key of ['serve.batch-1', 'serve.batch-2']) {
    const rec = s.steps[key];
    if (!rec) throw new Error(`the state holds no ${key} transaction: the refs come from its ReceiptsClaimed events`);
    for (const ev of eventsIn(await ctx.tx.receipt(rec.hash), ctx.c.qs, ctx.c.qs.getEvent('ReceiptsClaimed'))) {
      const ref = { subscriptionId: ev.subscriptionId, bucketIndex: ev.bucketIndex, seller: ev.seller };
      if (out.some((x) => sameRef(x, ref))) continue;
      const earlier = s.refs?.find((x) => sameRef(x, ref));
      out.push({ ...ref, period: period(ev.subscriptionId), status: earlier?.status, reason: earlier?.reason, value: earlier?.value });
    }
  }
  return out;
}

/** What a finalizeClaims receipt did to each ref it names: ClaimsFinalized, or ClaimSkipped and why. */
async function applyOutcomes(ctx: PoolCtx, receipt: TransactionReceipt, refs: RefRecord[], E: bigint): Promise<void> {
  const { report, c } = ctx;
  const finalized = eventsIn(receipt, c.qs, c.qs.getEvent('ClaimsFinalized'));
  const skipped = eventsIn(receipt, c.qs, c.qs.getEvent('ClaimSkipped'));
  for (const ref of refs) {
    const f = finalized.find((ev) => sameRef(ev, ref));
    const k = skipped.find((ev) => sameRef(ev, ref));
    if (f) {
      ref.status = 'finalized';
      ref.reason = undefined;
      ref.value = f.value;
      const expected = await finalizedValueOf(c, ref);
      report.check(
        `the ${ref.period} claim is finalized in epoch ${E + 1n} at its funded value (tx ${receipt.hash.slice(0, 10)}…)`,
        f.epoch === E + 1n && f.value === expected,
        `${fmt(f.value)} of ${fmt(f.claimed)} TRAC claimed`,
      );
    } else if (k && !settled(ref)) {
      const reason = skipReasonOf(k.reason);
      ref.reason = reason;
      if (reason === 'NoScore') {
        ref.status = 'waiting on the seller';
        report.note(`skip  the ${ref.period} claim: ClaimSkipped(NoScore), the seller has no node score in epoch ${E + 1n} yet`);
      } else if (reason === 'AlreadyFinalized') {
        ref.status = 'finalized by another caller';
        ref.value = await finalizedValueOf(c, ref);
        report.note(`=     the ${ref.period} claim was finalized by another caller first: ${fmt(ref.value)} TRAC`);
      } else {
        ref.status = reason === 'Void' ? 'void' : 'skipped';
        report.check(`the ${ref.period} claim is finalized`, false, `ClaimSkipped(${reason})`);
      }
    }
  }
}

export async function phaseFinalize(ctx: PoolCtx): Promise<void> {
  const { report, c, file } = ctx;
  const r = need(ctx.roles, ['owner', 'ownerAddr']);
  const s = await runState(ctx, 'serve');
  if (doneEarlier(ctx, '')) return;
  const E = s.E ?? 0n;
  if (!s.periods.ca) throw new Error('the state holds no account period');
  const deadline = await c.qs.batchDeadline(s.periods.ca);
  const end = await epochStart(ctx, E + 2n);
  const refs = await refsOf(ctx, s);
  s.refs = refs;
  file.save();

  // The claims count in E+1 only: once it has ended, the ones not finalized are void.
  if ((await now(ctx)) >= end) {
    for (const ref of refs.filter((x) => !settled(x))) {
      ref.status = 'void';
      report.check(`the ${ref.period} claim is finalized in epoch ${E + 1n}`, false, `epoch ${E + 1n} ended at ${iso(end)} before it was: the claim is void, and its money carries on`);
    }
    file.save();
    report.fail(`epoch ${E + 1n} has ended`);
    return;
  }
  if (!(await opensAt(ctx, deadline + 1n, `the finalization of epoch ${E}'s claims, after their batch deadline`))) return;
  report.say(`\nFinalize in epoch ${E + 1n}, ${ctx.env.send ? 'sending' : 'dry run'}:`);

  // A real node proves through E+1; on the fork, with FORK_PROOFS=1, a stand-in does.
  if ((await c.rss.getNodeEpochScore(E + 1n, s.sellerId)) === 0n) await standInProof(ctx, 'the seller\'s first in E+1, which the finalization needs');

  // Each attempt is a transaction of its own. Those sent earlier land, and their outcomes apply, first.
  const attempts = Object.keys(s.steps).filter((k) => k.startsWith(PREFIX)).sort();
  for (const k of attempts) await applyOutcomes(ctx, await ctx.tx.receipt(s.steps[k].hash), refs, E);

  // Why finalizeClaims would skip each ref not settled yet.
  const t = await now(ctx);
  const pending: RefRecord[] = [];
  for (const ref of refs.filter((x) => !settled(x))) {
    const why = await predictSkip(c, ref, t);
    if (why === 'None') pending.push(ref);
    else if (why === 'AlreadyFinalized') {
      ref.status = 'finalized by another caller';
      ref.value = await finalizedValueOf(c, ref);
      report.note(`=     the ${ref.period} claim is finalized already, by another caller (the upkeep cron): ${fmt(ref.value)} TRAC`);
    } else if (why === 'NoScore') {
      ref.status = 'waiting on the seller';
      ref.reason = why;
    } else {
      throw new Error(`finalizeClaims would skip the ${ref.period} claim: ${why}`);
    }
  }
  file.save();

  if (pending.length) {
    const qs = await c.qs.getAddress();
    const data = c.qs.interface.encodeFunctionData('finalizeClaims', [pending.map(({ subscriptionId, bucketIndex, seller }) => ({ subscriptionId, bucketIndex, seller }))]);
    const [count] = c.qs.interface.decodeFunctionResult('finalizeClaims', await ctx.tx.call(r.ownerAddr, qs, data));
    report.check(`finalizeClaims would finalize all ${pending.length} pending claims`, BigInt(count) === BigInt(pending.length), `${count} of ${pending.length}`);
    const result = await ctx.tx.run({
      key: `${PREFIX}${attempts.length + 1}`,
      label: `owner: finalizeClaims (${pending.length} claims: ${pending.map((x) => x.period).join(', ')})`,
      role: 'owner',
      signer: r.owner,
      to: qs,
      data,
    });
    if (result.receipt) await applyOutcomes(ctx, result.receipt, pending, E);
    file.save();
    if (!ctx.env.send) return;
  }

  report.set('refs', refs);
  const waiting = refs.filter((x) => x.status === 'waiting on the seller');
  if (waiting.length) {
    report.wait(
      `on the seller's proof: node ${s.sellerId} has no node score in epoch ${E + 1n} yet, so finalizeClaims skips its ` +
        `${waiting.map((x) => x.period).join(' and ')} claim${waiting.length > 1 ? 's' : ''} (NoScore). ` +
        `Run PHASE=finalize again after the node's next proof, before ${iso(end)}, when the claims become void.`,
    );
    return;
  }
  const ours = sum(refs.map((x) => x.value ?? 0n));
  const R = (await c.qis.getNodeEpoch(s.sellerId, E + 1n)).r;
  report.check(
    `every claim is finalized${refs.some((x) => x.status === 'finalized by another caller') ? ', some by another caller (the upkeep cron)' : ''}`,
    refs.every(settled),
    refs.map((x) => `${x.period} ${x.status}`).join(', '),
  );
  report.check(`node ${s.sellerId}'s R in epoch ${E + 1n} holds our finalized ${fmt(ours)} TRAC`, R >= ours, `R ${fmt(R)} TRAC`);
  s.finalizedValue = ours;
  file.save();
  complete(ctx);
  if (ctx.env.send) report.say(`\nNext: PHASE=close-claim SEND=1 from ${iso(await epochStart(ctx, E + 2n))}.`);
}
