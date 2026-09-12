import { assertEpcisQueryWindow, resolveEpcisQueryWindow, type EpcisQueryWindow } from './pagination.js';
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
import type { EpcisQueryParams, EpcisEventFilters, EpcisQueryScope, QueryEngine } from './types.js';
import { EPCIS_TYPE_PREFIX, EPCIS_CURRENT_PREFIX, EPCIS_NAMESPACES, EPCIS_STANDARD_EVENT_TYPES, normalizeEpcisEventType, standardEpcisEventType } from './epcis-vocabulary.js';

const PREFIXES = `
PREFIX epcis: <${EPCIS_TYPE_PREFIX}>
PREFIX epcisCurrent: <${EPCIS_CURRENT_PREFIX}>
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

/** VALUES keeps vocabulary alternatives out of Blazegraph's nested UNION path. */
function epcisPropertyPattern(property: string, object: string, purpose = 'value'): string {
  const predicate = `?_epcis_${property}_${purpose}`;
  return `{ VALUES ${predicate} { epcis:${property} epcisCurrent:${property} }
      ?event ${predicate} ${object} . }`;
}

function extensionLocalNameFilter(predicateVariable: string, localName: string): string {
  return `FILTER(REPLACE(STR(?${predicateVariable}), "^.*[/#]", "") = "${localName}")`;
}

/**
 * @deprecated Use createEpcisQueryPlan with separate filters, scope and row window.
 * Build a composite SPARQL query for EPCIS events.
 *
 * Adapted for v9's flat data graph model:
 * - Data lives in GRAPH <did:dkg:context-graph:{id}>
 * - UAL provenance is resolved via OPTIONAL join to GRAPH <did:dkg:context-graph:{id}/_meta>
 * - Groups by ?event (the event URI) instead of ?ual (the graph URI)
 */
export function buildEpcisQuery(params: EpcisQueryParams, contextGraphId: string): string {
  const { finalized = true, subGraphName, limit, offset, perPage: _perPage, ...filters } = params;
  return createEpcisQueryPlan(filters, { contextGraphId, finalized, subGraphName }, resolveEpcisQueryWindow({ limit, offset })).sparql;
}

/** The one scope resolution used by both SPARQL rendering and engine routing. */
function resolveEpcisQueryScope(scope: EpcisQueryScope) {
  const { contextGraphId } = scope;
  const partition = scope.finalized === false ? 'swm' : 'finalized';
  // Finalized subgraphs use the publisher target <cg>/<sub>; SWM targets
  // retain their context/shared-memory layout. Resolve both alongside engine routing.
  const publicGraph =
    partition === 'swm'
      ? contextGraphSharedMemoryUri(contextGraphId, scope.subGraphName)
      : scope.subGraphName
        ? contextGraphSubGraphUri(contextGraphId, scope.subGraphName)
        : contextGraphDataUri(contextGraphId);
  const metaGraph =
    partition === 'swm'
      ? contextGraphSharedMemoryMetaUri(contextGraphId, scope.subGraphName)
      : contextGraphMetaUri(contextGraphId);
  const privateGraph = scope.subGraphName
    ? contextGraphSubGraphPrivateUri(contextGraphId, scope.subGraphName)
    : contextGraphPrivateUri(contextGraphId);

  const options: NonNullable<Parameters<QueryEngine['query']>[1]> = {
    contextGraphId,
    subGraphName: scope.subGraphName,
    graphSuffix: scope.finalized ? undefined : '_shared_memory',
    includePrivate: true,
  };
  return { publicGraph, metaGraph, privateGraph, options };
}

/** Build one validated row window and its matching engine scope options. */
export function createEpcisQueryPlan(
  filters: EpcisEventFilters,
  scope: EpcisQueryScope,
  window: EpcisQueryWindow = resolveEpcisQueryWindow({}),
) {
  assertEpcisQueryWindow(window);
  const target = resolveEpcisQueryScope(scope);
  return { sparql: renderEpcisQuery(filters, target, window), options: target.options };
}

function renderEpcisQuery(
  params: EpcisEventFilters,
  { publicGraph, metaGraph, privateGraph }: ReturnType<typeof resolveEpcisQueryScope>,
  { limit, offset }: EpcisQueryWindow,
): string {
  const rootMembership = '?rootPublication dkg:rootEntity ?event .';
  const standardClasses = EPCIS_NAMESPACES.flatMap(prefix => EPCIS_STANDARD_EVENT_TYPES.map(name => sparqlIri(`${prefix}${name}`)));
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
  optionalClauses.push(`OPTIONAL ${epcisPropertyPattern('eventTimeZoneOffset', '?eventTimeZoneOffset')}`);

  // eventID filter — matches the RDF subject (the event's @id / rootEntity)
  if (params.eventID) {
    filterClauses.push(`FILTER(?event = <${escapeSparql(params.eventID)}>)`);
  }

  // eventType filter — narrow to a specific EPCIS event type
  if (params.eventType) {
    const standard = standardEpcisEventType(params.eventType);
    const types = standard
      ? EPCIS_NAMESPACES.map(prefix => `${prefix}${standard}`)
      : [normalizeEpcisEventType(params.eventType)];
    filterClauses.push(`FILTER(?eventType IN (${types.map(sparqlIri).join(', ')}))`);
  }

  // EPC filter — match epcList OR childEPCs per Section 8.2.7.1.
  // Uses VALUES + predicate variable instead of UNION to avoid
  // Blazegraph's nested-UnionNode crash when this lands inside a
  // GRAPH block that is itself part of an outer UNION.
  // Each filter gets its own scoped { VALUES ... } block so
  // the two predicate variables never collide when both are set.
  if (params.epc) {
    const epcValue = escapeSparql(params.epc);
    wherePatterns.push(`{ VALUES ?_epcPred { epcis:epcList epcisCurrent:epcList epcis:childEPCs epcisCurrent:childEPCs }
      ?event ?_epcPred ?_epcValue . FILTER(STR(?_epcValue) = "${epcValue}") }`);
  }

  // anyEPC — match across all 5 EPC fields (same VALUES approach,
  // own variable name to avoid collision with the epc filter above)
  if (params.anyEPC) {
    const epcValue = escapeSparql(params.anyEPC);
    wherePatterns.push(`{ VALUES ?_anyEpcPred { epcis:epcList epcisCurrent:epcList epcis:childEPCs epcisCurrent:childEPCs epcis:parentID epcisCurrent:parentID epcis:inputEPCList epcisCurrent:inputEPCList epcis:outputEPCList epcisCurrent:outputEPCList }
      ?event ?_anyEpcPred ?_anyEpcValue . FILTER(STR(?_anyEpcValue) = "${epcValue}") }`);
  }
  optionalClauses.push(`OPTIONAL ${epcisPropertyPattern('epcList', '?epc')}`);

  // Parent ID filter (AggregationEvent)
  if (params.parentID) {
    wherePatterns.push(epcisPropertyPattern('parentID', '?_parentIDMatch', 'filter'));
    filterClauses.push(`FILTER(STR(?_parentIDMatch) = "${escapeSparql(params.parentID)}" )`);
  }

  // Child EPCs filter (AggregationEvent)
  if (params.childEPC) {
    wherePatterns.push(epcisPropertyPattern('childEPCs', '?_childEPCMatch', 'filter'));
    filterClauses.push(`FILTER(STR(?_childEPCMatch) = "${escapeSparql(params.childEPC)}" )`);
  }

  // Input EPCs filter (TransformationEvent)
  if (params.inputEPC) {
    wherePatterns.push(epcisPropertyPattern('inputEPCList', '?_inputEPCMatch', 'filter'));
    filterClauses.push(`FILTER(STR(?_inputEPCMatch) = "${escapeSparql(params.inputEPC)}" )`);
  }

  // Output EPCs filter (TransformationEvent)
  if (params.outputEPC) {
    wherePatterns.push(epcisPropertyPattern('outputEPCList', '?_outputEPCMatch', 'filter'));
    filterClauses.push(`FILTER(STR(?_outputEPCMatch) = "${escapeSparql(params.outputEPC)}" )`);
  }

  // BizStep filter
  if (params.bizStep) {
    const bizStepUri = normalizeBizStep(params.bizStep);
    wherePatterns.push(epcisPropertyPattern('bizStep', '?bizStep'));
    filterClauses.push(`FILTER(STR(?bizStep) = "${escapeSparql(bizStepUri)}")`);
  } else {
    optionalClauses.push(`OPTIONAL ${epcisPropertyPattern('bizStep', '?bizStep')}`);
  }

  // BizLocation filter — JSON-LD stores bizLocation as a URI node, match with angle brackets.
  // Also bind ?bizLocation so it appears in SELECT results for toEpcisEvent.
  if (params.bizLocation) {
    wherePatterns.push(epcisPropertyPattern('bizLocation', `<${escapeSparql(params.bizLocation)}>`, 'filter'));
    optionalClauses.push(`OPTIONAL ${epcisPropertyPattern('bizLocation', '?bizLocation')}`);
  } else {
    optionalClauses.push(`OPTIONAL ${epcisPropertyPattern('bizLocation', '?bizLocation')}`);
  }

  // Time range filter
  if (params.from || params.to) {
    wherePatterns.push(epcisPropertyPattern('eventTime', '?eventTime'));
    if (params.from && params.to) {
      filterClauses.push(
        `FILTER(xsd:dateTime(STR(?eventTime)) >= xsd:dateTime("${escapeSparql(params.from)}") && xsd:dateTime(STR(?eventTime)) < xsd:dateTime("${escapeSparql(params.to)}"))`,
      );
    } else if (params.from) {
      filterClauses.push(`FILTER(xsd:dateTime(STR(?eventTime)) >= xsd:dateTime("${escapeSparql(params.from)}"))`);
    } else if (params.to) {
      filterClauses.push(`FILTER(xsd:dateTime(STR(?eventTime)) < xsd:dateTime("${escapeSparql(params.to)}"))`);
    }
  } else {
    optionalClauses.push(`OPTIONAL ${epcisPropertyPattern('eventTime', '?eventTime')}`);
  }

  // Action filter — required when filtered, OPTIONAL otherwise
  if (params.action) {
    wherePatterns.push(epcisPropertyPattern('action', '?action'));
    filterClauses.push(`FILTER(STR(?action) = "${escapeSparql(params.action)}")`);
  } else {
    optionalClauses.push(`OPTIONAL ${epcisPropertyPattern('action', '?action')}`);
  }

  // Disposition filter — required when filtered, OPTIONAL otherwise
  if (params.disposition) {
    const dispUri = normalizeGs1Vocabulary('Disp', params.disposition);
    wherePatterns.push(epcisPropertyPattern('disposition', '?disposition'));
    filterClauses.push(`FILTER(STR(?disposition) = "${escapeSparql(dispUri)}")`);
  } else {
    optionalClauses.push(`OPTIONAL ${epcisPropertyPattern('disposition', '?disposition')}`);
  }

  // ReadPoint filter — JSON-LD stores readPoint as a URI node, match with angle brackets.
  // Also bind ?readPoint so it appears in SELECT results for toEpcisEvent.
  if (params.readPoint) {
    wherePatterns.push(epcisPropertyPattern('readPoint', `<${escapeSparql(params.readPoint)}>`, 'filter'));
    optionalClauses.push(`OPTIONAL ${epcisPropertyPattern('readPoint', '?readPoint')}`);
  } else {
    optionalClauses.push(`OPTIONAL ${epcisPropertyPattern('readPoint', '?readPoint')}`);
  }
  optionalClauses.push(`OPTIONAL ${epcisPropertyPattern('parentID', '?parentID')}`);
  optionalClauses.push(`OPTIONAL ${epcisPropertyPattern('childEPCs', '?childEPCs')}`);
  optionalClauses.push(`OPTIONAL ${epcisPropertyPattern('inputEPCList', '?inputEPCList')}`);
  optionalClauses.push(`OPTIONAL ${epcisPropertyPattern('outputEPCList', '?outputEPCList')}`);

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
  (GROUP_CONCAT(DISTINCT STR(?epc); SEPARATOR=", ") AS ?epcList)
  (GROUP_CONCAT(DISTINCT STR(?childEPCs); SEPARATOR=", ") AS ?childEPCList)
  (GROUP_CONCAT(DISTINCT STR(?inputEPCList); SEPARATOR=", ") AS ?inputEPCs)
  (GROUP_CONCAT(DISTINCT STR(?outputEPCList); SEPARATOR=", ") AS ?outputEPCs)
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
ORDER BY DESC(xsd:dateTime(STR(?eventTime))) ?event
LIMIT ${limit}
OFFSET ${offset}`;
}
