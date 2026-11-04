// PHASE finalize, in E+1 after end(E) + the receipt grace: finalizeClaims on the
// two claims of the serve batches, one on each period the run funded, which the
// run's own state names and the batches' receipts must show. finalizeClaims does
// not revert for a claim it cannot finalize: it skips it with ClaimSkipped and a
// reason, and the transaction succeeds. So what became of each claim is worked out
// each time, in one place, from chain storage and the journal's receipts, and kept
// nowhere: finalized, by this run or by another caller; waiting on the seller,
// skipped NoScore while it has no node score in E+1, and retried after its next
// proof; or void, once E+1 has ended with it unfinalized.

import type { TransactionReceipt } from 'ethers';

import { eventsIn } from '../contracts';
import { fmt, iso, sum } from '../report';
import { ClaimRef, SkipReason, finalizedValueOf, predictSkip, skipReasonOf } from '../reads';
import { PoolCtx, complete, doneEarlier, epochStart, now, opensAt, runState, standInProof } from './context';
import { need } from './roles';
import { ServedState, SetupState } from './state';

const PREFIX = 'finalize.finalize-claims.';

const sameRef = (a: ClaimRef, b: ClaimRef): boolean =>
  a.subscriptionId.toLowerCase() === b.subscriptionId.toLowerCase() && a.bucketIndex === b.bucketIndex && a.seller === b.seller;

/** A claim of the serve batches. */
type Claim = ClaimRef & { period: 'account' | 'wallet' };

/** The claims the run must make: the seller's on bucket 0 of each period it funded. */
export const expectedClaims = (s: SetupState): Claim[] => [
  { period: 'account', subscriptionId: s.periods.ca, bucketIndex: 0n, seller: s.sellerId },
  { period: 'wallet', subscriptionId: s.periods.wallet, bucketIndex: 0n, seller: s.sellerId },
];

type Status = 'finalized' | 'finalized by another caller' | 'pending' | 'waiting on the seller' | 'void' | 'skipped';

/** What became of a claim: `reason` is why finalizeClaims would skip it now, and `value` what it finalized to. */
type Outcome = Claim & { status: Status; reason: SkipReason; value?: bigint };

const settled = (x: Outcome): boolean => x.status === 'finalized' || x.status === 'finalized by another caller';
const names = (xs: Claim[]): string => xs.map((x) => x.period).join(' and ');

/** The claims the journaled serve batches' receipts show, from their ReceiptsClaimed events. */
async function claimsInBatches(ctx: PoolCtx, s: ServedState): Promise<ClaimRef[]> {
  const out: ClaimRef[] = [];
  for (const key of ['serve.batch-1', 'serve.batch-2']) {
    const record = s.steps[key];
    if (record) out.push(...eventsIn(await ctx.tx.receipt(record.hash), ctx.c.qs, ctx.c.qs.getEvent('ReceiptsClaimed')));
  }
  return out;
}

/** One finalizeClaims receipt, its events checked: the claims it finalized. Each claim's fate is not read from here. */
async function readAttempt(ctx: PoolCtx, receipt: TransactionReceipt, claims: Claim[], P: bigint): Promise<ClaimRef[]> {
  const { report, c } = ctx;
  const finalized: ClaimRef[] = [];
  for (const ev of eventsIn(receipt, c.qs, c.qs.getEvent('ClaimsFinalized'))) {
    const claim = claims.find((x) => sameRef(x, ev));
    if (!claim) continue;
    finalized.push(claim);
    report.check(
      `the ${claim.period} claim is finalized in epoch ${P} at its funded value (tx ${receipt.hash.slice(0, 10)}…)`,
      ev.epoch === P && ev.value === (await finalizedValueOf(c, claim)),
      `${fmt(ev.value)} of ${fmt(ev.claimed)} TRAC claimed`,
    );
  }
  for (const ev of eventsIn(receipt, c.qs, c.qs.getEvent('ClaimSkipped'))) {
    const claim = claims.find((x) => sameRef(x, ev));
    if (claim) report.note(`skip  the ${claim.period} claim: ClaimSkipped(${skipReasonOf(ev.reason)}) (tx ${receipt.hash.slice(0, 10)}…)`);
  }
  return finalized;
}

/** What became of each claim, from chain storage now; `ours` are those the journal's receipts show this run finalized. */
async function outcomesOf(ctx: PoolCtx, claims: Claim[], ours: ClaimRef[]): Promise<Outcome[]> {
  const t = await now(ctx);
  const out: Outcome[] = [];
  for (const claim of claims) {
    const reason = await predictSkip(ctx.c, claim, t);
    if (reason === 'AlreadyFinalized') {
      out.push({ ...claim, reason, status: ours.some((x) => sameRef(x, claim)) ? 'finalized' : 'finalized by another caller', value: await finalizedValueOf(ctx.c, claim) });
    } else {
      out.push({ ...claim, reason, status: reason === 'None' ? 'pending' : reason === 'NoScore' ? 'waiting on the seller' : reason === 'Void' ? 'void' : 'skipped' });
    }
  }
  return out;
}

/** What the run's claims finalized to, as storage holds them now. */
export async function finalizedValue(ctx: PoolCtx, s: SetupState): Promise<bigint> {
  const values = await Promise.all(
    expectedClaims(s).map(async (x) => ((await ctx.c.qis.getSellerClaim(x.subscriptionId, x.bucketIndex, x.seller)).finalized ? finalizedValueOf(ctx.c, x) : 0n)),
  );
  return sum(values);
}

