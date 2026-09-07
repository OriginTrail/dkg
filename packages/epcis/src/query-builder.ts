import { EpcisPaginationPlan } from './pagination.js';
import {
  contextGraphDataUri,
  contextGraphMetaUri,
  contextGraphPrivateUri,
  contextGraphSharedMemoryUri,
  contextGraphSharedMemoryMetaUri,
  contextGraphSubGraphPrivateUri,
  contextGraphSubGraphUri,
  sparqlIri,
} from '@origintrail-official/dkg-core';
import type { EpcisQueryParams } from './types.js';
import { EPCIS_TYPE_PREFIX, EPCIS_STANDARD_EVENT_TYPES, normalizeEpcisEventType } from './epcis-vocabulary.js';

const PREFIXES = `
PREFIX epcis: <${EPCIS_TYPE_PREFIX}>
PREFIX epcisCurrent: <https://ref.gs1.org/epcis/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
PREFIX dkg: <http://dkg.io/ontology/>
`;

/** Escape special characters in SPARQL string literals. */
export function escapeSparql(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Normalize a GS1 CBV vocabulary value to a full URI.
 * Accepts shorthand (e.g., "assembling" with prefix "BizStep") or full URI passthrough.
 */
export function normalizeGs1Vocabulary(prefix: 'BizStep' | 'Disp', value: string): string {
  if (!value || typeof value !== 'string') {
    throw new Error(`Invalid ${prefix} value`);
  }
  if (!value.includes('://')) {
    return `https://ref.gs1.org/cbv/${prefix}-${value}`;
  }
  return value;
}

/**
 * Normalize bizStep to full GS1 CBV URI.
 * Accepts shorthand like "assembling" or full URI "https://ref.gs1.org/cbv/BizStep-assembling".
 */
export function normalizeBizStep(value: string): string {
  if (!value || typeof value !== 'string') {
    throw new Error('Invalid bizStep value');
  }
  return normalizeGs1Vocabulary('BizStep', value);
}

function extensionLocalNameFilter(predicateVariable: string, localName: string): string {
  return `FILTER(REPLACE(STR(?${predicateVariable}), "^.*[/#]", "") = "${localName}")`;
}

/**
 * Build a composite SPARQL query for EPCIS events.
 *
 * Adapted for v9's flat data graph model:
 * - Data lives in GRAPH <did:dkg:context-graph:{id}>
 * - UAL provenance is resolved via OPTIONAL join to GRAPH <did:dkg:context-graph:{id}/_meta>
 * - Groups by ?event (the event URI) instead of ?ual (the graph URI)
 */
export function buildEpcisQuery(params: EpcisQueryParams, contextGraphId: string): string {
  const page = new EpcisPaginationPlan(params.limit, params.offset, 100);
  return renderEpcisQuery(params, contextGraphId, page.pageSize, page.offset);
}

type EpcisEventFilters = Omit<EpcisQueryParams, 'limit' | 'offset' | 'perPage'>;

/** Build a request page from its already-normalized plan; no wire pagination is re-read. */
export function buildEpcisPageQuery(
  filters: EpcisEventFilters,
  contextGraphId: string,
  page: EpcisPaginationPlan,
): string {
  return renderEpcisQuery(filters, contextGraphId, page.queryRowLimit, page.offset);
}

function renderEpcisQuery(
  params: EpcisEventFilters,
  contextGraphId: string,
  limit: number,
  offset: number,
): string {
  const partition = params.finalized === false ? 'swm' : 'finalized';
  // Finalized data lands at `<cg>/<sub>` when a sub-graph is targeted —
  // see `packages/agent/src/finalization-handler.ts:358-362`, which
  // calls `contextGraphSubGraphUri(contextGraphId, subGraphName)`.
  // Earlier this branch used `contextGraphDataUri(cg, sub)` which yields
  // `<cg>/context/<sub>` — a different graph URI than where the publisher
  // actually writes, so finalized sub-graph queries returned zero events
  // whenever `subGraphName` was set. The unsub-graph (cg-only) finalized
  // URI keeps `contextGraphDataUri`'s single-arg fallback (`<cg>`).
  const publicGraph =
    partition === 'swm'
      ? contextGraphSharedMemoryUri(contextGraphId, params.subGraphName)
      : params.subGraphName
        ? contextGraphSubGraphUri(contextGraphId, params.subGraphName)
        : contextGraphDataUri(contextGraphId);
  const metaGraph =
    partition === 'swm'
      ? contextGraphSharedMemoryMetaUri(contextGraphId, params.subGraphName)
      : contextGraphMetaUri(contextGraphId);
  const privateGraph = params.subGraphName
    ? contextGraphSubGraphPrivateUri(contextGraphId, params.subGraphName)
    : contextGraphPrivateUri(contextGraphId);

  const rootMembership = '?rootPublication dkg:rootEntity ?event .';
  const standardClasses = EPCIS_STANDARD_EVENT_TYPES.map((name) => sparqlIri(`${EPCIS_TYPE_PREFIX}${name}`));
  const wherePatterns: string[] = [];
  const filterClauses: string[] = [];
  const optionalClauses: string[] = [];

  wherePatterns.push('?event a ?eventType .');
  // Modern captures identify their event-list members explicitly. Historical
  // direct-RDF publications identify standard event roots in canonical metadata
  // (both per-token and collapsed UAL subjects retain dkg:rootEntity).
  wherePatterns.push(`FILTER(EXISTS { ?_eventList (epcis:eventList|epcisCurrent:eventList) ?event . }
    || (?eventType IN (${standardClasses.join(', ')})
      && EXISTS { GRAPH <${metaGraph}> { ${rootMembership} } }))`);
  optionalClauses.push('OPTIONAL { ?event epcis:eventTimeZoneOffset ?eventTimeZoneOffset . }');

  // eventID filter — matches the RDF subject (the event's @id / rootEntity)
  if (params.eventID) {
    filterClauses.push(`FILTER(?event = <${escapeSparql(params.eventID)}>)`);
  }

  // eventType filter — narrow to a specific EPCIS event type
  if (params.eventType) {
    const typeIri = normalizeEpcisEventType(params.eventType);
    filterClauses.push(`FILTER(?eventType = ${sparqlIri(typeIri)})`);
  }

  // EPC filter — match epcList OR childEPCs per Section 8.2.7.1.
  // Uses VALUES + predicate variable instead of UNION to avoid
  // Blazegraph's nested-UnionNode crash when this lands inside a
  // GRAPH block that is itself part of an outer UNION.
  // Each filter gets its own scoped { VALUES ... } block so
  // the two predicate variables never collide when both are set.
  if (params.epc) {
    const epcValue = escapeSparql(params.epc);
    wherePatterns.push(`{ VALUES ?_epcPred { epcis:epcList epcis:childEPCs }
      ?event ?_epcPred "${epcValue}" . }`);
  }

  // anyEPC — match across all 5 EPC fields (same VALUES approach,
  // own variable name to avoid collision with the epc filter above)
  if (params.anyEPC) {
    const epcValue = escapeSparql(params.anyEPC);
    wherePatterns.push(`{ VALUES ?_anyEpcPred { epcis:epcList epcis:childEPCs epcis:parentID epcis:inputEPCList epcis:outputEPCList }
      ?event ?_anyEpcPred "${epcValue}" . }`);
  }
  optionalClauses.push('OPTIONAL { ?event epcis:epcList ?epc . }');

  // Parent ID filter (AggregationEvent)
  if (params.parentID) {
    wherePatterns.push(`?event epcis:parentID "${escapeSparql(params.parentID)}" .`);
  }

  // Child EPCs filter (AggregationEvent)
  if (params.childEPC) {
    wherePatterns.push(`?event epcis:childEPCs "${escapeSparql(params.childEPC)}" .`);
  }

  // Input EPCs filter (TransformationEvent)
  if (params.inputEPC) {
    wherePatterns.push(`?event epcis:inputEPCList "${escapeSparql(params.inputEPC)}" .`);
  }

  // Output EPCs filter (TransformationEvent)
  if (params.outputEPC) {
    wherePatterns.push(`?event epcis:outputEPCList "${escapeSparql(params.outputEPC)}" .`);
  }

  // BizStep filter
  if (params.bizStep) {
    const bizStepUri = normalizeBizStep(params.bizStep);
    wherePatterns.push('?event epcis:bizStep ?bizStep .');
    filterClauses.push(`FILTER(STR(?bizStep) = "${escapeSparql(bizStepUri)}")`);
  } else {
    optionalClauses.push('OPTIONAL { ?event epcis:bizStep ?bizStep . }');
  }

  // BizLocation filter — JSON-LD stores bizLocation as a URI node, match with angle brackets.
  // Also bind ?bizLocation so it appears in SELECT results for toEpcisEvent.
  if (params.bizLocation) {
    wherePatterns.push(`?event epcis:bizLocation <${escapeSparql(params.bizLocation)}> .`);
    optionalClauses.push('OPTIONAL { ?event epcis:bizLocation ?bizLocation . }');
  } else {
    optionalClauses.push('OPTIONAL { ?event epcis:bizLocation ?bizLocation . }');
  }

  // Time range filter
  if (params.from || params.to) {
    wherePatterns.push('?event epcis:eventTime ?eventTime .');
    if (params.from && params.to) {
      filterClauses.push(
        `FILTER(xsd:dateTime(?eventTime) >= xsd:dateTime("${escapeSparql(params.from)}") && xsd:dateTime(?eventTime) < xsd:dateTime("${escapeSparql(params.to)}"))`,
      );
    } else if (params.from) {
      filterClauses.push(`FILTER(xsd:dateTime(?eventTime) >= xsd:dateTime("${escapeSparql(params.from)}"))`);
    } else if (params.to) {
      filterClauses.push(`FILTER(xsd:dateTime(?eventTime) < xsd:dateTime("${escapeSparql(params.to)}"))`);
    }
  } else {
    optionalClauses.push('OPTIONAL { ?event epcis:eventTime ?eventTime . }');
  }

  // Action filter — required when filtered, OPTIONAL otherwise
  if (params.action) {
    wherePatterns.push('?event epcis:action ?action .');
    filterClauses.push(`FILTER(STR(?action) = "${escapeSparql(params.action)}")`);
  } else {
    optionalClauses.push('OPTIONAL { ?event epcis:action ?action . }');
  }

  // Disposition filter — required when filtered, OPTIONAL otherwise
  if (params.disposition) {
    const dispUri = normalizeGs1Vocabulary('Disp', params.disposition);
    wherePatterns.push('?event epcis:disposition ?disposition .');
    filterClauses.push(`FILTER(STR(?disposition) = "${escapeSparql(dispUri)}")`);
  } else {
    optionalClauses.push('OPTIONAL { ?event epcis:disposition ?disposition . }');
  }

  // ReadPoint filter — JSON-LD stores readPoint as a URI node, match with angle brackets.
  // Also bind ?readPoint so it appears in SELECT results for toEpcisEvent.
  if (params.readPoint) {
    wherePatterns.push(`?event epcis:readPoint <${escapeSparql(params.readPoint)}> .`);
    optionalClauses.push('OPTIONAL { ?event epcis:readPoint ?readPoint . }');
  } else {
    optionalClauses.push('OPTIONAL { ?event epcis:readPoint ?readPoint . }');
  }
  optionalClauses.push('OPTIONAL { ?event epcis:parentID ?parentID . }');
  optionalClauses.push('OPTIONAL { ?event epcis:childEPCs ?childEPCs . }');
  optionalClauses.push('OPTIONAL { ?event epcis:inputEPCList ?inputEPCList . }');
  optionalClauses.push('OPTIONAL { ?event epcis:outputEPCList ?outputEPCList . }');

  // Extension identifiers carried as JSON-LD triples. Match by predicate local
  // name so project-specific ontologies stay outside the generic DKG EPCIS API.
  if (params.configurationId) {
    wherePatterns.push(`?event ?configurationIdPredicate ?configurationId .
      ${extensionLocalNameFilter('configurationIdPredicate', 'configurationId')}`);
    filterClauses.push(`FILTER(STR(?configurationId) = "${escapeSparql(params.configurationId)}")`);
  } else {
    optionalClauses.push(`OPTIONAL { ?event ?configurationIdPredicate ?configurationId .
      ${extensionLocalNameFilter('configurationIdPredicate', 'configurationId')} }`);
  }

  if (params.shipmentId) {
    wherePatterns.push(`?event ?shipmentIdPredicate ?shipmentId .
      ${extensionLocalNameFilter('shipmentIdPredicate', 'shipmentId')}`);
    filterClauses.push(`FILTER(STR(?shipmentId) = "${escapeSparql(params.shipmentId)}")`);
  } else {
    optionalClauses.push(`OPTIONAL { ?event ?shipmentIdPredicate ?shipmentId .
      ${extensionLocalNameFilter('shipmentIdPredicate', 'shipmentId')} }`);
  }

  const graphBody = [
    ...wherePatterns,
    ...optionalClauses,
  ].join('\n      ');

  // sparql-scan-allow: R3 -- legacy offset is validated <= 10000, page <= 1000 (+1 lookahead); deeper walks fail and require narrower filters.
  return `${PREFIXES}
SELECT ?event ?eventType ?eventTime ?eventTimeZoneOffset ?bizStep ?bizLocation ?disposition ?readPoint ?action ?parentID ?configurationId ?shipmentId ?ual
  (GROUP_CONCAT(DISTINCT ?epc; SEPARATOR=", ") AS ?epcList)
  (GROUP_CONCAT(DISTINCT ?childEPCs; SEPARATOR=", ") AS ?childEPCList)
  (GROUP_CONCAT(DISTINCT ?inputEPCList; SEPARATOR=", ") AS ?inputEPCs)
  (GROUP_CONCAT(DISTINCT ?outputEPCList; SEPARATOR=", ") AS ?outputEPCs)
WHERE {
  {
    GRAPH <${publicGraph}> {
      ${graphBody}
    }
  }
  union
  {
    GRAPH <${publicGraph}> {
      ?event dkg:privateDataAnchor "true" .
    }
    GRAPH <${privateGraph}> {
      ${graphBody}
    }
  }
  ${filterClauses.join('\n  ')}
  OPTIONAL {
    GRAPH <${metaGraph}> {
      ${rootMembership}
      { ?rootPublication dkg:partOf ?ual . }
      union
      { ?rootPublication dkg:batchId ?ualBid . BIND(?rootPublication AS ?ual) }
    }
  }
}
GROUP BY ?event ?eventType ?eventTime ?eventTimeZoneOffset ?bizStep ?bizLocation ?disposition ?readPoint ?action ?parentID ?configurationId ?shipmentId ?ual
ORDER BY DESC(?eventTime) ?event
LIMIT ${limit}
OFFSET ${offset}`;
}
