// PHASE hub: the activation refused before the Hub transaction (and, in a
// reverted snapshot, while the settlement or StakingV10 does not read the
// pool), then the Hub owner's transaction 998 printed, then the activation;
// each with its smallest gas limit, and the Hub's contract order after it.

import * as fs from 'fs';
import * as path from 'path';

import { ethers } from 'ethers';

import type { HubLib } from '../../../typechain/contracts/storage/Hub';
import { errorMessage } from '../contracts';
import { field, rpc } from '../network';
import { requireParameter } from '../parameters';
import { toJson } from '../report';
import { TX_GAS_CAP } from '../tx';
import { Ctx, HUB, LIVE, expectRevert, saveResults, send, withPool } from './context';
import { impersonate, measureTx } from './plumbing';
import { DIR, asObject, asString } from './results';

/** The Hub owner transaction 998 printed: the line `[Hub] Hub owner transaction (JSON): {...}` of the deploy log. */
function hubTransactionOf(logFile: string): { to: string; data: string } {
  const line = fs
    .readFileSync(logFile, 'utf8')
    .split('\n')
    .find((l) => l.includes('Hub owner transaction (JSON):'));
  if (!line) throw new Error(`${logFile} holds no "Hub owner transaction (JSON)" line`);
  const o = asObject(JSON.parse(line.slice(line.indexOf('{'))), `${logFile}: the Hub owner transaction`);
  return { to: asString(o.to, 'to'), data: asString(o.data, 'data') };
}

/** The Hub's state diff of a transaction, slots written per contract, from anvil's prestate tracer. */
async function stateDiffOf(ctx: Ctx, hash: string): Promise<Record<string, number> | string> {
  try {
    const trace = await rpc(ctx.hre, 'debug_traceTransaction', [hash, { tracer: 'prestateTracer', tracerConfig: { diffMode: true } }]);
    const names = new Map<string, string>();
    for (const c of await ctx.stack.hub.getAllContracts()) names.set(c.addr.toLowerCase(), c.name);
    const diff: Record<string, number> = {};
    const post = field(trace, 'post');
    for (const [a, p] of Object.entries(typeof post === 'object' && post !== null ? post : {})) {
      const storage = field(p, 'storage');
      const slots = typeof storage === 'object' && storage !== null ? Object.keys(storage).length : 0;
      if (slots) diff[names.get(a.toLowerCase()) ?? a] = slots;
    }
    return diff;
  } catch (e: unknown) {
    return `prestateTracer unavailable: ${errorMessage(e)}`;
  }
}

