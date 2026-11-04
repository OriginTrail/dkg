// PHASE finalize, in E+1 after end(E) + the receipt grace: finalizeClaims on the
// two claims of the serve batches, one on each period the run funded, which the
// run's own state names and the batches' receipts must show. finalizeClaims does
// not revert for a claim it cannot finalize: it skips it with ClaimSkipped and a
// reason, and the transaction succeeds. So what became of each claim is worked out
// each time, in one place, from chain storage and the journal's receipts, and kept
// nowhere: finalized, by this run or by another caller; waiting on the seller,
// skipped NoScore while it has no node score in E+1, and retried after its next
// proof; or void, once E+1 has ended with it unfinalized. Storage says only that a
// claim was finalized: what it finalized to is in its ClaimsFinalized event, which is
// held to what the claim was due, whoever's it is.

import type { TransactionReceipt } from 'ethers';

import { Contracts, eventsIn } from '../contracts';
import { fmt, iso, sum } from '../report';
import { ClaimRef, SkipReason, finalizedValueOf, predictSkip, skipReasonOf } from '../reads';
import { PoolCtx, complete, doneEarlier, epochStart, now, opensAt, runState, standInProof } from './context';
import { pagedLogs } from './reward-claims';
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

/** What became of a claim: `reason` is why finalizeClaims would skip it now. */
type Outcome = Claim & { status: Status; reason: SkipReason };

const settled = (x: Outcome): boolean => x.status === 'finalized' || x.status === 'finalized by another caller';
export const names = (xs: { period: string }[]): string => xs.map((x) => x.period).join(' and ');

/** The claims the journaled serve batches' receipts show, from their ReceiptsClaimed events. */
async function claimsInBatches(ctx: PoolCtx, s: ServedState): Promise<ClaimRef[]> {
  const out: ClaimRef[] = [];
  for (const key of ['serve.batch-1', 'serve.batch-2']) {
    const record = s.steps[key];
    if (record) out.push(...eventsIn(await ctx.tx.receipt(record.hash), ctx.c.qs, ctx.c.qs.getEvent('ReceiptsClaimed')));
  }
  return out;
}

/** One finalizeClaims receipt: the claims it finalized. Neither their fate nor what they finalized to is read from here. */
function readAttempt(ctx: PoolCtx, receipt: TransactionReceipt, claims: Claim[]): ClaimRef[] {
  const { report, c } = ctx;
  const finalized = claims.filter((x) => eventsIn(receipt, c.qs, c.qs.getEvent('ClaimsFinalized')).some((ev) => sameRef(x, ev)));
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
      out.push({ ...claim, reason, status: ours.some((x) => sameRef(x, claim)) ? 'finalized' : 'finalized by another caller' });
    } else {
      out.push({ ...claim, reason, status: reason === 'None' ? 'pending' : reason === 'NoScore' ? 'waiting on the seller' : reason === 'Void' ? 'void' : 'skipped' });
    }
  }
  return out;
}

/** The run's claims that storage does not hold finalized, whoever would have finalized them. */
export async function unfinalizedClaims(ctx: PoolCtx, s: SetupState): Promise<Claim[]> {
  const out: Claim[] = [];
  for (const x of expectedClaims(s)) if (!(await ctx.c.qis.getSellerClaim(x.subscriptionId, x.bucketIndex, x.seller)).finalized) out.push(x);
  return out;
}

/** A finalization, as its ClaimsFinalized event says. */
type Finalization = ClaimRef & { epoch: bigint; claimed: bigint; value: bigint; score: bigint; tx: string; block: number };

/** Every finalization since the run's stake, of any seller on any period, whoever's it is. */
async function finalizationsSince(ctx: PoolCtx, s: SetupState): Promise<Finalization[]> {
  const { qs } = ctx.c;
  const staked = await ctx.tx.receipt(s.steps['setup.stake'].hash);
  const logs = await pagedLogs(ctx.hre.ethers.provider, { address: await qs.getAddress(), topics: [qs.getEvent('ClaimsFinalized').fragment.topicHash] }, staked.blockNumber);
  return logs.map((l) => {
    const { args } = qs.interface.parseLog({ topics: [...l.topics], data: l.data }) ?? {};
    if (!args) throw new Error(`transaction ${l.transactionHash}: a ClaimsFinalized log that does not parse`);
    return { subscriptionId: args.subscriptionId, bucketIndex: args.bucketIndex, seller: args.seller, epoch: args.epoch, claimed: args.claimed, value: args.value, score: args.score, tx: l.transactionHash, block: l.blockNumber };
  });
}

