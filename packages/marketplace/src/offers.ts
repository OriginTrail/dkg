// SPDX-License-Identifier: Apache-2.0

/**
 * Offers (OT-RFC-27): what a seller publishes in the Marketplace Context
 * Graph's Verifiable Memory, and how a buyer reads them.
 *
 * A seller has one Knowledge Asset per service, `offer-<serviceId>`, holding
 * its `ServiceOffer`: the seller's identity, the service, its class and unit,
 * the model it serves by its URN, with the model's provenance and tokenizer,
 * the capacity, the node's libp2p peer id, which buyers dial, the price
 * schedule, the last epoch the asset is stored through (`validUntilEpoch`),
 * and whether it is withdrawn. `serviceId` is keccak256 of the model's URN, so
 * every seller of one model serves one budget. The model's own Knowledge Asset
 * is not written by sellers: an offer refers to it. When anything in the offer
 * changes, the seller publishes the asset again: an update, under the same id.
 *
 * **The price schedule.** `pricePerUnit` applies from `priceEpoch` on, and
 * `nextPricePerUnit`, when set, from the epoch after it on. An offer prices no
 * epoch before `priceEpoch` or after `validUntilEpoch`, and none once
 * withdrawn.
 *
 * **Signed.** One of the node's operational wallets signs it: an EIP-712
 * `ServiceOffer` over every other field, in the request domain, `signedAt`
 * included. No contract reads it, and Verifiable Memory does not say who
 * published an asset, so a buyer keeps an offer only when the chain says its
 * signer is an operational wallet of the offer's seller, and of a seller's
 * offers for one service only the newest (router.ts). The node that publishes
 * an asset keeps its earlier versions' triples beside the newest; other nodes
 * hold the newest alone.
 *
 * Its subject is named after its signature, so the triples of two offers
 * never share one, and every field is always written: triples someone else
 * adds under it only add rows to a buyer's query, and the seller's own row
 * stays among them.
 */
import { ethers } from 'ethers';
import {
  SERVICE_CLASS_INFERENCE,
  recoverSigner,
  type MarketplaceChainAdapter,
  type MarketplaceDomain,
} from '@origintrail-official/dkg-chain';

export const MARKETPLACE_NS = 'https://dkg.network/marketplace#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const P = (name: string) => `${MARKETPLACE_NS}${name}`;

/** A seller's signed offer of one service, as its Knowledge Asset holds it. */
export interface ServiceOffer {
  seller: bigint;
  serviceId: string;
  serviceClass: number;
  unit: 'token';
  /** The model's URN; its keccak256 is `serviceId`. */
  model: string;
  provenance: 'weights-pinned' | 'upstream-claimed';
  tokenizerBundle?: string;
  /** A positive integer, or `null` when the seller states none. */
  capacity: number | null;
  /** The seller node's libp2p peer id, which buyers dial. */
  peerId: string;
  /** Wei per unit, from `priceEpoch` on. */
  pricePerUnit: bigint;
  priceEpoch: number;
  /** Wei per unit from the epoch after `priceEpoch` on, when it differs. */
  nextPricePerUnit?: bigint;
  /** The last epoch the offer's asset is stored through: its end epoch on chain. */
  validUntilEpoch: number;
  withdrawn: boolean;
  /** When the seller signed it, in chain seconds. */
  signedAt: number;
  /** An operational wallet's EIP-712 signature over every other field. */
  signature: string;
}

/** One epoch of an offer, as its schedule prices that epoch: what routing, the catalog and the gateway read. */
export interface Offer {
  seller: bigint;
  serviceId: string;
  serviceClass: number;
  unit: 'token';
  pricePerUnit: bigint;
  epoch: number;
  capacity: number | null;
  model: string;
  provenance: 'weights-pinned' | 'upstream-claimed';
  tokenizerBundle?: string;
  peerId: string;
  signedAt: number;
  signature: string;
}

