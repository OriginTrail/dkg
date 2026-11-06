// PHASE setup, in epoch E: a small position on the seller's node; a new
// Conviction Account under PublishingConviction 10.2.0, opted in, the buyer
// key added; a Conviction Account subscription and a wallet-paid subscription of E, each
// booked in E.

import { costOf, subscriptionIdOf } from '../../../test/helpers/conviction-service';

import { eventsIn } from '../contracts';
import { FORK_ETH } from '../fork';
import { fmt, iso } from '../report';
import { MIN_EPOCH_LEFT, needsOf, plannedAmounts } from './config';
import { PoolCtx, bindState, complete, doneEarlier, epochStart, now, opensAt, planDigest, walletSubscriptionClash } from './context';
import { checkBalances, checkDeployment, maxFeePerGas, progressOf, verifySeller } from './check';
import { need } from './roles';
import { Amounts, SmokeState, setupMissing } from './state';
import { shownBy, tracMoved } from './tx';

/** FORK-ONLY: the owner's ETH and TRAC, and the seller's ETH, from anvil's balance setters, with SEND=1: a dry run changes nothing. */
export async function fundOnFork(ctx: PoolCtx, trac: bigint): Promise<void> {
  if (!ctx.net.local || !ctx.env.send) return;
  const { ownerAddr, sellerAddr } = ctx.roles;
  const provider = ctx.hre.ethers.provider;
  if (ownerAddr && (await provider.getBalance(ownerAddr)) < FORK_ETH / 10n) {
    await ctx.fork.setEth(ownerAddr, FORK_ETH);
    ctx.report.standIn(`the owner's ETH set to ${fmt(FORK_ETH)} with anvil_setBalance`);
  }
  if (ownerAddr && trac > 0n && (await ctx.c.token.balanceOf(ownerAddr)) < trac) {
    await ctx.fork.dealErc20(await ctx.c.token.getAddress(), ownerAddr, trac);
    ctx.report.standIn(`the owner's TRAC set to ${fmt(trac)} with anvil_dealERC20`);
  }
  if (sellerAddr && ctx.roles.sellerImpersonated && (await provider.getBalance(sellerAddr)) < FORK_ETH / 10n) {
    await ctx.fork.setEth(sellerAddr, FORK_ETH);
    ctx.report.standIn(`the seller's ETH set to ${fmt(FORK_ETH)} with anvil_setBalance`);
  }
}

function newState(ctx: PoolCtx, hub: string, settlement: string, sellerId: bigint, a: Amounts, startedAt: bigint): SmokeState {
  const r = need(ctx.roles, ['ownerAddr', 'buyer', 'edgeBuyer', 'caSession', 'walletSession', 'edgeSession', 'sellerAddr']);
  return {
    version: 1,
    run: ctx.env.run,
    network: ctx.net.local ? 'fork' : 'base-sepolia',
    chainId: ctx.net.chainId,
    forkBlock: ctx.net.forkBlock,
    hub,
    settlement,
    startedAt,
    addresses: {
      owner: r.ownerAddr,
      buyer: r.buyer.address,
      edgeBuyer: r.edgeBuyer.address,
      caSession: r.caSession.address,
      walletSession: r.walletSession.address,
      edgeSession: r.edgeSession.address,
      seller: r.sellerAddr,
    },
    sellerId,
    amounts: a,
    subscriptions: {},
    costs: {},
    steps: {},
    phases: {},
  };
}

