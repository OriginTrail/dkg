// SPDX-License-Identifier: Apache-2.0

/**
 * The buyer's router (OT-RFC-27): which seller serves a call, per service.
 *   1. Candidates: the epoch's offers at or under the budget's price cap, from
 *      sellers in the sharding table.
 *   2. Order: pinned sellers, then price, then this node's measured latency.
 *   3. Quotes from the first three, kept five minutes, and only for their own
 *      epoch, each from the peer its offer names, which must answer as the
 *      offer's seller. A quote that does not read as one
 *      (`quoteResponseFromWire`) counts as no answer.
 *   A call with tools goes only to a seller whose quote says it takes tool
 *   calls for the service. A pick knows of each seller whether it can serve
 *   now and whether it takes tools, each yes, no or not known (`Outcome`):
 *   a seller whose kept quote says it takes none is known so and not searched;
 *   one that answers that it serves but takes none uses up no place of the
 *   three; and the pick asks at most `QUOTES_PER_PICK` new quotes. With no
 *   route, it says none takes tools (`tools_unsupported`) only when a seller
 *   serves but takes none and every seller is known to take none; a seller it
 *   did not read, or one that cannot serve now but may take them (unreachable,
 *   now or in the ten minutes after, or saying it takes them), makes it a pick
 *   with no route for now (`no_seller`).
 *   4. It stays with the seller that answered, so each seller gets one run of
 *      nonces, and moves on when a seller is unreachable, for ten minutes, or
 *      returns a receipt that fails the buyer's checks, for the rest of the epoch.
 *      A seller that refuses a call for good (a refusal not to retry) goes to
 *      the back of the order for ten minutes: tried only when no other can serve.
 *
 * Every offer the buyer reads comes through `offersOf`, from the Marketplace
 * Context Graph's Verifiable Memory, which keeps only those the chain says an
 * operational wallet of their seller signed: the wallet's identity is
 * `IdentityStorage.getIdentityId`, the read the settlement makes of a batch's
 * sender. The chain's answer for a wallet is kept five minutes; a read that
 * fails keeps nothing, and its offers are left out until the chain answers.
 * Of a seller's offers for one service it keeps the newest of those, by
 * `signedAt`, and only then reads what that one says of each epoch: none once
 * it is withdrawn or past its last epoch, so an older copy never brings an
 * offer back.
 */
import type { MarketplaceChainAdapter, MarketplaceDomain } from '@origintrail-official/dkg-chain';
import { offerIn, serviceOfferSignerOf, type Offer, type ServiceOffer } from './offers.js';
import { quoteResponseFromWire, type QuoteResponse } from './wire.js';

export const QUOTE_TTL_MS = 5 * 60_000;
export const UNREACHABLE_MS = 10 * 60_000;
/** How long the chain's answer of which identity a wallet signs for is kept. */
export const SIGNER_TTL_MS = 5 * 60_000;
const QUOTED_CANDIDATES = 3;
/**
 * The most new quotes one pick asks for; kept quotes it reads for nothing. A call with tools reads on past sellers that
 * serve but take none, which use up none of the `QUOTED_CANDIDATES` places, up to this many.
 */
export const QUOTES_PER_PICK = 12;

/** Whether something is so of a seller, as far as a pick knows. */
type Known = 'yes' | 'no' | 'unknown';

/** What a pick knows of one seller: whether it can serve the call now (at its quoted price), and whether it takes tools. */
interface Outcome {
  serves: Known;
  tools: Known;
  pricePerUnit?: bigint;
}

/** A seller the pick did not read: nothing is known of it. */
const UNREAD: Outcome = { serves: 'unknown', tools: 'unknown' };
/** A seller held out for ten minutes after it did not answer: it cannot serve now, and may take tools. */
const COOLING: Outcome = { serves: 'no', tools: 'unknown' };

export interface Route {
  seller: bigint;
  peerId: string;
  pricePerUnit: bigint;
}

/** What a call needs of its seller beyond the service: that it take tool calls. */
export interface RouteNeeds {
  tools?: boolean;
}

/** A pick: a route, or why there is none: no seller serves now, or none of those that do takes tool calls. */
export type RoutePick = { route: Route } | { route: null; reason: 'no_seller' | 'tools_unsupported' };

