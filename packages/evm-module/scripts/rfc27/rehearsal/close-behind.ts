// PHASE close-behind: the close more than maxCloseStepsPerClaim epochs behind,
// when every claim reverts QueryInferenceCloseBehind until a keeper's
// closeEpochs catches up.

import { eventsIn } from '../contracts';
import { fmt, sum } from '../report';
import { Ctx, expectRevert, saveResults, send, withPool } from './context';
import { impersonate } from './plumbing';
import { positions } from './reads';
import { SELLERS } from './scenario';

export async function phaseCloseBehind(ctx: Ctx): Promise<void> {
  const { report } = ctx;
  const check = report.check.bind(report);
  const c = await withPool(ctx);
  const [, , , , , , keeper] = await ctx.hre.ethers.getSigners();
  const steps = await c.qis.maxCloseStepsPerClaim();
  const closed = await c.qis.closedThrough();
  const target = closed + steps + 2n;
  await ctx.fork.warpTo((await c.chronos.timestampForEpoch(target + 1n)) + 60n);
  const E = await c.chronos.getCurrentEpoch();
  report.say(`\nEpoch ${E}, closed through ${closed}, maxCloseStepsPerClaim ${steps}`);
  const p = (await positions(c)).find((x) => SELLERS.includes(x.node));
  if (!p) throw new Error(`no position on nodes ${SELLERS.join(', ')}`);
  const owner = await impersonate(ctx, p.owner);
  const snftAddr = await c.snft.getAddress();
  const claimData = c.snft.interface.encodeFunctionData('claim', [p.tokenId]);
  const why = await expectRevert(ctx, `token ${p.tokenId} claim`, p.owner, snftAddr, claimData);
  check('a claim reverts QueryInferenceCloseBehind once the close is more than maxCloseStepsPerClaim epochs behind', why.startsWith('QueryInferenceCloseBehind'), why);
  const closing = await send(ctx, `keeper: closeEpochs(${steps * 2n})`, keeper, await c.qs.getAddress(), c.qs.interface.encodeFunctionData('closeEpochs', [steps * 2n]));
  const closes = eventsIn(closing.receipt, c.qs, c.qs.getEvent('EpochClosed')).map((e) => {
    const money = e.walletDue + e.convictionDue + e.carryIn;
    return { epoch: e.epoch, money, served: e.sumR, unused: money - e.sumR };
  });
  report.say(
    `  unused share of epochs ${closes[0]?.epoch}..${closes[closes.length - 1]?.epoch}: money ${fmt(sum(closes.map((x) => x.money)))}, ` +
      `served ${fmt(sum(closes.map((x) => x.served)))}, unused ${fmt(sum(closes.map((x) => x.unused)))}`,
  );
  const claimed = await send(ctx, `token ${p.tokenId} owner: claim`, owner, snftAddr, claimData);
  check('after closeEpochs the claim goes through', claimed.receipt.status === 1);
  saveResults(ctx, 'close-behind', { epoch: E, closedBefore: closed, closeGas: closing.gasUsed, claimGas: claimed.gasUsed });
}
