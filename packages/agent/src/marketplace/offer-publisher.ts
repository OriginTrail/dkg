/**
 * OT-RFC-27 marketplace offer publication + discovery over the shared
 * `marketplace` Context Graph.
 *
 * Every (seller, offering) pair is ONE graph-scoped Knowledge Asset, authored
 * by the seller's agent (the key that also signs its receipts) and published
 * through the named KA lifecycle (create → write → share → publish to VM).
 * Re-publishing an offering with a new ask is an on-chain UPDATE of that same
 * KA: the update's version is the confirmed version + 1, and every node
 * replaces the KA's previous content when it reconciles the update from the
 * chain. Any seller may publish into the registered marketplace CG because it
 * is public with an open publish policy, and only the KA's author can update
 * it, so each offer stays attributable to — and writable only by — its seller.
 *
 * Why not shared memory alone: a graph-scoped share at an unchanged assertion
 * version with new content is refused by peers and by the RFC-64 catalog
 * (`CONFLICTING_KA_ASSERTION_VERSION`), and an unpublished KA's next draft is
 * always sealed at that same version, so an SWM-only offer can never be
 * repriced. The legacy `share()` lane is not applied by receivers at all.
 *
 * RDF vocabulary (namespace `https://w3id.org/dkg/marketplace#`): `mkt:Offer`
 * with `mkt:offeringId`, `mkt:serviceType`, `mkt:unit`, `mkt:askPerUnitWei`,
 * `mkt:sellerIdentityId`, `mkt:sellerPeerId`, `mkt:sellerAddress`,
 * `mkt:revision`, `mkt:modelId`, `mkt:capacityUnitsPerMin`, `mkt:expiresAt`.
 * Wei amounts, identity ids and revisions are plain string literals (they
 * exceed double precision) parsed back with `BigInt`. `mkt:sellerAddress` is
 * required: buyers verify the seller-signed receipt against it, and discovery
 * accepts an offer only from a KA authored by that same address. `mkt:revision`
 * strictly increases on every change, so while an update is in flight (its new
 * version shared, the old one still in VM) discovery returns only the newest.
 *
 * The ports below are satisfied by `DKGAgent` adapters (publish side:
 * `createMarketplaceOfferAssetPort`; discovery side: `query`), while unit
 * tests inject fakes — the same seam the design doc calls the "thin
 * injectable offer source".
 */
import {
  MARKETPLACE_CONTEXT_GRAPH,
  MemoryLayer,
  parseContextGraphLayerUri,
  validateAssertionName,
} from '@origintrail-official/dkg-core';
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
  revision: `${MKT_NAMESPACE}revision`,
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
  /** Operational wallet that signs receipts AND authors the offer KAs. */
  sellerAddress: string;
}

type OfferContent = Pick<
  MarketplaceSellerOffering,
  'offeringLocalId' | 'offeringId' | 'serviceType' | 'modelId' | 'unit' | 'askPerUnitWei' | 'capacityUnitsPerMin' | 'expiresAt'
>;

/** Deterministic offer-KA subject for one (seller, offering) pair. */
export function marketplaceOfferSubject(sellerPeerId: string, offeringLocalId: string): string {
  return `urn:dkg:marketplace:offer:${sellerPeerId}:${offeringLocalId}`;
}

/**
 * The seller-local Knowledge Asset name of one offering. Stable across
 * republishes, so a new ask updates the same KA instead of minting another.
 */
export function marketplaceOfferAssetName(offering: Pick<OfferContent, 'offeringLocalId' | 'offeringId'>): string {
  const readable = `marketplace-offer-${offering.offeringLocalId}`;
  return readable.length <= 128 && validateAssertionName(readable).valid
    ? readable
    : `marketplace-offer-${offering.offeringId}`;
}

