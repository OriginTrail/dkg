// PHASE switch: the emergency switch, off and on again, inside a snapshot that
// is reverted.
//
// The switch the Hub owner pulls if the query/inference pool misbehaves and a
// fixed settlement cannot replace it at once: QueryInferenceSettlement removed
// from the Hub by name, so StakingV10 and StakingKPI read no pool, and
// QueryInferenceStorage paused, so no subscription is funded meanwhile. Then on
// again: a fresh deployment of the settlement, registered and initialized by
// one Hub transaction, as 998 registers contracts, which also unpauses. Last,
// what a removal by address does instead once the settlement is the Hub's last
// entry, as every registration leaves it, and why a removal by name of the
// last entry leaves its address unusable, so that switching on takes a fresh
// deployment.
//
// The pool needs value to show anything, so the phase first runs two epochs
// of it, from the activation epoch S: a wallet subscription of S that both sellers
// serve, so S has a pool, and a wallet subscription of S + 1 that no one serves, so its
// money rolls forward. The switch goes off in S + 2, with a batch for that epoch
// in hand, and on again in S + 3, once that batch has missed its epoch. It runs
// right after the hub phase, before S ends, and everything is reverted at the end,
// so the later phases find the chain as the hub phase left it.

import { ethers } from 'ethers';

import { subscriptionIdOf } from '../../../test/helpers/conviction-service';
import { Contracts } from '../contracts';
import { chainNow } from '../network';
import { groupFault, poolShareOf } from '../reads';
import { fmt } from '../report';
import { Ctx, HUB, expectRevert, saveResults, send, succeeds, withPool } from './context';
import { accountRequest, approve, claimAll, fundTrac, openServiceAccount, requestDomain, signedGroup, submitBatch, walletRequest } from './operations';
import { impersonate, operationalKeys } from './plumbing';
import { expectedReward, positions, smallestOn } from './reads';
import type { TxEntry } from './results';
import { CA_SUBSCRIPTION_VALUE, COMMITTED, MAX_COST_PER_EPOCH, SELLERS, TRAC } from './scenario';

/** A placeholder entry for the Hub's contract set: an address with no code and no key. */
const PLACEHOLDER_NAME = 'HubSetPlaceholder';
const PLACEHOLDER = '0x000000000000000000000000000000000000dEaD';
const SWITCH_SERVED_VALUE = 5n * TRAC; // a wallet subscription both sellers serve
const SWITCH_UNSERVED_VALUE = 2n * TRAC; // a wallet subscription no one serves, so its money rolls forward
const SWITCH_STRANDED_VALUE = 1n * TRAC; // a wallet subscription whose batch the outage stops
const SWITCH_AFTER_VALUE = 1n * TRAC; // a wallet subscription served once the switch is on again

export async function phaseSwitch(ctx: Ctx): Promise<void> {
  const { report, stack } = ctx;
  const c = await withPool(ctx);
  const h = stack.hub;
  const qsDeployedAddr = await c.qs.getAddress();
  const S = await c.qis.activationEpoch();
  const C = await c.chronos.getCurrentEpoch();
  if (S === 0n || C > S) throw new Error(`run PHASE=switch right after PHASE=hub: activation ${S}, current epoch ${C}`);
  const startBlock = await ctx.hre.ethers.provider.getBlockNumber();
  report.say(`\nin a snapshot from epoch ${C}, block ${startBlock}: the switch, then revert`);
  const out = await ctx.fork.inSnapshot(() => offAndOn(ctx, c, S, C));
  const moneyLeft = await c.qis.fundingIn(S);
  report.check(
    'the snapshot is reverted: the block, the epoch, the deployed settlement and the money are as the hub phase left them',
    (await ctx.hre.ethers.provider.getBlockNumber()) === startBlock &&
      (await c.chronos.getCurrentEpoch()) === C &&
      (await h.getContractAddress('QueryInferenceSettlement')) === qsDeployedAddr &&
      !(await c.qis.paused()) &&
      moneyLeft.wallet === 0n &&
      moneyLeft.account === 0n,
  );
  saveResults(ctx, 'switch', out);
}

