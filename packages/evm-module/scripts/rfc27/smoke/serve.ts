// PHASE serve, still in E, once the seller has proved in E: the session keys sign
// five requests, the seller submits them in two receipt batches, each counted as it
// lands, and the Conviction Account period is topped up between them, which is what
// lets the second batch land. The edge, on a period of its own buyer key, so the
// main flow's assignment stays as it is: fund, revoke, assign the same key again,
// and a top-up of the old period is refused with AssignmentExpired.

import { costOf, subscriptionIdOf } from '../../../test/helpers/conviction-service';

import { eventsIn } from '../contracts';
import { groupFault } from '../reads';
import { fmt, iso, sum } from '../report';
import { planValue, requestPlan } from './config';
import { PoolCtx, complete, doneEarlier, epochStart, now, planDigest, runState, standInProof } from './context';
import { need } from './roles';
import { fundOnFork } from './setup';
import { serveMissing } from './state';
import { shownBy } from './tx';

export async function phaseServe(ctx: PoolCtx): Promise<void> {
  const { report, c, market, file } = ctx;
  const r = need(ctx.roles, ['owner', 'buyer', 'edgeBuyer', 'caSession', 'walletSession', 'edgeSession', 'seller', 'sellerAddr']);
  const s = await runState(ctx, 'setup');
  if (doneEarlier(ctx, '')) return;
  const { amounts: a, E, accountId, accountExpiresAt: expiresAt, buyerNonce } = s;
  const { ca, wallet } = s.periods;
  const current = await c.chronos.getCurrentEpoch();
  if (current !== E) throw new Error(`serve runs in epoch ${E}, the epoch of the periods, and a batch lands only there; it is ${current}: start a new run`);
  await fundOnFork(ctx, 0n);
  const plan = requestPlan(a);
  const end = await epochStart(ctx, E + 1n);

  // A batch needs the seller's node score in E. A real node proves through E; on the fork, with FORK_PROOFS=1, a stand-in does.
  if ((await c.rss.getNodeEpochScore(E, s.sellerId)) === 0n) await standInProof(ctx, 'the seller\'s first in E, which a batch needs, and after the stake, so the position holds score in E');
  const nodeScore = await c.rss.getNodeEpochScore(E, s.sellerId);
  if (nodeScore === 0n) {
    report.wait(`on the seller's proof: node ${s.sellerId} has no node score in epoch ${E} yet, so a batch would revert NoNodeScore. Run PHASE=serve again after the node's next proof, before ${iso(end)}, when the periods end.`);
    return;
  }
  report.check(`the seller has a node score in epoch ${E}, the current one, which a batch needs`, true, `node ${s.sellerId}, score ${nodeScore}`);
  report.say(`\nServe in epoch ${E}, ${ctx.env.send ? 'sending' : 'dry run'}:`);

  // The requests are issued now by the chain's clock, inside both periods.
  const issuedAt = async () => {
    const t = await now(ctx);
    const starts = [(await c.cssvc.getSubscription(ca)).periodStart, (await c.cssvc.getSubscription(wallet)).periodStart];
    return starts.reduce((m, x) => (x > m ? x : m), t);
  };
  /** Whether the seller has spent `nonce` of the period: its receipt landed. */
  const landed = async (id: string, nonce: bigint) => ((await c.qis.nonceWord(id, s.sellerId, nonce >> 8n)) >> (nonce & 0xffn)) % 2n === 1n;

  // 1. The first batch: two account requests, up to the period's value before the top-up, and two wallet requests.
  let t = await issuedAt();
  const firstTotal = planValue(plan.caFirst) + planValue(plan.wallet);
  const b1 = await market.batch(
    'serve.batch-1',
    `${plan.caFirst.count + plan.wallet.count} requests: account ${fmt(planValue(plan.caFirst))}, wallet ${fmt(planValue(plan.wallet))} TRAC`,
    r.seller,
    [
      await market.group(r.caSession, ca, s.sellerId, 0n, plan.caFirst.count, plan.caFirst.units, t),
      await market.group(r.walletSession, wallet, s.sellerId, 0n, plan.wallet.count, plan.wallet.units, t),
    ],
    { done: (await landed(wallet, 0n)) ? 'the seller has landed on both periods' : undefined },
  );
  const [accepted] = eventsIn(b1.receipt, c.qs, c.qs.getEvent('ReceiptBatchAccepted'));
  if (shownBy(report, b1, accepted, 'the first batch\'s ReceiptBatchAccepted event')) {
    report.check(
      'the first batch counts in whole for the seller as it lands: four requests, signed by the two session keys',
      accepted.seller === s.sellerId && accepted.itemCount === 4n && accepted.claimed === firstTotal && accepted.counted === firstTotal,
      `${fmt(accepted.counted)} of ${fmt(accepted.claimed)} TRAC, stake factor ${fmt(accepted.stakeFactor18)}`,
    );
  }

  // 2. The next batch, with what is left of the account bucket too little for it, is refused and spends nothing; the top-up lifts it.
  const afterTopUpValue = planValue(plan.caAfterTopUp);
  t = await issuedAt();
  const secondGroups = [await market.group(r.caSession, ca, s.sellerId, BigInt(plan.caFirst.count), plan.caAfterTopUp.count, plan.caAfterTopUp.units, t)];
  if (b1.receipt && (await c.qs.bucketLeft(ca, 0)) < afterTopUpValue) {
    const why = await ctx.tx.refusal(r.sellerAddr, await c.qs.getAddress(), market.batchData(secondGroups));
    report.check('with the account bucket too low for it, the next batch is refused until the top-up', why === groupFault(0, 'BelowMinCounted'), why);
  }
  const topUp = await market.topUp('serve.top-up', 'buyer key', r.buyer, ca, a.caTopUp, planDigest(ctx, 'account plan, topped up'), {
    done: (await c.cssvc.getSubscription(ca)).value >= a.caValue + a.caTopUp ? 'the period holds the topped-up value' : undefined,
  });
  if (ctx.env.send) {
    s.costs.topUp = (await c.cssvc.getSubscription(ca)).cost - s.costs.ca;
    file.save();
  }
  const [toppedUp] = eventsIn(topUp.receipt, c.ss, c.ss.getEvent('PeriodToppedUp'));
  if (shownBy(report, topUp, toppedUp, 'the top-up\'s PeriodToppedUp event')) {
    // No event says what a transaction adds to an epoch's money, and others fund periods too: the money holds it at least.
    const booked = (await c.qis.fundingIn(E)).conviction;
    report.check(
      `the top-up is accepted at ${fmt(toppedUp.cost)} TRAC, booked in epoch ${E}`,
      toppedUp.cost === costOf(a.caTopUp, a.discountBps) && booked >= s.costs.ca + toppedUp.cost,
      `booked ${fmt(booked)} TRAC`,
    );
    const value = (await c.cssvc.getBucket(ca, 0)).value;
    report.check(`the account bucket's value rises to ${fmt(value)} TRAC`, value === a.caValue + a.caTopUp);
  }

  // 3. The second batch: one more account request, above what the bucket held before the top-up.
  const caTotal = planValue(plan.caFirst) + afterTopUpValue;
  const b2 = await market.batch(
    'serve.batch-2',
    `${plan.caAfterTopUp.count} request: account ${fmt(afterTopUpValue)} TRAC`,
    r.seller,
    secondGroups,
    { needs: ['serve.top-up'], done: (await landed(ca, BigInt(plan.caFirst.count))) ? 'the seller has landed the request after the top-up' : undefined },
  );
  if (b2.receipt || b2.skipped) {
    const [caFilled, walletFilled] = [await c.qis.bucketFilled(ca, 0), await c.qis.bucketFilled(wallet, 0)];
    report.check(
      `the seller's batches fill ${fmt(caFilled)} TRAC of the account bucket, which has ${fmt(await c.qs.bucketLeft(ca, 0))} left, and ${fmt(walletFilled)} of the wallet bucket`,
      caFilled === caTotal && walletFilled === planValue(plan.wallet),
    );
  }

  // FORK-ONLY, with FORK_PROOFS=1: the seller proves in E after the stake, so the position holds score in E.
  if (!(s.fork?.proofs ?? []).includes(E.toString())) await standInProof(ctx, 'after the stake, so the position holds score in E');

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
  const edge2 = await c.cssvc.getAssignment(accountId, r.edgeBuyer.address);
  // Resumed once the key is assigned again, the moment this check is about has passed.
  if (revoked.receipt && edge2.revokedAt !== 0n) {
    const why = await ctx.tx.refusal(r.edgeBuyer.address, ssAddr, topUpEdge);
    report.check('while the edge key stands revoked, a top-up of its period is refused (AssignmentRevoked)', why.startsWith('AssignmentRevoked'), why);
  }
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
    const booked = await c.qis.fundingIn(E);
    const ours = { wallet: a.walletValue, conviction: sum([s.costs.ca, s.costs.topUp ?? 0n, s.costs.edge ?? 0n]) };
    report.check(
      `epoch ${E} has our money booked: ${fmt(ours.wallet)} TRAC of wallet value and ${fmt(ours.conviction)} TRAC of account cost`,
      booked.wallet >= ours.wallet && booked.conviction >= ours.conviction,
      `booked ${fmt(booked.wallet)} wallet, ${fmt(booked.conviction)} account${booked.wallet === ours.wallet && booked.conviction === ours.conviction ? ': ours alone' : ''}`,
    );
    const missing = serveMissing(s);
    if (missing.length) report.check('the state holds what serve records', false, `no ${missing.join(', ')}`);
    complete(ctx);
    report.say(`\nNext: PHASE=claim SEND=1 from ${iso(end)}, once epoch ${E} has ended, with nothing run first.`);
  }
}
