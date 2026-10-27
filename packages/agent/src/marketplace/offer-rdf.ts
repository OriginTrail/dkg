/**
 * OT-RFC-27 offer RDF vocabulary (`https://w3id.org/dkg/marketplace#`), the
 * extension predicates of seller connectors / pinned metering, and the
 * discovery TRIPLE SCAN.
 *
 * Discovery reads every `mkt:` triple of every `mkt:Offer` subject per graph
 * and groups them in TS — never an OPTIONAL-per-predicate SELECT: the
 * `marketplace` CG has an open publish policy and the authority check runs
 * AFTER the engine, so one junk KA carrying k values for each of ~20 OPTIONAL
 * predicates would make every buyer materialize k^20 rows. The scan has no
 * truncating LIMIT, a group over 64 triples is skipped, a core predicate with
 * two distinct values skips the offer, and an extension predicate with two
 * distinct values drops its extension group (the offer itself stays).
 *
 * Never published: base URLs, file paths, secret env keys, upstream origins,
 * or the contents of `allowedBuyers`.
 */
import { sparqlString } from '@origintrail-official/dkg-core';
import {
  CHAT_PAYLOAD_SCHEMA,
  CHAT_TEMPLATE_OPENAI_COUNT_V1,
  CHAT_TEMPLATE_OPENAI_COUNT_V1_DIGEST,
  SHA256_DIGEST_PATTERN,
  STUB_WORDS_DIGEST,
  isTokenizerKind,
  type MarketplaceOffer,
  type OfferMetering,
  type OfferModelFacts,
} from '@origintrail-official/dkg-marketplace';
import type { Quad } from '@origintrail-official/dkg-storage';
import { strip, stripLiteral } from '../dkg-agent-utils.js';

/** RDF namespace for marketplace offer Knowledge Assets. */
export const MKT_NAMESPACE = 'https://w3id.org/dkg/marketplace#';

const ns = (local: string) => `${MKT_NAMESPACE}${local}`;

export const MKT = {
  Offer: ns('Offer'),
  // core
  offeringId: ns('offeringId'),
  serviceType: ns('serviceType'),
  unit: ns('unit'),
  askPerUnitWei: ns('askPerUnitWei'),
  sellerIdentityId: ns('sellerIdentityId'),
  sellerPeerId: ns('sellerPeerId'),
  sellerAddress: ns('sellerAddress'),
  revision: ns('revision'),
  modelId: ns('modelId'),
  capacityUnitsPerMin: ns('capacityUnitsPerMin'),
  expiresAt: ns('expiresAt'),
  // extensions
  apiShape: ns('apiShape'),
  toolTransport: ns('toolTransport'),
  meteringBasis: ns('meteringBasis'),
  tokenizerKind: ns('tokenizerKind'),
  tokenizerDigest: ns('tokenizerDigest'),
  chatTemplate: ns('chatTemplate'),
  chatTemplateDigest: ns('chatTemplateDigest'),
  queryCostSchedule: ns('queryCostSchedule'),
  queryCostScheduleDigest: ns('queryCostScheduleDigest'),
  provenanceClass: ns('provenanceClass'),
  upstreamModel: ns('upstreamModel'),
  weightsDigest: ns('weightsDigest'),
  servingSeed: ns('servingSeed'),
  servingTemperature: ns('servingTemperature'),
  contextLength: ns('contextLength'),
  modelFamily: ns('modelFamily'),
  modelDisplayName: ns('modelDisplayName'),
  quantization: ns('quantization'),
  access: ns('access'),
} as const;

/** Core predicates: two distinct values on any of them skip the offer. */
export const MKT_CORE_PREDICATES: readonly string[] = [
  MKT.offeringId, MKT.serviceType, MKT.unit, MKT.askPerUnitWei, MKT.sellerIdentityId, MKT.sellerPeerId,
  MKT.sellerAddress, MKT.revision, MKT.modelId, MKT.capacityUnitsPerMin, MKT.expiresAt,
];

/** The published facts beyond the core offer (all optional). */
export type OfferExtensionFacts = Pick<MarketplaceOffer, 'apiShape' | 'toolTransport' | 'metering' | 'model' | 'queryCost' | 'access'>;

/** Upper bound of a published free-form string fact (display name, family, …). */
export const MAX_OFFER_FACT_CHARS = 256;
/** A (graph, offer) group with more triples than this is skipped. */
export const MAX_OFFER_GROUP_TRIPLES = 64;

/** A literal object (escaped). */
export function mktLiteral(value: string | bigint | number): string {
  return sparqlString(String(value));
}