export async function phaseFinalize(ctx: PoolCtx): Promise<void> {
  const { report, c } = ctx;
  const r = need(ctx.roles, ['owner', 'ownerAddr']);
  const s = await runState(ctx, 'serve');
  if (doneEarlier(ctx, '')) return;
  const P = s.E + 1n; // the epoch the claims count in
  const end = await epochStart(ctx, s.E + 2n);

  // The claims the run's own state expects: without both, nothing here could prove the run.
  const claims = expectedClaims(s);
  const shown = await claimsInBatches(ctx, s);
  const missing = claims.filter((x) => !shown.some((y) => sameRef(x, y)));
  if (!report.check('the serve batches claimed on the account and the wallet period, for the seller', missing.length === 0, missing.length ? `their receipts show no ${names(missing)} claim` : undefined)) {
    report.fail(`the serve batches' receipts show no ${names(missing)} claim`);
    return;
  }

  // Each attempt is a transaction of its own, and those sent earlier land first. Then only a
  // claim still unfinalized can be void, once E+1 has ended; another caller may have finalized
  // the others at any time before.
  const attempts = Object.keys(s.steps).filter((k) => k.startsWith(PREFIX));
  const ours: ClaimRef[] = [];
  for (const k of attempts) ours.push(...(await readAttempt(ctx, await ctx.tx.receipt(s.steps[k].hash), claims, P)));
  let outcomes = await outcomesOf(ctx, claims, ours);
  const voided = outcomes.filter((x) => x.status === 'void');
  if (voided.length) {
    for (const x of voided) report.check(`the ${x.period} claim is finalized in epoch ${P}`, false, `epoch ${P} ended at ${iso(end)} before it was: the claim is void, and its money carries on`);
    report.set('claims', outcomes);
    report.fail(`epoch ${P} ended with the ${names(voided)} claim unfinalized`);
    return;
  }

  if (!outcomes.every(settled)) {
    const deadline = await c.qs.batchDeadline(s.periods.ca);
    if (!(await opensAt(ctx, deadline + 1n, `the finalization of epoch ${s.E}'s claims, after their batch deadline`))) return;
    report.say(`\nFinalize in epoch ${P}, ${ctx.env.send ? 'sending' : 'dry run'}:`);

    // A real node proves through E+1; on the fork, with FORK_PROOFS=1, a stand-in does.
    if ((await c.rss.getNodeEpochScore(P, s.sellerId)) === 0n) await standInProof(ctx, 'the seller\'s first in E+1, which the finalization needs');
    outcomes = await outcomesOf(ctx, claims, ours);
    const stuck = outcomes.find((x) => x.status === 'skipped');
    if (stuck) throw new Error(`finalizeClaims would skip the ${stuck.period} claim: ${stuck.reason}`);

    const pending = outcomes.filter((x) => x.status === 'pending');
    if (pending.length) {
      const qs = await c.qs.getAddress();
      const data = c.qs.interface.encodeFunctionData('finalizeClaims', [pending.map(({ subscriptionId, bucketIndex, seller }) => ({ subscriptionId, bucketIndex, seller }))]);
      const [count] = c.qs.interface.decodeFunctionResult('finalizeClaims', await ctx.tx.call(r.ownerAddr, qs, data));
      report.check(`finalizeClaims would finalize all ${pending.length} pending claims`, BigInt(count) === BigInt(pending.length), `${count} of ${pending.length}`);
      const result = await ctx.tx.step({
        key: `${PREFIX}${attempts.length + 1}`,
        label: `owner: finalizeClaims (${pending.length} claims: ${names(pending)})`,
        role: 'owner',
        signer: r.owner,
        to: qs,
        data,
      });
      if (!ctx.env.send) return;
      if (result.receipt) ours.push(...(await readAttempt(ctx, result.receipt, claims, P)));
      outcomes = await outcomesOf(ctx, claims, ours);
    }
  }

  report.set('claims', outcomes);
  const waiting = outcomes.filter((x) => x.status === 'waiting on the seller');
  if (waiting.length) {
    report.wait(
      `on the seller's proof: node ${s.sellerId} has no node score in epoch ${P} yet, so finalizeClaims skips its ` +
        `${names(waiting)} claim${waiting.length > 1 ? 's' : ''} (NoScore). ` +
        `Run PHASE=finalize again after the node's next proof, before ${iso(end)}, when the claims become void.`,
    );
    return;
  }

  for (const x of outcomes.filter((y) => y.status === 'finalized by another caller')) {
    report.note(`=     the ${x.period} claim was finalized by another caller (the upkeep cron): ${fmt(x.value ?? 0n)} TRAC`);
  }
  const value = sum(outcomes.map((x) => x.value ?? 0n));
  const R = (await c.qis.getNodeEpoch(s.sellerId, P)).r;
  report.check(
    `every claim is finalized${outcomes.some((x) => x.status === 'finalized by another caller') ? ', some by another caller (the upkeep cron)' : ''}`,
    outcomes.every(settled),
    outcomes.map((x) => `${x.period} ${x.status}`).join(', '),
  );
  report.check(`node ${s.sellerId}'s R in epoch ${P} holds our finalized ${fmt(value)} TRAC`, value > 0n && R >= value, `R ${fmt(R)} TRAC`);
  complete(ctx);
  if (ctx.env.send) report.say(`\nNext: PHASE=close-claim SEND=1 from ${iso(end)}.`);
}
