import { sparqlIri } from '@origintrail-official/dkg-core';
import { EPCIS_NAMESPACES, EPCIS_STANDARD_EVENT_TYPES, epcisPropertyIris, standardEpcisEventIris } from './epcis-vocabulary.js';

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
 * Equivalent standard classes must consume one pagination slot. Prefer the
 * later accepted namespace when both are asserted, but never override an
 * explicit capture discriminator or collapse distinct extension IRIs.
 * Keep this inside the same data GRAPH as the event's rdf:type bindings.
 */
export function buildEpcisEventTypePreferencePattern(): string {
  const equivalentTypes = EPCIS_STANDARD_EVENT_TYPES.flatMap(name => {
    const iris = standardEpcisEventIris(name);
    return iris.flatMap((iri, index) => iris.slice(index + 1).map(preferred =>
      `(?eventType = ${sparqlIri(iri)} && EXISTS { ?event a ${sparqlIri(preferred)} . })`));
  }).join(' || ');
  // Use constant type tests: Blazegraph does not reliably correlate an outer
  // eventType through a VALUES-bound alias pair inside FILTER NOT EXISTS.
  return `FILTER(BOUND(?_declaredEventType) || !(${equivalentTypes}))`;
}
