/**
 * OT-RFC-27 marketplace offer publication + discovery over the shared
 * `marketplace` Context Graph. Offers are ordinary Knowledge Assets: the
 * seller shares one RDF node per offering into the CG's shared memory (public
 * access, gossiped over SWM), and buyers discover them with a local SPARQL
 * query over their synced view of the same CG.
 *
 * RDF vocabulary (namespace `https://w3id.org/dkg/marketplace#`): `mkt:Offer`
 * with `mkt:offeringId`, `mkt:serviceType`, `mkt:unit`, `mkt:askPerUnitWei`,
 * `mkt:sellerIdentityId`, `mkt:sellerPeerId`, `mkt:sellerAddress`,
 * `mkt:modelId`, `mkt:capacityUnitsPerMin`, `mkt:expiresAt`. Wei amounts and
 * identity ids are plain string literals (uint96/uint72 exceed double
 * precision) parsed back with `BigInt`. `mkt:sellerAddress` is required by
 * buyers to verify the seller-signed receipt off-chain, so the publisher
 * always writes it.
 *
 * The ports below are structurally satisfied by `DKGAgent` (publish side:
 * `contextGraphExists`/`createContextGraph`/`share`; discovery side:
 * `query`), while unit tests inject fakes — the same seam the design doc
 * calls the "thin injectable offer source".
 */
import { MARKETPLACE_CONTEXT_GRAPH } from '@origintrail-official/dkg-core';
import type { MarketplaceOffer, MarketplaceServiceType, MarketplaceUnit } from '@origintrail-official/dkg-marketplace';
import type { Quad } from '@origintrail-official/dkg-storage';
import { strip, stripLiteral } from '../dkg-agent-utils.js';
import type { MarketplaceSellerOffering } from './seller-service.js';

/** RDF namespace for marketplace offer Knowledge Assets. */
export const MKT_NAMESPACE = 'https://w3id.org/dkg/marketplace#';

const MKT = {
  Offer: `${MKT_NAMESPACE}Offer`,
  offeringId: `${MKT_NAMESPACE}offeringId`,
  serviceType: `${MKT_NAMESPACE}serviceType`,
  unit: `${MKT_NAMESPACE}unit`,
  askPerUnitWei: `${MKT_NAMESPACE}askPerUnitWei`,
  sellerIdentityId: `${MKT_NAMESPACE}sellerIdentityId`,
  sellerPeerId: `${MKT_NAMESPACE}sellerPeerId`,
  sellerAddress: `${MKT_NAMESPACE}sellerAddress`,
  modelId: `${MKT_NAMESPACE}modelId`,
  capacityUnitsPerMin: `${MKT_NAMESPACE}capacityUnitsPerMin`,
  expiresAt: `${MKT_NAMESPACE}expiresAt`,
} as const;

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

export const MARKETPLACE_SERVICE_TYPES: readonly MarketplaceServiceType[] =
  ['inference', 'query', 'reasoning', 'graph-ml'];

export const MARKETPLACE_UNITS: readonly MarketplaceUnit[] = ['token', 'query-unit'];

/** Identity of the publishing seller node, stamped onto every offer KA. */
export interface MarketplaceSellerIdentity {
  sellerIdentityId: bigint;
  sellerPeerId: string;
  /** Operational wallet that signs receipts — buyers verify against it. */
  sellerAddress: string;
}

/** Deterministic offer-KA subject for one (seller, offering) pair. */
export function marketplaceOfferSubject(sellerPeerId: string, offeringLocalId: string): string {
  return `urn:dkg:marketplace:offer:${sellerPeerId}:${offeringLocalId}`;
}

