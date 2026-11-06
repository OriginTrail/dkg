// PHASE check, read-only, and the checks setup repeats: the deployment
// (versions, wiring through the Hub, activation, pause, parameters), the
// seller's identity, the balances the run needs, and the plan.

import { ethers } from 'ethers';

import { EXPECTED_VERSIONS, NEW_CONTRACTS } from '../contracts';
import { requireParameter } from '../parameters';
import { fmt, iso, span } from '../report';
import { MIN_EPOCH_LEFT, NOTHING_YET, Progress, needsOf, plannedAmounts, requestPlan, planValue } from './config';
import { Ctx, PoolCtx, epochStart, now, walletSubscriptionClash, withPool } from './context';
import { Roles } from './roles';
import { Amounts, PHASES } from './state';

/** Whether the Hub holds the OT-RFC-27 stack; reports "not deployed yet" when it does not. */
export async function deployed(ctx: Ctx): Promise<boolean> {
  const missing = await ctx.stack.missing();
  if (missing.length === 0) return true;
  const v: Record<string, string> = {};
  for (const n of ['PublishingConviction', 'StakingV10', 'StakingKPI']) v[n] = await ctx.stack.versionAt(await ctx.stack.addr(n));
  ctx.report.set('deployed', false);
  ctx.report.set('missing', missing);
  const what = missing.length === NEW_CONTRACTS.length ? 'none of the new OT-RFC-27 contracts' : `not yet ${missing.join(', ')}`;
  ctx.report.say(
    `\n  NOT DEPLOYED YET  the Hub holds ${what}; PublishingConviction is ${v.PublishingConviction}, StakingV10 ${v.StakingV10}, ` +
      `StakingKPI ${v.StakingKPI}. Run the check again after the deploy and the Hub owner's two transactions.`,
  );
  return false;
}

/** Versions, wiring, activation, pause and parameters; whether funding is live. */
export async function checkDeployment(ctx: PoolCtx, current: bigint): Promise<{ live: boolean }> {
  const { report, c, stack } = ctx;
  report.set('deployed', true);
  report.say('\nVersions:');
  const versions: Record<string, string> = {};
  for (const [n, want] of Object.entries(EXPECTED_VERSIONS)) {
    versions[n] = await stack.versionAt(await stack.addr(n));
    report.check(`${n} is ${want}`, versions[n] === want, versions[n]);
  }
  report.set('versions', versions);

  report.say('\nWiring through the Hub:');
  const [qs, qis, sss, vault, sv10] = await Promise.all([c.qs.getAddress(), c.qis.getAddress(), c.sss.getAddress(), c.css.getAddress(), c.sv10.getAddress()]);
  report.check('StakingV10 10.1.0 reads the Hub\'s settlement and its storage', (await c.sv10.queryInferenceSettlement()) === qs && (await c.sv10.queryInferenceStorage()) === qis);
  report.check('StakingKPI 10.1.0 reads the Hub\'s settlement', (await c.kpi.queryInferenceSettlement()) === qs);
  report.check(
    'QueryInferenceSettlement reads the Hub\'s QueryInferenceStorage, ServiceSubscriptionsStorage and vault',
    (await c.qs.queryInferenceStorage()) === qis && (await c.qs.serviceSubscriptionsStorage()) === sss && (await c.qs.convictionStakingStorage()) === vault,
  );
  report.check(
    'ServiceSubscriptions reads the Hub\'s storages',
    (await c.ss.queryInferenceStorage()) === qis && (await c.ss.serviceSubscriptionsStorage()) === sss && (await c.ss.publishingConvictionStorage()) === (await c.pcs.getAddress()),
  );
  report.check(
    'ServiceSubscriptionsWallet pays into the vault StakingV10 pays from, and reads the Hub\'s storages',
    (await c.ssw.stakingStorageAddress()) === vault &&
      (await c.sv10.convictionStorage()) === vault &&
      (await c.ssw.tokenContract()) === (await c.token.getAddress()) &&
      (await c.ssw.queryInferenceStorage()) === qis &&
      (await c.ssw.serviceSubscriptionsStorage()) === sss,
  );
  report.check('DKGStakingConvictionNFT calls the Hub\'s StakingV10', (await c.snft.stakingV10()) === sv10);
  report.check('StakingV10Ledger wired the Hub\'s ConvictionWithdrawalStorage', (await c.ledger.withdrawalStorage()) === (await c.cws.getAddress()));

  report.say('\nActivation, pause and parameters:');
  const activation = await c.qis.activationEpoch();
  const paused = await c.qis.paused();
  const treasury = await c.params.protocolTreasury();
  report.check(
    `the activation epoch is set and reached: ${activation === 0n ? 'unset' : `epoch ${activation}`}, current ${current}`,
    activation !== 0n && activation <= current,
    activation > current ? `funding opens at ${iso(await epochStart(ctx, activation))}` : undefined,
  );
  report.check('QueryInferenceStorage is not paused', !paused);
  report.check('no protocol treasury is wired, so Conviction Account funding is open', treasury === ethers.ZeroAddress, treasury);
  const lambda = requireParameter('QueryInferenceStorage', ['lambdaBps']);
  const lambdaNow = await c.qis.lambdaBps();
  report.check(`λ is parameters.json "testnet"'s ${lambda.value} bps`, lambdaNow === lambda.value, `lambdaBps ${lambdaNow}`);
  const bounds = {
    maxItemsPerBatch: [await c.qis.maxItemsPerBatch(), requireParameter('QueryInferenceStorage', ['maxItemsPerBatch']).value],
    maxGroupsPerBatch: [await c.qis.maxGroupsPerBatch(), requireParameter('QueryInferenceStorage', ['maxGroupsPerBatch']).value],
    maxBudgetsPerSubscription: [await c.sss.maxBudgetsPerSubscription(), requireParameter('ServiceSubscriptionsStorage', ['maxBudgetsPerSubscription']).value],
  };
  report.check(
    'the batch and budget bounds are parameters.json "testnet"\'s',
    Object.values(bounds).every(([onChain, want]) => onChain === want),
    Object.entries(bounds).map(([k, [onChain]]) => `${k} ${onChain}`).join(', '),
  );
  report.set('parameters', { activation, paused, treasury, lambdaNow, bounds });
  return { live: activation !== 0n && activation <= current && !paused && treasury === ethers.ZeroAddress };
}

