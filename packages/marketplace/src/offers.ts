// SPDX-License-Identifier: Apache-2.0

/**
 * Offers (OT-RFC-27): what a seller puts in the Marketplace Context Graph's
 * shared memory, one offer per service and epoch, and how a buyer reads them.
 *
 * An offer names the seller's identity, the service, its class and unit, the
 * price per unit in wei for that epoch, the capacity, and the model it serves
 * by its URN, with the model's provenance and tokenizer. `serviceId` is
 * keccak256 of that URN, so every seller of one model serves one budget. The
 * model's own Knowledge Asset is not written by sellers: an offer refers to it.
 *
 * It also names the seller node's libp2p peer id, which buyers dial, and one
 * of the node's operational wallets signs it: an EIP-712 `Offer` over every
 * other field, in the request domain, `signedAt` included. No contract reads
 * it. A buyer keeps an offer only when the chain says its signer is an
 * operational wallet of the offer's seller, and of a seller's offers for one
 * service and epoch only the newest (router.ts).
 *
 * Shared memory keeps every writer's triples under a subject side by side. So
 * an offer's subject is named after its signature, which only its seller can
 * make, and no one can write that subject first. Every field is always
 * written: triples someone else adds under it only add rows to a buyer's
 * query, and the seller's own row stays among them.
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

export interface Offer {
  seller: bigint;
  serviceId: string;
  serviceClass: number;
  unit: 'token';
  pricePerUnit: bigint;
  epoch: number;
  /** A positive integer, or `null` when the seller states none. */
  capacity: number | null;
  /** The model's URN; its keccak256 is `serviceId`. */
  model: string;
  provenance: 'weights-pinned' | 'upstream-claimed';
  tokenizerBundle?: string;
  /** The seller node's libp2p peer id, which buyers dial. */
  peerId: string;
  /** When the seller signed it, in chain seconds. */
  signedAt: number;
  /** An operational wallet's EIP-712 signature over every other field. */
  signature: string;
}

/** A quad as the agent's shared memory takes it: IRIs bare, literals quoted. */
export interface OfferQuad {
  subject: string;
  predicate: string;
  object: string;
  graph: string;
}

/**
 * The EIP-712 type an offer is signed as, in the request domain. A capacity
 * the seller states none of is 0, and no tokenizer the empty string, as the
 * offer's quads carry them.
 */
export const OFFER_TYPES = {
  Offer: [
    { name: 'seller', type: 'uint72' },
    { name: 'serviceId', type: 'bytes32' },
    { name: 'serviceClass', type: 'uint8' },
    { name: 'unit', type: 'string' },
    { name: 'pricePerUnit', type: 'uint96' },
    { name: 'epoch', type: 'uint64' },
    { name: 'capacity', type: 'uint64' },
    { name: 'model', type: 'string' },
    { name: 'provenance', type: 'string' },
    { name: 'tokenizerBundle', type: 'string' },
    { name: 'peerId', type: 'string' },
    { name: 'signedAt', type: 'uint64' },
  ],
};

/** The service id of a model: keccak256 of its URN. */
export function serviceIdOf(modelUrn: string): string {
  return ethers.id(modelUrn);
}

/** The fields an offer's signature is over, as `OFFER_TYPES` takes them. */
function signedFields(offer: Omit<Offer, 'signature'>): Record<string, unknown> {
  return {
    seller: offer.seller, serviceId: offer.serviceId, serviceClass: offer.serviceClass, unit: offer.unit,
    pricePerUnit: offer.pricePerUnit, epoch: offer.epoch, capacity: offer.capacity ?? 0, model: offer.model,
    provenance: offer.provenance, tokenizerBundle: offer.tokenizerBundle ?? '', peerId: offer.peerId, signedAt: offer.signedAt,
  };
}

/** The digest an offer's signature is over. */
export function hashOffer(domain: MarketplaceDomain, offer: Omit<Offer, 'signature'>): string {
  return ethers.TypedDataEncoder.hash(domain, OFFER_TYPES, signedFields(offer));
}

/** `offer`, signed by the operational wallet `signer` through the chain adapter, which holds its key. */
export async function signOffer(
  chain: Pick<MarketplaceChainAdapter, 'signTypedDataAs'>,
  signer: string,
  domain: MarketplaceDomain,
  offer: Omit<Offer, 'signature'>,
): Promise<Offer> {
  return { ...offer, signature: await chain.signTypedDataAs(signer, domain, OFFER_TYPES, signedFields(offer)) };
}

