// PHASE setup, in epoch E: a small position on the seller's node; a new
// Conviction Account under PublishingConviction 10.2.0, opted in, the buyer
// key assigned; a Conviction Account period and a wallet-paid period of E.

import { ethers } from 'ethers';

import { costOf, subscriptionIdOf } from '../../../test/helpers/conviction-service';

import { eventsIn } from '../contracts';
import { FORK_ETH } from '../fork';
import { fmt, iso } from '../report';
import { MIN_EPOCH_LEFT, plannedAmounts } from './config';
import { HUB, PoolCtx, bindState, complete, doneEarlier, epochStart, now, opensAt } from './context';
import { checkBalances, checkDeployment, maxFeePerGas, verifySeller } from './check';
import { need } from './roles';
import { Amounts, SmokeState } from './state';

/** A plan's commitment, opaque to the contracts: the run's label and the plan's name. */
export const planDigest = (ctx: PoolCtx, what: string): string => ethers.id(`rfc27-smoke/${ctx.env.run}/${what}`);

/** FORK-ONLY: the owner's ETH and TRAC, and the seller's ETH, from anvil's balance setters. */
export async function fundOnFork(ctx: PoolCtx, trac: bigint): Promise<void> {
  if (!ctx.net.local) return;
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

function newState(ctx: PoolCtx, settlement: string, sellerId: bigint, a: Amounts, startedAt: bigint): SmokeState {
  const r = need(ctx.roles, ['ownerAddr', 'buyer', 'edgeBuyer', 'caSession', 'walletSession', 'edgeSession', 'sellerAddr']);
  return {
    version: 1,
    run: ctx.env.run,
    network: ctx.net.local ? 'fork' : 'base-sepolia',
    chainId: ctx.net.chainId,
    forkBlock: ctx.net.forkBlock,
    hub: HUB,
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
    periods: {},
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
  const fundedIn = s?.periods.ca || s?.periods.wallet ? s?.E : undefined;
  const end = await epochStart(ctx, (await c.chronos.getCurrentEpoch()) + 1n);
  if (fundedIn === undefined && end - (await now(ctx)) < MIN_EPOCH_LEFT && !(await opensAt(ctx, end + 120n, 'setup, with a whole epoch for setup and serve'))) return;
  const current = await c.chronos.getCurrentEpoch();
  if (fundedIn !== undefined && current !== fundedIn) throw new Error(`the periods of this run were funded in epoch ${fundedIn}, and it is ${current} now: start a new run`);

  const d = await checkDeployment(ctx, current);
  if (!d.live) throw new Error('funding is not live: see the checks above');
  report.say('\nSeller:');
  const a = await plannedAmounts(c, s, await maxFeePerGas(ctx));
  const seller = await verifySeller(ctx, a);
  if (!seller.ok) throw new Error('the seller does not qualify: see the checks above');
  if (!s && ctx.env.send) {
    file.state = newState(ctx, await c.qs.getAddress(), seller.id, a, await now(ctx));
    file.save();
    s = file.state;
  }
  await fundOnFork(ctx, a.committed + a.walletValue + a.stake);
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
  const vault0 = await c.token.balanceOf(vault);
  const staked = await market.stake('setup', r.owner, seller.id, a.stake, s?.tokenId !== undefined ? `position ${s.tokenId}` : undefined);
  const [stakedEv] = eventsIn(staked.receipt, c.sv10, c.sv10.getEvent('Staked'));
  if (s && stakedEv && staked.receipt) {
    const block = await ctx.hre.ethers.provider.getBlock(staked.receipt.blockNumber);
    s.tokenId = stakedEv.tokenId;
    s.stakeRaw = stakedEv.amount;
    s.stakeEpoch = await c.chronos.epochAtTimestamp(BigInt(block?.timestamp ?? 0));
    file.save();
    const pos = await c.css.getPosition(stakedEv.tokenId);
    report.check(
      `position ${s.tokenId}: ${fmt(a.stake)} TRAC on node ${seller.id} at tier 0, with no lock, claimed through epoch ${s.stakeEpoch - 1n}`,
      pos.raw === a.stake && pos.identityId === seller.id && pos.lockTier === 0n && pos.expiryTimestamp === 0n && pos.lastClaimedEpoch === s.stakeEpoch - 1n,
    );
    report.check('the stake moved into the vault', (await c.token.balanceOf(vault)) - vault0 === a.stake);
  }

  // 2. The Conviction Account, opted in.
  const vault1 = await c.token.balanceOf(vault);
  const created = await market.createAccount('setup', r.owner, a.committed, s?.accountId !== undefined ? `account ${s.accountId}` : undefined);
  const [createdEv] = eventsIn(created.receipt, c.pc, c.pc.getEvent('AccountCreated'));
  if (s && createdEv) {
    s.accountId = createdEv.accountId;
    s.accountExpiresAt = (await c.pcs.getAccount(createdEv.accountId)).expiresAtTimestamp;
    file.save();
    const acct = await c.pcs.getAccount(createdEv.accountId);
    report.check(
      `account ${s.accountId}: ${fmt(a.committed)} TRAC over ${a.lock} windows at ${a.discountBps} bps, owned by the owner`,
      acct.committedTRAC === a.committed && acct.lockDurationEpochs === a.lock && acct.discountBps === a.discountBps && (await c.nft.ownerOf(createdEv.accountId)) === r.ownerAddr,
    );
    const credits = eventsIn(created.receipt, c.es, c.es.getEvent('TokensAddedToEpochRange')).filter((ev) => ev.shardId === 1n);
    report.check('createAccount books nothing to the staker pool (10.2.0), and the commitment moved into the vault', credits.length === 0 && (await c.token.balanceOf(vault)) - vault1 === a.committed);
  }
  const accountId = s?.accountId;
  const spending = accountId === undefined ? undefined : await c.cssvc.getServiceSpending(accountId);
  await market.optIn('setup.opt-in', r.owner, accountId, { needs: ['setup.create-account'], done: spending && spending.enabledAt !== 0n ? 'service spending is on' : undefined });

  // 3. The buyer key, assigned with its consent by EIP-712 signature, at most the period's cost and its top-up.
  const cap = costOf(a.caValue, a.discountBps) + costOf(a.caTopUp, a.discountBps);
  const account = accountId !== undefined && s?.accountExpiresAt !== undefined ? { id: accountId, expiresAt: s.accountExpiresAt } : undefined;
  const held = accountId === undefined ? undefined : await c.cssvc.getAssignment(accountId, r.buyer.address);
  const assigned = await market.assign('setup.assign-buyer', `owner: assign the buyer key ${r.buyer.address}, at most ${fmt(cap)} TRAC a period`, r.owner, account, r.buyer, cap, {
    needs: ['setup.opt-in'],
    done: held && held.assignedAt !== 0n && held.revokedAt === 0n ? `assigned at nonce ${held.nonce}` : undefined,
  });
  const [assignedEv] = eventsIn(assigned.receipt, c.ss, c.ss.getEvent('ServiceAssigned'));
  if (assignedEv && account) {
    report.check(
      'the buyer key is assigned, with its limit and the account\'s expiry as signed',
      assignedEv.assignee === r.buyer.address && assignedEv.maxCostPerPeriod === cap && assignedEv.expiresAt === account.expiresAt,
    );
  }
  if (s && accountId !== undefined) {
    const now_ = await c.cssvc.getAssignment(accountId, r.buyer.address);
    if (now_.assignedAt !== 0n) s.buyerNonce = now_.nonce;
    file.save();
  }

  // 4. Gas for the derived buyer keys.
  for (const [k, w] of [['buyer', r.buyer], ['edge-buyer', r.edgeBuyer]] as const) {
    const bal = await ctx.hre.ethers.provider.getBalance(w.address);
    await ctx.tx.run({
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

  // 5. The Conviction Account period of E: no TRAC moves, and its cost is due in E+1.
  const caPeriod = subscriptionIdOf(r.buyer.address, E);
  const due0 = await c.qis.dueIn(E + 1n);
  const funded = await market.fundFromConviction('setup.fund-account-period', 'buyer key', r.buyer, accountId, E, r.caSession.address, a.caValue, planDigest(ctx, 'account plan'), {
    needs: ['setup.assign-buyer', 'setup.eth-buyer'],
    done: (await c.cssvc.subscriptionExists(caPeriod)) ? `period ${caPeriod} exists` : undefined,
  });
  if (s && (await c.cssvc.subscriptionExists(caPeriod))) {
    s.periods.ca = caPeriod;
    s.costs.ca = (await c.cssvc.getSubscription(caPeriod)).cost;
    file.save();
  }
  const [fundedEv] = eventsIn(funded.receipt, c.ss, c.ss.getEvent('PeriodFunded'));
  if (fundedEv) {
    report.check(`the account period's cost is its value at the account's discount: ${fmt(fundedEv.cost)} TRAC`, fundedEv.cost === costOf(a.caValue, a.discountBps) && fundedEv.subscriptionId === caPeriod);
    const moved = eventsIn(funded.receipt, c.token, c.token.getEvent('Transfer')).length;
    const credits = eventsIn(funded.receipt, c.es, c.es.getEvent('TokensAddedToEpochRange')).length;
    report.check('the account period moves no TRAC and books nothing to the staker pool', moved === 0 && credits === 0);
    report.check(`its cost is due in epoch ${E + 1n}`, (await c.qis.dueIn(E + 1n)).conviction - due0.conviction === fundedEv.cost);
  }

  // 6. The wallet-paid period of E, paid by the owner into the vault.
  const walletPeriod = subscriptionIdOf(r.ownerAddr, E);
  const vault2 = await c.token.balanceOf(vault);
  const due1 = await c.qis.dueIn(E + 1n);
  const walletFunded = await market.fundFromWallet(
    'setup',
    'owner',
    r.owner,
    E,
    r.walletSession.address,
    a.walletValue,
    planDigest(ctx, 'wallet plan'),
    (await c.cssvc.subscriptionExists(walletPeriod)) ? `period ${walletPeriod} exists` : undefined,
  );
  if (s && (await c.cssvc.subscriptionExists(walletPeriod))) {
    s.periods.wallet = walletPeriod;
    file.save();
  }
  if (walletFunded.receipt) {
    report.check(
      `the wallet period's ${fmt(a.walletValue)} TRAC moved into the vault and is due in epoch ${E + 1n}`,
      (await c.token.balanceOf(vault)) - vault2 === a.walletValue && (await c.qis.dueIn(E + 1n)).wallet - due1.wallet === a.walletValue,
    );
  }

  complete(ctx);
  if (ctx.env.send) report.say(`\nNext: PHASE=serve SEND=1, still in epoch ${E}, before ${iso(await epochStart(ctx, E + 1n))}.`);
}
