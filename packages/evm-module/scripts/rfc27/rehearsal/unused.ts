// PHASE unused: the unused share of every closed epoch, from storage.
//
// Per closed epoch from activation: money = walletDue + convictionDue +
// carryIn, served = ΣR finalized in it, unused = money − served, whoever
// closed it (a keeper's closeEpochs or a claim on its way). The carry into
// the activation epoch is 0, and each close carries money − pool on.

import { closeFromStorage } from '../reads';
import { fmt, sum } from '../report';
import { Ctx, saveResults, withPool } from './context';

export async function phaseUnused(ctx: Ctx): Promise<void> {
  const { report } = ctx;
  const c = await withPool(ctx);
  const activation = await c.qis.activationEpoch();
  const closedThrough = await c.qis.closedThrough();
  const rows: { epoch: bigint; walletDue: bigint; convictionDue: bigint; carryIn: bigint; money: bigint; served: bigint; unused: bigint; pool: bigint }[] = [];
  for (let e = activation; e <= closedThrough; e++) {
    const x = await closeFromStorage(c, e);
    const money = x.walletDue + x.convictionDue + x.carryIn;
    rows.push({ epoch: e, walletDue: x.walletDue, convictionDue: x.convictionDue, carryIn: x.carryIn, money, served: x.sumR, unused: money - x.sumR, pool: x.pool });
  }
  report.say(`\nunused share, epochs ${activation}..${closedThrough} (money = walletDue + convictionDue + carryIn, served = sumR):`);
  for (const r of rows) {
    if (r.money > 0n || r.served > 0n) report.say(`  epoch ${r.epoch}: money ${fmt(r.money)}, served ${fmt(r.served)}, unused ${fmt(r.unused)}, pool ${fmt(r.pool)}`);
  }
  const empty = rows.filter((r) => r.money === 0n && r.served === 0n).map((r) => r.epoch);
  report.say(`  the other ${empty.length} epochs had no money and served nothing`);
  report.say(`  total: money ${fmt(sum(rows.map((r) => r.money)))}, served ${fmt(sum(rows.map((r) => r.served)))}, unused ${fmt(sum(rows.map((r) => r.unused)))}`);
  report.check(
    'every closed epoch pools its whole money once value is served, and carries it otherwise',
    rows.every((r) => (r.served > 0n ? r.pool === r.money : r.pool === 0n)),
  );
  saveResults(ctx, 'unused', { activation, closedThrough, rows }, { txs: false });
}
