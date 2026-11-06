// What the rehearsal reads off the fork: every position and Conviction
// Account, StakingKPI's nets against the nets claims split, the staker-pool
// credits a transaction booked, and the reward a claim pays, from views.

import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import type { Interface, TransactionReceipt } from 'ethers';

import type { PoolModel, Range } from '../../../test/helpers/emission-model';
import { BaseContracts, Contracts, eventsIn } from '../contracts';
import { chainNow } from '../network';
import { claimPreview } from '../reads';
import type { StakingKPI } from '../../../typechain';
import { Ctx, LIVE } from './context';
import type { AccountSummary, NodeEpochNet, Position } from './results';

/** Every live position of the staking NFT. */
export async function positions(c: BaseContracts): Promise<Position[]> {
  const next = await c.snft.nextTokenId();
  const out: Position[] = [];
  for (let t = 1n; t <= next; t++) {
    const p = await c.css.getPosition(t);
    if (p.identityId === 0n) continue;
    out.push({
      tokenId: t,
      owner: await c.snft.ownerOf(t),
      node: p.identityId,
      raw: p.raw,
      lastClaimedEpoch: p.lastClaimedEpoch,
      migrationEpoch: p.migrationEpoch,
      expiryTimestamp: p.expiryTimestamp,
      cumulativeRewardsClaimed: p.cumulativeRewardsClaimed,
    });
  }
  return out;
}

/** The smallest position of `node` among `pos`. */
export const smallestOn = (pos: Position[], node: bigint): Position | undefined =>
  pos.filter((p) => p.node === node).sort((a, b) => (a.raw < b.raw ? -1 : 1))[0];

/** Every Conviction Account, with whether it is live and whether PublishingConviction 10.0.8 scheduled it. */
export async function accountsSummary(ctx: Ctx): Promise<AccountSummary[]> {
  const { nft, pcs } = ctx.base;
  const supply = await nft.totalSupply();
  const t = await chainNow(ctx.hre);
  const out: AccountSummary[] = [];
  for (let id = 1n; id <= supply; id++) {
    if (!(await pcs.accountExists(id))) continue;
    const a = await pcs.getAccount(id);
    out.push({
      id,
      owner: await nft.ownerOf(id),
      committed: a.committedTRAC,
      createdAtTimestamp: a.createdAtTimestamp,
      expiresAtTimestamp: a.expiresAtTimestamp,
      lock: a.lockDurationEpochs,
      lastSettledWindow: a.lastSettledWindow,
      fullySwept: a.fullySwept,
      topUp: await pcs.topUpBalance(id),
      scheduled: a.lastSettledWindow >= a.lockDurationEpochs,
      live: t < a.expiresAtTimestamp,
      createdBefore1008: Number(a.createdAtTimestamp) * 1000 < LIVE.PublishingConviction.deploymentTimestamp,
    });
  }
  return out;
}

/** Per node and epoch of the claim windows with a score: StakingKPI's net, and the split state. */
export async function nodeEpochNets(c: BaseContracts, kpi: StakingKPI, nodes: bigint[], from: bigint, to: bigint): Promise<Record<string, NodeEpochNet>> {
  const out: Record<string, NodeEpochNet> = {};
  for (const n of nodes) {
    for (let e = from; e <= to; e++) {
      if ((await c.rss.getEpochLastScorePerStake(n, e)) === 0n && (await c.rss.getNodeEpochScore(e, n)) === 0n) continue;
      out[`${n}:${e}`] = {
        kpiNet: await kpi.getNetNodeRewards(n, e),
        split: await c.css.isOperatorFeeClaimedForEpoch(n, e),
        storedNet: await c.css.getNetNodeEpochRewards(n, e),
      };
    }
  }
  return out;
}

/** Whether each `<node>:<epoch>` is split, and the net its split stored. */
export async function storedNets(c: BaseContracts, keys: string[]): Promise<Record<string, { split: boolean; storedNet: bigint }>> {
  const out: Record<string, { split: boolean; storedNet: bigint }> = {};
  for (const k of keys) {
    const [n, e] = k.split(':').map((x) => BigInt(x));
    out[k] = { split: await c.css.isOperatorFeeClaimedForEpoch(n, e), storedNet: await c.css.getNetNodeEpochRewards(n, e) };
  }
  return out;
}

/** The shard of EpochStorageV8 that holds the staker pools. */
const STAKER_SHARD_ID = 1n;

/** The staker shard's pools, by epoch, and the remainder it carries, as storage holds them. */
export type StoredPools = { pools: Map<bigint, bigint>; remainder: bigint };