/** Build the offer Knowledge Asset quads for one offering at `revision`. */
export function buildMarketplaceOfferQuads(
  offering: OfferContent,
  seller: MarketplaceSellerIdentity,
  revision: bigint,
): Quad[] {
  const subject = marketplaceOfferSubject(seller.sellerPeerId, offering.offeringLocalId);
  // `graph: ''` — the KA lifecycle routes quads into the asset's own graph.
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
    quad(MKT.revision, literal(revision)),
  ];
  if (offering.modelId !== undefined) quads.push(quad(MKT.modelId, literal(offering.modelId)));
  if (offering.capacityUnitsPerMin !== undefined) {
    quads.push(quad(MKT.capacityUnitsPerMin, literal(offering.capacityUnitsPerMin)));
  }
  if (offering.expiresAt !== undefined) quads.push(quad(MKT.expiresAt, literal(offering.expiresAt)));
  return quads;
}

/** The publish side of one offer Knowledge Asset (an agent adapter in production). */
export interface MarketplaceOfferAssetPort {
  /**
   * The content of the asset's latest CONFIRMED (Verifiable Memory) version
   * on this node, or null when it was never published. Without a local
   * lifecycle record, the newest version of `subject` this author holds in
   * Verifiable Memory stands in for it.
   */
  readPublishedOffer(assetName: string, subject: string): Promise<Quad[] | null>;
  /**
   * Make `quads` the asset's next version and publish it to Verifiable
   * Memory: the first publish mints the KA, later ones update the same KA.
   */
  publishOfferAsset(assetName: string, quads: Quad[]): Promise<{ ual?: string }>;
}

export type MarketplaceOfferPublishOutcome = 'published' | 'unchanged';

export interface MarketplaceOfferPublishResult {
  /** Offer subjects of every configured offering (stable offer ids). */
  published: string[];
  assets: Array<{
    offeringLocalId: string;
    assetName: string;
    outcome: MarketplaceOfferPublishOutcome;
    revision: string;
    ual?: string;
  }>;
}

/** Offer content as a comparable set, ignoring the revision stamp. */
function offerContentKey(quads: readonly Quad[], subject: string): string {
  return quads
    .filter((quad) => quad.subject === subject && quad.predicate !== MKT.revision)
    .map((quad) => `${quad.predicate}\u0000${quad.object}`)
    .sort()
    .join('\u0001');
}

/** The `mkt:revision` of `subject` in an offer's quads (0 when absent). */
export function publishedOfferRevision(quads: readonly Quad[], subject: string): bigint {
  const raw = quads.find((quad) => quad.subject === subject && quad.predicate === MKT.revision)?.object;
  return parseBigint(raw === undefined ? undefined : stripLiteral(raw)) ?? 0n;
}

/**
 * Publish every offering as its own Knowledge Asset into the `marketplace`
 * Context Graph. An offering whose published content is unchanged is left
 * alone (no chain transaction); a changed one is published as the next
 * version of the same KA with a strictly larger `mkt:revision`.
 *
 * `opts.ensureAnchor` runs first and must leave this node bound to the ONE
 * on-chain registration of the marketplace CG (adopting another seller's
 * anchor, never minting a second one); its failure aborts the publish.
 */
export async function publishMarketplaceOfferings(
  port: MarketplaceOfferAssetPort,
  offerings: readonly MarketplaceSellerOffering[],
  seller: MarketplaceSellerIdentity,
  opts: { ensureAnchor?: () => Promise<void>; nowMs?: () => number } = {},
): Promise<MarketplaceOfferPublishResult> {
  await opts.ensureAnchor?.();
  const nowMs = opts.nowMs ?? Date.now;
  const result: MarketplaceOfferPublishResult = { published: [], assets: [] };
  for (const offering of offerings) {
    const subject = marketplaceOfferSubject(seller.sellerPeerId, offering.offeringLocalId);
    const assetName = marketplaceOfferAssetName(offering);
    const current = await port.readPublishedOffer(assetName, subject);
    const currentRevision = current ? publishedOfferRevision(current, subject) : 0n;
    const candidate = buildMarketplaceOfferQuads(offering, seller, currentRevision);
    result.published.push(subject);
    if (current && offerContentKey(current, subject) === offerContentKey(candidate, subject)) {
      result.assets.push({ offeringLocalId: offering.offeringLocalId, assetName, outcome: 'unchanged', revision: currentRevision.toString() });
      continue;
    }
    const clock = BigInt(Math.floor(nowMs()));
    const revision = clock > currentRevision ? clock : currentRevision + 1n;
    const { ual } = await port.publishOfferAsset(assetName, buildMarketplaceOfferQuads(offering, seller, revision));
    result.assets.push({
      offeringLocalId: offering.offeringLocalId,
      assetName,
      outcome: 'published',
      revision: revision.toString(),
      ...(ual !== undefined ? { ual } : {}),
    });
  }
  return result;
}

