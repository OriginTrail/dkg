// A position's reward claims, as the chain recorded them: each claim moves its
// LastClaimedEpochUpdated cursor, and pays what CumulativeRewardsClaimedUpdated
// adds in the same transaction, or nothing when the window held no reward. Each
// is replayed in order against the epochs' nets, worked out from what no claim
// writes, compounding into the raw stake the next one reads. That is exact, since
// a claim settles only the epoch it runs in, and leaves the score inputs of every
// ended epoch as the later claims read them.

import type { Log, Provider } from 'ethers';
import { ethers } from 'ethers';

import type { Contracts } from '../contracts';
import { EpochReward, claimPreview, poolShareOf } from '../reads';

/** A public endpoint limits eth_getLogs to a range of 200 blocks. */
const LOG_PAGE = 199;

/** Logs from `fromBlock` to the head, a page at a time, in order. */
export async function pagedLogs(provider: Pick<Provider, 'getBlockNumber' | 'getLogs'>, filter: { address: string | string[]; topics: (string | string[])[] }, fromBlock: number): Promise<Log[]> {
  const head = await provider.getBlockNumber();
  const logs: Log[] = [];
  for (let from = fromBlock; from <= head; from += LOG_PAGE) {
    logs.push(...(await provider.getLogs({ ...filter, fromBlock: from, toBlock: Math.min(from + LOG_PAGE - 1, head) })));
  }
  return logs;
}

/**
 * The first block at or after `ts`, given a block `from` that is. It steps back from
 * there, doubling, and then halves what is left: an endpoint serves no block it has pruned,
 * so it reads none from long before `ts`.
 */
export async function firstBlockAt(provider: Pick<Provider, 'getBlock'>, ts: bigint, from: number): Promise<number> {
  const before = async (n: number): Promise<boolean> => BigInt((await provider.getBlock(n))?.timestamp ?? 0) < ts;
  let high = from;
  let step = 256;
  let low = Math.max(high - step, 0);
  while (!(await before(low))) {
    if (low === 0) return 0;
    high = low;
    step *= 2;
    low = Math.max(high - step, 0);
  }
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (await before(middle)) low = middle;
    else high = middle;
  }
  return high;
}

/**
 * A node's net of epoch `e`, as `StakingV10._nodeEpochReward` splits it, from what no
 * claim writes: its share of the publishing pool by score, its query/inference gross,
 * final once the epoch has ended, and the operator fee in force at the epoch's end. Once
 * a claim has split an epoch, StakingKPI gives back the net that claim stored, so it
 * cannot be what that claim is checked against.
 */
export async function netFromInputs(c: Contracts, node: bigint, e: bigint): Promise<bigint> {
  const { publishingShare, feeBps } = await poolShareOf(c, node, e, 0n, 0n);
  const gross = publishingShare + (await c.qs.queryInferenceGross(e, node));
  return gross - (gross * feeBps) / (await c.params.maxOperatorFee());
}

/** The net of each epoch from..to, by `netFromInputs`. */
export async function netsFromInputs(c: Contracts, node: bigint, from: bigint, to: bigint): Promise<Map<bigint, bigint>> {
  const nets = new Map<bigint, bigint>();
  for (let e = from; e <= to; e++) nets.set(e, await netFromInputs(c, node, e));
  return nets;
}

/** One claim: the epochs it covered, what it paid, what the epochs' nets give, and where it ran. */
export type RewardClaim = { from: bigint; to: bigint; paid: bigint; previewed: bigint; tx: string; block: number };

export type RewardClaims = {
  claims: RewardClaim[];
  /** Every claimed epoch, as the epochs' nets give it. */
  per: EpochReward[];
  /** What the claims paid together. */
  total: bigint;
  /** The last epoch they claimed. */
  through: bigint;
};

/**
 * The claims of tier-0 position `tokenId`, on `node`, staked with `stakeRaw` at
 * block `fromBlock`, whose first claimable epoch is `firstEpoch`.
 */
export async function rewardClaims(
  provider: Pick<Provider, 'getBlockNumber' | 'getLogs'>,
  c: Contracts,
  o: { tokenId: bigint; node: bigint; stakeRaw: bigint; firstEpoch: bigint; fromBlock: number },
): Promise<RewardClaims> {
  const claimedTopic = c.css.getEvent('LastClaimedEpochUpdated').fragment.topicHash;
  const paidTopic = c.css.getEvent('CumulativeRewardsClaimedUpdated').fragment.topicHash;
  const logs = await pagedLogs(provider, { address: await c.css.getAddress(), topics: [[claimedTopic, paidTopic], ethers.toBeHex(o.tokenId, 32)] }, o.fromBlock);

  const paidIn = new Map<string, bigint>();
  const cursors: { epoch: bigint; tx: string; block: number }[] = [];
  for (const l of logs) {
    const parsed = c.css.interface.parseLog({ topics: [...l.topics], data: l.data });
    if (parsed?.name === 'CumulativeRewardsClaimedUpdated') paidIn.set(l.transactionHash, (paidIn.get(l.transactionHash) ?? 0n) + BigInt(parsed.args.added));
    if (parsed?.name === 'LastClaimedEpochUpdated') cursors.push({ epoch: BigInt(parsed.args.epoch), tx: l.transactionHash, block: l.blockNumber });
  }

  const claims: RewardClaim[] = [];
  const per: EpochReward[] = [];
  let raw = o.stakeRaw;
  let from = o.firstEpoch;
  for (const cursor of cursors) {
    const preview = await claimPreview(c, o.tokenId, o.node, from, cursor.epoch, raw, await netsFromInputs(c, o.node, from, cursor.epoch));
    const paid = paidIn.get(cursor.tx) ?? 0n;
    claims.push({ from, to: cursor.epoch, paid, previewed: preview.total, tx: cursor.tx, block: cursor.block });
    per.push(...preview.per);
    raw += paid;
    from = cursor.epoch + 1n;
  }
  return { claims, per, total: raw - o.stakeRaw, through: from - 1n };
}