export type Seller = { id: bigint; ok: boolean };

/** The seller's operational key resolves to an identity with a profile that is in the sharding table. */
export async function verifySeller(ctx: Ctx, a: Amounts): Promise<Seller> {
  const { report, base: c, roles: r } = ctx;
  if (!r.sellerAddr) {
    report.check('the seller key is set', false, ctx.net.local ? 'set RFC27_SMOKE_SELLER_KEY, RFC27_SMOKE_SELLER_ADDRESS or RFC27_SMOKE_SELLER_ID' : 'set RFC27_SMOKE_SELLER_KEY');
    return { id: 0n, ok: false };
  }
  const id = await c.ids.getIdentityId(r.sellerAddr);
  const keyHash = ethers.keccak256(ethers.solidityPacked(['address'], [r.sellerAddr]));
  const operational = id !== 0n && (await c.ids.keyHasPurpose(id, keyHash, 2));
  const profile = id !== 0n && (await c.ps.profileExists(id));
  const inTable = id !== 0n && (await c.sts.nodeExists(id));
  const name = profile ? await c.ps.getName(id) : '';
  let ok = report.check(
    `the seller key ${r.sellerAddr}${r.sellerImpersonated ? ' (fork-only: impersonated)' : ''} is an operational key of node ${id}, which has a profile and is in the sharding table`,
    id !== 0n && operational && profile && inTable,
    `identity ${id}, operational ${operational}, profile ${profile}${name ? ` "${name}"` : ''}, sharding table ${inTable}`,
  );
  if (ok) {
    const [stake, max] = [await c.css.getNodeStakeV10(id), await c.params.maximumStake()];
    // A stake already made is in the node's stake, whether or not the run got to record its position.
    const adding = (await progressOf(ctx)).staked ? 0n : a.stake;
    ok = report.check(`node ${id} takes the ${fmt(a.stake)} TRAC stake under the maximum stake`, stake + adding <= max, `node stake ${fmt(stake)} of ${fmt(max)} TRAC`);
  }
  return { id, ok };
}

export async function maxFeePerGas(ctx: Ctx): Promise<bigint> {
  const fee = await ctx.hre.ethers.provider.getFeeData();
  return fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
}

