// SPDX-License-Identifier: Apache-2.0

/**
 * The buyer's router (OT-RFC-27): which seller serves a call, per service.
 *   1. Candidates: the epoch's offers at or under the budget's price cap, from
 *      sellers in the sharding table.
 *   2. Order: pinned sellers, then price, then this node's measured latency.
 *   3. Quotes from the first three, kept five minutes.
 *   4. It stays with the seller that answered, so each seller gets one run of
 *      nonces, and moves on when a seller is unreachable, for ten minutes, or
 *      returns a receipt that fails the buyer's checks, for the rest of the epoch.
 *
 * How a seller's identity becomes a peer to dial is `SellerPeers`, one
 * interface: the node has no lookup yet, so it routes to no one.
 */
import type { MarketplaceChainAdapter } from '@origintrail-official/dkg-chain';
import type { Offer } from './offers.js';
import type { QuoteResponse } from './wire.js';

/** The peer to dial for a seller's identity, or `null` when it is not known. */
export interface SellerPeers {
  peerOf(identityId: bigint): Promise<string | null>;
}

/** No lookup: every seller is unknown, so the gateway answers `no_seller`. */
export const NO_SELLER_PEERS: SellerPeers = { peerOf: async () => null };

export const QUOTE_TTL_MS = 5 * 60_000;
export const UNREACHABLE_MS = 10 * 60_000;
const QUOTED_CANDIDATES = 3;

export interface Route {
  seller: bigint;
  peerId: string;
  pricePerUnit: bigint;
}

export interface RouterDeps {
  chain: Pick<MarketplaceChainAdapter, 'isShardingTableMember'>;
  /** The offers of the given epochs, from the Marketplace Context Graph. */
  offers(epochs: number[]): Promise<Offer[]>;
  quote(peerId: string, services: string[]): Promise<QuoteResponse>;
  peers: SellerPeers;
  /** Sellers tried first for a service: the standing plan's pinned seller. */
  pinned?: (serviceId: string) => Promise<readonly bigint[]>;
  /** Milliseconds. */
  clock?: () => number;
}

export class Router {
  private readonly quotes = new Map<string, { at: number; quote: QuoteResponse }>();
  private readonly sticky = new Map<string, bigint>();
  private readonly unreachableUntil = new Map<string, number>();
  private readonly failedIn = new Map<string, number>();
  private readonly latency = new Map<string, number>();
  private readonly clock: () => number;

  constructor(private readonly deps: RouterDeps) {
    this.clock = deps.clock ?? Date.now;
  }

  /** The seller for a call to `serviceId` in `epoch`, under `maxPricePerUnit`; `null` when none can serve it. */
  async pick(serviceId: string, epoch: number, maxPricePerUnit: bigint): Promise<Route | null> {
    const now = this.clock();
    const pinned = (await this.deps.pinned?.(serviceId)) ?? [];
    const offers = (await this.deps.offers([epoch])).filter((o) =>
      o.serviceId === serviceId && o.epoch === epoch && o.pricePerUnit <= maxPricePerUnit
      && this.failedIn.get(o.seller.toString()) !== epoch
      && (this.unreachableUntil.get(o.seller.toString()) ?? 0) <= now);
    const candidates: Offer[] = [];
    for (const o of offers) {
      if (!candidates.some((c) => c.seller === o.seller) && await this.deps.chain.isShardingTableMember(o.seller)) candidates.push(o);
    }
    const rank = (o: Offer) => [
      o.seller === this.sticky.get(serviceId) ? 0 : 1,
      pinned.includes(o.seller) ? 0 : 1,
    ];
    candidates.sort((a, b) => {
      const [ra, rb] = [rank(a), rank(b)];
      if (ra[0] !== rb[0]) return ra[0]! - rb[0]!;
      if (ra[1] !== rb[1]) return ra[1]! - rb[1]!;
      if (a.pricePerUnit !== b.pricePerUnit) return a.pricePerUnit < b.pricePerUnit ? -1 : 1;
      return (this.latency.get(a.seller.toString()) ?? Infinity) - (this.latency.get(b.seller.toString()) ?? Infinity);
    });
    for (const offer of candidates.slice(0, QUOTED_CANDIDATES)) {
      const peerId = await this.deps.peers.peerOf(offer.seller);
      if (!peerId) continue;
      const quote = await this.quoteOf(offer.seller, peerId, serviceId, now);
      const quoted = quote?.offers.find((q) => q.serviceId === serviceId);
      if (!quote || quote.epoch !== epoch || !quoted?.available || BigInt(quoted.pricePerUnit) > maxPricePerUnit) continue;
      this.sticky.set(serviceId, offer.seller);
      return { seller: offer.seller, peerId, pricePerUnit: BigInt(quoted.pricePerUnit) };
    }
    return null;
  }

  /** A seller that did not answer: left out for ten minutes. */
  unreachable(seller: bigint): void {
    this.unreachableUntil.set(seller.toString(), this.clock() + UNREACHABLE_MS);
    this.forget(seller);
  }

  /** A seller whose receipt failed the checks: left out for the rest of `epoch`. */
  failed(seller: bigint, epoch: number): void {
    this.failedIn.set(seller.toString(), epoch);
    this.forget(seller);
  }

  /** A quote that no longer holds: the next call asks again. */
  requote(seller: bigint): void {
    for (const key of this.quotes.keys()) if (key.startsWith(`${seller}:`)) this.quotes.delete(key);
  }

  /** How long a call to the seller took, in milliseconds. */
  measured(seller: bigint, ms: number): void {
    const before = this.latency.get(seller.toString());
    this.latency.set(seller.toString(), before === undefined ? ms : (before * 3 + ms) / 4);
  }

  private async quoteOf(seller: bigint, peerId: string, serviceId: string, now: number): Promise<QuoteResponse | null> {
    const key = `${seller}:${serviceId}`;
    const kept = this.quotes.get(key);
    if (kept && now - kept.at < QUOTE_TTL_MS) return kept.quote;
    try {
      const quote = await this.deps.quote(peerId, [serviceId]);
      if (quote.seller !== seller.toString()) return null;
      this.quotes.set(key, { at: now, quote });
      return quote;
    } catch {
      this.unreachable(seller);
      return null;
    }
  }

  private forget(seller: bigint): void {
    this.requote(seller);
    for (const [service, s] of this.sticky) if (s === seller) this.sticky.delete(service);
  }
}
