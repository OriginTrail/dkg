import type { EpcisQueryParams } from './types.js';

const PREFIXES = `
PREFIX epcis: <https://gs1.github.io/EPCIS/>
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

/**
 * Build a composite SPARQL query for EPCIS events.
 *
 * Adapted for v9's flat data graph model:
 * - Data lives in GRAPH <did:dkg:paranet:{id}>
 * - UAL provenance is resolved via OPTIONAL join to GRAPH <did:dkg:paranet:{id}/_meta>
 * - Groups by ?event (the event URI) instead of ?ual (the graph URI)
 */
export function buildEpcisQuery(params: EpcisQueryParams, paranetId: string): string {
  const dataGraph = `did:dkg:paranet:${paranetId}`;
  const metaGraph = `${dataGraph}/_meta`;

  const wherePatterns: string[] = [];
  const filterClauses: string[] = [];
  const optionalClauses: string[] = [];

  // Base pattern — always present
  wherePatterns.push('?event a ?eventType .');

  // Must be an EPCIS event type
  filterClauses.push('FILTER(STRSTARTS(STR(?eventType), "https://gs1.github.io/EPCIS/"))');

  // eventID filter — matches the RDF subject (the event's @id / rootEntity)
  if (params.eventID) {
    filterClauses.push(`FILTER(?event = <${escapeSparql(params.eventID)}>)`);
  }

  // eventType filter — narrow to a specific EPCIS event type
  if (params.eventType) {
    filterClauses.push(`FILTER(?eventType = <https://gs1.github.io/EPCIS/${escapeSparql(params.eventType)}>)`);
  }

  // EPC filter — UNION epcList + childEPCs per Section 8.2.7.1
  if (params.epc) {
    const epcValue = escapeSparql(params.epc);
    wherePatterns.push(`{
          { ?event epcis:epcList "${epcValue}" }
          UNION { ?event epcis:childEPCs "${epcValue}" }
        }`);
  }

  // anyEPC — 5-way UNION across all EPC fields
  if (params.anyEPC) {
    const epcValue = escapeSparql(params.anyEPC);
    wherePatterns.push(`{
          { ?event epcis:epcList "${epcValue}" }
          UNION { ?event epcis:childEPCs "${epcValue}" }
          UNION { ?event epcis:parentID "${epcValue}" }
          UNION { ?event epcis:inputEPCList "${epcValue}" }
          UNION { ?event epcis:outputEPCList "${epcValue}" }
        }`);
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

  // Pagination
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 1000);
  const offset = Math.max(params.offset ?? 0, 0);

  return `${PREFIXES}
SELECT ?event ?eventType ?eventTime ?bizStep ?bizLocation ?disposition ?readPoint ?action ?parentID ?ual
  (GROUP_CONCAT(DISTINCT ?epc; SEPARATOR=", ") AS ?epcList)
  (GROUP_CONCAT(DISTINCT ?childEPCs; SEPARATOR=", ") AS ?childEPCList)
  (GROUP_CONCAT(DISTINCT ?inputEPCList; SEPARATOR=", ") AS ?inputEPCs)
  (GROUP_CONCAT(DISTINCT ?outputEPCList; SEPARATOR=", ") AS ?outputEPCs)
WHERE {
  GRAPH <${dataGraph}> {
    ${wherePatterns.join('\n    ')}
    ${optionalClauses.join('\n    ')}
  }
  ${filterClauses.join('\n  ')}
  OPTIONAL {
    GRAPH <${metaGraph}> {
      ?ka dkg:rootEntity ?event .
      ?ka dkg:partOf ?ual .
    }
  }
}
GROUP BY ?event ?eventType ?eventTime ?bizStep ?bizLocation ?disposition ?readPoint ?action ?parentID ?ual
ORDER BY DESC(?eventTime) ?event
LIMIT ${limit}
OFFSET ${offset}`;
}
