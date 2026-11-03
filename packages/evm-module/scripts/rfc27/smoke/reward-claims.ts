// A position's reward claims, as the chain recorded them: each claim moves its
// LastClaimedEpochUpdated cursor, and pays what CumulativeRewardsClaimedUpdated
// adds in the same transaction, or nothing when the window held no reward. Each
// is replayed in order against StakingKPI's preview, compounding into the raw
// stake the next one reads. That is exact, since a claim settles only the epoch
// it runs in, and leaves the score inputs of every ended epoch as the later
// claims read them.

import type { Provider } from 'ethers';
import { ethers } from 'ethers';

import type { Contracts } from '../contracts';
import { EpochReward, claimPreview } from '../reads';

/** A public endpoint limits eth_getLogs to a range of 200 blocks. */
const LOG_PAGE = 199;

/** One claim: the epochs it covered, what it paid, what the preview says of them, and where it ran. */
export type RewardClaim = { from: bigint; to: bigint; paid: bigint; previewed: bigint; tx: string; block: number };

export type RewardClaims = {
  claims: RewardClaim[];
  /** Every claimed epoch, as the preview gives it. */
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
  const address = await c.css.getAddress();
  const claimedTopic = c.css.getEvent('LastClaimedEpochUpdated').fragment.topicHash;
  const paidTopic = c.css.getEvent('CumulativeRewardsClaimedUpdated').fragment.topicHash;
  const tokenTopic = ethers.toBeHex(o.tokenId, 32);
  const head = await provider.getBlockNumber();
  const logs = [];
  for (let from = o.fromBlock; from <= head; from += LOG_PAGE) {
    logs.push(...(await provider.getLogs({ address, topics: [[claimedTopic, paidTopic], tokenTopic], fromBlock: from, toBlock: Math.min(from + LOG_PAGE - 1, head) })));
  }

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
    const preview = await claimPreview(c, o.tokenId, o.node, from, cursor.epoch, raw);
    const paid = paidIn.get(cursor.tx) ?? 0n;
    claims.push({ from, to: cursor.epoch, paid, previewed: preview.total, tx: cursor.tx, block: cursor.block });
    per.push(...preview.per);
    raw += paid;
    from = cursor.epoch + 1n;
  }
  return { claims, per, total: raw - o.stakeRaw, through: from - 1n };
}
