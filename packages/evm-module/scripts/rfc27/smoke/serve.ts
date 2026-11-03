// PHASE serve, still in E: the session keys sign five requests, the seller
// submits them in two receipt batches, and the Conviction Account period is
// topped up between them. The edge, on a period of its own buyer key, so the
// main flow's assignment stays as it is: fund, revoke, assign the same key
// again, and a top-up of the old period is refused with AssignmentExpired.

import { costOf, subscriptionIdOf } from '../../../test/helpers/conviction-service';

import { eventsIn } from '../contracts';
import { fmt, iso, sum } from '../report';
import { planValue, requestPlan } from './config';
import { PoolCtx, complete, doneEarlier, epochStart, now, runState, standInProof } from './context';
import { need } from './roles';
import { fundOnFork, planDigest } from './setup';
import { serveMissing } from './state';

export async function phaseServe(ctx: PoolCtx): Promise<void> {
  const { report, c, market, file } = ctx;
  const r = need(ctx.roles, ['owner', 'buyer', 'edgeBuyer', 'caSession', 'walletSession', 'edgeSession', 'seller']);
  const s = await runState(ctx, 'setup');
  if (doneEarlier(ctx, '')) return;
  const { amounts: a, E, accountId, accountExpiresAt: expiresAt, buyerNonce } = s;
  const { ca, wallet } = s.periods;
  const current = await c.chronos.getCurrentEpoch();
  if (current !== E) throw new Error(`serve runs in epoch ${E}, the epoch of the periods; it is ${current}: start a new run`);
  await fundOnFork(ctx, 0n);
  const plan = requestPlan(a);
  report.say(`\nServe in epoch ${E}, ${ctx.env.send ? 'sending' : 'dry run'}:`);

  // The requests are issued now by the chain's clock, inside both periods.
  const issuedAt = async () => {
    const t = await now(ctx);
    const starts = [(await c.cssvc.getSubscription(ca)).periodStart, (await c.cssvc.getSubscription(wallet)).periodStart];
    return starts.reduce((m, x) => (x > m ? x : m), t);
  };
  const claimed = async (id: string) => (await c.qis.getSellerClaim(id, 0, s.sellerId)).claimed;

  // 1. The first batch: two account requests, up to the period's value before the top-up, and two wallet requests.
  let t = await issuedAt();
  const b1 = await market.batch(
    'serve.batch-1',
    `${plan.caFirst.count + plan.wallet.count} requests: account ${fmt(planValue(plan.caFirst))}, wallet ${fmt(planValue(plan.wallet))} TRAC`,
    r.seller,
    [
      await market.group(r.caSession, ca, s.sellerId, 0n, plan.caFirst.count, plan.caFirst.units, t),
      await market.group(r.walletSession, wallet, s.sellerId, 0n, plan.wallet.count, plan.wallet.units, t),
    ],
    { done: (await claimed(wallet)) > 0n ? 'the seller has claimed on both periods' : undefined },
  );
  const [accepted] = eventsIn(b1.receipt, c.qs, c.qs.getEvent('ReceiptBatchAccepted'));
  if (accepted) {
    report.check(
      'the first batch is accepted for the seller: four requests, signed by the two session keys',
      accepted.seller === s.sellerId && accepted.itemCount === 4n && accepted.value === planValue(plan.caFirst) + planValue(plan.wallet),
      `stake factor ${fmt(accepted.stakeFactor18)}`,
    );
  }

  // 2. The top-up of the account period: accepted, its cost due in E+1, the bucket's funded cap raised.
  const capBefore = await c.qs.fundedCap(ca, 0);
  const dueBefore = (await c.qis.dueIn(E + 1n)).conviction;
  const topUp = await market.topUp('serve.top-up', 'buyer key', r.buyer, ca, a.caTopUp, planDigest(ctx, 'account plan, topped up'), {
    done: (await c.cssvc.getSubscription(ca)).value >= a.caValue + a.caTopUp ? 'the period holds the topped-up value' : undefined,
  });
  if (ctx.env.send) {
    s.costs.topUp = (await c.cssvc.getSubscription(ca)).cost - s.costs.ca;
    file.save();
  }
  const [toppedUp] = eventsIn(topUp.receipt, c.ss, c.ss.getEvent('PeriodToppedUp'));
  if (toppedUp) {
    report.check(
      `the top-up is accepted at ${fmt(toppedUp.cost)} TRAC, due in epoch ${E + 1n}`,
      toppedUp.cost === costOf(a.caTopUp, a.discountBps) && (await c.qis.dueIn(E + 1n)).conviction - dueBefore === toppedUp.cost,
    );
    const capAfter = await c.qs.fundedCap(ca, 0);
    report.check(`the account bucket's funded cap rises from ${fmt(capBefore)} to ${fmt(capAfter)} TRAC`, capAfter === ((a.caValue + a.caTopUp) * (10_000n - a.discountBps)) / 10_000n);
  }

  // 3. The second batch: one more account request, above the cap before the top-up.
  t = await issuedAt();
  const caTotal = planValue(plan.caFirst) + planValue(plan.caAfterTopUp);
  const b2 = await market.batch(
    'serve.batch-2',
    `${plan.caAfterTopUp.count} request: account ${fmt(planValue(plan.caAfterTopUp))} TRAC`,
    r.seller,
    [await market.group(r.caSession, ca, s.sellerId, BigInt(plan.caFirst.count), plan.caAfterTopUp.count, plan.caAfterTopUp.units, t)],
    { done: (await claimed(ca)) >= caTotal ? 'the seller has claimed the request after the top-up' : undefined },
  );
  if (b2.receipt || b2.skipped) {
    const [caClaimed, walletClaimed] = [await c.qis.bucketClaimed(ca, 0), await c.qis.bucketClaimed(wallet, 0)];
    report.check(
      `the seller's claims: ${fmt(caClaimed)} TRAC on the account bucket, within its cap of ${fmt(await c.qs.fundedCap(ca, 0))}, and ${fmt(walletClaimed)} on the wallet bucket`,
      caClaimed === caTotal && walletClaimed === planValue(plan.wallet),
    );
  }

  // FORK-ONLY, with FORK_PROOFS=1: the seller proves in E after the stake, so the position holds score in E.
  if (ctx.env.send && !(s.fork?.proofs ?? []).includes(E.toString())) await standInProof(ctx, 'after the stake, so the position holds score in E');

  // 4. The edge.
  report.say('\n  The edge: revoke, assign the same key again, and a top-up of the old period is refused:');
  const edgeCap = costOf(a.edgeValue, a.discountBps) + costOf(a.caTopUp, a.discountBps);
  const account = { id: accountId, expiresAt };
  const edgePeriod = subscriptionIdOf(r.edgeBuyer.address, E);
  const edge0 = await c.cssvc.getAssignment(accountId, r.edgeBuyer.address);
  await market.assign('serve.edge-assign', `owner: assign the edge buyer key ${r.edgeBuyer.address}`, r.owner, account, r.edgeBuyer, edgeCap, {
    done: edge0.assignedAt !== 0n ? 'assigned' : undefined,
  });
  await market.fundFromConviction('serve.edge-fund', 'edge buyer key', r.edgeBuyer, accountId, E, r.edgeSession.address, a.edgeValue, planDigest(ctx, 'edge plan'), {
    needs: ['serve.edge-assign'],
    done: (await c.cssvc.subscriptionExists(edgePeriod)) ? `period ${edgePeriod} exists` : undefined,
  });
  if (ctx.env.send && (await c.cssvc.subscriptionExists(edgePeriod))) {
    // The edge period's record names the assignment it was funded under.
    const sub = await c.cssvc.getSubscription(edgePeriod);
    s.periods.edge = edgePeriod;
    s.costs.edge = sub.cost;
    s.edgeNonce = sub.assignmentNonce;
    file.save();
  }
  const edge1 = await c.cssvc.getAssignment(accountId, r.edgeBuyer.address);
  const replaced = s.edgeNonce !== undefined && edge1.nonce !== s.edgeNonce;
  const revoked = await market.revoke('serve.edge-revoke', r.owner, accountId, r.edgeBuyer.address, 'the edge buyer key', {
    needs: ['serve.edge-fund'],
    done: edge1.revokedAt !== 0n || replaced ? 'revoked' : undefined,
  });
  const ssAddr = await c.ss.getAddress();
  const topUpEdge = market.topUpData(edgePeriod, a.caTopUp, planDigest(ctx, 'edge plan, topped up'));
  if (revoked.receipt) {
    const why = await ctx.tx.refusal(r.edgeBuyer.address, ssAddr, topUpEdge);
    report.check('while the edge key stands revoked, a top-up of its period is refused (AssignmentRevoked)', why.startsWith('AssignmentRevoked'), why);
  }
  const edge2 = await c.cssvc.getAssignment(accountId, r.edgeBuyer.address);
  const again = await market.assign('serve.edge-reassign', 'owner: assign the same edge buyer key again', r.owner, account, r.edgeBuyer, edgeCap, {
    needs: ['serve.edge-revoke'],
    done: s.edgeNonce !== undefined && edge2.revokedAt === 0n && edge2.nonce > s.edgeNonce ? `assigned again at nonce ${edge2.nonce}` : undefined,
  });
  if ((again.receipt || again.skipped) && s.edgeNonce !== undefined) {
    const why = await ctx.tx.refusal(r.edgeBuyer.address, ssAddr, topUpEdge);
    report.set('edgeRefusal', why);
    report.check(
      'after the revocation and a new assignment of the same key, a top-up of the old period is refused with AssignmentExpired',
      why === `AssignmentExpired(${accountId}, ${r.edgeBuyer.address})`,
      why,
    );
    const live = await c.cssvc.getAssignment(accountId, r.edgeBuyer.address);
    const oldEnd = await c.cssvc.assignmentEnd(accountId, r.edgeBuyer.address, s.edgeNonce);
    report.check(
      'the old period keeps the assignment it was funded under, ended at the revocation, and the new assignment is live',
      oldEnd > 0n && oldEnd <= (await now(ctx)) && live.revokedAt === 0n && live.nonce > s.edgeNonce,
      `old assignment ended ${iso(oldEnd)}, new nonce ${live.nonce}`,
    );
    const buyer = await c.cssvc.getAssignment(accountId, r.buyer.address);
    const buyerEnd = await c.cssvc.assignmentEnd(accountId, r.buyer.address, buyerNonce);
    report.check('the main buyer key\'s assignment is untouched: live, ending at the account\'s expiry', buyer.revokedAt === 0n && buyerEnd === expiresAt, `ends ${iso(buyerEnd)}`);
  }

  if (ctx.env.send) {
    const due = await c.qis.dueIn(E + 1n);
    const ours = { wallet: a.walletValue, conviction: sum([s.costs.ca, s.costs.topUp ?? 0n, s.costs.edge ?? 0n]) };
    report.check(
      `epoch ${E + 1n} has our money due: ${fmt(ours.wallet)} TRAC of wallet value and ${fmt(ours.conviction)} TRAC of account cost`,
      due.wallet >= ours.wallet && due.conviction >= ours.conviction,
      `due ${fmt(due.wallet)} wallet, ${fmt(due.conviction)} account${due.wallet === ours.wallet && due.conviction === ours.conviction ? ': ours alone' : ''}`,
    );
    const missing = serveMissing(s);
    if (missing.length) report.check('the state holds what serve records', false, `no ${missing.join(', ')}`);
    complete(ctx);
    report.say(
      `\nNext: PHASE=finalize SEND=1 in epoch ${E + 1n}, after the batch deadline ${iso(await c.qs.batchDeadline(ca))} and before ${iso(await epochStart(ctx, E + 2n))}.`,
    );
  }
}