/** A quad as the agent's memory takes it: IRIs bare, literals quoted. */
export interface OfferQuad {
  subject: string;
  predicate: string;
  object: string;
  graph: string;
}

/**
 * The EIP-712 type an offer is signed as, in the request domain. A capacity
 * the seller states none of is 0, no tokenizer the empty string, and no next
 * price 0, as the offer's quads carry them.
 */
export const SERVICE_OFFER_TYPES = {
  ServiceOffer: [
    { name: 'seller', type: 'uint72' },
    { name: 'serviceId', type: 'bytes32' },
    { name: 'serviceClass', type: 'uint8' },
    { name: 'unit', type: 'string' },
    { name: 'model', type: 'string' },
    { name: 'provenance', type: 'string' },
    { name: 'tokenizerBundle', type: 'string' },
    { name: 'capacity', type: 'uint64' },
    { name: 'peerId', type: 'string' },
    { name: 'pricePerUnit', type: 'uint96' },
    { name: 'priceEpoch', type: 'uint64' },
    { name: 'nextPricePerUnit', type: 'uint96' },
    { name: 'validUntilEpoch', type: 'uint64' },
    { name: 'withdrawn', type: 'bool' },
    { name: 'signedAt', type: 'uint64' },
  ],
};

/** The service id of a model: keccak256 of its URN. */
export function serviceIdOf(modelUrn: string): string {
  return ethers.id(modelUrn);
}

/** The fields an offer's signature is over, as `SERVICE_OFFER_TYPES` takes them. */
function signedFields(offer: Omit<ServiceOffer, 'signature'>): Record<string, unknown> {
  return {
    seller: offer.seller, serviceId: offer.serviceId, serviceClass: offer.serviceClass, unit: offer.unit, model: offer.model,
    provenance: offer.provenance, tokenizerBundle: offer.tokenizerBundle ?? '', capacity: offer.capacity ?? 0, peerId: offer.peerId,
    pricePerUnit: offer.pricePerUnit, priceEpoch: offer.priceEpoch, nextPricePerUnit: offer.nextPricePerUnit ?? 0n,
    validUntilEpoch: offer.validUntilEpoch, withdrawn: offer.withdrawn, signedAt: offer.signedAt,
  };
}

/** The digest an offer's signature is over. */
export function hashServiceOffer(domain: MarketplaceDomain, offer: Omit<ServiceOffer, 'signature'>): string {
  return ethers.TypedDataEncoder.hash(domain, SERVICE_OFFER_TYPES, signedFields(offer));
}

/** `offer`, signed by the operational wallet `signer` through the chain adapter, which holds its key. */
export async function signServiceOffer(
  chain: Pick<MarketplaceChainAdapter, 'signTypedDataAs'>,
  signer: string,
  domain: MarketplaceDomain,
  offer: Omit<ServiceOffer, 'signature'>,
): Promise<ServiceOffer> {
  return { ...offer, signature: await chain.signTypedDataAs(signer, domain, SERVICE_OFFER_TYPES, signedFields(offer)) };
}

/** The wallet that signed `offer`; `null` when its signature recovers to none, or a field does not fit its type. */
export function serviceOfferSignerOf(domain: MarketplaceDomain, offer: ServiceOffer): string | null {
  try {
    return recoverSigner(hashServiceOffer(domain, offer), offer.signature);
  } catch {
    return null;
  }
}

/** What the schedule asks in `epoch`, whatever the offer's validity; `null` before its `priceEpoch`. */
export function scheduledPrice(offer: Pick<ServiceOffer, 'pricePerUnit' | 'priceEpoch' | 'nextPricePerUnit'>, epoch: number): bigint | null {
  if (epoch < offer.priceEpoch) return null;
  return epoch > offer.priceEpoch && offer.nextPricePerUnit !== undefined ? offer.nextPricePerUnit : offer.pricePerUnit;
}

