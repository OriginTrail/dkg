// OT-RFC-27 script support: what the contracts pay, computed from views. A
// claim's payment as StakingKPI's nets preview it, a position's share of the
// query/inference pool, an epoch's money, value and pool as storage keeps them,
// and a node's gross worked out without the contract.

import { ethers } from 'ethers';

import { Fault, stakeFactorOf } from '../../test/helpers/query-inference';
import type { Contracts } from './contracts';

const SCALE18 = 10n ** 18n;
const BPS = 10_000n;

/** A batch's refusal for group `g`, in the words of `decodeError`. */
export const groupFault = (g: number, fault: keyof typeof Fault): string => `GroupFault(${g}, ${Fault[fault]})`;
/** A batch's refusal for item `i` of group `g`, in the words of `decodeError`. */
export const receiptFault = (g: number, i: number, fault: keyof typeof Fault): string => `ReceiptFault(${g}, ${i}, ${Fault[fault]})`;

/**
 * The stake factor a batch should capture, from the stake alone: the node's live
 * effective stake, or its challenge's snapshot if that took one and is lower,
 * against the maximum stake. A check compares a batch with this, so a factor
 * that went wrong on its way into the batch can't vouch for itself.
 */
export const stakeFactorFrom = (s: { live: bigint; snapshotSet: boolean; snapshot: bigint; maximumStake: bigint }): bigint =>
  stakeFactorOf(s.snapshotSet && s.snapshot < s.live ? s.snapshot : s.live, s.maximumStake);

/** A batch's captured factor is right: what the stake gives, and above 0, since a seller with no stake gives no reason to trust either side. */
export const capturedFactorHolds = (captured: bigint, expected: bigint): boolean => expected > 0n && captured === expected;

/** `stakeFactorFrom` over what the chain holds for `node` now. */
export async function expectedStakeFactor(c: Contracts, node: bigint): Promise<bigint> {
  return stakeFactorFrom({
    live: await c.css.getNodeEffectiveStake(node),
    snapshotSet: await c.rss.nodeChallengeStakeSnapshotSet(node),
    snapshot: await c.rss.nodeChallengeStakeSnapshot(node),
    maximumStake: await c.params.maximumStake(),
  });
}

export type EpochReward = { epoch: bigint; scored: boolean; score: bigint; nodeScore: bigint; net: bigint; reward: bigint };
export type ClaimPreview = { total: bigint; per: EpochReward[] };

/** A position's delegator key in RandomSamplingStorage. */
export const delegatorKey = (tokenId: bigint): string => ethers.zeroPadValue(ethers.toBeHex(tokenId), 32);

/** What a claim reads of one epoch: the score-per-stake inputs of the position, the node's score, the net. */
type EpochInputs = { epoch: bigint; cur: bigint; settled: bigint; last: bigint; nodeScore: bigint; net: bigint };

/** Each epoch's inputs from views; `nets` overrides StakingKPI's net, by epoch, with nets read earlier. */
async function inputsOf(c: Contracts, tokenId: bigint, node: bigint, from: bigint, to: bigint, nets?: ReadonlyMap<bigint, bigint>): Promise<EpochInputs[]> {
  const key = delegatorKey(tokenId);
  const out: EpochInputs[] = [];
  for (let e = from; e <= to; e++) {
    const cur = await c.rss.getEpochLastScorePerStake(node, e);
    if (cur === 0n) {
      out.push({ epoch: e, cur, settled: 0n, last: 0n, nodeScore: 0n, net: 0n });
      continue;
    }
    out.push({
      epoch: e,
      cur,
      settled: await c.rss.getEpochNodeDelegatorScore(e, node, key),
      last: await c.rss.getDelegatorLastSettledNodeEpochScorePerStake(e, node, key),
      nodeScore: await c.rss.getNodeEpochScore(e, node),
      net: nets?.get(e) ?? (await c.kpi.getNetNodeRewards(node, e)),
    });
  }
  return out;
}

/**
 * An epoch's reward to a tier-0 position of raw stake `raw`, as
 * `StakingV10._claim` computes it: its settled score plus raw × the score
 * per stake since it last settled, times the node's net over its score.
 */
const rewardIn = (x: EpochInputs, raw: bigint): EpochReward => {
  if (x.cur === 0n) return { epoch: x.epoch, scored: false, score: 0n, nodeScore: 0n, net: 0n, reward: 0n };
  const score = x.settled + (x.cur > x.last ? (raw * (x.cur - x.last)) / SCALE18 : 0n);
  const reward = x.nodeScore === 0n || score === 0n ? 0n : (score * x.net) / x.nodeScore;
  return { epoch: x.epoch, scored: true, score, nodeScore: x.nodeScore, net: x.net, reward };
};

/**
 * What one claim pays tier-0 position `tokenId`, of raw stake `raw`, on
 * `node` for epochs from..to, with StakingKPI's nets, or `nets` read earlier.
 */
export async function claimPreview(
  c: Contracts,
  tokenId: bigint,
  node: bigint,
  from: bigint,
  to: bigint,
  raw: bigint,
  nets?: ReadonlyMap<bigint, bigint>,
): Promise<ClaimPreview> {
  const per = (await inputsOf(c, tokenId, node, from, to, nets)).map((x) => rewardIn(x, raw));
  return { total: per.reduce((a, r) => a + r.reward, 0n), per };
}

