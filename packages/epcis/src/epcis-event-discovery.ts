import { sparqlIri } from '@origintrail-official/dkg-core';
import { EPCIS_NAMESPACES, EPCIS_STANDARD_EVENT_TYPES, EPCIS_TYPE_PREFIX, epcisPropertyIris, standardEpcisEventIris } from './epcis-vocabulary.js';

interface EventDiscoveryContext {
  metaGraph: string;
  source: 'public' | 'anchored-private';
  partition: 'swm' | 'finalized';
}

/**
 * Discover unfiltered events inside their data GRAPH. Declaration takes
 * precedence over legacy class/shape evidence. Only anchored private SWM
 * may use timing evidence in place of document or publication membership.
 */
export function buildEpcisEventDiscoveryPattern({ metaGraph, source, partition }: EventDiscoveryContext): string {
  const standardTypes = standardEpcisEventIris().map(sparqlIri).join(', ');
  const properties = (field: string) => epcisPropertyIris(field).map(sparqlIri).join(' ');
  const rootEvidence = [
    `EXISTS { VALUES ?_eventListPred { ${properties('eventList')} }
      ?_eventList ?_eventListPred ?event . }`,
    `EXISTS { GRAPH ${sparqlIri(metaGraph)} { ?_rootPublication dkg:rootEntity ?event . } }`,
  ];
  if (source === 'anchored-private' && partition === 'swm') {
    rootEvidence.push(`EXISTS { VALUES ?_privateEventEvidencePred { ${properties('eventTime')} }
      ?event ?_privateEventEvidencePred ?_privateEventEvidence . }`);
  }
  // Membership identifies the event subject, not its discriminator. Prefer
  // a standard class; legacy GS1 extension classes need both timing fields.
  const standardType = `?eventType IN (${standardTypes})`;
  const gs1Type = EPCIS_NAMESPACES.map(prefix =>
    `STRSTARTS(STR(?eventType), "${prefix}")`).join(' || ');
  const timingEvidence = ['eventTime', 'eventTimeZoneOffset'].map(field =>
    `EXISTS { VALUES ?_epcis_${field}_evidence { ${properties(field)} }
      ?event ?_epcis_${field}_evidence ?_typeEvidence_${field} . }`).join(' && ');
  const noStandardType = `NOT EXISTS { ?event a ?_standardEventType .
      FILTER(?_standardEventType IN (${standardTypes})) }`;
  const legacyType = `(${standardType} || ((${gs1Type}) && ${timingEvidence} && ${noStandardType}))`;
  return `FILTER(BOUND(?_declaredEventType) || (${legacyType} && (${rootEvidence.join(' || ')})))`;
}

/**
 * Group equivalent standard types under the capture vocabulary's canonical
 * identity, including when aliases occur in different admitted data graphs.
 * Declaration checks use the raw class before grouping; extensions stay exact.
 */
export function buildEpcisEventTypeBinding(): string {
  const expression = EPCIS_STANDARD_EVENT_TYPES.reduceRight((fallback, name) => {
    const aliases = standardEpcisEventIris(name).map(sparqlIri).join(', ');
    return `IF(?_rawEventType IN (${aliases}), ${sparqlIri(`${EPCIS_TYPE_PREFIX}${name}`)}, ${fallback})`;
  }, '?_rawEventType');
  return `BIND(${expression} AS ?eventType)`;
}
