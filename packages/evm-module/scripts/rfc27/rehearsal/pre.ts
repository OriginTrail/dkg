// PHASE pre: the live contracts (PublishingConviction 10.0.8, StakingV10
// 10.0.4, StakingKPI 10.0.2) before the upgrade, inside a snapshot that is
// reverted: a scheduled account's publish, every position's claim, the settles,
// and StakingKPI's nets, which the existing phase compares the upgraded contracts
// with. The claims come before the expired accounts' settles: 10.0.8 can sweep a
// late account's tail into an epoch that has ended, which 10.2.0 does not, so what
// the claims pay would differ by that alone.

import { Ctx, saveResults, send } from './context';
import { claimAll, publishAs } from './operations';
import { operationalKeys } from './plumbing';
import { accountsSummary, eventNamesIn, eventSources, nodeEpochNets, positions, stakerCredits, storedNets } from './reads';
import type { Range } from '../../../test/helpers/emission-model';
import { SCHEDULED_ACCOUNT, TRAC } from './scenario';

export async function phasePre(ctx: Ctx): Promise<void> {
  const { report, stack, base: c } = ctx;
  const block = await ctx.hre.ethers.provider.getBlock('latest');
  if (!block) throw new Error('no latest block');
  const E = await c.chronos.getCurrentEpoch();
  report.say(`Fork block ${block.number} (ts ${block.timestamp}), epoch ${E}, epoch length ${await c.chronos.epochLength()}`);
  const versions: Record<string, string> = {};
  for (const n of ['PublishingConviction', 'StakingV10', 'StakingKPI', 'DKGPublishingConvictionNFT', 'DKGStakingConvictionNFT']) {
    versions[n] = await stack.versionAt(await stack.addr(n));
  }
  report.say(`live versions ${JSON.stringify(versions)}`);

  const pos = await positions(c);
  const accounts = await accountsSummary(ctx);
  const operational = await operationalKeys(ctx);
  report.say(`operational keys from recent challenges ${JSON.stringify(operational)}`);
  const nodes = [...new Set(pos.map((p) => p.node))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const from = pos.reduce((m, p) => (p.lastClaimedEpoch + 1n < m ? p.lastClaimedEpoch + 1n : m), E);

  report.say(`\nStakingKPI ${versions.StakingKPI} nets for nodes ${nodes.join(',')} over epochs ${from}..${E - 1n}`);
  const kpi = await stack.held('StakingKPI');
  const kpiBefore = await nodeEpochNets(c, kpi, nodes, from, E - 1n);

  report.say('\nin a snapshot: the 10.0.8 / 10.0.4 behaviour, then revert');
  const old = await ctx.fork.inSnapshot(async () => {
    const pc = await stack.held('PublishingConviction');
    const [agent] = await c.pcs.getRegisteredAgents(SCHEDULED_ACCOUNT);
    const publish = await publishAs(ctx, pc, SCHEDULED_ACCOUNT, agent, 10n * TRAC, 2n, '10.0.8');
    const [anyone] = await ctx.hre.ethers.getSigners();
    const nft = await c.nft.getAddress();
    const settle = (id: bigint) => c.nft.interface.encodeFunctionData('settle', [id]);
    const settleScheduled = await send(ctx, `10.0.8 settle(${SCHEDULED_ACCOUNT})`, anyone, nft, settle(SCHEDULED_ACCOUNT));
    const claims = await claimAll(ctx, pos, '10.0.4');
    const netsAfterOldClaims = await storedNets(c, Object.keys(kpiBefore));
    const expired = accounts.filter((a) => !a.live).map((a) => a.id);
    const sources = await eventSources(ctx.hre);
    const settles: { id: bigint; stakerCredits: Range[]; events: string[] }[] = [];
    for (const id of expired) {
      const { receipt } = await send(ctx, `10.0.8 settle(${id})`, anyone, nft, settle(id));
      settles.push({ id, stakerCredits: stakerCredits(receipt, c), events: eventNamesIn(receipt, sources) });
    }
    return { publish, settleScheduled: stakerCredits(settleScheduled.receipt, c), settles, claims, netsAfterOldClaims };
  });
  report.say('reverted');

  saveResults(ctx, 'pre', {
    forkBlock: block.number,
    forkTimestamp: block.timestamp,
    epoch: E,
    versions,
    operational,
    positions: pos,
    accounts,
    kpiBefore,
    old,
  });
}
