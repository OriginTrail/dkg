import { isSafeIri } from '@origintrail-official/dkg-core';

/** Capture discriminator, independent of auxiliary rdf:type assertions. */
export const EPCIS_DECLARED_EVENT_TYPE = 'http://dkg.io/ontology/epcisEventType';

export const EPCIS_TYPE_PREFIX = 'https://gs1.github.io/EPCIS/';
export const EPCIS_STANDARD_EVENT_TYPES = Object.freeze([
  'ObjectEvent', 'AggregationEvent', 'TransactionEvent', 'TransformationEvent', 'AssociationEvent',
] as const);

export type StandardEpcisEventType = typeof EPCIS_STANDARD_EVENT_TYPES[number];

export type ResolvedEpcisEventType =
  | { kind: 'standard'; iri: string; name: StandardEpcisEventType }
  | { kind: 'gs1-extension' | 'external' | 'legacy-gs1-extension'; iri: string };

/** Own canonical identity and category, including query-only legacy local names. */
export function resolveEpcisEventType(value: string): ResolvedEpcisEventType | undefined {
  const name = EPCIS_STANDARD_EVENT_TYPES.find((name) => value === name || value === `${EPCIS_TYPE_PREFIX}${name}`);
  if (name) return { kind: 'standard', name, iri: `${EPCIS_TYPE_PREFIX}${name}` };
  if (isSafeIri(value)) return {
    kind: value.startsWith(EPCIS_TYPE_PREFIX) ? 'gs1-extension' : 'external', iri: value,
  };
  // Historical responses compacted every GS1 class. Accept their query aliases,
  // while keeping them distinct from valid capture discriminators.
  if (/^[A-Za-z][A-Za-z0-9._-]*$/.test(value)) {
    return { kind: 'legacy-gs1-extension', iri: `${EPCIS_TYPE_PREFIX}${value}` };
  }
  return undefined;
}

/** Recognize only standard schema discriminators, in compact or canonical form. */
export function standardEpcisEventType(value: string): StandardEpcisEventType | undefined {
  const resolved = resolveEpcisEventType(value);
  return resolved?.kind === 'standard' ? resolved.name : undefined;
}

/** Standard responses stay compact; extension IRIs retain their exact namespace. */
export function compactEpcisEventType(value: string): string {
  const resolved = resolveEpcisEventType(value);
  return resolved?.kind === 'standard' ? resolved.name : value;
}
