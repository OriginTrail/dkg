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
 * Each offer's subject is fixed by seller, service and epoch, so sharing it
 * again replaces it.
 */
import { ethers } from 'ethers';
import { SERVICE_CLASS_INFERENCE } from '@origintrail-official/dkg-chain';

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
  capacity: number | null;
  /** The model's URN; its keccak256 is `serviceId`. */
  model: string;
  provenance: 'weights-pinned' | 'upstream-claimed';
  tokenizerBundle?: string;
}

/** A quad as the agent's shared memory takes it: IRIs bare, literals quoted. */
export interface OfferQuad {
  subject: string;
  predicate: string;
  object: string;
  graph: string;
}

/** The service id of a model: keccak256 of its URN. */
export function serviceIdOf(modelUrn: string): string {
  return ethers.id(modelUrn);
}

export function offerSubject(seller: bigint, serviceId: string, epoch: number): string {
  return `urn:dkg:marketplace:offer:${seller}:${serviceId.toLowerCase()}:${epoch}`;
}

const literal = (value: string | number | bigint) => JSON.stringify(String(value));

export function offerQuads(offer: Offer): OfferQuad[] {
  const subject = offerSubject(offer.seller, offer.serviceId, offer.epoch);
  const quad = (predicate: string, object: string): OfferQuad => ({ subject, predicate, object, graph: '' });
  return [
    quad(RDF_TYPE, P('Offer')),
    quad(P('seller'), literal(offer.seller)),
    quad(P('serviceId'), literal(offer.serviceId.toLowerCase())),
    quad(P('serviceClass'), literal(offer.serviceClass === SERVICE_CLASS_INFERENCE ? 'inference' : 'query')),
    quad(P('unit'), literal(offer.unit)),
    quad(P('pricePerUnit'), literal(offer.pricePerUnit)),
    quad(P('epoch'), literal(offer.epoch)),
    ...(offer.capacity !== null ? [quad(P('capacity'), literal(offer.capacity))] : []),
    quad(P('model'), literal(offer.model)),
    quad(P('provenance'), literal(offer.provenance)),
    ...(offer.tokenizerBundle ? [quad(P('tokenizerBundle'), literal(offer.tokenizerBundle))] : []),
  ];
}

const FIELDS = ['seller', 'serviceId', 'serviceClass', 'unit', 'pricePerUnit', 'epoch', 'capacity', 'model', 'provenance', 'tokenizerBundle'] as const;
const OPTIONAL = new Set<string>(['capacity', 'tokenizerBundle']);

/** The query for the offers of `epochs`, over the Marketplace Context Graph's shared memory. */
export function offersQuery(epochs: readonly number[]): string {
  const patterns = FIELDS.map((f) => (OPTIONAL.has(f) ? `OPTIONAL { ?offer <${P(f)}> ?${f} }` : `?offer <${P(f)}> ?${f} .`));
  const values = epochs.map((e) => literal(e)).join(' ');
  return `SELECT ?offer ${FIELDS.map((f) => `?${f}`).join(' ')} WHERE { ?offer <${RDF_TYPE}> <${P('Offer')}> . ${patterns.join(' ')} VALUES ?epoch { ${values} } }`;
}

/** The value of a literal as a query returns it (`"5"`, `"5"^^<…>`). */
function valueOf(term: unknown): string | undefined {
  if (typeof term !== 'string') return undefined;
  const match = /^"((?:[^"\\]|\\.)*)"(?:\^\^<[^>]*>|@[\w-]+)?$/s.exec(term);
  return match ? (JSON.parse(`"${match[1]}"`) as string) : term;
}

/** The well-formed offers among a query's rows; anything malformed is dropped. */
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
    if (!seller || !/^[1-9]\d*$/.test(seller) || !serviceId || !ethers.isHexString(serviceId, 32)) continue;
    if (!price || !/^\d+$/.test(price) || !Number.isSafeInteger(epoch) || !model || serviceIdOf(model) !== serviceId.toLowerCase()) continue;
    if (v('serviceClass') !== 'inference' || v('unit') !== 'token') continue;
    const provenance = v('provenance');
    offers.push({
      seller: BigInt(seller),
      serviceId: serviceId.toLowerCase(),
      serviceClass: SERVICE_CLASS_INFERENCE,
      unit: 'token',
      pricePerUnit: BigInt(price),
      epoch,
      capacity: capacity && /^\d+$/.test(capacity) ? Number(capacity) : null,
      model,
      provenance: provenance === 'weights-pinned' ? 'weights-pinned' : 'upstream-claimed',
      ...(v('tokenizerBundle') ? { tokenizerBundle: v('tokenizerBundle') } : {}),
    });
  }
  return offers;
}