/** How the buyer router sources offers; the CG-backed source below is the production path. */
export interface MarketplaceOfferSource {
  discoverOffers(): Promise<MarketplaceOffer[]>;
}

/** The agent surface offer discovery needs (structurally `DKGAgent`). */
export interface MarketplaceOfferQueryPort {
  query(sparql: string, options: { contextGraphId: string; includeSharedMemory: boolean }): Promise<unknown>;
}

// `GRAPH ?g` keeps every row inside ONE Knowledge Asset graph, so a row never
// mixes the ask of one version with the revision of another, and `?g` names
// the asset's author for the authority check below.
const DISCOVER_OFFERS_SPARQL = `PREFIX mkt: <${MKT_NAMESPACE}>
SELECT ?g ?offer ?offeringId ?serviceType ?unit ?ask ?sellerIdentityId ?sellerPeerId ?sellerAddress ?revision ?modelId ?capacity ?expiresAt WHERE {
  GRAPH ?g {
    ?offer a mkt:Offer ;
      mkt:offeringId ?offeringId ;
      mkt:serviceType ?serviceType ;
      mkt:unit ?unit ;
      mkt:askPerUnitWei ?ask ;
      mkt:sellerIdentityId ?sellerIdentityId ;
      mkt:sellerPeerId ?sellerPeerId ;
      mkt:sellerAddress ?sellerAddress .
    OPTIONAL { ?offer mkt:revision ?revision }
    OPTIONAL { ?offer mkt:modelId ?modelId }
    OPTIONAL { ?offer mkt:capacityUnitsPerMin ?capacity }
    OPTIONAL { ?offer mkt:expiresAt ?expiresAt }
  }
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

function parseOfferRow(row: Record<string, string>): MarketplaceOffer | undefined {
  const offerId = typeof row['offer'] === 'string' ? strip(row['offer']) : undefined;
  const offeringId = optionalLiteral(row, 'offeringId');
  const serviceType = optionalLiteral(row, 'serviceType') as MarketplaceServiceType | undefined;
  const unit = optionalLiteral(row, 'unit') as MarketplaceUnit | undefined;
  const askPerUnitWei = parseBigint(optionalLiteral(row, 'ask'));
  const sellerIdentityId = parseBigint(optionalLiteral(row, 'sellerIdentityId'));
  const sellerPeerId = optionalLiteral(row, 'sellerPeerId');
  const sellerAddress = optionalLiteral(row, 'sellerAddress');
  if (
    !offerId || !offeringId || !sellerPeerId || !sellerAddress
    || serviceType === undefined || !MARKETPLACE_SERVICE_TYPES.includes(serviceType)
    || unit === undefined || !MARKETPLACE_UNITS.includes(unit)
    || askPerUnitWei === undefined || askPerUnitWei < 0n
    || sellerIdentityId === undefined || sellerIdentityId <= 0n
  ) {
    return undefined;
  }
  const capacityUnitsPerMin = parseBigint(optionalLiteral(row, 'capacity'));
  const expiresAtRaw = optionalLiteral(row, 'expiresAt');
  const expiresAt = expiresAtRaw !== undefined ? Number(expiresAtRaw) : undefined;
  const modelId = optionalLiteral(row, 'modelId');
  return {
    offerId,
    offeringId,
    serviceType,
    unit,
    askPerUnitWei,
    sellerIdentityId,
    sellerPeerId,
    sellerAddress,
    ...(modelId !== undefined ? { modelId } : {}),
    ...(capacityUnitsPerMin !== undefined ? { capacityUnitsPerMin } : {}),
    ...(expiresAt !== undefined && Number.isFinite(expiresAt) ? { expiresAt } : {}),
  };
}

interface NewestOffer {
  offer: MarketplaceOffer;
  revision: bigint;
  verified: boolean;
}

/** The authorized, newest offer row per `{author}\u0000{offeringId}` key. */
function newestOffersByKey(bindings: ReadonlyArray<Record<string, string>>): Map<string, NewestOffer> {
  const newest = new Map<string, NewestOffer>();
  for (const row of bindings) {
    const offer = parseOfferRow(row);
    if (!offer?.sellerAddress) continue;
    const graph = typeof row['g'] === 'string' ? parseContextGraphLayerUri(strip(row['g'])) : undefined;
    if (
      graph === undefined
      || graph.contextGraphId !== MARKETPLACE_CONTEXT_GRAPH
      || graph.layer === MemoryLayer.WorkingMemory
      || graph.agentAddress.toLowerCase() !== offer.sellerAddress.toLowerCase()
    ) {
      continue;
    }
    const revision = parseBigint(optionalLiteral(row, 'revision')) ?? 0n;
    const verified = graph.layer === MemoryLayer.VerifiableMemory;
    const key = `${graph.agentAddress.toLowerCase()}\u0000${offer.offeringId.toLowerCase()}`;
    const held = newest.get(key);
    if (held && (held.revision > revision || (held.revision === revision && (held.verified || !verified)))) {
      continue;
    }
    newest.set(key, { offer, revision, verified });
  }
  return newest;
}

/**
 * Parse discovery SELECT rows into typed offers, one per (seller, offering).
 *
 * Authority: a row counts only when its graph is a Knowledge Asset graph
 * (`…/_verifiable_memory|_shared_memory/{author}/{number}`) whose author is
 * the offer's own `mkt:sellerAddress` — a node cannot advertise, reprice or
 * shadow another seller's offer, because it cannot author that seller's KAs.
 * Among a seller's rows for one offering the highest `mkt:revision` wins
 * (Verifiable Memory over shared memory at an equal revision), so an update
 * in flight never shows both asks. Malformed rows (bad numerics, unknown
 * enums) are skipped rather than failing the whole discovery — the CG is
 * network-writable, so rows are untrusted data.
 */
export function parseMarketplaceOfferBindings(bindings: ReadonlyArray<Record<string, string>>): MarketplaceOffer[] {
  return [...newestOffersByKey(bindings).values()].map(({ offer }) => offer);
}

/**
 * Production offer source: a local SPARQL query over this node's view of the
 * `marketplace` CG — Verifiable Memory plus shared memory, where a new offer
 * version is visible before its update is confirmed.
 *
 * Monotonic per node: an offer never goes back below the highest revision
 * this source has already returned for that (seller, offering). The new
 * version's shared-memory copy is retracted from every node as soon as the
 * seller's update confirms, while each node replaces its Verifiable Memory
 * copy only when it reconciles the update from the chain (seconds on most
 * nodes, about a minute on a core that signed the update's ACK) — in between
 * its store holds only the OLD version again. Only offers this node still
 * holds are returned; the held revision just never regresses.
 */
export function createContextGraphOfferSource(port: MarketplaceOfferQueryPort): MarketplaceOfferSource {
  const returned = new Map<string, NewestOffer>();
  return {
    async discoverOffers() {
      const result = await port.query(DISCOVER_OFFERS_SPARQL, {
        contextGraphId: MARKETPLACE_CONTEXT_GRAPH,
        includeSharedMemory: true,
      });
      const bindings = (result as { type?: string; bindings?: unknown })?.bindings;
      if (!Array.isArray(bindings)) return [];
      const offers: MarketplaceOffer[] = [];
      for (const [key, newest] of newestOffersByKey(bindings as Array<Record<string, string>>)) {
        const held = returned.get(key);
        if (held && held.revision > newest.revision) {
          offers.push(held.offer);
          continue;
        }
        returned.set(key, newest);
        offers.push(newest.offer);
      }
      return offers;
    },
  };
}