/** What a claim is due, from what no finalization writes: its value and its weighted value × min(1, the bucket's funded cap / all its claims). */
async function dueOf(c: Contracts, ref: ClaimRef): Promise<{ value: bigint; score: bigint }> {
  const { weighted } = await c.qis.getSellerClaim(ref.subscriptionId, ref.bucketIndex, ref.seller);
  const cap = await c.qs.fundedCap(ref.subscriptionId, ref.bucketIndex);
  const total = await c.qis.bucketClaimed(ref.subscriptionId, ref.bucketIndex);
  return { value: await finalizedValueOf(c, ref), score: total > cap ? (weighted * cap) / total : weighted };
}

/**
 * Each of the run's claims against what it was due, by its own event, whoever finalized
 * it; and the node's and the epoch's sums, which others' value also goes into, exactly
 * against all the epoch's finalizations: other value cannot make up for a claim finalized
 * at too little, nor a sum hold what no finalization shows. False if any of them fails.
 */
export async function checkFinalizations(ctx: PoolCtx, s: SetupState): Promise<boolean> {
  const { report, c } = ctx;
  const P = s.E + 1n;
  // The sums as of the last block read: others can finalize in E+1 while the logs are paged.
  const head = await ctx.hre.ethers.provider.getBlockNumber();
  const finalizations = await finalizationsSince(ctx, s);
  let ok = true;
  for (const claim of expectedClaims(s)) {
    const ev = finalizations.find((x) => sameRef(x, claim));
    const due = await dueOf(c, claim);
    const held = report.check(
      `the ${claim.period} claim is finalized in epoch ${P} at what it is due, by its own ClaimsFinalized event`,
      !!ev && ev.epoch === P && ev.value === due.value && ev.score === due.score,
      ev ? `${fmt(ev.value)} of ${fmt(ev.claimed)} TRAC claimed, due ${fmt(due.value)}; score ${ev.score}, due ${due.score}; tx ${ev.tx}` : 'no ClaimsFinalized of it on chain',
    );
    ok = held && ok;
  }
  const inP = finalizations.filter((x) => x.epoch === P && x.block <= head);
  const ofSeller = inP.filter((x) => x.seller === s.sellerId);
  const value = (xs: Finalization[]): bigint => sum(xs.map((x) => x.value));
  const score = (xs: Finalization[]): bigint => sum(xs.map((x) => x.score));
  const node = await c.qis.getNodeEpoch(s.sellerId, P, { blockTag: head });
  const totals = await c.qis.getEpochTotals(P, { blockTag: head });
  const nodeHolds = report.check(
    `node ${s.sellerId}'s R and score in epoch ${P} are what its finalizations add up to`,
    node.r === value(ofSeller) && node.score === score(ofSeller),
    `R ${fmt(node.r)} TRAC, ${ofSeller.length} finalization${ofSeller.length === 1 ? '' : 's'} of ${fmt(value(ofSeller))} TRAC; score ${node.score} of ${score(ofSeller)}`,
  );
  const totalsHold = report.check(
    `epoch ${P}'s ΣR and ΣQueryInferenceScore are what all its finalizations add up to`,
    totals.sumR === value(inP) && totals.sumScore === score(inP),
    `ΣR ${fmt(totals.sumR)} TRAC, ${inP.length} finalization${inP.length === 1 ? '' : 's'} of ${fmt(value(inP))} TRAC; ΣQueryInferenceScore ${totals.sumScore} of ${score(inP)}`,
  );
  report.set('finalizations', inP);
  return ok && nodeHolds && totalsHold;
}

/** What the run's claims that storage holds finalized were due: after `checkFinalizations`, what they finalized to. */
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
  for (const k of attempts) ours.push(...readAttempt(ctx, await ctx.tx.receipt(s.steps[k].hash), claims));
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
      if (result.receipt) ours.push(...readAttempt(ctx, result.receipt, claims));
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
    report.note(`=     the ${x.period} claim was finalized by another caller (the upkeep cron)`);
  }
  report.check(
    `every claim is finalized${outcomes.some((x) => x.status === 'finalized by another caller') ? ', some by another caller (the upkeep cron)' : ''}`,
    outcomes.every(settled),
    outcomes.map((x) => `${x.period} ${x.status}`).join(', '),
  );
  await checkFinalizations(ctx, s);
  complete(ctx);
  if (ctx.env.send) report.say(`\nNext: PHASE=close-claim SEND=1 from ${iso(end)}.`);
}