/** The score tier-0 position `tokenId` holds so far in `epoch` on `node`. */
export async function positionScore(c: Contracts, tokenId: bigint, node: bigint, epoch: bigint, raw: bigint): Promise<bigint> {
  const key = delegatorKey(tokenId);
  const cur = await c.rss.getEpochLastScorePerStake(node, epoch);
  const settled = await c.rss.getEpochNodeDelegatorScore(epoch, node, key);
  const last = await c.rss.getDelegatorLastSettledNodeEpochScorePerStake(epoch, node, key);
  return settled + (cur > last ? (raw * (cur - last)) / SCALE18 : 0n);
}

/** StakingKPI's net of `node` in each epoch from..to, and whether a claim has split the epoch yet. */
export async function kpiNets(c: Contracts, node: bigint, from: bigint, to: bigint): Promise<{ nets: Map<bigint, bigint>; split: Map<bigint, boolean> }> {
  const nets = new Map<bigint, bigint>();
  const split = new Map<bigint, boolean>();
  for (let e = from; e <= to; e++) {
    nets.set(e, await c.kpi.getNetNodeRewards(node, e));
    split.set(e, await c.css.isOperatorFeeClaimedForEpoch(node, e));
  }
  return { nets, split };
}

export type PoolShare = {
  nodeScore: bigint;
  publishingShare: bigint;
  feeBps: bigint;
  netWithPool: bigint;
  netWithoutPool: bigint;
  rewardWithPool: bigint;
  rewardWithoutPool: bigint;
  poolShare: bigint;
};

/** A position's reward in epoch `e` with the pool and without it: the share of the pool it is paid. */
export async function poolShareOf(c: Contracts, node: bigint, e: bigint, score: bigint, net: bigint): Promise<PoolShare> {
  const nodeScore = await c.rss.getNodeEpochScore(e, node);
  const allScore = await c.rss.getAllNodesEpochScore(e);
  const stakerPool = await c.es.getEpochPool(1, e);
  const publishingShare = allScore === 0n ? 0n : (stakerPool * nodeScore) / allScore;
  const feeBps = await c.ps.getOperatorFeePercentageByTimestampReverse(node, (await c.chronos.timestampForEpoch(e + 1n)) - 1n);
  const maxFee = await c.params.maxOperatorFee();
  const netWithoutPool = publishingShare - (publishingShare * feeBps) / maxFee;
  const rewardWithPool = nodeScore === 0n ? 0n : (score * net) / nodeScore;
  const rewardWithoutPool = nodeScore === 0n ? 0n : (score * netWithoutPool) / nodeScore;
  return { nodeScore, publishingShare, feeBps, netWithPool: net, netWithoutPool, rewardWithPool, rewardWithoutPool, poolShare: rewardWithPool - rewardWithoutPool };
}

/** An epoch as storage keeps it, and the pool `epochPool` reads from it. */
export type EpochNumbers = {
  epoch: bigint;
  walletFunding: bigint;
  accountFunding: bigint;
  /** What was funded for the epoch's own subscriptions. */
  money: bigint;
  totalServed: bigint;
  totalWeighted: bigint;
  /** The λ the epoch took when its first value counted; 0 until then. */
  lambdaBps: bigint;
  pool: bigint;
};

export async function epochNumbers(c: Contracts, e: bigint): Promise<EpochNumbers> {
  const funded = await c.qis.fundingIn(e);
  const totals = await c.qis.getEpochTotals(e);
  return {
    epoch: e,
    walletFunding: funded.wallet,
    accountFunding: funded.account,
    money: funded.wallet + funded.account,
    totalServed: totals.totalServed,
    totalWeighted: totals.totalWeighted,
    lambdaBps: totals.lambdaBps,
    pool: await c.qs.epochPool(e),
  };
}

/**
 * The rollover rule over consecutive epochs from activation, worked out without
 * the contract: an epoch with no value has a pool of 0, and its money waits for
 * the next epoch with value, whose pool takes all of it. `waiting` is what is
 * still waiting after the last epoch.
 */
export function poolsFromMoney(epochs: readonly { money: bigint; totalServed: bigint }[]): { pools: bigint[]; waiting: bigint } {
  let waiting = 0n;
  const pools = epochs.map((x) => {
    waiting += x.money;
    if (x.totalServed === 0n) return 0n;
    const pool = waiting;
    waiting = 0n;
    return pool;
  });
  return { pools, waiting };
}

/** A node's gross from a pool, worked out without the contract: each term floored on its own, the second by R when no node has a score. */
export function grossOf(pool: bigint, lambdaBps: bigint, node: { servedValue: bigint; weightedValue: bigint }, totals: { totalServed: bigint; totalWeighted: bigint }): bigint {
  if (node.servedValue === 0n) return 0n;
  const first = (pool * (BPS - lambdaBps) * node.servedValue) / (BPS * totals.totalServed);
  const second = totals.totalWeighted === 0n ? (pool * lambdaBps * node.servedValue) / (BPS * totals.totalServed) : (pool * lambdaBps * node.weightedValue) / (BPS * totals.totalWeighted);
  return first + second;
}
