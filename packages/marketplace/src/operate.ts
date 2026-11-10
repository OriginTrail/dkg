// SPDX-License-Identifier: Apache-2.0

/**
 * What the node API's seller routes return, in the shapes of the UI data
 * contract (`SellerStatus`, `Offering`, `Batch`): the epoch and its times, the
 * Core Node gate, whether the node has proved this epoch, its operational
 * wallets' ETH, its offerings with their backends' state and this and the next
 * epoch's prices, this epoch's ledger and next landing, its recent batches,
 * its served value and the pool so far, and each ended epoch's pool and gross.
 * Beside the shape, `lastLanding` says what the last landing tick did, and each
 * offering's `listing` whether its offer is listed and why not. Amounts
 * are decimal strings of wei with `…Trac` siblings (`…Ether` for ETH); times
 * are chain seconds.
 */
import type { MarketplaceChainAdapter } from '@origintrail-official/dkg-chain';
import { MarketplaceRefusal } from './buyer.js';
import type { LandingReport } from './landing.js';
import type { BatchRecord } from './ledger.js';
import type { Seller } from './seller.js';
import { amount } from './views.js';

/** How many landed batches Operate lists, and how many ended epochs. */
const RECENT_BATCHES = 50;
const ENDED_EPOCHS = 6;

/** A node's Core Node gate (`Gate`): its profile, its place in the sharding table, and its stake against the minimum. */
export async function gateView(chain: MarketplaceChainAdapter, identityId: bigint) {
  const minimumStake = await chain.getMinimumStake();
  if (identityId <= 0n) return { profile: false, shardingTable: false, ...amount('stake', 0n), ...amount('minimumStake', minimumStake) };
  const [profile, shardingTable, stake] = await Promise.all([
    chain.profileExists(identityId),
    chain.isShardingTableMember(identityId),
    chain.getNodeStake(identityId),
  ]);
  return { profile, shardingTable, ...amount('stake', stake), ...amount('minimumStake', minimumStake) };
}

/** A batch that landed (`Batch`): its transaction, when it was sent, its receipts, value, counted part and gas. */
export function batchView(b: BatchRecord) {
  return {
    tx: b.txHash ?? b.hashes[b.hashes.length - 1]!,
    at: b.at,
    items: b.items,
    ...amount('value', BigInt(b.value ?? '0')),
    ...amount('counted', BigInt(b.counted ?? '0')),
    gasUsed: Number(b.gasUsed ?? '0'),
  };
}

/** What a landing tick did: why it stopped, or the batches it landed. */
export function landingView(report: LandingReport) {
  if ('stopped' in report) return { stopped: report.stopped };
  return {
    sent: report.sent.map((b) => ({ txHash: b.txHash, items: b.items, ...amount('value', b.value), ...amount('counted', b.counted) })),
    refused: report.refused,
    waiting: report.waiting,
  };
}

/**
 * One of the seller's services (`Offering`): its backend's state, this and the next epoch's price, and its offer
 * in Verifiable Memory (`listing`: listed or not, its asset and last epoch, and why a run failed); `null` without one.
 */
export async function offeringView(seller: Seller, serviceId: string) {
  const { price, nextPrice } = await seller.pricesOf(serviceId);
  const listing = seller.offers ? seller.offers.listingOf(serviceId, (await seller.chain.getEpochTimes()).epoch) : null;
  return { serviceId: serviceId.toLowerCase(), connector: seller.backendOf(serviceId), ...amount('price', price), ...amount('nextPrice', nextPrice), listing };
}

/** Operate (`SellerStatus`), with the last landing tick's report beside it. */
export async function sellerStatusView(seller: Seller) {
  const chain = seller.chain;
  const [times, identityId] = await Promise.all([chain.getEpochTimes(), chain.getIdentityId()]);
  const proved = identityId > 0n;
  const [gate, score, wallets, offerings, node, pool] = await Promise.all([
    gateView(chain, identityId),
    proved ? chain.getNodeEpochScore(times.epoch, identityId) : 0n,
    Promise.all(seller.wallets.map(async (address) => ({ address, ...amount('eth', (await chain.getWalletBalances(address)).eth, 'Ether') }))),
    Promise.all([...seller.services.keys()].map((serviceId) => offeringView(seller, serviceId))),
    proved ? chain.getNodeEpoch(identityId, times.epoch) : { servedValue: 0n, weightedValue: 0n },
    chain.epochPool(times.epoch),
  ]);
  const { summary } = seller.ledger.epochReport(times.epoch);
  const endedEpochs = seller.ledger.epochs().filter((e) => e < times.epoch).slice(-ENDED_EPOCHS).reverse();
  const ended = await Promise.all(endedEpochs.map(async (epoch) => ({
    epoch,
    ...amount('pool', await chain.epochPool(epoch)),
    ...amount('gross', proved ? await chain.queryInferenceGross(epoch, identityId) : 0n),
  })));
  return {
    identityId: Number(identityId),
    epoch: times.epoch,
    startsAt: times.startsAt,
    endsAt: times.endsAt,
    gate,
    scoredThisEpoch: score > 0n,
    wallets,
    offerings,
    ledger: {
      ...summary.counts,
      ...amount('heldValue', BigInt(summary.heldValue)),
      ...amount('landedValue', BigInt(summary.landedValue)),
      ...amount('counted', BigInt(summary.counted)),
    },
    nextLandingAt: seller.nextLandingAt(times),
    batches: seller.ledger.landedBatches(RECENT_BATCHES).map(batchView),
    thisEpoch: { ...amount('servedValue', node.servedValue), ...amount('weightedValue', node.weightedValue), ...amount('poolSoFar', pool) },
    ended,
    lastLanding: seller.lastLanding ? landingView(seller.lastLanding) : null,
  };
}

/** Land now: the batches that landed, and, when none did, why. */
export async function landNowView(seller: Seller) {
  const report = await seller.landNow();
  if ('stopped' in report) return { batches: [], stopped: report.stopped };
  const batches = report.sent.map((b) => seller.ledger.batch(b.batchId)).filter((b): b is BatchRecord => b !== undefined).map(batchView);
  return { batches, refused: report.refused, waiting: report.waiting };
}

/** Set a service's price for the next epoch, in wei per unit: the offering as it stands then. */
export async function setNextPriceView(seller: Seller, serviceId: string, price: bigint) {
  if (!seller.services.has(serviceId.toLowerCase())) throw new MarketplaceRefusal('ServiceNotFound', [serviceId]);
  await seller.setNextPrice(serviceId, price);
  return offeringView(seller, serviceId);
}