/** How far the run has got: a spend counts once its receipt confirms it, or the state holds what it made. */
export async function progressOf(ctx: Ctx): Promise<Progress> {
  const s = ctx.file.state;
  if (!s) return NOTHING_YET;
  // Read, not waited for: a transaction not mined yet has spent nothing so far, and the phase waits for it itself.
  const confirmed = async (key: string): Promise<boolean> => {
    const record = s.steps[key];
    return !!record && (await ctx.hre.ethers.provider.getTransactionReceipt(record.hash))?.status === 1;
  };
  const sentBy = (role: string): bigint => BigInt(Object.values(s.steps).filter((x) => x.role === role).length);
  return {
    staked: s.tokenId !== undefined || (await confirmed('setup.stake')),
    accountCreated: s.accountId !== undefined || (await confirmed('setup.create-account')),
    walletFunded: s.subscriptions.wallet !== undefined || (await confirmed('setup.fund-wallet-subscription')),
    buyerFunded: await confirmed('setup.eth-buyer'),
    edgeBuyerFunded: await confirmed('setup.eth-edge-buyer'),
    sent: { owner: sentBy('owner'), buyer: sentBy('buyer'), edgeBuyer: sentBy('edge buyer'), seller: sentBy('seller') },
  };
}

/** The ETH and TRAC the run still spends, against what each role holds. */
export async function checkBalances(ctx: Ctx, a: Amounts): Promise<void> {
  const { report, roles: r, base: c } = ctx;
  report.say('\nBalances:');
  const maxFee = await maxFeePerGas(ctx);
  const progress = await progressOf(ctx);
  const needs = needsOf(a, maxFee, progress);
  report.set('needs', { ...needs, maxFeePerGas: maxFee });
  report.note(`at a max fee of ${ethers.formatUnits(maxFee, 'gwei')} gwei: twice the planned gas of what is left to send, and ${fmt(10n ** 13n)} ETH a transaction for the L1 data fee`);
  const byFork = ctx.net.local ? ' (fork-only: setup sets it with anvil\'s balance setters)' : '';
  if (r.ownerAddr) {
    const [eth, trac] = [await ctx.hre.ethers.provider.getBalance(r.ownerAddr), await c.token.balanceOf(r.ownerAddr)];
    const left = [progress.accountCreated ? '' : 'the commitment', progress.walletFunded ? '' : 'the wallet subscription', progress.staked ? '' : 'the stake'].filter(Boolean).join(', ');
    report.check(
      `the owner ${r.ownerAddr}${r.ownerImpersonated ? ' (fork-only: impersonated)' : ''} holds the TRAC the run still spends: ${left || 'none'}`,
      trac >= needs.ownerTrac || ctx.net.local,
      `${fmt(trac)} of ${fmt(needs.ownerTrac)} TRAC${trac < needs.ownerTrac ? byFork : ''}`,
    );
    report.check('the owner holds the ETH the run still spends: its gas and the buyers\' ETH', eth >= needs.ownerEth || ctx.net.local, `${fmt(eth)} of about ${fmt(needs.ownerEth)} ETH${eth < needs.ownerEth ? byFork : ''}`);
  } else {
    report.check('the owner key is set', false, 'set RFC27_SMOKE_OWNER_KEY');
  }
  if (r.sellerAddr) {
    const eth = await ctx.hre.ethers.provider.getBalance(r.sellerAddr);
    report.check('the seller key holds the ETH of the batches it still sends', eth >= needs.sellerEth || ctx.net.local, `${fmt(eth)} of about ${fmt(needs.sellerEth)} ETH${eth < needs.sellerEth ? byFork : ''}`);
  }
  // A derived key is sent its ETH once: until then it is planned for, and from then on it holds what it holds.
  const keyHas = (funded: boolean, key: Roles['buyer']): Promise<bigint> | bigint => (funded && key ? ctx.hre.ethers.provider.getBalance(key.address) : a.keyEth);
  const [buyerHas, edgeBuyerHas] = [await keyHas(progress.buyerFunded, r.buyer), await keyHas(progress.edgeBuyerFunded, r.edgeBuyer)];
  report.check(
    `the ${fmt(a.keyEth)} ETH the owner sends each derived buyer covers the gas it still spends`,
    buyerHas >= needs.buyerEth && edgeBuyerHas >= needs.edgeBuyerEth,
    `buyer ${fmt(buyerHas)} of about ${fmt(needs.buyerEth)}, edge buyer ${fmt(edgeBuyerHas)} of about ${fmt(needs.edgeBuyerEth)} ETH`,
  );
}