export async function stakerPools(c: BaseContracts, from: bigint, to: bigint): Promise<StoredPools> {
  const pools = new Map<bigint, bigint>();
  for (let e = from; e <= to; e++) pools.set(e, await c.es.getEpochPool(STAKER_SHARD_ID, e));
  return { pools, remainder: await c.es.accumulatedRemainder(STAKER_SHARD_ID) };
}

/**
 * The pools moved exactly as `model` books them: every epoch read gained what it
 * books for that epoch, it books none outside those read, and the remainder is
 * its own. A credit's event can't stand in for this: it says what was asked for,
 * and these say what stakers can be paid.
 */
export function poolsHold(before: StoredPools, after: StoredPools, model: PoolModel): boolean {
  for (const e of model.perEpoch.keys()) if (!after.pools.has(e)) return false;
  for (const [e, pool] of after.pools) {
    if (pool - (before.pools.get(e) ?? 0n) !== (model.perEpoch.get(e) ?? 0n)) return false;
  }
  return after.remainder === model.remainder;
}

/** What a transaction booked to the staker pool, range by range. */
export const stakerCredits = (receipt: TransactionReceipt, c: BaseContracts): Range[] =>
  eventsIn(receipt, c.es, c.es.getEvent('TokensAddedToEpochRange'))
    .filter((e) => e.shardId === STAKER_SHARD_ID)
    .map((e) => ({ start: e.startEpoch, end: e.endEpoch, amount: e.tokenAmount }));

/** Every interface whose events a settle's receipt may carry, in the order they are tried. */
const EVENT_SOURCES = [
  'Hub',
  'EpochStorage',
  'PublishingConviction',
  'DKGPublishingConvictionNFT',
  'StakingV10',
  'StakingV10Ledger',
  'StakingKPI',
  'QueryInferenceSettlement',
  'QueryInferenceStorage',
  'ServiceSubscriptions',
  'ServiceSubscriptionsWallet',
  'ServiceSubscriptionsStorage',
  'ConvictionStakingStorage',
  'DKGStakingConvictionNFT',
  'Token',
];

export const eventSources = (hre: HardhatRuntimeEnvironment): Promise<Interface[]> =>
  Promise.all(EVENT_SOURCES.map(async (n) => (await hre.ethers.getContractFactory(n)).interface));

/** The names of the events in `receipt`, each decoded by the first of `interfaces` that knows it. */
export function eventNamesIn(receipt: TransactionReceipt, interfaces: Interface[]): string[] {
  const out: string[] = [];
  for (const log of receipt.logs) {
    for (const i of interfaces) {
      try {
        const p = i.parseLog({ topics: [...log.topics], data: log.data });
        if (p) {
          out.push(p.name);
          break;
        }
      } catch {
        // another contract's log
      }
    }
  }
  return out;
}

/** Billing windows from `fromWindow` up to, not including, `toWindow`. */
export type WindowRange = { fromWindow: bigint; toWindow: bigint };

/**
 * The windows a settle at time `at` must book on an account whose cursor is
 * `cursor`, worked out without the settlement: every window closed by then,
 * capped at the lock. Window w closes at createdAt + (w + 1) × epLen.
 */
export function closedWindows(o: { cursor: bigint; createdAt: bigint; epLen: bigint; lock: bigint; at: bigint }): WindowRange {
  const current = o.at > o.createdAt ? (o.at - o.createdAt) / o.epLen : 0n;
  const to = current < o.lock ? current : o.lock;
  return { fromWindow: o.cursor, toWindow: to > o.cursor ? to : o.cursor };
}

export const sameRanges = (a: Range[], b: Range[]): boolean =>
  a.length === b.length && a.every((r, i) => r.start === b[i].start && r.end === b[i].end && r.amount === b[i].amount);

export type ExpectedReward = { total: bigint; per: Record<string, bigint> };

/**
 * The reward `_claim` pays position `p` for epochs `from..to`, from views, for
 * a position whose boost has expired: the shared claim preview, with `nets`
 * by `<node>:<epoch>` (an epoch without one nets 0), at the raw stake the
 * position holds now. `per` holds each epoch the node scored in.
 */
export async function expectedReward(c: Contracts, p: Position, from: bigint, to: bigint, nets: Record<string, bigint>): Promise<ExpectedReward> {
  const byEpoch = new Map<bigint, bigint>();
  for (let e = from; e <= to; e++) byEpoch.set(e, nets[`${p.node}:${e}`] ?? 0n);
  const raw = (await c.css.getPosition(p.tokenId)).raw;
  const preview = await claimPreview(c, p.tokenId, p.node, from, to, raw, byEpoch);
  const per: Record<string, bigint> = {};
  for (const x of preview.per) if (x.scored) per[String(x.epoch)] = x.reward;
  return { total: preview.total, per };
}