export async function phaseSetup(ctx: PoolCtx): Promise<void> {
  const { report, c, market, file } = ctx;
  const r = need(ctx.roles, ['owner', 'ownerAddr', 'buyer', 'edgeBuyer', 'caSession', 'walletSession', 'seller']);
  let s = await bindState(ctx);
  if (doneEarlier(ctx, s ? `epoch ${s.E}, account ${s.accountId}, position ${s.tokenId}` : '')) return;

  // Funding opens in the activation epoch; setup and serve both land in E.
  const activation = await c.qis.activationEpoch();
  if (activation === 0n) throw new Error('the activation epoch is unset: the Hub owner sets it after the Hub transaction');
  if ((await c.chronos.getCurrentEpoch()) < activation && !(await opensAt(ctx, (await epochStart(ctx, activation)) + 120n, `funding, from the activation epoch ${activation}`))) return;
  const fundedIn = s?.subscriptions.ca || s?.subscriptions.wallet || s?.steps['setup.fund-account-subscription'] || s?.steps['setup.fund-wallet-subscription'] ? s?.E : undefined;
  const end = await epochStart(ctx, (await c.chronos.getCurrentEpoch()) + 1n);
  if (fundedIn === undefined && end - (await now(ctx)) < MIN_EPOCH_LEFT && !(await opensAt(ctx, end + 120n, 'setup, with a whole epoch for setup and serve'))) return;
  let current = await c.chronos.getCurrentEpoch();
  if (fundedIn !== undefined && current !== fundedIn) throw new Error(`the subscriptions of this run were funded in epoch ${fundedIn}, and it is ${current} now: start a new run`);
  const a = await plannedAmounts(c, s, await maxFeePerGas(ctx));

  // Before anything is spent: the owner has one wallet subscription an epoch, and it must be this run's.
  const clash = await walletSubscriptionClash(ctx, r, a.walletValue, fundedIn ?? current);
  if (clash) {
    if (fundedIn !== undefined) throw new Error(`${clash}, and this run funded its account subscription in that epoch: start a new run`);
    if (!(await opensAt(ctx, (await epochStart(ctx, current + 1n)) + 120n, `setup, with a wallet subscription of its own in the next epoch, as ${clash}`))) return;
    current = await c.chronos.getCurrentEpoch();
  }

  const d = await checkDeployment(ctx, current);
  if (!d.live) throw new Error('funding is not live: see the checks above');
  report.say('\nSeller:');
  const seller = await verifySeller(ctx, a);
  if (!seller.ok) throw new Error('the seller does not qualify: see the checks above');
  if (!s && ctx.env.send) {
    file.state = newState(ctx, await ctx.stack.hub.getAddress(), await c.qs.getAddress(), seller.id, a, await now(ctx));
    file.save();
    s = file.state;
  }
  await fundOnFork(ctx, needsOf(a, 0n, await progressOf(ctx)).ownerTrac);
  await checkBalances(ctx, a);
  if (report.failed) throw new Error('a check failed: see above');

  const E = fundedIn ?? current;
  if (s) {
    s.E = E;
    file.save();
  }
  const vault = await c.css.getAddress();
  report.say(`\nSetup in epoch ${E} (ends ${iso(await epochStart(ctx, E + 1n))}), ${ctx.env.send ? 'sending' : 'dry run'}:`);

  // 1. The position on the seller's node, at tier 0.
  const staked = await market.stake('setup', r.owner, seller.id, a.stake, { done: s?.tokenId !== undefined ? `position ${s.tokenId}` : undefined });
  const [stakedEv] = eventsIn(staked.receipt, c.sv10, c.sv10.getEvent('Staked'));
  if (shownBy(report, staked, stakedEv, 'the stake\'s Staked event') && s && staked.receipt) {
    const block = await ctx.hre.ethers.provider.getBlock(staked.receipt.blockNumber);
    s.tokenId = stakedEv.tokenId;
    s.stakeRaw = stakedEv.amount;
    s.stakeEpoch = await c.chronos.epochAtTimestamp(BigInt(block?.timestamp ?? 0));
    file.save();
    const pos = await c.css.getPosition(stakedEv.tokenId);
    // Resumed in a later epoch, another caller may have claimed since: only the claim's own effects differ then.
    const claimedThrough = staked.replayed ? pos.lastClaimedEpoch >= s.stakeEpoch - 1n : pos.lastClaimedEpoch === s.stakeEpoch - 1n;
    report.check(
      `position ${s.tokenId}: ${fmt(a.stake)} TRAC on node ${seller.id} at tier 0, with no lock, claimed through epoch ${s.stakeEpoch - 1n}`,
      pos.raw === a.stake + pos.cumulativeRewardsClaimed && pos.identityId === seller.id && pos.lockTier === 0n && pos.expiryTimestamp === 0n && claimedThrough,
    );
    const moved = tracMoved(staked.receipt, c.token, vault);
    report.check('the stake moved into the vault', moved === a.stake, `${fmt(moved)} TRAC, by its own Transfer logs`);
  }

  // 2. The Conviction Account, opted in.
  const created = await market.createAccount('setup', r.owner, a.committed, { done: s?.accountId !== undefined ? `account ${s.accountId}` : undefined });
  const [createdEv] = eventsIn(created.receipt, c.pc, c.pc.getEvent('AccountCreated'));
  if (shownBy(report, created, createdEv, 'the account\'s AccountCreated event') && s) {
    s.accountId = createdEv.accountId;
    s.accountExpiresAt = (await c.pcs.getAccount(createdEv.accountId)).expiresAtTimestamp;
    file.save();
    const acct = await c.pcs.getAccount(createdEv.accountId);
    report.check(
      `account ${s.accountId}: ${fmt(a.committed)} TRAC over ${a.lock} windows at ${a.discountBps} bps, owned by the owner`,
      acct.committedTRAC === a.committed && acct.lockDurationEpochs === a.lock && acct.discountBps === a.discountBps && (await c.nft.ownerOf(createdEv.accountId)) === r.ownerAddr,
    );
    const credits = eventsIn(created.receipt, c.es, c.es.getEvent('TokensAddedToEpochRange')).filter((ev) => ev.shardId === 1n);
    const moved = created.receipt ? tracMoved(created.receipt, c.token, vault) : 0n;
    report.check('createAccount books nothing to the staker pool (10.2.0), and the commitment moved into the vault', credits.length === 0 && moved === a.committed, `${fmt(moved)} TRAC, by its own Transfer logs`);
  }
  const accountId = s?.accountId;
  const spending = accountId === undefined ? undefined : await c.sss.getServiceSpending(accountId);
  await market.optIn('setup.opt-in', r.owner, accountId, { needs: ['setup.create-account'], done: spending && spending.enabledAt !== 0n ? 'service spending is on' : undefined });

  // 3. The buyer, added with its consent by EIP-712 signature, at most the subscription's cost and its top-up.
  const cap = costOf(a.caValue, a.discountBps) + costOf(a.caTopUp, a.discountBps);
  const account = accountId !== undefined && s?.accountExpiresAt !== undefined ? { id: accountId, expiresAt: s.accountExpiresAt } : undefined;
  const held = accountId === undefined ? undefined : await c.sss.getGrant(accountId, r.buyer.address);
  const added = await market.addBuyer('setup.add-buyer', `owner: add the buyer ${r.buyer.address}, at most ${fmt(cap)} TRAC a subscription`, r.owner, account, r.buyer, cap, {
    needs: ['setup.opt-in'],
    done: held && held.grantedAt !== 0n && held.revokedAt === 0n ? `added at nonce ${held.nonce}` : undefined,
  });
  const [addedEv] = eventsIn(added.receipt, c.ss, c.ss.getEvent('BuyerAdded'));
  if (shownBy(report, added, addedEv, 'the grant\'s BuyerAdded event') && account) {
    report.check(
      'the buyer is added, with its limit and the account\'s expiry as signed',
      addedEv.buyer === r.buyer.address && addedEv.maxCostPerEpoch === cap && addedEv.expiresAt === account.expiresAt,
    );
  }
  if (s && accountId !== undefined) {
    const now_ = await c.sss.getGrant(accountId, r.buyer.address);
    if (now_.grantedAt !== 0n) s.buyerNonce = now_.nonce;
    file.save();
  }

  // 4. Gas for the derived buyers.
  for (const [k, w] of [['buyer', r.buyer], ['edge-buyer', r.edgeBuyer]] as const) {
    const bal = await ctx.hre.ethers.provider.getBalance(w.address);
    await ctx.tx.step({
      key: `setup.eth-${k}`,
      label: `owner: send ${fmt(a.keyEth)} ETH to the ${k} key ${w.address}`,
      role: 'owner',
      signer: r.owner,
      to: w.address,
      data: '0x',
      value: a.keyEth,
      done: bal >= a.keyEth / 2n ? `it holds ${fmt(bal)} ETH` : undefined,
    });
  }

  // 5. The Conviction Account subscription of E: no TRAC moves, and its cost is booked in E.
  const caSubscription = subscriptionIdOf(r.buyer.address, E);
  const funded = await market.fundFromAccount('setup.fund-account-subscription', 'buyer', r.buyer, accountId, E, r.caSession.address, a.caValue, planDigest(ctx, 'account plan'), {
    needs: ['setup.add-buyer', 'setup.eth-buyer'],
    done: (await c.sss.subscriptionExists(caSubscription)) ? `subscription ${caSubscription} exists` : undefined,
  });
  if (s && (await c.sss.subscriptionExists(caSubscription))) {
    s.subscriptions.ca = caSubscription;
    s.costs.ca = (await c.sss.getSubscription(caSubscription)).cost;
    file.save();
  }
  const [fundedEv] = eventsIn(funded.receipt, c.ss, c.ss.getEvent('SubscriptionFunded'));
  if (shownBy(report, funded, fundedEv, 'the account subscription\'s SubscriptionFunded event')) {
    report.check(`the account subscription's cost is its value at the account's discount: ${fmt(fundedEv.cost)} TRAC`, fundedEv.cost === costOf(a.caValue, a.discountBps) && fundedEv.subscriptionId === caSubscription);
    const moved = eventsIn(funded.receipt, c.token, c.token.getEvent('Transfer')).length;
    const credits = eventsIn(funded.receipt, c.es, c.es.getEvent('TokensAddedToEpochRange')).length;
    report.check('the account subscription moves no TRAC and books nothing to the staker pool', moved === 0 && credits === 0);
    // No event says what a transaction adds to an epoch's money, and others fund subscriptions too: the money holds it at least.
    const booked = (await c.qis.fundingIn(E)).account;
    report.check(`its cost is booked in epoch ${E}`, booked >= fundedEv.cost, `booked ${fmt(booked)} TRAC`);
  }

  // 6. The wallet-paid subscription of E, paid by the owner into the vault.
  const walletSubscription = subscriptionIdOf(r.ownerAddr, E);
  const walletFunded = await market.fundFromWallet(
    'setup',
    'owner',
    r.owner,
    E,
    r.walletSession.address,
    a.walletValue,
    planDigest(ctx, 'wallet plan'),
    { done: (await c.sss.subscriptionExists(walletSubscription)) ? `subscription ${walletSubscription} exists` : undefined },
  );
  if (s && (await c.sss.subscriptionExists(walletSubscription))) {
    s.subscriptions.wallet = walletSubscription;
    file.save();
  }
  const [walletEv] = eventsIn(walletFunded.receipt, c.ssw, c.ssw.getEvent('SubscriptionFunded'));
  if (shownBy(report, walletFunded, walletEv, 'the wallet subscription\'s SubscriptionFunded event') && walletFunded.receipt) {
    const moved = tracMoved(walletFunded.receipt, c.token, vault);
    const booked = (await c.qis.fundingIn(E)).wallet;
    report.check(
      `the wallet subscription's ${fmt(a.walletValue)} TRAC moved into the vault and is booked in epoch ${E}`,
      moved === a.walletValue && booked >= a.walletValue,
      `${fmt(moved)} TRAC by its own Transfer logs; booked ${fmt(booked)} TRAC`,
    );
  }

  const missing = s ? setupMissing(s) : [];
  if (ctx.env.send && missing.length) report.check('the state holds what setup records', false, `no ${missing.join(', ')}`);
  complete(ctx);
  if (ctx.env.send) report.say(`\nNext: PHASE=serve SEND=1, still in epoch ${E}, before ${iso(await epochStart(ctx, E + 1n))}.`);
}