export interface RouterDeps {
  chain: Pick<MarketplaceChainAdapter, 'getMarketplaceContracts' | 'getIdentityIdForAddress' | 'isShardingTableMember'>;
  /** The offers in the Marketplace Context Graph's Verifiable Memory, their signatures not checked. */
  offers(): Promise<ServiceOffer[]>;
  /** A seller's answer to `quote`, as it came: the router reads it with `quoteResponseFromWire`. */
  quote(peerId: string, services: string[]): Promise<unknown>;
  /** Sellers tried first for a service: the standing plan's pinned seller. */
  pinned?: (serviceId: string) => Promise<readonly bigint[]>;
  /** Milliseconds. */
  clock?: () => number;
}

export class Router {
  private readonly quotes = new Map<string, { at: number; quote: QuoteResponse }>();
  private readonly sticky = new Map<string, bigint>();
  private readonly unreachableUntil = new Map<string, number>();
  private readonly demotedUntil = new Map<string, number>();
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
  async pick(serviceId: string, epoch: number, maxPricePerUnit: bigint, needs: RouteNeeds = {}): Promise<Route | null> {
    return (await this.pickFor(serviceId, epoch, maxPricePerUnit, needs)).route;
  }

  /**
   * As `pick`, with why there is no route when there is none. Each seller's `Outcome` is what the pick learned of
   * it: from a kept quote, a new one, or nothing; the route is the first, in order, that serves and takes the call,
   * and the reason for none comes from all of them.
   */
  async pickFor(serviceId: string, epoch: number, maxPricePerUnit: bigint, needs: RouteNeeds = {}): Promise<RoutePick> {
    const now = this.clock();
    const pinned = (await this.deps.pinned?.(serviceId)) ?? [];
    const outcomes: Outcome[] = [];
    const searched: Offer[] = [];
    const offers = (await this.offersOf([epoch])).filter((o) =>
      o.serviceId === serviceId && o.epoch === epoch && o.pricePerUnit <= maxPricePerUnit && this.failedIn.get(o.seller.toString()) !== epoch);
    for (const o of offers) {
      if ((this.unreachableUntil.get(o.seller.toString()) ?? 0) > now) {
        outcomes.push(COOLING);
        continue;
      }
      if (!(await this.deps.chain.isShardingTableMember(o.seller))) continue;
      // A call with tools does not search a seller whose kept quote says it takes none: that quote is what it knows.
      const kept = needs.tools ? this.keptQuote(o.seller, serviceId, epoch, now) : undefined;
      const known = kept && outcomeOf(kept, serviceId, epoch, maxPricePerUnit);
      if (known && known.tools !== 'yes') outcomes.push(known);
      else searched.push(o);
    }
    const rank = (o: Offer) => [
      (this.demotedUntil.get(o.seller.toString()) ?? 0) > now ? 1 : 0,
      o.seller === this.sticky.get(serviceId) ? 0 : 1,
      pinned.includes(o.seller) ? 0 : 1,
    ];
    searched.sort((a, b) => {
      const [ra, rb] = [rank(a), rank(b)];
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
      if (a.pricePerUnit !== b.pricePerUnit) return a.pricePerUnit < b.pricePerUnit ? -1 : 1;
      return (this.latency.get(a.seller.toString()) ?? Infinity) - (this.latency.get(b.seller.toString()) ?? Infinity);
    });
    // `places`: sellers read that could not serve, of the three; `asked`: new quotes, of `QUOTES_PER_PICK`.
    let places = 0;
    let asked = 0;
    for (const offer of searched) {
      const kept = this.keptQuote(offer.seller, serviceId, epoch, now);
      if (places >= QUOTED_CANDIDATES || (!kept && asked >= QUOTES_PER_PICK)) {
        outcomes.push(UNREAD);
        continue;
      }
      if (!kept) asked += 1;
      const outcome = outcomeOf(kept ?? await this.quoteOf(offer.seller, offer.peerId, serviceId, epoch, now), serviceId, epoch, maxPricePerUnit);
      outcomes.push(outcome);
      if (outcome.serves === 'yes' && (!needs.tools || outcome.tools === 'yes')) {
        this.sticky.set(serviceId, offer.seller);
        return { route: { seller: offer.seller, peerId: offer.peerId, pricePerUnit: outcome.pricePerUnit! } };
      }
      // One that serves but takes no tools uses up no place: a call with tools reads on for one that does.
      if (outcome.serves !== 'yes') places += 1;
    }
    return { route: null, reason: needs.tools && toolsUnsupported(outcomes) ? 'tools_unsupported' : 'no_seller' };
  }