/** The offer's price in `epoch`; `null` once withdrawn, after its last epoch, or before its schedule starts. */
export function offerPriceIn(offer: ServiceOffer, epoch: number): bigint | null {
  return offer.withdrawn || epoch > offer.validUntilEpoch ? null : scheduledPrice(offer, epoch);
}

/** The offer as one epoch sees it; `null` for an epoch it does not price. */
export function offerIn(offer: ServiceOffer, epoch: number): Offer | null {
  const pricePerUnit = offerPriceIn(offer, epoch);
  if (pricePerUnit === null) return null;
  return {
    seller: offer.seller, serviceId: offer.serviceId, serviceClass: offer.serviceClass, unit: offer.unit, pricePerUnit, epoch,
    capacity: offer.capacity, model: offer.model, provenance: offer.provenance,
    ...(offer.tokenizerBundle ? { tokenizerBundle: offer.tokenizerBundle } : {}), peerId: offer.peerId, signedAt: offer.signedAt,
    signature: offer.signature,
  };
}

/** An offer's subject, named after its signature. */
export function serviceOfferSubject(signature: string): string {
  return `urn:dkg:marketplace:offer:${ethers.keccak256(signature)}`;
}

const literal = (value: string | number | bigint | boolean) => JSON.stringify(String(value));

export function serviceOfferQuads(offer: ServiceOffer): OfferQuad[] {
  const subject = serviceOfferSubject(offer.signature);
  const quad = (predicate: string, object: string): OfferQuad => ({ subject, predicate, object, graph: '' });
  return [
    quad(RDF_TYPE, P('ServiceOffer')),
    quad(P('seller'), literal(offer.seller)),
    quad(P('serviceId'), literal(offer.serviceId.toLowerCase())),
    quad(P('serviceClass'), literal(offer.serviceClass === SERVICE_CLASS_INFERENCE ? 'inference' : 'query')),
    quad(P('unit'), literal(offer.unit)),
    quad(P('model'), literal(offer.model)),
    quad(P('provenance'), literal(offer.provenance)),
    quad(P('tokenizerBundle'), literal(offer.tokenizerBundle ?? '')),
    quad(P('capacity'), literal(offer.capacity ?? 0)),
    quad(P('peerId'), literal(offer.peerId)),
    quad(P('pricePerUnit'), literal(offer.pricePerUnit)),
    quad(P('priceEpoch'), literal(offer.priceEpoch)),
    quad(P('nextPricePerUnit'), literal(offer.nextPricePerUnit ?? 0n)),
    quad(P('validUntilEpoch'), literal(offer.validUntilEpoch)),
    quad(P('withdrawn'), literal(offer.withdrawn)),
    quad(P('signedAt'), literal(offer.signedAt)),
    quad(P('signature'), literal(offer.signature)),
  ];
}

const FIELDS = [
  'seller', 'serviceId', 'serviceClass', 'unit', 'model', 'provenance', 'tokenizerBundle', 'capacity', 'peerId', 'pricePerUnit', 'priceEpoch',
  'nextPricePerUnit', 'validUntilEpoch', 'withdrawn', 'signedAt', 'signature',
] as const;

/** The query for every offer, over the Marketplace Context Graph's Verifiable Memory. */
export function serviceOffersQuery(): string {
  const patterns = FIELDS.map((f) => `?offer <${P(f)}> ?${f} .`);
  return `SELECT ?offer ${FIELDS.map((f) => `?${f}`).join(' ')} WHERE { ?offer <${RDF_TYPE}> <${P('ServiceOffer')}> . ${patterns.join(' ')} }`;
}

/** The value of a literal as a query returns it (`"5"`, `"5"^^<…>`). */
function valueOf(term: unknown): string | undefined {
  if (typeof term !== 'string') return undefined;
  const match = /^"((?:[^"\\]|\\.)*)"(?:\^\^<[^>]*>|@[\w-]+)?$/s.exec(term);
  return match ? (JSON.parse(`"${match[1]}"`) as string) : term;
}

