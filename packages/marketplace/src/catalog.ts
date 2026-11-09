// SPDX-License-Identifier: Apache-2.0

/**
 * What the node API's catalog routes return, in the shapes of the UI data
 * contract: this epoch's services, from the offers the node reads out of the
 * Marketplace Context Graph that their sellers signed (the router keeps no
 * others), of sellers in the sharding table (`Service`,
 * `Offer`); one service with a row per seller (`ServiceDetail`); and one
 * seller's storefront (`Seller`), with its served value per epoch from the
 * chain. A seller's availability is its last quote's, and its latency this
 * node's own. No Model KA is published yet, so a service's label is its
 * model's URN, and its family, modality, context length and logo are left
 * out. Amounts are decimal strings of wei with `…Trac` siblings.
 */
import { SERVICE_CLASS_QUERY, subscriptionIdOf } from '@origintrail-official/dkg-chain';
import { MarketplaceRefusal } from './buyer.js';
import type { Gateway } from './gateway.js';
import type { Offer } from './offers.js';
import { gateView } from './operate.js';
import { amount } from './views.js';

/** How many epochs a storefront shows: the current one and those before it. */
const RECENT_EPOCHS = 6;

/** This epoch's offers, one per seller and service, and the next epoch's by the same key. */
interface Offers {
  epoch: number;
  current: Offer[];
  next: Map<string, Offer>;
}

const offerKey = (o: { seller: bigint; serviceId: string }) => `${o.seller}:${o.serviceId}`;

/** This and the next epoch's offers of sellers in the sharding table: the router keeps one per seller, service and epoch, the newest. */
async function offersNow(gateway: Gateway): Promise<Offers> {
  const { epoch } = await gateway.chain.getEpochTimes();
  const members = new Map<bigint, boolean>();
  const current = new Map<string, Offer>();
  const next = new Map<string, Offer>();
  for (const o of await gateway.router.offersOf([epoch, epoch + 1])) {
    if (!members.has(o.seller)) members.set(o.seller, await gateway.chain.isShardingTableMember(o.seller));
    if (!members.get(o.seller)) continue;
    if (o.epoch === epoch) current.set(offerKey(o), o);
    else if (o.epoch === epoch + 1) next.set(offerKey(o), o);
  }
  return { epoch, current: [...current.values()], next };
}

function offerView(gateway: Gateway, offers: Offers, o: Offer) {
  const quote = gateway.router.lastQuote(o.seller, o.serviceId);
  const next = offers.next.get(offerKey(o));
  return {
    serviceId: o.serviceId,
    seller: Number(o.seller),
    epoch: o.epoch,
    unit: o.unit,
    ...amount('pricePerUnit', o.pricePerUnit),
    ...(next ? amount('nextPricePerUnit', next.pricePerUnit) : {}),
    provenance: o.provenance,
    available: quote ? quote.available : null,
    ...(quote ? { quotedAt: quote.at } : {}),
    measured: { latencyMs: gateway.router.latencyOf(o.seller), tokensPerSecond: null },
  };
}

/** What this epoch's subscription has left for each service it funds, less the receipts the node holds. */
async function coveredNow(gateway: Gateway, epoch: number): Promise<Map<string, bigint>> {
  const chain = gateway.chain;
  const subscriptionId = subscriptionIdOf(gateway.buyerWallet, epoch);
  const covered = new Map<string, bigint>();
  if (!(await chain.subscriptionExists(subscriptionId))) return covered;
  for (const [budgetIndex, b] of (await chain.getBudgets(subscriptionId)).entries()) {
    const left = (await chain.budgetLeft(subscriptionId, budgetIndex)) - gateway.heldValue(subscriptionId, budgetIndex);
    covered.set(b.serviceId.toLowerCase(), left > 0n ? left : 0n);
  }
  return covered;
}

/** One service's card: its offers, cheapest first, their price range, and what the subscription has left for it. */
function serviceView(gateway: Gateway, offers: Offers, serviceId: string, covered: Map<string, bigint>) {
  const own = offers.current
    .filter((o) => o.serviceId === serviceId)
    .sort((a, b) => (a.pricePerUnit < b.pricePerUnit ? -1 : a.pricePerUnit > b.pricePerUnit ? 1 : Number(a.seller - b.seller)));
  const left = covered.get(serviceId);
  return {
    serviceId,
    serviceClass: own[0]!.serviceClass === SERVICE_CLASS_QUERY ? 'query' : 'inference',
    label: own[0]!.model,
    offers: own.map((o) => offerView(gateway, offers, o)),
    ...amount('priceMin', own[0]!.pricePerUnit),
    ...amount('priceMax', own[own.length - 1]!.pricePerUnit),
    ...(left !== undefined ? { covered: amount('left', left) } : {}),
  };
}

/** The catalog (`GET /catalog`): this epoch's services and the reference rate. */
export async function catalogView(gateway: Gateway) {
  const offers = await offersNow(gateway);
  const covered = await coveredNow(gateway, offers.epoch);
  const ids = [...new Set(offers.current.map((o) => o.serviceId))].sort();
  return { epoch: offers.epoch, fx: gateway.fx, services: ids.map((id) => serviceView(gateway, offers, id, covered)) };
}

/** One service (`GET /services/{serviceId}`): its card, the reference rate, and each seller's storefront. */
export async function serviceDetailView(gateway: Gateway, serviceId: string) {
  const offers = await offersNow(gateway);
  const id = serviceId.toLowerCase();
  if (!offers.current.some((o) => o.serviceId === id)) throw new MarketplaceRefusal('ServiceNotFound', [serviceId]);
  const service = serviceView(gateway, offers, id, await coveredNow(gateway, offers.epoch));
  const sellers = [...new Set(service.offers.map((o) => BigInt(o.seller)))];
  return { ...service, fx: gateway.fx, sellers: await Promise.all(sellers.map((s) => storefront(gateway, offers, s))) };
}

/** One seller (`GET /sellers/{identityId}`); refused for an identity with no profile and no offers. */
export async function sellerView(gateway: Gateway, identityId: bigint) {
  const view = await storefront(gateway, await offersNow(gateway), identityId);
  if (!view.gate.profile && view.offers.length === 0) throw new MarketplaceRefusal('SellerNotFound', [identityId.toString()]);
  return view;
}

/** A seller's gate, stake factor, availability by its last quotes, offers, and served value in recent epochs, newest first. */
async function storefront(gateway: Gateway, offers: Offers, identityId: bigint) {
  const chain = gateway.chain;
  const own = offers.current.filter((o) => o.seller === identityId);
  const { activationEpoch } = await chain.batchState();
  const first = Math.max(activationEpoch || offers.epoch, offers.epoch - RECENT_EPOCHS + 1);
  const epochs = Array.from({ length: Math.max(0, offers.epoch - first + 1) }, (_, i) => offers.epoch - i);
  const [gate, stakeFactor18, recent] = await Promise.all([
    gateView(chain, identityId),
    chain.stakeFactor(identityId),
    Promise.all(epochs.map(async (epoch) => {
      const node = await chain.getNodeEpoch(identityId, epoch);
      return { epoch, ...amount('servedValue', node.servedValue), ...amount('weightedValue', node.weightedValue) };
    })),
  ]);
  const quotes = own.map((o) => gateway.router.lastQuote(identityId, o.serviceId)).filter((q) => q !== undefined);
  return {
    identityId: Number(identityId),
    gate,
    stakeFactor18: stakeFactor18.toString(),
    available: quotes.length === 0 ? null : quotes.some((q) => q.available),
    offers: own.map((o) => offerView(gateway, offers, o)),
    recent,
  };
}