/** Extension quads of one offering, in a stable order. */
export function buildOfferExtensionQuads(facts: OfferExtensionFacts, quad: (predicate: string, object: string) => Quad): Quad[] {
  const out: Quad[] = [];
  const add = (predicate: string, value: string | bigint | undefined) => {
    if (value !== undefined) out.push(quad(predicate, mktLiteral(value)));
  };
  add(MKT.apiShape, facts.apiShape);
  add(MKT.toolTransport, facts.toolTransport);
  if (facts.metering) {
    add(MKT.meteringBasis, facts.metering.basis);
    if (facts.metering.basis === 'pinned') {
      add(MKT.tokenizerKind, facts.metering.tokenizer.kind);
      add(MKT.tokenizerDigest, facts.metering.tokenizer.digest);
      add(MKT.chatTemplate, facts.metering.chatTemplate?.id);
      add(MKT.chatTemplateDigest, facts.metering.chatTemplate?.digest);
    }
  }
  add(MKT.queryCostSchedule, facts.queryCost?.schedule);
  add(MKT.queryCostScheduleDigest, facts.queryCost?.digest);
  const model = facts.model;
  if (model) {
    add(MKT.provenanceClass, model.provenanceClass);
    add(MKT.upstreamModel, model.upstreamModel);
    add(MKT.weightsDigest, model.weightsDigest);
    add(MKT.servingSeed, model.servingSeed);
    add(MKT.servingTemperature, model.servingTemperature);
    add(MKT.contextLength, model.contextLength);
    add(MKT.modelFamily, model.family);
    add(MKT.modelDisplayName, model.displayName);
    add(MKT.quantization, model.quantization);
  }
  if (facts.access === 'restricted') add(MKT.access, 'restricted');
  return out;
}

/**
 * Discovery: every `mkt:` triple of every offer subject, per graph. Grouped
 * by `(g, offer)` in TS (see the module comment) — no OPTIONAL, no LIMIT.
 */
export const DISCOVER_OFFER_TRIPLES_SPARQL = `PREFIX mkt: <${MKT_NAMESPACE}>
SELECT ?g ?offer ?p ?o WHERE {
  GRAPH ?g {
    ?offer a mkt:Offer ;
      ?p ?o .
    FILTER(STRSTARTS(STR(?p), "${MKT_NAMESPACE}"))
  }
}`;

export interface OfferTripleGroup {
  g: string;
  offer: string;
  /** predicate IRI → distinct RAW objects (still quoted literals). */
  values: Map<string, string[]>;
}

/** Group triple-scan rows by `(g, offer)`; groups over 64 distinct triples are dropped. */
export function groupOfferTriples(bindings: ReadonlyArray<Record<string, string>>): OfferTripleGroup[] {
  const groups = new Map<string, { group: OfferTripleGroup; seen: Set<string>; oversized: boolean }>();
  for (const row of bindings) {
    const g = row['g'];
    const offer = row['offer'];
    const p = row['p'];
    const o = row['o'];
    if (typeof g !== 'string' || typeof offer !== 'string' || typeof p !== 'string' || typeof o !== 'string') continue;
    const key = `${g}\u0000${offer}`;
    let entry = groups.get(key);
    if (!entry) {
      entry = { group: { g: strip(g), offer: strip(offer), values: new Map() }, seen: new Set(), oversized: false };
      groups.set(key, entry);
    }
    if (entry.oversized) continue;
    const predicate = strip(p);
    const tripleKey = `${predicate}\u0000${o}`;
    if (entry.seen.has(tripleKey)) continue;
    entry.seen.add(tripleKey);
    if (entry.seen.size > MAX_OFFER_GROUP_TRIPLES) {
      entry.oversized = true;
      entry.group.values.clear();
      continue;
    }
    const list = entry.group.values.get(predicate);
    if (list) list.push(o);
    else entry.group.values.set(predicate, [o]);
  }
  return [...groups.values()].filter((entry) => !entry.oversized).map((entry) => entry.group);
}

type Values = ReadonlyMap<string, readonly string[]>;
const DROP = Symbol('drop');

/** The single literal of a predicate: undefined when absent, DROP when duplicated or empty. */
function single(values: Values, predicate: string): string | undefined | typeof DROP {
  const raw = values.get(predicate);
  if (!raw || raw.length === 0) return undefined;
  if (raw.length > 1) return DROP;
  const value = stripLiteral(raw[0]);
  return value.length > 0 && value.length <= MAX_OFFER_FACT_CHARS ? value : DROP;
}

const DECIMAL = /^(0|[1-9]\d*)$/;