export async function phaseHub(ctx: Ctx): Promise<void> {
  const { report, stack, base: c } = ctx;
  const h = stack.hub;
  const check = report.check.bind(report);
  // The versions the upgrade replaces, read at the addresses the tracked
  // deployments file records for them.
  const replaced: Record<string, string> = {};
  for (const n of ['PublishingConviction', 'StakingV10', 'StakingKPI']) replaced[n] = await stack.versionAt(LIVE[n].evmAddress);
  const hubTx = hubTransactionOf(process.env.DEPLOY_LOG ?? path.join(DIR, 'deploy.log'));
  if (hubTx.to.toLowerCase() !== HUB.toLowerCase()) throw new Error(`the printed transaction is to ${hubTx.to}, not the Hub`);

  const ownerAddr = await h.owner();
  const owner = await impersonate(ctx, ownerAddr);
  const [newContracts, newAssetStorages, reinit, forwards] = h.interface.decodeFunctionData('setAndReinitializeContracts', hubTx.data) as unknown as [
    HubLib.ContractStructOutput[],
    HubLib.ContractStructOutput[],
    string[],
    HubLib.ForwardCallInputArgsStructOutput[],
  ];
  report.say(
    `Hub.setAndReinitializeContracts: ${newContracts.length} registrations, ${newAssetStorages.length} asset storages, ` +
      `${reinit.length} initialize() calls, ${forwards.reduce((s, f) => s + f.encodedData.length, 0)} forwarded calls`,
  );
  const before: Record<string, string> = {};
  for (const r of newContracts) {
    try {
      before[r.name] = await h.getContractAddress(r.name);
    } catch {
      before[r.name] = ethers.ZeroAddress;
    }
  }
  const registered = (name: string): string => {
    const r = newContracts.find((x) => x.name === name);
    if (!r) throw new Error(`the Hub transaction registers no ${name}`);
    return r.addr;
  };

  // The activation guard, before the Hub transaction. The storage is not in
  // the Hub yet, so the Hub refuses the forward itself; inside a reverted
  // snapshot, with the pool's contracts registered piecewise, the storage's
  // own guard refuses while either reader is missing.
  const qisNew = registered('QueryInferenceStorage');
  const qsNew = registered('QueryInferenceSettlement');
  const cssvcNew = registered('ServiceSubscriptionsStorage');
  const qisIface = (await ctx.hre.ethers.getContractFactory('QueryInferenceStorage')).interface;
  const qsIface = (await ctx.hre.ethers.getContractFactory('QueryInferenceSettlement')).interface;
  const forward = (to: string, data: string) => h.interface.encodeFunctionData('forwardCall', [to, data]);
  const activateData = (e: bigint) => forward(qisNew, qisIface.encodeFunctionData('setActivationEpoch', [e]));
  const register = (name: string, addr: string) => h.interface.encodeFunctionData('setContractAddress', [name, addr]);
  const E0 = await c.chronos.getCurrentEpoch();
  const guards: Record<string, string> = {};
  guards.beforeHubTransaction = await expectRevert(ctx, 'Hub.forwardCall(QueryInferenceStorage, setActivationEpoch) before the Hub transaction', ownerAddr, HUB, activateData(E0 + 1n));
  check('before the Hub transaction the activation is refused', guards.beforeHubTransaction.startsWith('InvalidTargetContract'), guards.beforeHubTransaction);
  await ctx.fork.inSnapshot(async () => {
    await ctx.fork.send('Hub.setContractAddress(QueryInferenceStorage)', owner, HUB, register('QueryInferenceStorage', qisNew));
    guards.storageOnly = await expectRevert(ctx, 'setActivationEpoch with only QueryInferenceStorage registered', ownerAddr, HUB, activateData(E0 + 1n));
    await ctx.fork.send('Hub.setContractAddress(ServiceSubscriptionsStorage)', owner, HUB, register('ServiceSubscriptionsStorage', cssvcNew));
    await ctx.fork.send('Hub.setContractAddress(QueryInferenceSettlement)', owner, HUB, register('QueryInferenceSettlement', qsNew));
    await ctx.fork.send('Hub.forwardCall(QueryInferenceSettlement, initialize)', owner, HUB, forward(qsNew, qsIface.encodeFunctionData('initialize')));
    guards.stakingV10Old = await expectRevert(ctx, `setActivationEpoch with the settlement registered and StakingV10 ${replaced.StakingV10}`, ownerAddr, HUB, activateData(E0 + 1n));
  });
  check('PoolNotWired while the Hub holds no settlement', guards.storageOnly === 'PoolNotWired(QueryInferenceSettlement)', guards.storageOnly);
  check(`PoolNotWired while StakingV10 is ${replaced.StakingV10}`, guards.stakingV10Old === 'PoolNotWired(StakingV10)', guards.stakingV10Old);

  const estimate = BigInt(String(await rpc(ctx.hre, 'eth_estimateGas', [{ from: ownerAddr, to: HUB, data: hubTx.data }])));
  report.say(`estimated gas ${estimate}${estimate >= TX_GAS_CAP ? ' ⚠ above the 2^24 transaction gas cap' : ''}`);
  // The gas limit the Hub owner sets by hand: the smallest one the
  // transaction goes through with, found in reverted snapshots.
  const hubGas = await measureTx(ctx, ownerAddr, HUB, hubTx.data);
  report.say(`  Hub transaction: gas used ${hubGas.gasUsed}, smallest gas limit ${hubGas.minGasLimit}`);
  const hubSend = await send(ctx, 'Hub owner: Hub.setAndReinitializeContracts (998)', owner, HUB, hubTx.data);

  // The Hub's contract set, in order. A registration appends, and the set's
  // removal by address leaves the removed name pointing one past the end when
  // the removed entry is the last one: then every lookup of that name panics,
  // and StakingV10 looks up QueryInferenceSettlement on every claim.
  const order = (await h.getAllContracts()).map((r, index) => ({ index, name: r.name, addr: r.addr }));
  const settlementIndex = order.findIndex((r) => r.name === 'QueryInferenceSettlement');
  const hubOrder = { size: order.length, settlementIndex, settlementIsLast: settlementIndex === order.length - 1, last: order[order.length - 1], contracts: order };
  report.say(`\nHub.getAllContracts() after the Hub transaction, ${order.length} entries in order:`);
  for (let i = 0; i < order.length; i += 6) report.say(`  ${order.slice(i, i + 6).map((r) => `${r.index} ${r.name}`).join(', ')}`);
  report.say(
    `QueryInferenceSettlement is entry ${settlementIndex} of 0..${order.length - 1}, and the last entry is ${hubOrder.last.name}` +
      (hubOrder.settlementIsLast ? ' ⚠ the settlement IS the last entry: a removal by address would stop every claim' : ': the settlement is not the last entry'),
  );
  const stateDiff = await stateDiffOf(ctx, hubSend.receipt.hash);

  const pool = await withPool(ctx);
  const E = await c.chronos.getCurrentEpoch();
  const qis = pool.qis;
  const activation = E + 1n;
  const activateCall = forward(await qis.getAddress(), qis.interface.encodeFunctionData('setActivationEpoch', [activation]));
  const activationGas = await measureTx(ctx, ownerAddr, HUB, activateCall);
  report.say(`  activation: gas used ${activationGas.gasUsed}, smallest gas limit ${activationGas.minGasLimit}`);
  await send(ctx, `Hub owner: Hub.forwardCall(QueryInferenceStorage, setActivationEpoch(${activation}))`, owner, HUB, activateCall);

  // The wiring and parameters the rest of the rehearsal depends on.
  report.say('\nAfter the Hub transaction:');
  const versions: Record<string, string> = {};
  for (const n of [
    'ServiceSubscriptionsStorage',
    'ServiceSubscriptions',
    'ServiceSubscriptionsWallet',
    'QueryInferenceStorage',
    'QueryInferenceSettlement',
    'StakingV10Ledger',
    'ConvictionWithdrawalStorage',
    'PublishingConviction',
    'StakingV10',
    'StakingKPI',
  ]) {
    versions[n] = await stack.versionAt(await stack.addr(n));
  }
  report.say(`  ${JSON.stringify(versions)}`);
  const qs = await stack.addr('QueryInferenceSettlement');
  check('PublishingConviction is 10.2.0', versions.PublishingConviction === '10.2.0');
  check('StakingV10 is 10.1.0', versions.StakingV10 === '10.1.0');
  check('StakingKPI is 10.1.0', versions.StakingKPI === '10.1.0');
  check(
    'StakingV10 reads the settlement and the pool storage from the Hub',
    (await pool.sv10.queryInferenceSettlement()) === qs && (await pool.sv10.queryInferenceStorage()) === (await qis.getAddress()),
  );
  check(
    'the Hub holds StakingV10Ledger and ConvictionWithdrawalStorage, which the ledger wired',
    (await stack.holds('StakingV10Ledger')) && (await pool.ledger.withdrawalStorage()) === (await stack.addr('ConvictionWithdrawalStorage')),
  );
  check('StakingKPI reads the settlement from the Hub', (await pool.kpi.queryInferenceSettlement()) === qs);
  check('DKGStakingConvictionNFT re-read StakingV10', (await c.snft.stakingV10()) === (await pool.sv10.getAddress()));
  const params = {
    maxItemsPerBatch: await qis.maxItemsPerBatch(),
    maxGroupsPerBatch: await qis.maxGroupsPerBatch(),
    lambdaBps: await qis.lambdaBps(),
    activationEpoch: await qis.activationEpoch(),
    maxBudgetsPerSubscription: await pool.sss.maxBudgetsPerSubscription(),
    epochLength: await c.chronos.epochLength(),
  };
  report.say(`  ${JSON.stringify(toJson(params))}`);
  // parameters.json "testnet", read as the deploy reads it, under the getters the deploy compares.
  const want = {
    items: requireParameter('QueryInferenceStorage', ['maxItemsPerBatch']).value,
    groups: requireParameter('QueryInferenceStorage', ['maxGroupsPerBatch']).value,
    lambda: requireParameter('QueryInferenceStorage', ['lambdaBps']).value,
    budgets: requireParameter('ServiceSubscriptionsStorage', ['maxBudgetsPerSubscription']).value,
  };
  check(
    `QueryInferenceStorage holds parameters.json "testnet" (${want.items}, ${want.groups}, λ ${want.lambda})`,
    params.maxItemsPerBatch === want.items && params.maxGroupsPerBatch === want.groups && params.lambdaBps === want.lambda,
  );
  check(`ServiceSubscriptionsStorage.maxBudgetsPerSubscription is ${want.budgets}`, params.maxBudgetsPerSubscription === want.budgets);
  check(`activation epoch ${activation} = current + 1`, params.activationEpoch === activation);
  for (const n of ['PublishingConviction', 'StakingV10', 'StakingKPI']) {
    check(`the old ${n} ${replaced[n]} left the Hub's contract set`, !(await h['isContract(address)'](LIVE[n].evmAddress)));
  }

  saveResults(ctx, 'hub', {
    hubOwner: ownerAddr,
    replaced,
    guards,
    hubTransaction: {
      to: hubTx.to,
      dataBytes: (hubTx.data.length - 2) / 2,
      registrations: newContracts.map((r) => ({ name: r.name, addr: r.addr, was: before[r.name] })),
      initializeCalls: reinit.length,
      forwardedCalls: forwards.map((f) => ({ contract: f.contractName, calls: f.encodedData.length })),
      estimate,
      gas: hubGas,
    },
    hubOrder,
    stateDiff,
    epochAtActivation: E,
    activation,
    activationGas,
    versions,
    params,
  });
}