/** A decimal count that is a safe integer: 0, or no leading zero. */
const isCount = (value: string | undefined): value is string =>
  value !== undefined && /^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value));
const isWei = (value: string | undefined): value is string => value !== undefined && /^(0|[1-9]\d*)$/.test(value);

/**
 * The well-formed offers among a query's rows, each field as it was written;
 * anything else is dropped. Their signatures are checked by the router.
 */
export function serviceOffersFromBindings(rows: ReadonlyArray<Record<string, unknown>>): ServiceOffer[] {
  const offers: ServiceOffer[] = [];
  for (const row of rows) {
    const v = (f: (typeof FIELDS)[number]) => valueOf(row[f]);
    const [seller, serviceId, model, capacity, provenance, tokenizerBundle, peerId] =
      [v('seller'), v('serviceId'), v('model'), v('capacity'), v('provenance'), v('tokenizerBundle'), v('peerId')];
    const [price, priceEpoch, next, validUntil, withdrawn, signedAt, signature] =
      [v('pricePerUnit'), v('priceEpoch'), v('nextPricePerUnit'), v('validUntilEpoch'), v('withdrawn'), v('signedAt'), v('signature')];
    if (!seller || !/^[1-9]\d*$/.test(seller) || !serviceId || !ethers.isHexString(serviceId, 32)) continue;
    if (!model || serviceIdOf(model) !== serviceId.toLowerCase() || v('serviceClass') !== 'inference' || v('unit') !== 'token') continue;
    if (provenance !== 'weights-pinned' && provenance !== 'upstream-claimed') continue;
    if (!isCount(capacity) || tokenizerBundle === undefined || !peerId || !isWei(price) || price === '0' || !isWei(next)) continue;
    if (!isCount(priceEpoch) || !isCount(validUntil) || (withdrawn !== 'true' && withdrawn !== 'false') || !isCount(signedAt)) continue;
    if (!signature || !ethers.isHexString(signature)) continue;
    offers.push({
      seller: BigInt(seller),
      serviceId: serviceId.toLowerCase(),
      serviceClass: SERVICE_CLASS_INFERENCE,
      unit: 'token',
      model,
      provenance,
      ...(tokenizerBundle ? { tokenizerBundle } : {}),
      capacity: capacity === '0' ? null : Number(capacity),
      peerId,
      pricePerUnit: BigInt(price),
      priceEpoch: Number(priceEpoch),
      ...(next === '0' ? {} : { nextPricePerUnit: BigInt(next) }),
      validUntilEpoch: Number(validUntil),
      withdrawn: withdrawn === 'true',
      signedAt: Number(signedAt),
      signature,
    });
  }
  return offers;
}

/** An offer as JSON keeps it: its amounts as decimal strings. */
export type ServiceOfferWire = Omit<ServiceOffer, 'seller' | 'pricePerUnit' | 'nextPricePerUnit'> & {
  seller: string;
  pricePerUnit: string;
  nextPricePerUnit?: string;
};

export function serviceOfferToWire(offer: ServiceOffer): ServiceOfferWire {
  const { nextPricePerUnit, ...rest } = offer;
  return {
    ...rest, seller: offer.seller.toString(), pricePerUnit: offer.pricePerUnit.toString(),
    ...(nextPricePerUnit === undefined ? {} : { nextPricePerUnit: nextPricePerUnit.toString() }),
  };
}

export function serviceOfferFromWire(wire: ServiceOfferWire): ServiceOffer {
  const { nextPricePerUnit, ...rest } = wire;
  return {
    ...rest, seller: BigInt(wire.seller), pricePerUnit: BigInt(wire.pricePerUnit),
    ...(nextPricePerUnit === undefined ? {} : { nextPricePerUnit: BigInt(nextPricePerUnit) }),
  };
}
