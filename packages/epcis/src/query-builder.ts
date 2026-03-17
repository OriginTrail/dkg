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
 * Normalize bizStep to full GS1 CBV URI.
 * Accepts shorthand like "assembling" or full URI "https://ref.gs1.org/cbv/BizStep-assembling".
 */
export function normalizeBizStep(value: string): string {
  if (!value || typeof value !== 'string') {
    throw new Error('Invalid bizStep value');
  }
  if (!value.includes('://')) {
    return `https://ref.gs1.org/cbv/BizStep-${value}`;
  }
  return value;
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

  // EPC filter
  if (params.epc) {
    const epcValue = escapeSparql(params.epc);
    if (params.fullTrace) {
      wherePatterns.push(`{
          { ?event epcis:epcList "${epcValue}" }
          UNION { ?event epcis:inputEPCList "${epcValue}" }
          UNION { ?event epcis:outputEPCList "${epcValue}" }
          UNION { ?event epcis:childEPCs "${epcValue}" }
          UNION { ?event epcis:parentID "${epcValue}" }
        }`);
    } else {
      wherePatterns.push(`?event epcis:epcList "${epcValue}" .`);
    }
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

  // BizLocation filter
  if (params.bizLocation) {
    wherePatterns.push(`?event epcis:bizLocation "${escapeSparql(params.bizLocation)}" .`);
  } else {
    optionalClauses.push('OPTIONAL { ?event epcis:bizLocation ?bizLocation . }');
  }

  // Time range filter
  if (params.from || params.to) {
    wherePatterns.push('?event epcis:eventTime ?eventTime .');
    if (params.from && params.to) {
      filterClauses.push(
        `FILTER(xsd:dateTime(?eventTime) >= xsd:dateTime("${escapeSparql(params.from)}") && xsd:dateTime(?eventTime) <= xsd:dateTime("${escapeSparql(params.to)}"))`,
      );
    } else if (params.from) {
      filterClauses.push(`FILTER(xsd:dateTime(?eventTime) >= xsd:dateTime("${escapeSparql(params.from)}"))`);
    } else if (params.to) {
      filterClauses.push(`FILTER(xsd:dateTime(?eventTime) <= xsd:dateTime("${escapeSparql(params.to)}"))`);
    }
  } else {
    optionalClauses.push('OPTIONAL { ?event epcis:eventTime ?eventTime . }');
  }

  // Always-optional fields
  optionalClauses.push('OPTIONAL { ?event epcis:disposition ?disposition . }');
  optionalClauses.push('OPTIONAL { ?event epcis:readPoint ?readPoint . }');
  optionalClauses.push('OPTIONAL { ?event epcis:action ?action . }');
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
ORDER BY DESC(?eventTime)
LIMIT ${limit}
OFFSET ${offset}`;
}