function parseMetering(values: Values): OfferMetering | undefined {
  const basis = single(values, MKT.meteringBasis);
  const kind = single(values, MKT.tokenizerKind);
  const digest = single(values, MKT.tokenizerDigest);
  const template = single(values, MKT.chatTemplate);
  const templateDigest = single(values, MKT.chatTemplateDigest);
  if ([basis, kind, digest, template, templateDigest].includes(DROP)) return undefined;
  if (basis === 'provider-reported') {
    return [kind, digest, template, templateDigest].every((v) => v === undefined) ? { basis } : undefined;
  }
  if (basis !== 'pinned' || !isTokenizerKind(kind) || typeof digest !== 'string' || !SHA256_DIGEST_PATTERN.test(digest)) {
    return undefined;
  }
  if (kind === 'stub-words-v1' && digest !== STUB_WORDS_DIGEST) return undefined;
  if ((template === undefined) !== (templateDigest === undefined)) return undefined;
  if (template !== undefined
    && (template !== CHAT_TEMPLATE_OPENAI_COUNT_V1.version || templateDigest !== CHAT_TEMPLATE_OPENAI_COUNT_V1_DIGEST)) {
    return undefined;
  }
  return {
    basis: 'pinned',
    tokenizer: { kind, digest },
    ...(template !== undefined ? { chatTemplate: { id: CHAT_TEMPLATE_OPENAI_COUNT_V1.version, digest: templateDigest as string } } : {}),
  };
}

function parseModel(values: Values): OfferModelFacts | undefined | typeof DROP {
  const read = (predicate: string) => single(values, predicate);
  const fields = {
    provenanceClass: read(MKT.provenanceClass),
    upstreamModel: read(MKT.upstreamModel),
    weightsDigest: read(MKT.weightsDigest),
    servingSeed: read(MKT.servingSeed),
    servingTemperature: read(MKT.servingTemperature),
    contextLength: read(MKT.contextLength),
    family: read(MKT.modelFamily),
    displayName: read(MKT.modelDisplayName),
    quantization: read(MKT.quantization),
  };
  if (Object.values(fields).includes(DROP)) return DROP;
  const f = fields as Record<keyof typeof fields, string | undefined>;
  if (f.provenanceClass !== undefined && !['weights-pinned', 'upstream-claimed', 'stub'].includes(f.provenanceClass)) return DROP;
  if (f.weightsDigest !== undefined && !SHA256_DIGEST_PATTERN.test(f.weightsDigest)) return DROP;
  if (f.servingSeed !== undefined && !/^-?(0|[1-9]\d*)$/.test(f.servingSeed)) return DROP;
  if (f.contextLength !== undefined
    && (!DECIMAL.test(f.contextLength) || BigInt(f.contextLength) <= 0n || BigInt(f.contextLength) > BigInt(Number.MAX_SAFE_INTEGER))) {
    return DROP;
  }
  const model: OfferModelFacts = {
    ...(f.provenanceClass !== undefined ? { provenanceClass: f.provenanceClass as OfferModelFacts['provenanceClass'] } : {}),
    ...(f.family !== undefined ? { family: f.family } : {}),
    ...(f.displayName !== undefined ? { displayName: f.displayName } : {}),
    ...(f.contextLength !== undefined ? { contextLength: BigInt(f.contextLength) } : {}),
    ...(f.quantization !== undefined ? { quantization: f.quantization } : {}),
    ...(f.weightsDigest !== undefined ? { weightsDigest: f.weightsDigest } : {}),
    ...(f.upstreamModel !== undefined ? { upstreamModel: f.upstreamModel } : {}),
    ...(f.servingSeed !== undefined ? { servingSeed: BigInt(f.servingSeed) } : {}),
    ...(f.servingTemperature !== undefined ? { servingTemperature: f.servingTemperature } : {}),
  };
  return Object.keys(model).length > 0 ? model : undefined;
}

/**
 * The extension groups of one offer. A malformed group (unknown enum, bad
 * digest, non-decimal numeric, a pin without kind+digest, a stub-words or
 * template pin with a foreign digest, a duplicated predicate) is dropped on
 * its own; the offer is kept. A well-formed query-cost pin that is not V1 is
 * KEPT so the buyer's recount reports `schedule-drift` (it sizes with V1).
 * `access` fails closed: any value other than a single `open` is `restricted`.
 */
export function parseOfferExtensions(values: Values): OfferExtensionFacts {
  const out: OfferExtensionFacts = {};
  const apiShape = single(values, MKT.apiShape);
  if (apiShape === CHAT_PAYLOAD_SCHEMA) out.apiShape = CHAT_PAYLOAD_SCHEMA;
  const toolTransport = single(values, MKT.toolTransport);
  if (toolTransport === 'native' || toolTransport === 'prompt' || toolTransport === 'none') out.toolTransport = toolTransport;
  const metering = parseMetering(values);
  if (metering) out.metering = metering;
  const model = parseModel(values);
  if (model !== undefined && model !== DROP) out.model = model;
  const schedule = single(values, MKT.queryCostSchedule);
  const scheduleDigest = single(values, MKT.queryCostScheduleDigest);
  if (typeof schedule === 'string' && typeof scheduleDigest === 'string' && SHA256_DIGEST_PATTERN.test(scheduleDigest)) {
    out.queryCost = { schedule, digest: scheduleDigest };
  }
  if (values.has(MKT.access)) out.access = single(values, MKT.access) === 'open' ? 'open' : 'restricted';
  return out;
}