export async function printPlan(ctx: Ctx, r: Roles, a: Amounts, current: bigint, activation: bigint): Promise<void> {
  const s = ctx.file.state;
  const E = s?.E ?? (activation > current ? activation : current);
  const ts = (e: bigint) => epochStart(ctx, e);
  const p = requestPlan(a);
  const say = (line: string) => ctx.report.say(line);
  say(`\nPlan of run "${ctx.env.run}"${s ? '' : ' (not started)'}:`);
  say(`  roles     owner ${r.ownerAddr ?? '(no key)'}, buyer ${r.buyer?.address ?? '?'}, edge buyer ${r.edgeBuyer?.address ?? '?'}`);
  say(`            session keys: account ${r.caSession?.address ?? '?'}, wallet ${r.walletSession?.address ?? '?'}, edge ${r.edgeSession?.address ?? '?'}; seller ${r.sellerAddr ?? '?'}`);
  const when = s?.E !== undefined ? ` = ${E}` : E > current ? ` = ${E}, the activation epoch, from ${iso(await ts(E))}` : ` (now ${current}, ends ${iso(await ts(current + 1n))})`;
  say(
    `  setup     epoch E${when}: stake ${fmt(a.stake)} TRAC on the seller's node at tier 0; account of ${fmt(a.committed)} TRAC ` +
      `(floor ${fmt(a.committedFloor)}: ${a.lock} windows × ${fmt(a.caValue + a.caTopUp + a.edgeValue)} spent in the first; discount ${a.discountBps} bps); ` +
      `opt-in; buyer added; account subscription ${fmt(a.caValue)} TRAC; wallet subscription ${fmt(a.walletValue)} TRAC; ${fmt(a.keyEth)} ETH to each buyer`,
  );
  say(
    `  serve     epoch E, once the seller has proved in it, and before E ends: ${p.caFirst.count + p.caAfterTopUp.count + p.wallet.count} requests in two batches (account ${fmt(planValue(p.caFirst))} + ` +
      `${fmt(planValue(p.caAfterTopUp))} after its top-up of ${fmt(a.caTopUp)}, wallet ${fmt(planValue(p.wallet))} TRAC); ` +
      `edge: a ${fmt(a.edgeValue)} TRAC subscription of the edge buyer, revoked, added again, its top-up refused GrantExpired`,
  );
  say(`  claim     from the start of E+1, ${iso(await ts(E + 1n))}: E's numbers against the chain's events, then claimFor against the epochs' nets`);
  say(`  withdraw  optional: in the middle of an epoch after claim; claimWithdrawnEpoch once that epoch has ended (from ${iso(await ts(E + 2n))})`);
  if (s) {
    const done = PHASES.filter((p) => ctx.file.done(p)).join(', ') || 'nothing yet';
    say(`  progress  done: ${done}${s.withdrawal ? `; withdrawn in epoch ${s.withdrawal.epoch}${ctx.file.done('withdraw') ? ', its epoch claimed' : ''}` : ''}`);
  }
}

export async function phaseCheck(ctx: Ctx): Promise<void> {
  const current = await ctx.base.chronos.getCurrentEpoch();
  const s = ctx.file.load();
  const isDeployed = await deployed(ctx);
  let activation = 0n;
  const pctx = isDeployed ? await withPool(ctx) : undefined;
  if (pctx) {
    await checkDeployment(pctx, current);
    activation = await pctx.c.qis.activationEpoch();
  } else {
    ctx.report.say('  The seller, the balances and the plan do not need the deploy:');
  }
  ctx.report.say('\nSeller:');
  const a = await plannedAmounts(ctx.base, s, await maxFeePerGas(ctx));
  ctx.report.set('seller', await verifySeller(ctx, a));
  await checkBalances(ctx, a);
  const { ownerAddr, walletSession } = ctx.roles;
  if (pctx && ownerAddr && walletSession) {
    const E = s?.E ?? (activation > current ? activation : current);
    const clash = await walletSubscriptionClash(pctx, { ownerAddr, walletSession }, a.walletValue, E);
    ctx.report.check(`the owner's wallet subscription of epoch ${E}, if it has one, is this run's`, !clash, clash);
  }
  if (!s && isDeployed) {
    const left = (await epochStart(ctx, current + 1n)) - (await now(ctx));
    ctx.report.check(`epoch ${current} has at least ${span(MIN_EPOCH_LEFT)} left for setup and serve`, left >= MIN_EPOCH_LEFT || activation > current, `${span(left)} left`);
  }
  for (const p of PHASES) {
    const failed = ctx.file.failedChecks(p);
    if (failed) ctx.report.check(`PHASE=${p} of this run has no failed check`, false, `${failed} failed when it last ran: run it again`);
  }
  ctx.report.set('amounts', a);
  await printPlan(ctx, ctx.roles, a, current, activation);
}