/** Build the offer Knowledge Asset quads for one offering. */
export function buildMarketplaceOfferQuads(
  offering: Pick<
    MarketplaceSellerOffering,
    'offeringLocalId' | 'offeringId' | 'serviceType' | 'modelId' | 'unit' | 'askPerUnitWei' | 'capacityUnitsPerMin' | 'expiresAt'
  >,
  seller: MarketplaceSellerIdentity,
): Quad[] {
  const subject = marketplaceOfferSubject(seller.sellerPeerId, offering.offeringLocalId);
  // `graph: ''` — share() routes quads into the CG's shared-memory graph.
  const quad = (predicate: string, object: string): Quad => ({ subject, predicate, object, graph: '' });
  const literal = (value: string | bigint | number): string => `"${value}"`;
  const quads: Quad[] = [
    quad(RDF_TYPE, MKT.Offer),
    quad(MKT.offeringId, literal(offering.offeringId)),
    quad(MKT.serviceType, literal(offering.serviceType)),
    quad(MKT.unit, literal(offering.unit)),
    quad(MKT.askPerUnitWei, literal(offering.askPerUnitWei)),
    quad(MKT.sellerIdentityId, literal(seller.sellerIdentityId)),
    quad(MKT.sellerPeerId, literal(seller.sellerPeerId)),
    quad(MKT.sellerAddress, literal(seller.sellerAddress)),
  ];
  if (offering.modelId !== undefined) quads.push(quad(MKT.modelId, literal(offering.modelId)));
  if (offering.capacityUnitsPerMin !== undefined) {
    quads.push(quad(MKT.capacityUnitsPerMin, literal(offering.capacityUnitsPerMin)));
  }
  if (offering.expiresAt !== undefined) quads.push(quad(MKT.expiresAt, literal(offering.expiresAt)));
  return quads;
}

/** The agent surface offer publication needs (structurally `DKGAgent`). */
export interface MarketplaceOfferPublishPort {
  contextGraphExists(id: string): Promise<boolean>;
  createContextGraph(opts: { id: string; name: string; description?: string }): Promise<void>;
  share(contextGraphId: string, quads: Quad[]): Promise<{ shareOperationId: string }>;
}

/**
 * Publish every offering as a Knowledge Asset into the `marketplace` Context
 * Graph, creating the CG (open access) when this node has not seen it yet.
 * Re-publishing an offering shares the same subject again — SWM applies it
 * as an update of the existing offer node.
 *
 * `opts.ensureRegistered` runs after the CG exists and BEFORE the shares: a
 * plain-name unregistered CG carries no authority a replica can verify, so
 * without an on-chain anchor buyer nodes never accept its shares. The hook
 * must contain its own failures (a later publish retries).
 */
export async function publishMarketplaceOfferings(
  port: MarketplaceOfferPublishPort,
  offerings: readonly MarketplaceSellerOffering[],
  seller: MarketplaceSellerIdentity,
  opts: { ensureRegistered?: (contextGraphId: string) => Promise<void> } = {},
): Promise<{ published: string[]; shareOperationIds: string[] }> {
  if (!(await port.contextGraphExists(MARKETPLACE_CONTEXT_GRAPH))) {
    await port.createContextGraph({
      id: MARKETPLACE_CONTEXT_GRAPH,
      name: 'Marketplace',
      description: 'OT-RFC-27 NeuroSymbolic Marketplace offers',
    });
  }
  await opts.ensureRegistered?.(MARKETPLACE_CONTEXT_GRAPH);
  const published: string[] = [];
  const shareOperationIds: string[] = [];
  for (const offering of offerings) {
    const quads = buildMarketplaceOfferQuads(offering, seller);
    const { shareOperationId } = await port.share(MARKETPLACE_CONTEXT_GRAPH, quads);
    published.push(marketplaceOfferSubject(seller.sellerPeerId, offering.offeringLocalId));
    shareOperationIds.push(shareOperationId);
  }
  return { published, shareOperationIds };
}

/** How the buyer router sources offers; the CG-backed source below is the production path. */
export interface MarketplaceOfferSource {
  discoverOffers(): Promise<MarketplaceOffer[]>;
}

/** The agent surface offer discovery needs (structurally `DKGAgent`). */
export interface MarketplaceOfferQueryPort {
  query(sparql: string, options: { contextGraphId: string; includeSharedMemory: boolean }): Promise<unknown>;
}

