// PHASE serve, still in E, once the seller has proved in E: the session keys sign
// five requests, the seller submits them in two receipt batches, each counted as it
// lands, and the Conviction Account subscription is topped up between them, which is what
// lets the second batch land. The edge, on a subscription of its own buyer, so the
// main flow's grant stays as it is: fund, revoke, add the same buyer again,
// and a top-up of the old subscription is refused with GrantExpired.

import { costOf, subscriptionIdOf } from '../../../test/helpers/conviction-service';

import { eventsIn } from '../contracts';
import { capturedFactorHolds, expectedStakeFactor, groupFault } from '../reads';
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
  const { ca, wallet } = s.subscriptions;
  const current = await c.chronos.getCurrentEpoch();
  if (current !== E) throw new Error(`serve runs in epoch ${E}, the epoch of the subscriptions, and a batch lands only there; it is ${current}: start a new run`);
  await fundOnFork(ctx, 0n);
  const plan = requestPlan(a);
  const end = await epochStart(ctx, E + 1n);

  // A batch needs the seller's node score in E. A real node proves through E; on the fork, with FORK_PROOFS=1, a stand-in does.
  if ((await c.rss.getNodeEpochScore(E, s.sellerId)) === 0n) await standInProof(ctx, 'the seller\'s first in E, which a batch needs, and after the stake, so the position holds score in E');
  const nodeScore = await c.rss.getNodeEpochScore(E, s.sellerId);
  if (nodeScore === 0n) {
    report.wait(`on the seller's proof: node ${s.sellerId} has no node score in epoch ${E} yet, so a batch would revert NoNodeScore. Run PHASE=serve again after the node's next proof, before ${iso(end)}, when the subscriptions end.`);
    return;
  }
  report.check(`the seller has a node score in epoch ${E}, the current one, which a batch needs`, true, `node ${s.sellerId}, score ${nodeScore}`);
  report.say(`\nServe in epoch ${E}, ${ctx.env.send ? 'sending' : 'dry run'}:`);

  // The requests are issued now by the chain's clock, inside both subscriptions.
  const issuedAt = async () => {
    const t = await now(ctx);
    const starts = [(await c.sss.getSubscription(ca)).startsAt, (await c.sss.getSubscription(wallet)).startsAt];
    return starts.reduce((m, x) => (x > m ? x : m), t);
  };
  /** Whether the seller has spent `nonce` of the subscription: its receipt landed. */
  const landed = async (id: string, nonce: bigint) => ((await c.qis.nonceWord(id, s.sellerId, nonce >> 8n)) >> (nonce & 0xffn)) % 2n === 1n;

  /** A batch against the factor its node's stake gave before it was sent, so a wrong factor can't vouch for the scores built on it. */
  const checkFactor = (which: string, captured: bigint, expected: bigint | undefined) =>
    report.check(
      `the ${which} batch captured the stake factor its node's stake gives, worked out before it was sent`,
      expected !== undefined && capturedFactorHolds(captured, expected),
      `captured ${captured}, expected ${expected}`,
    );

  // 1. The first batch: two account requests, up to the subscription's value before the top-up, and two wallet requests.
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
    { stakeFactor18: await expectedStakeFactor(c, s.sellerId), done: (await landed(wallet, 0n)) ? 'the seller has landed on both subscriptions' : undefined },
  );
  const [accepted] = eventsIn(b1.receipt, c.qs, c.qs.getEvent('ReceiptBatchAccepted'));
  if (shownBy(report, b1, accepted, 'the first batch\'s ReceiptBatchAccepted event')) {
    report.check(
      'the first batch counts in whole for the seller as it lands: four requests, signed by the two session keys',
      accepted.seller === s.sellerId && accepted.itemCount === 4n && accepted.value === firstTotal && accepted.counted === firstTotal,
      `${fmt(accepted.counted)} of ${fmt(accepted.value)} TRAC, stake factor ${fmt(accepted.stakeFactor18)}`,
    );
    checkFactor('first', accepted.stakeFactor18, b1.stakeFactor18);
  }

  // 2. The next batch, with what is left of the account budget too little for it, is refused and spends nothing; the top-up lifts it.
  const afterTopUpValue = planValue(plan.caAfterTopUp);
  t = await issuedAt();
  const secondGroups = [await market.group(r.caSession, ca, s.sellerId, BigInt(plan.caFirst.count), plan.caAfterTopUp.count, plan.caAfterTopUp.units, t)];
  if (b1.receipt && (await c.qs.budgetLeft(ca, 0)) < afterTopUpValue) {
    const why = await ctx.tx.refusal(r.sellerAddr, await c.qs.getAddress(), market.batchData(secondGroups));
    report.check('with the account budget too low for it, the next batch is refused until the top-up', why === groupFault(0, 'BelowMinCounted'), why);
  }
  const topUp = await market.topUp('serve.top-up', 'buyer', r.buyer, ca, a.caTopUp, planDigest(ctx, 'account plan, topped up'), {
    done: (await c.sss.getSubscription(ca)).value >= a.caValue + a.caTopUp ? 'the subscription holds the topped-up value' : undefined,
  });
  if (ctx.env.send) {
    s.costs.topUp = (await c.sss.getSubscription(ca)).cost - s.costs.ca;
    file.save();
  }
  const [toppedUp] = eventsIn(topUp.receipt, c.ss, c.ss.getEvent('SubscriptionToppedUp'));
  if (shownBy(report, topUp, toppedUp, 'the top-up\'s SubscriptionToppedUp event')) {
    // No event says what a transaction adds to an epoch's money, and others fund subscriptions too: the money holds it at least.
    const booked = (await c.qis.fundingIn(E)).account;
    report.check(
      `the top-up is accepted at ${fmt(toppedUp.cost)} TRAC, booked in epoch ${E}`,
      toppedUp.cost === costOf(a.caTopUp, a.discountBps) && booked >= s.costs.ca + toppedUp.cost,
      `booked ${fmt(booked)} TRAC`,
    );
    const value = (await c.sss.getBudget(ca, 0)).value;
    report.check(`the account budget's value rises to ${fmt(value)} TRAC`, value === a.caValue + a.caTopUp);
  }

  // 3. The second batch: one more account request, above what the budget held before the top-up.
  const caTotal = planValue(plan.caFirst) + afterTopUpValue;
  const b2 = await market.batch(
    'serve.batch-2',
    `${plan.caAfterTopUp.count} request: account ${fmt(afterTopUpValue)} TRAC`,
    r.seller,
    secondGroups,
    {
      needs: ['serve.top-up'],
      stakeFactor18: await expectedStakeFactor(c, s.sellerId),
      done: (await landed(ca, BigInt(plan.caFirst.count))) ? 'the seller has landed the request after the top-up' : undefined,
    },
  );
  const [acceptedSecond] = eventsIn(b2.receipt, c.qs, c.qs.getEvent('ReceiptBatchAccepted'));
  if (shownBy(report, b2, acceptedSecond, 'the second batch\'s ReceiptBatchAccepted event')) checkFactor('second', acceptedSecond.stakeFactor18, b2.stakeFactor18);
  if (b2.receipt || b2.skipped) {
    const [caFilled, walletFilled] = [await c.qis.budgetUsed(ca, 0), await c.qis.budgetUsed(wallet, 0)];
    report.check(
      `the seller's batches fill ${fmt(caFilled)} TRAC of the account budget, which has ${fmt(await c.qs.budgetLeft(ca, 0))} left, and ${fmt(walletFilled)} of the wallet budget`,
      caFilled === caTotal && walletFilled === planValue(plan.wallet),
    );
  }

  // FORK-ONLY, with FORK_PROOFS=1: the seller proves in E after the stake, so the position holds score in E.
  if (!(s.fork?.proofs ?? []).includes(E.toString())) await standInProof(ctx, 'after the stake, so the position holds score in E');

  // 4. The edge.
  report.say('\n  The edge: revoke, add the same buyer again, and a top-up of the old subscription is refused:');
  const edgeCap = costOf(a.edgeValue, a.discountBps) + costOf(a.caTopUp, a.discountBps);
  const account = { id: accountId, expiresAt };
  const edgeSubscription = subscriptionIdOf(r.edgeBuyer.address, E);
  const edge0 = await c.sss.getGrant(accountId, r.edgeBuyer.address);
  await market.addBuyer('serve.edge-add-buyer', `owner: add the edge buyer ${r.edgeBuyer.address}`, r.owner, account, r.edgeBuyer, edgeCap, {
    done: edge0.grantedAt !== 0n ? 'added' : undefined,
  });
  await market.fundFromAccount('serve.edge-fund', 'edge buyer', r.edgeBuyer, accountId, E, r.edgeSession.address, a.edgeValue, planDigest(ctx, 'edge plan'), {
    needs: ['serve.edge-add-buyer'],
    done: (await c.sss.subscriptionExists(edgeSubscription)) ? `subscription ${edgeSubscription} exists` : undefined,
  });
  if (ctx.env.send && (await c.sss.subscriptionExists(edgeSubscription))) {
    // The edge subscription's record names the grant it was funded under.
    const sub = await c.sss.getSubscription(edgeSubscription);
    s.subscriptions.edge = edgeSubscription;
    s.costs.edge = sub.cost;
    s.edgeNonce = sub.grantNonce;
    file.save();
  }
  const edge1 = await c.sss.getGrant(accountId, r.edgeBuyer.address);
  const replaced = s.edgeNonce !== undefined && edge1.nonce !== s.edgeNonce;
  const revoked = await market.removeBuyer('serve.edge-revoke', r.owner, accountId, r.edgeBuyer.address, 'the edge buyer', {
    needs: ['serve.edge-fund'],
    done: edge1.revokedAt !== 0n || replaced ? 'revoked' : undefined,
  });
  const ssAddr = await c.ss.getAddress();
  const topUpEdge = market.topUpData(edgeSubscription, a.caTopUp, planDigest(ctx, 'edge plan, topped up'));
  const edge2 = await c.sss.getGrant(accountId, r.edgeBuyer.address);
  // Resumed once the buyer is added again, the moment this check is about has passed.
  if (revoked.receipt && edge2.revokedAt !== 0n) {
    const why = await ctx.tx.refusal(r.edgeBuyer.address, ssAddr, topUpEdge);
    report.check('while the edge key stands revoked, a top-up of its subscription is refused (GrantRevoked)', why.startsWith('GrantRevoked'), why);
  }
  const again = await market.addBuyer('serve.edge-add-again', 'owner: add the same edge buyer again', r.owner, account, r.edgeBuyer, edgeCap, {
    needs: ['serve.edge-revoke'],
    done: s.edgeNonce !== undefined && edge2.revokedAt === 0n && edge2.nonce > s.edgeNonce ? `added again at nonce ${edge2.nonce}` : undefined,
  });
  if ((again.receipt || again.skipped) && s.edgeNonce !== undefined) {
    const why = await ctx.tx.refusal(r.edgeBuyer.address, ssAddr, topUpEdge);
    report.set('edgeRefusal', why);
    report.check(
      'after the revocation and a new grant to the same buyer, a top-up of the old subscription is refused with GrantExpired',
      why === `GrantExpired(${accountId}, ${r.edgeBuyer.address})`,
      why,
    );
    const live = await c.sss.getGrant(accountId, r.edgeBuyer.address);
    const oldEnd = await c.sss.grantEnd(accountId, r.edgeBuyer.address, s.edgeNonce);
    report.check(
      'the old subscription keeps the grant it was funded under, ended at the revocation, and the new grant is live',
      oldEnd > 0n && oldEnd <= (await now(ctx)) && live.revokedAt === 0n && live.nonce > s.edgeNonce,
      `old grant ended ${iso(oldEnd)}, new nonce ${live.nonce}`,
    );
    const buyer = await c.sss.getGrant(accountId, r.buyer.address);
    const buyerEnd = await c.sss.grantEnd(accountId, r.buyer.address, buyerNonce);
    report.check('the main buyer\'s grant is untouched: live, ending at the account\'s expiry', buyer.revokedAt === 0n && buyerEnd === expiresAt, `ends ${iso(buyerEnd)}`);
  }

  if (ctx.env.send) {
    const booked = await c.qis.fundingIn(E);
    const ours = { wallet: a.walletValue, account: sum([s.costs.ca, s.costs.topUp ?? 0n, s.costs.edge ?? 0n]) };
    report.check(
      `epoch ${E} has our money booked: ${fmt(ours.wallet)} TRAC of wallet value and ${fmt(ours.account)} TRAC of account cost`,
      booked.wallet >= ours.wallet && booked.account >= ours.account,
      `booked ${fmt(booked.wallet)} wallet, ${fmt(booked.account)} account${booked.wallet === ours.wallet && booked.account === ours.account ? ': ours alone' : ''}`,
    );
    const missing = serveMissing(s);
    if (missing.length) report.check('the state holds what serve records', false, `no ${missing.join(', ')}`);
    complete(ctx);
    report.say(`\nNext: PHASE=claim SEND=1 from ${iso(end)}, once epoch ${E} has ended, with nothing run first.`);
  }
}