/** The wallet that signed `offer`; `null` when its signature recovers to none, or a field does not fit its type. */
export function offerSignerOf(domain: MarketplaceDomain, offer: Offer): string | null {
  try {
    return recoverSigner(hashOffer(domain, offer), offer.signature);
  } catch {
    return null;
  }
}

/** An offer's subject, named after its signature. */
export function offerSubject(signature: string): string {
  return `urn:dkg:marketplace:offer:${ethers.keccak256(signature)}`;
}

const literal = (value: string | number | bigint) => JSON.stringify(String(value));

export function offerQuads(offer: Offer): OfferQuad[] {
  const subject = offerSubject(offer.signature);
  const quad = (predicate: string, object: string): OfferQuad => ({ subject, predicate, object, graph: '' });
  return [
    quad(RDF_TYPE, P('Offer')),
    quad(P('seller'), literal(offer.seller)),
    quad(P('serviceId'), literal(offer.serviceId.toLowerCase())),
    quad(P('serviceClass'), literal(offer.serviceClass === SERVICE_CLASS_INFERENCE ? 'inference' : 'query')),
    quad(P('unit'), literal(offer.unit)),
    quad(P('pricePerUnit'), literal(offer.pricePerUnit)),
    quad(P('epoch'), literal(offer.epoch)),
    quad(P('capacity'), literal(offer.capacity ?? 0)),
    quad(P('model'), literal(offer.model)),
    quad(P('provenance'), literal(offer.provenance)),
    quad(P('tokenizerBundle'), literal(offer.tokenizerBundle ?? '')),
    quad(P('peerId'), literal(offer.peerId)),
    quad(P('signedAt'), literal(offer.signedAt)),
    quad(P('signature'), literal(offer.signature)),
  ];
}

const FIELDS = [
  'seller', 'serviceId', 'serviceClass', 'unit', 'pricePerUnit', 'epoch', 'capacity', 'model', 'provenance', 'tokenizerBundle', 'peerId',
  'signedAt', 'signature',
] as const;

/** The query for the offers of `epochs`, over the Marketplace Context Graph's shared memory. */
export function offersQuery(epochs: readonly number[]): string {
  const patterns = FIELDS.map((f) => `?offer <${P(f)}> ?${f} .`);
  const values = epochs.map((e) => literal(e)).join(' ');
  return `SELECT ?offer ${FIELDS.map((f) => `?${f}`).join(' ')} WHERE { ?offer <${RDF_TYPE}> <${P('Offer')}> . ${patterns.join(' ')} VALUES ?epoch { ${values} } }`;
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

/**
 * The well-formed offers among a query's rows, each field as it was written;
 * anything else is dropped. Their signatures are checked by the router.
 */
export function offersFromBindings(rows: ReadonlyArray<Record<string, unknown>>): Offer[] {
  const offers: Offer[] = [];
  for (const row of rows) {
    const v = (f: string) => valueOf(row[f]);
    const seller = v('seller');
    const serviceId = v('serviceId');
    const price = v('pricePerUnit');
    const epoch = Number(v('epoch'));
    const model = v('model');
    const capacity = v('capacity');
    const provenance = v('provenance');
    const tokenizerBundle = v('tokenizerBundle');
    const peerId = v('peerId');
    const signedAt = v('signedAt');
    const signature = v('signature');
    if (!seller || !/^[1-9]\d*$/.test(seller) || !serviceId || !ethers.isHexString(serviceId, 32)) continue;
    if (!price || !/^\d+$/.test(price) || !Number.isSafeInteger(epoch) || !model || serviceIdOf(model) !== serviceId.toLowerCase()) continue;
    if (v('serviceClass') !== 'inference' || v('unit') !== 'token' || !isCount(capacity) || !isCount(signedAt)) continue;
    if (provenance !== 'weights-pinned' && provenance !== 'upstream-claimed') continue;
    if (tokenizerBundle === undefined || !peerId || !signature || !ethers.isHexString(signature)) continue;
    offers.push({
      seller: BigInt(seller),
      serviceId: serviceId.toLowerCase(),
      serviceClass: SERVICE_CLASS_INFERENCE,
      unit: 'token',
      pricePerUnit: BigInt(price),
      epoch,
      capacity: capacity === '0' ? null : Number(capacity),
      model,
      provenance,
      ...(tokenizerBundle ? { tokenizerBundle } : {}),
      peerId,
      signedAt: Number(signedAt),
      signature,
    });
  }
  return offers;
}