  /** A seller that did not answer: left out for ten minutes. */
  unreachable(seller: bigint): void {
    this.unreachableUntil.set(seller.toString(), this.clock() + UNREACHABLE_MS);
    this.forget(seller);
  }

  /** A seller that refused a call for good: behind every other seller for ten minutes, and no longer the one it stays with. */
  demote(seller: bigint): void {
    this.demotedUntil.set(seller.toString(), this.clock() + UNREACHABLE_MS);
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

  /**
   * What the offers an operational wallet of their seller signed, as the chain says now, say of `epochs`: per
   * seller and service, the newest such offer, for each of those epochs it prices. Newest first, a tie broken by
   * the signature, the first that holds is kept, so an offer someone else signed never hides the seller's own.
   */
  async offersOf(epochs: number[]): Promise<Offer[]> {
    const offers = await this.deps.offers();
    this.domain ??= (await this.deps.chain.getMarketplaceContracts()).requestDomain;
    const now = this.clock();
    for (const [wallet, read] of this.signers) if (now - read.at >= SIGNER_TTL_MS) this.signers.delete(wallet);
    const kept = new Map<string, ServiceOffer>();
    for (const offer of [...offers].sort((a, b) => b.signedAt - a.signedAt || b.signature.localeCompare(a.signature))) {
      const key = `${offer.seller}:${offer.serviceId}`;
      if (kept.has(key)) continue;
      const signer = serviceOfferSignerOf(this.domain, offer);
      if (signer && (await this.identityOf(signer, now)) === offer.seller) kept.set(key, offer);
    }
    return [...kept.values()].flatMap((offer) => epochs.map((epoch) => offerIn(offer, epoch)).filter((o): o is Offer => o !== null));
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

  /** The seller's quote for `serviceId` in `epoch`: the one kept, while it is for that epoch and within its five minutes, or a new one. */
  private async quoteOf(seller: bigint, peerId: string, serviceId: string, epoch: number, now: number): Promise<QuoteResponse | null> {
    const key = `${seller}:${serviceId}`;
    const kept = this.keptQuote(seller, serviceId, epoch, now);
    if (kept) return kept;
    try {
      // A quote that does not read as one counts as no answer.
      const quote = quoteResponseFromWire(await this.deps.quote(peerId, [serviceId]));
      if (quote.seller !== seller.toString()) return null;
      this.quotes.set(key, { at: now, quote });
      return quote;
    } catch {
      this.unreachable(seller);
      return null;
    }
  }

  /** The quote kept from `seller` for `serviceId`, while it is for `epoch` and within its five minutes. */
  private keptQuote(seller: bigint, serviceId: string, epoch: number, now: number): QuoteResponse | undefined {
    const kept = this.quotes.get(`${seller}:${serviceId}`);
    return kept && kept.quote.epoch === epoch && now - kept.at < QUOTE_TTL_MS ? kept.quote : undefined;
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

/**
 * What a quote says of a seller for a call: it serves when it is for the epoch and offers the service, available, at
 * or under the price cap; it takes tools when its offer says so. No quote, or one for another epoch, says nothing of
 * its tools.
 */
function outcomeOf(quote: QuoteResponse | null, serviceId: string, epoch: number, maxPricePerUnit: bigint): Outcome {
  if (!quote || quote.epoch !== epoch) return { serves: 'no', tools: 'unknown' };
  const quoted = quote.offers.find((q) => q.serviceId === serviceId);
  const tools: Known = quoted?.tools === true ? 'yes' : 'no';
  if (!quoted?.available || BigInt(quoted.pricePerUnit) > maxPricePerUnit) return { serves: 'no', tools };
  return { serves: 'yes', tools, pricePerUnit: BigInt(quoted.pricePerUnit) };
}

/** Whether no seller takes tools, for certain: one serves without them, and every seller is known to take none. */
function toolsUnsupported(outcomes: readonly Outcome[]): boolean {
  return outcomes.some((o) => o.serves === 'yes') && outcomes.every((o) => o.tools === 'no');
}
