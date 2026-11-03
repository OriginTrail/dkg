// OT-RFC-27 script support: what the contracts pay, computed from views. A
// claim's payment as StakingKPI's nets preview it, a position's share of the
// query/inference pool, an epoch's close as storage keeps it, and the reason a
// finalization would skip a claim.

import { ethers } from 'ethers';

import type { Contracts } from './contracts';

const SCALE18 = 10n ** 18n;

/** `QueryInferenceSettlement.Skip`, in declaration order. */
export const SKIP_REASONS = ['None', 'UnknownPeriod', 'UnknownBucket', 'AlreadyFinalized', 'TooEarly', 'Void', 'NothingClaimed', 'NoScore'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export const skipReasonOf = (code: bigint): SkipReason => SKIP_REASONS[Number(code)] ?? 'None';

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

export type EpochCloseNumbers = {
  epoch: bigint;
  walletDue: bigint;
  convictionDue: bigint;
  carryIn: bigint;
  pool: bigint;
  sumR: bigint;
  sumScore: bigint;
  lambdaBps: bigint;
  closed: boolean;
};

/** An epoch's close as storage keeps it, the carry into it chained from activation, as `EpochClosed` reports it. */
export async function closeFromStorage(c: Contracts, e: bigint): Promise<EpochCloseNumbers> {
  const activation = await c.qis.activationEpoch();
  let carryIn = 0n;
  for (let x = activation; x < e; x++) {
    const due = await c.qis.dueIn(x);
    carryIn = due.wallet + due.conviction + carryIn - (await c.qis.getEpochClose(x)).pool;
  }
  const due = await c.qis.dueIn(e);
  const close = await c.qis.getEpochClose(e);
  const totals = await c.qis.getEpochTotals(e);
  return {
    epoch: e,
    walletDue: due.wallet,
    convictionDue: due.conviction,
    carryIn,
    pool: close.pool,
    sumR: totals.sumR,
    sumScore: totals.sumScore,
    lambdaBps: close.lambdaBps,
    closed: close.closed,
  };
}

export type ClaimRef = { subscriptionId: string; bucketIndex: bigint; seller: bigint };

/**
 * Why `finalizeClaims` would skip `ref` now, from views, in the order
 * `QueryInferenceSettlement._finalize` checks: 'None' when it would finalize.
 */
export async function predictSkip(c: Contracts, ref: ClaimRef, now: bigint): Promise<SkipReason> {
  const s = await c.cssvc.getSubscription(ref.subscriptionId);
  if (s.periodStart === 0n) return 'UnknownPeriod';
  if (ref.bucketIndex >= s.bucketCount) return 'UnknownBucket';
  const claim = await c.qis.getSellerClaim(ref.subscriptionId, ref.bucketIndex, ref.seller);
  if (claim.finalized) return 'AlreadyFinalized';
  const epoch = BigInt(s.periodId);
  const current = await c.chronos.getCurrentEpoch();
  if (current > epoch + 1n) return 'Void';
  if (current <= epoch || now <= s.periodEnd + (await c.qis.receiptGraceSecondsAt(epoch))) return 'TooEarly';
  if (claim.claimed === 0n) return 'NothingClaimed';
  if ((await c.rss.getNodeEpochScore(current, ref.seller)) === 0n) return 'NoScore';
  return 'None';
}

/** What `ref` finalizes to: claimed × min(1, the bucket's funded cap / all its claims). */
export async function finalizedValueOf(c: Contracts, ref: ClaimRef): Promise<bigint> {
  const claim = await c.qis.getSellerClaim(ref.subscriptionId, ref.bucketIndex, ref.seller);
  const cap = await c.qs.fundedCap(ref.subscriptionId, ref.bucketIndex);
  const total = await c.qis.bucketClaimed(ref.subscriptionId, ref.bucketIndex);
  return total > cap ? (claim.claimed * cap) / total : claim.claimed;
}
