// SPDX-License-Identifier: Apache-2.0

/**
 * The buyer's router (OT-RFC-27): which seller serves a call, per service.
 *   1. Candidates: the epoch's offers at or under the budget's price cap, from
 *      sellers in the sharding table.
 *   2. Order: pinned sellers, then price, then this node's measured latency.
 *   3. Quotes from the first three, kept five minutes, each from the peer its
 *      offer names, which must answer as the offer's seller.
 *   4. It stays with the seller that answered, so each seller gets one run of
 *      nonces, and moves on when a seller is unreachable, for ten minutes, or
 *      returns a receipt that fails the buyer's checks, for the rest of the epoch.
 *
 * Every offer the buyer reads comes through `offersOf`, which keeps only
 * those the chain says an operational wallet of their seller signed: the
 * wallet's identity is `IdentityStorage.getIdentityId`, the read the
 * settlement makes of a batch's sender. The chain's answer for a wallet is
 * kept five minutes; a read that fails keeps nothing, and its offers are left
 * out until the chain answers.
 */
import type { MarketplaceChainAdapter, MarketplaceDomain } from '@origintrail-official/dkg-chain';
import { offerSignerOf, type Offer } from './offers.js';
import type { QuoteResponse } from './wire.js';

export const QUOTE_TTL_MS = 5 * 60_000;
export const UNREACHABLE_MS = 10 * 60_000;
/** How long the chain's answer of which identity a wallet signs for is kept. */
export const SIGNER_TTL_MS = 5 * 60_000;
const QUOTED_CANDIDATES = 3;

export interface Route {
  seller: bigint;
  peerId: string;
  pricePerUnit: bigint;
}

export interface RouterDeps {
  chain: Pick<MarketplaceChainAdapter, 'getMarketplaceContracts' | 'getIdentityIdForAddress' | 'isShardingTableMember'>;
  /** The offers of the given epochs, from the Marketplace Context Graph, their signatures not checked. */
  offers(epochs: number[]): Promise<Offer[]>;
  quote(peerId: string, services: string[]): Promise<QuoteResponse>;
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
  /** wallet => the identity the chain says it signs for, and when that was read. */
  private readonly signers = new Map<string, { identityId: bigint; at: number }>();
  private domain: MarketplaceDomain | undefined;
  private readonly clock: () => number;

  constructor(private readonly deps: RouterDeps) {
    this.clock = deps.clock ?? Date.now;
  }

  /** The seller for a call to `serviceId` in `epoch`, under `maxPricePerUnit`; `null` when none can serve it. */
  async pick(serviceId: string, epoch: number, maxPricePerUnit: bigint): Promise<Route | null> {
    const now = this.clock();
    const pinned = (await this.deps.pinned?.(serviceId)) ?? [];
    const offers = (await this.offersOf([epoch])).filter((o) =>
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
      const quote = await this.quoteOf(offer.seller, offer.peerId, serviceId, now);
      const quoted = quote?.offers.find((q) => q.serviceId === serviceId);
      if (!quote || quote.epoch !== epoch || !quoted?.available || BigInt(quoted.pricePerUnit) > maxPricePerUnit) continue;
      this.sticky.set(serviceId, offer.seller);
      return { seller: offer.seller, peerId: offer.peerId, pricePerUnit: BigInt(quoted.pricePerUnit) };
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

  /** The offers of `epochs` that an operational wallet of their seller signed, as the chain says now. */
  async offersOf(epochs: number[]): Promise<Offer[]> {
    const offers = await this.deps.offers(epochs);
    this.domain ??= (await this.deps.chain.getMarketplaceContracts()).requestDomain;
    const now = this.clock();
    for (const [wallet, read] of this.signers) if (now - read.at >= SIGNER_TTL_MS) this.signers.delete(wallet);
    const signed: Offer[] = [];
    for (const offer of offers) {
      const signer = offerSignerOf(this.domain, offer);
      if (signer && (await this.identityOf(signer, now)) === offer.seller) signed.push(offer);
    }
    return signed;
  }

  /** What the last quote from `seller` said of `serviceId`, and when it came, in seconds; `undefined` while none has. */
  lastQuote(seller: bigint, serviceId: string): { available: boolean; at: number } | undefined {
    const kept = this.quotes.get(`${seller}:${serviceId}`);
    if (!kept) return undefined;
    return { available: kept.quote.offers.find((o) => o.serviceId === serviceId)?.available ?? false, at: Math.floor(kept.at / 1_000) };
  }

  /** This node's measured time for a call to `seller`, in milliseconds; `null` before its first call. */
  latencyOf(seller: bigint): number | null {
    return this.latency.get(seller.toString()) ?? null;
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

  /** The identity `wallet` is an operational wallet of (0 for none), kept from the last read; `undefined` while the chain cannot say. */
  private async identityOf(wallet: string, now: number): Promise<bigint | undefined> {
    const kept = this.signers.get(wallet);
    if (kept) return kept.identityId;
    try {
      const identityId = await this.deps.chain.getIdentityIdForAddress(wallet);
      this.signers.set(wallet, { identityId, at: now });
      return identityId;
    } catch {
      return undefined;
    }
  }
}