const DISCOVER_OFFERS_SPARQL = `PREFIX mkt: <${MKT_NAMESPACE}>
SELECT ?offer ?offeringId ?serviceType ?unit ?ask ?sellerIdentityId ?sellerPeerId ?sellerAddress ?modelId ?capacity ?expiresAt WHERE {
  ?offer a mkt:Offer ;
    mkt:offeringId ?offeringId ;
    mkt:serviceType ?serviceType ;
    mkt:unit ?unit ;
    mkt:askPerUnitWei ?ask ;
    mkt:sellerIdentityId ?sellerIdentityId ;
    mkt:sellerPeerId ?sellerPeerId .
  OPTIONAL { ?offer mkt:sellerAddress ?sellerAddress }
  OPTIONAL { ?offer mkt:modelId ?modelId }
  OPTIONAL { ?offer mkt:capacityUnitsPerMin ?capacity }
  OPTIONAL { ?offer mkt:expiresAt ?expiresAt }
}`;

function optionalLiteral(row: Record<string, string>, key: string): string | undefined {
  const raw = row[key];
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const value = stripLiteral(raw);
  return value.length > 0 ? value : undefined;
}

function parseBigint(value: string | undefined): bigint | undefined {
  if (value === undefined) return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

/**
 * Parse discovery SELECT rows into typed offers. Malformed rows (bad
 * numerics, unknown enums) are skipped rather than failing the whole
 * discovery — the CG is network-writable, so rows are untrusted data.
 */
export function parseMarketplaceOfferBindings(bindings: ReadonlyArray<Record<string, string>>): MarketplaceOffer[] {
  const offers: MarketplaceOffer[] = [];
  for (const row of bindings) {
    const offerId = typeof row['offer'] === 'string' ? strip(row['offer']) : undefined;
    const offeringId = optionalLiteral(row, 'offeringId');
    const serviceType = optionalLiteral(row, 'serviceType') as MarketplaceServiceType | undefined;
    const unit = optionalLiteral(row, 'unit') as MarketplaceUnit | undefined;
    const askPerUnitWei = parseBigint(optionalLiteral(row, 'ask'));
    const sellerIdentityId = parseBigint(optionalLiteral(row, 'sellerIdentityId'));
    const sellerPeerId = optionalLiteral(row, 'sellerPeerId');
    if (
      !offerId || !offeringId || !sellerPeerId
      || serviceType === undefined || !MARKETPLACE_SERVICE_TYPES.includes(serviceType)
      || unit === undefined || !MARKETPLACE_UNITS.includes(unit)
      || askPerUnitWei === undefined || askPerUnitWei < 0n
      || sellerIdentityId === undefined || sellerIdentityId <= 0n
    ) {
      continue;
    }
    const capacityUnitsPerMin = parseBigint(optionalLiteral(row, 'capacity'));
    const expiresAtRaw = optionalLiteral(row, 'expiresAt');
    const expiresAt = expiresAtRaw !== undefined ? Number(expiresAtRaw) : undefined;
    const sellerAddress = optionalLiteral(row, 'sellerAddress');
    offers.push({
      offerId,
      offeringId,
      serviceType,
      unit,
      askPerUnitWei,
      sellerIdentityId,
      sellerPeerId,
      ...(sellerAddress !== undefined ? { sellerAddress } : {}),
      ...(optionalLiteral(row, 'modelId') !== undefined ? { modelId: optionalLiteral(row, 'modelId') } : {}),
      ...(capacityUnitsPerMin !== undefined ? { capacityUnitsPerMin } : {}),
      ...(expiresAt !== undefined && Number.isFinite(expiresAt) ? { expiresAt } : {}),
    });
  }
  return offers;
}

/**
 * Production offer source: a local SPARQL query over this node's synced view
 * of the `marketplace` CG (shared memory included — offers travel over SWM).
 */
export function createContextGraphOfferSource(port: MarketplaceOfferQueryPort): MarketplaceOfferSource {
  return {
    async discoverOffers() {
      const result = await port.query(DISCOVER_OFFERS_SPARQL, {
        contextGraphId: MARKETPLACE_CONTEXT_GRAPH,
        includeSharedMemory: true,
      });
      const bindings = (result as { type?: string; bindings?: unknown })?.bindings;
      if (!Array.isArray(bindings)) return [];
      return parseMarketplaceOfferBindings(bindings as Array<Record<string, string>>);
    },
  };
}