/** Everything the phase reverts: the pool's first epochs from activation epoch S, the switch off, on again, and the removals. */
async function offAndOn(ctx: Ctx, c: Contracts, S: bigint, C: bigint): Promise<{ [key: string]: unknown }> {
  const { report, stack } = ctx;
  const check = report.check.bind(report);
  const h = stack.hub;
  const qisAddr = await c.qis.getAddress();
  const qsDeployed = c.qs;
  const qsDeployedAddr = await qsDeployed.getAddress();
  const ssAddr = await c.ss.getAddress();
  const sswAddr = await c.ssw.getAddress();
  const snftAddr = await c.snft.getAddress();
  const ownerAddr = await h.owner();
  const owner = await impersonate(ctx, ownerAddr);
  const [deployer, walletBuyer, caOwner, buyer, caSession, , , walletSession] = await ctx.hre.ethers.getSigners();

  const [nOn, nOff] = SELLERS; // nOff is claimed while the switch is off, nOn once it is on again
  const ops = await operationalKeys(ctx);
  const mirror: Record<string, bigint> = {};
  for (const n of SELLERS) {
    if (!ops[String(n)]) throw new Error(`no operational key seen for node ${n}`);
    mirror[String(n)] = await c.rss.getNodeEpochScore(C - 1n, n);
    if (mirror[String(n)] === 0n) throw new Error(`node ${n} scored nothing in epoch ${C - 1n}`);
  }
  const out: { [key: string]: unknown } = { activation: S, sellers: SELLERS, epochLength: await c.chronos.epochLength() };

  // ---- epoch S: a wallet subscription both sellers serve; a Conviction Account to fund from later ----
  await ctx.fork.warpTo((await c.chronos.timestampForEpoch(S)) + 120n);
  report.say(`\nEpoch ${await c.chronos.getCurrentEpoch()}: funding and serving`);
  await fundTrac(ctx, owner, walletBuyer.address, 100n * TRAC, 'fork-only: Hub owner sends TRAC to the wallet buyer');
  await fundTrac(ctx, owner, caOwner.address, COMMITTED, 'fork-only: Hub owner sends TRAC to the account owner');
  await approve(ctx, 'wallet buyer: approve ServiceSubscriptionsWallet', walletBuyer, sswAddr, 100n * TRAC);
  const fundWallet = (epoch: bigint, value: bigint, plan: string) =>
    c.ssw.interface.encodeFunctionData('fundFromWallet', [walletRequest(epoch, walletSession.address, value, plan)]);
  await send(ctx, `wallet buyer: fundFromWallet(epoch ${S}, ${fmt(SWITCH_SERVED_VALUE)} TRAC)`, walletBuyer, sswAddr, fundWallet(S, SWITCH_SERVED_VALUE, 'switch rehearsal: served'));
  const servedSubscription = subscriptionIdOf(walletBuyer.address, S);

  const { accountId } = await openServiceAccount(ctx, c, {
    owner: caOwner,
    committed: COMMITTED,
    buyer,
    maxCostPerEpoch: MAX_COST_PER_EPOCH,
    addBuyerLabel: 'account owner: add the buyer',
  });
  const fundAccount = (epoch: bigint) =>
    c.ss.interface.encodeFunctionData('fundFromAccount', [accountRequest(accountId, epoch, caSession.address, CA_SUBSCRIPTION_VALUE, 'switch rehearsal: account')]);
  /** Whether each kind of funding would go through for `epoch` now. */
  const fundingOpen = async (epoch: bigint) => ({
    wallet: await succeeds(ctx, walletBuyer.address, sswAddr, fundWallet(epoch, TRAC, 'switch rehearsal: probe')),
    account: await succeeds(ctx, buyer.address, ssAddr, fundAccount(epoch)),
  });

  // FORK-ONLY: both sellers score in S, as each scored in the last full epoch before the fork.
  for (const n of SELLERS) await ctx.fork.proof(c, n, mirror[String(n)], `node ${n} scores in epoch ${S} what it scored in ${C - 1n}`);
  const qiDomain = await requestDomain(c);
  const issuedAt = await chainNow(ctx.hre);
  const servedBy: Record<string, bigint[]> = { [String(nOn)]: [2n * TRAC], [String(nOff)]: [1n * TRAC] };
  for (const seller of SELLERS) {
    const group = await signedGroup({ domain: qiDomain, session: walletSession, subscriptionId: servedSubscription, seller, firstNonce: 0n, values: servedBy[String(seller)], issuedAt });
    const opSigner = await impersonate(ctx, ops[String(seller)]);
    await submitBatch(ctx, qsDeployed, opSigner, `node ${seller} operational key: submitReceiptBatch`, [group]);
  }

  // ---- epoch S + 1: a subscription no one serves ----
  await ctx.fork.warpTo((await c.chronos.timestampForEpoch(S + 1n)) + 120n);
  report.say(`\nEpoch ${await c.chronos.getCurrentEpoch()}: a subscription no one serves`);
  await send(
    ctx,
    `wallet buyer: fundFromWallet(epoch ${S + 1n}, ${fmt(SWITCH_UNSERVED_VALUE)} TRAC), which no one serves`,
    walletBuyer,
    sswAddr,
    fundWallet(S + 1n, SWITCH_UNSERVED_VALUE, 'switch rehearsal: unserved'),
  );

  // ---- epoch S + 2: a batch in hand, then the switch goes off ----
  await ctx.fork.warpTo((await c.chronos.timestampForEpoch(S + 2n)) + 120n);
  report.say(`\nEpoch ${await c.chronos.getCurrentEpoch()}: a subscription funded and served, whose batch has not landed, then the switch goes off`);
  await send(ctx, `wallet buyer: fundFromWallet(epoch ${S + 2n}, ${fmt(SWITCH_STRANDED_VALUE)} TRAC)`, walletBuyer, sswAddr, fundWallet(S + 2n, SWITCH_STRANDED_VALUE, 'switch rehearsal: the batch the outage stops'));
  await ctx.fork.proof(c, nOn, mirror[String(nOn)], `node ${nOn} scores in epoch ${S + 2n} what it scored in ${C - 1n}`);
  const strandedBatch = c.qs.interface.encodeFunctionData('submitReceiptBatch', [
    [
      await signedGroup({
        domain: qiDomain,
        session: walletSession,
        subscriptionId: subscriptionIdOf(walletBuyer.address, S + 2n),
        seller: nOn,
        firstNonce: 0n,
        values: [SWITCH_STRANDED_VALUE],
        issuedAt: await chainNow(ctx.hre),
      }),
    ],
  ]);
  const opOn = ops[String(nOn)];
  const before = {
    pool: await qsDeployed.epochPool(S),
    gross: {} as Record<string, bigint>,
    rolled: (await c.qis.fundingIn(S + 1n)).wallet,
    rolledEpochPool: await qsDeployed.epochPool(S + 1n),
  };
  for (const n of SELLERS) before.gross[String(n)] = await qsDeployed.queryInferenceGross(S, n);
  check(
    `epoch ${S} pools the served ${fmt(SWITCH_SERVED_VALUE)} TRAC; ${S + 1n}, with no value, has no pool, and its ${fmt(SWITCH_UNSERVED_VALUE)} TRAC rolls forward`,
    before.pool === SWITCH_SERVED_VALUE && before.rolledEpochPool === 0n && before.rolled === SWITCH_UNSERVED_VALUE,
    `gross ${SELLERS.map((n) => `node ${n} ${fmt(before.gross[String(n)])}`).join(', ')}`,
  );

  // Each seller's net of S with the pool, as StakingKPI previews it, and
  // without it: the publishing share less the operator fee (the shared pool
  // share of a position, here of none).
  const netWith: Record<string, bigint> = {};
  const netWithout: Record<string, bigint> = {};
  for (const n of SELLERS) {
    netWith[String(n)] = await c.kpi.getNetNodeRewards(n, S);
    netWithout[String(n)] = (await poolShareOf(c, n, S, 0n, netWith[String(n)])).netWithoutPool;
  }
  const pos = await positions(c);
  const pOff = smallestOn(pos, nOff);
  const pOn = smallestOn(pos, nOn);
  if (!pOff || !pOn) throw new Error(`no position on node ${pOff ? nOn : nOff}`);
  const keyOff = `${nOff}:${S}`;
  const shareWith = (await expectedReward(c, pOff, S, S, { [keyOff]: netWith[String(nOff)] })).total;
  const shareWithout = (await expectedReward(c, pOff, S, S, { [keyOff]: netWithout[String(nOff)] })).total;

  // The counterfactual: token pOff's claim with the switch on, reverted at once.
  const [claimOn] = await ctx.fork.inSnapshot(() => claimAll(ctx, [pOff], 'counterfactual, switch on:'));

  // ---- off ----
  const offTxs = ctx.txs.length;
  const removeByName = h.interface.encodeFunctionData('removeContractByName', ['QueryInferenceSettlement']);
  const register = (name: string, addr: string) => h.interface.encodeFunctionData('setContractAddress', [name, addr]);
  const setPaused = (paused: boolean) => h.interface.encodeFunctionData('forwardCall', [qisAddr, c.qis.interface.encodeFunctionData('setPaused', [paused])]);
  await send(ctx, 'Hub owner: Hub.removeContractByName("QueryInferenceSettlement")', owner, HUB, removeByName);
  check(
    'switch off: the Hub holds no QueryInferenceSettlement, and StakingV10 and StakingKPI read none',
    !(await stack.holds('QueryInferenceSettlement')) &&
      (await c.sv10.queryInferenceSettlement()) === ethers.ZeroAddress &&
      (await c.kpi.queryInferenceSettlement()) === ethers.ZeroAddress,
  );
  const openRemoved = await fundingOpen(S + 3n);
  const batchRemoved = await expectRevert(ctx, `switch off: node ${nOn}'s batch, with the settlement removed`, opOn, qsDeployedAddr, strandedBatch);
  check('switch off: a batch reverts, since the storage refuses a contract the Hub no longer holds', batchRemoved.startsWith('UnauthorizedAccess'), batchRemoved);
  check(
    'with the settlement removed, wallet and Conviction Account funding both stay open, so the pause belongs with the removal',
    openRemoved.wallet && openRemoved.account,
  );
  await send(ctx, 'Hub owner: Hub.forwardCall(QueryInferenceStorage, setPaused(true))', owner, HUB, setPaused(true));
  const pausedWallet = await expectRevert(ctx, 'switch off: fundFromWallet', walletBuyer.address, sswAddr, fundWallet(S + 3n, TRAC, 'switch rehearsal: probe'));
  const pausedAccount = await expectRevert(ctx, 'switch off: fundFromAccount', buyer.address, ssAddr, fundAccount(S + 3n));
  const pausedBatch = await expectRevert(ctx, `switch off: node ${nOn}'s batch, with the storage paused too`, opOn, qsDeployedAddr, strandedBatch);
  check(
    'switch off: the pause refuses both kinds of funding',
    pausedWallet.startsWith('QueryInferencePaused') && pausedAccount.startsWith('QueryInferencePaused'),
    `${pausedWallet}, ${pausedAccount}`,
  );
  check('switch off: the pause refuses a batch first', pausedBatch.startsWith('QueryInferencePaused'), pausedBatch);
  check(
    `switch off: a claim reads epoch ${S}, which has ended, without the settlement: nothing else has to run`,
    await succeeds(ctx, pOff.owner, snftAddr, c.snft.interface.encodeFunctionData('claim', [pOff.tokenId])),
  );
  const kpiOff = await c.kpi.getNetNodeRewards(nOff, S);
  check(
    `switch off: StakingKPI's net of node ${nOff} in ${S} is the publishing share alone`,
    kpiOff === netWithout[String(nOff)] && kpiOff < netWith[String(nOff)],
    `${fmt(netWith[String(nOff)])} → ${fmt(kpiOff)} TRAC`,
  );
  const [claimOff] = await claimAll(ctx, [pOff], 'switch off:');
  const lost = claimOn.reward - claimOff.reward;
  check(
    `switch off: token ${pOff.tokenId}'s claim pays the publishing pool alone, ${fmt(lost)} TRAC less than with the switch on: its share of node ${nOff}'s pool gross in ${S}`,
    lost > 0n && lost === shareWith - shareWithout,
    `${fmt(claimOff.reward)} TRAC (switch on: ${fmt(claimOn.reward)})`,
  );
  check(
    `switch off: the claim split node ${nOff}'s ${S} without the pool`,
    (await c.css.isOperatorFeeClaimedForEpoch(nOff, S)) && (await c.css.getNetNodeEpochRewards(nOff, S)) === netWithout[String(nOff)],
  );

  // ---- epoch S + 3: still off across the epoch boundary ----
  await ctx.fork.warpTo((await c.chronos.timestampForEpoch(S + 3n)) + 120n);
  report.say(`\nEpoch ${await c.chronos.getCurrentEpoch()}: the outage spans an epoch boundary, then the switch goes on again`);
  const during = { pool: await qsDeployed.epochPool(S), rolled: (await c.qis.fundingIn(S + 1n)).wallet, stranded: (await c.qis.fundingIn(S + 2n)).wallet };

  // ---- on: a fresh settlement, registered, initialized and unpaused in one Hub transaction ----
  const onTxs = ctx.txs.length;
  const factory = await ctx.hre.ethers.getContractFactory('QueryInferenceSettlement', deployer);
  const deployed = await send(ctx, 'deployer: deploy a fresh QueryInferenceSettlement', deployer, undefined, (await factory.getDeployTransaction(HUB)).data);
  if (!deployed.receipt.contractAddress) throw new Error('the deployment created no contract');
  const fresh = ethers.getAddress(deployed.receipt.contractAddress);
  await send(
    ctx,
    'Hub owner: Hub.setAndReinitializeContracts: register the fresh settlement, initialize it, unpause the storage',
    owner,
    HUB,
    h.interface.encodeFunctionData('setAndReinitializeContracts', [
      [{ name: 'QueryInferenceSettlement', addr: fresh }],
      [],
      [fresh],
      [{ contractName: 'QueryInferenceStorage', encodedData: [c.qis.interface.encodeFunctionData('setPaused', [false])] }],
    ]),
  );
  const qsFresh = await stack.connect('QueryInferenceSettlement', fresh);
  const orderOn = await h.getAllContracts();
  check(
    'switch on: the Hub holds the fresh settlement, StakingV10 and StakingKPI read it, it reads the same storage, and the storage is unpaused',
    (await h.getContractAddress('QueryInferenceSettlement')) === fresh &&
      (await c.sv10.queryInferenceSettlement()) === fresh &&
      (await c.kpi.queryInferenceSettlement()) === fresh &&
      (await qsFresh.queryInferenceStorage()) === qisAddr &&
      !(await c.qis.paused()),
  );
  check(`switch on: the registration appended the settlement as the Hub's last entry (${orderOn.length - 1})`, orderOn[orderOn.length - 1].addr === fresh);
  const grossSame = (await Promise.all(SELLERS.map(async (n) => (await qsFresh.queryInferenceGross(S, n)) === before.gross[String(n)]))).every(Boolean);
  check(
    `switch on: the pool's state is kept: ${S}'s pool, each seller's gross, and the money waiting since ${S + 1n}`,
    during.pool === before.pool &&
      during.rolled === before.rolled &&
      during.stranded === SWITCH_STRANDED_VALUE &&
      (await qsFresh.epochPool(S)) === before.pool &&
      (await c.qis.fundingIn(S + 1n)).wallet === before.rolled &&
      grossSame,
  );
  const openOn = await fundingOpen(S + 4n);
  check('switch on: both kinds of funding are open again', openOn.wallet && openOn.account);
  await ctx.fork.proof(c, nOn, mirror[String(nOn)], `node ${nOn} scores in epoch ${S + 3n} what it scored in ${C - 1n}`);
  const missed = await expectRevert(ctx, `switch on: node ${nOn}'s batch for the subscription of ${S + 2n}, in ${S + 3n}`, opOn, fresh, strandedBatch);
  check(`switch on: a batch that missed its epoch during the outage never counts, so its work has lost its R`, missed === groupFault(0, 'OutsideEpoch'), missed);
  // The money of the epochs with no value rolls through the outage, to the next batch.
  await send(ctx, `wallet buyer: fundFromWallet(epoch ${S + 3n}, ${fmt(SWITCH_AFTER_VALUE)} TRAC)`, walletBuyer, sswAddr, fundWallet(S + 3n, SWITCH_AFTER_VALUE, 'switch rehearsal: after the outage'));
  const afterSubscription = subscriptionIdOf(walletBuyer.address, S + 3n);
  const afterGroup = await signedGroup({ domain: qiDomain, session: walletSession, subscriptionId: afterSubscription, seller: nOn, firstNonce: 0n, values: [SWITCH_AFTER_VALUE], issuedAt: await chainNow(ctx.hre) });
  await submitBatch(ctx, qsFresh, await impersonate(ctx, opOn), `node ${nOn} operational key: submitReceiptBatch, on the fresh settlement`, [afterGroup]);
  const poolAfter = await qsFresh.epochPool(S + 3n);
  check(
    `switch on: the fresh settlement counts a batch, and epoch ${S + 3n}'s pool takes the money that rolled through the outage: ${fmt(SWITCH_UNSERVED_VALUE)} + ${fmt(SWITCH_STRANDED_VALUE)} + ${fmt(SWITCH_AFTER_VALUE)} TRAC`,
    poolAfter === SWITCH_UNSERVED_VALUE + SWITCH_STRANDED_VALUE + SWITCH_AFTER_VALUE,
    `${fmt(poolAfter)} TRAC`,
  );
  const [claimAfter] = await claimAll(ctx, [pOn], 'switch on again:');
  check(
    `switch on: token ${pOn.tokenId}'s claim splits node ${nOn}'s ${S} with the pool, as StakingKPI previewed before the switch`,
    claimAfter.reward > 0n && (await c.css.getNetNodeEpochRewards(nOn, S)) === netWith[String(nOn)],
    `${fmt(claimAfter.reward)} TRAC; net ${fmt(netWith[String(nOn)])} TRAC`,
  );
  const stranded = netWith[String(nOff)] - netWithout[String(nOff)];
  check(
    `switch on: node ${nOff}'s ${S}, split while the switch was off, stays without the pool: ${fmt(stranded)} TRAC of its net is paid to no one`,
    (await c.css.getNetNodeEpochRewards(nOff, S)) === netWithout[String(nOff)] && (await qsFresh.queryInferenceGross(S, nOff)) > 0n,
  );

  // ---- a removal by address of the Hub's last entry, the fresh settlement ----
  const byAddressTxs = ctx.txs.length;
  await send(ctx, 'Hub owner: Hub.removeContractByAddress(the fresh settlement, the last entry)', owner, HUB, h.interface.encodeFunctionData('removeContractByAddress', [fresh]));
  const lookup = await expectRevert(ctx, 'Hub.isContract("QueryInferenceSettlement")', ownerAddr, HUB, h.interface.encodeFunctionData('isContract(string)', ['QueryInferenceSettlement']));
  await impersonate(ctx, pOff.owner);
  const claimOffData = c.snft.interface.encodeFunctionData('claim', [pOff.tokenId]);
  const claimPanics = await expectRevert(ctx, `token ${pOff.tokenId} claim`, pOff.owner, snftAddr, claimOffData);
  const reRegister = await expectRevert(ctx, 'Hub.setContractAddress("QueryInferenceSettlement", the fresh settlement)', ownerAddr, HUB, register('QueryInferenceSettlement', fresh));
  check(
    'by address: the name points one past the end, so the lookup, a claim and registering the settlement under its name all panic',
    lookup === 'Panic(0x32)' && claimPanics === 'Panic(0x32)' && reRegister === 'Panic(0x32)',
  );
  await send(ctx, `Hub owner: Hub.setContractAddress("${PLACEHOLDER_NAME}", ${PLACEHOLDER}), an entry under another name`, owner, HUB, register(PLACEHOLDER_NAME, PLACEHOLDER));
  check(
    'by address: an entry appended under another name restores the lookup, and claims go through again',
    !(await stack.holds('QueryInferenceSettlement')) && (await succeeds(ctx, pOff.owner, snftAddr, claimOffData)),
  );
  await send(ctx, 'Hub owner: Hub.setContractAddress("QueryInferenceSettlement", the fresh settlement)', owner, HUB, register('QueryInferenceSettlement', fresh));
  check('by address: then the settlement registers again', (await h.getContractAddress('QueryInferenceSettlement')) === fresh);

  // ---- a removal by name of the last entry, which the settlement is again ----
  // Claims go on, as the name lookup is sound, but the removed address keeps a
  // pointer one past the end, so it can never be registered again: switching
  // on takes a fresh deployment.
  await send(ctx, 'Hub owner: Hub.removeContractByName("QueryInferenceSettlement"), the last entry', owner, HUB, removeByName);
  const byNameClaims = await succeeds(ctx, pOff.owner, snftAddr, claimOffData);
  const sameAddress = await expectRevert(ctx, 'Hub.setContractAddress("QueryInferenceSettlement", the removed address)', ownerAddr, HUB, register('QueryInferenceSettlement', fresh));
  const addressLookup = await expectRevert(ctx, 'Hub.isContract(the removed address)', ownerAddr, HUB, h.interface.encodeFunctionData('isContract(address)', [fresh]));
  check(
    'by name, the last entry: claims go through, but the removed address can never be registered again, so switching on takes a fresh deployment',
    byNameClaims && sameAddress.startsWith('AddressAlreadyInSet') && addressLookup === 'Panic(0x32)',
    `${sameAddress}; isContract(address) ${addressLookup}`,
  );

  const gasOf = (from: number, to: number) => ctx.txs.slice(from, to).map((t: TxEntry) => ({ label: t.label, gasUsed: t.gasUsed }));
  out.switch = {
    positions: { off: { tokenId: pOff.tokenId, node: nOff }, on: { tokenId: pOn.tokenId, node: nOn } },
    before,
    during,
    funding: { removedOnly: openRemoved, paused: { wallet: pausedWallet, account: pausedAccount }, onAgain: openOn },
    nets: { with: netWith, without: netWithout },
    claims: { counterfactualOn: claimOn, off: claimOff, onAgain: claimAfter, lostByOffClaim: lost, strandedNet: stranded },
    batches: { removed: batchRemoved, paused: pausedBatch, missed, poolAfter },
    fresh,
    byAddress: { lookup, claim: claimPanics, reRegister, placeholder: { name: PLACEHOLDER_NAME, addr: PLACEHOLDER } },
    byNameLastEntry: { claims: byNameClaims, sameAddress, addressLookup },
    gas: { off: gasOf(offTxs, onTxs), on: gasOf(onTxs, byAddressTxs), byAddress: gasOf(byAddressTxs, ctx.txs.length) },
  };

  return out;
}
