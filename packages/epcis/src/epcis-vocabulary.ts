import { isSafeIri } from '@origintrail-official/dkg-core';
import { EpcisQueryValidationError } from './query-validation.js';

export const EPCIS_TYPE_PREFIX = 'https://gs1.github.io/EPCIS/';
export const EPCIS_CURRENT_PREFIX = 'https://ref.gs1.org/epcis/';
export const EPCIS_NAMESPACES = [EPCIS_TYPE_PREFIX, EPCIS_CURRENT_PREFIX] as const;
export const EPCIS_STANDARD_EVENT_TYPES = Object.freeze([
  'ObjectEvent', 'AggregationEvent', 'TransactionEvent', 'TransformationEvent', 'AssociationEvent',
] as const);

export type StandardEpcisEventType = typeof EPCIS_STANDARD_EVENT_TYPES[number];

/** Recognize only the five standard classes, in compact or canonical form. */
export function standardEpcisEventType(value: string): StandardEpcisEventType | undefined {
  return EPCIS_STANDARD_EVENT_TYPES.find((name) => value === name || EPCIS_NAMESPACES.some(prefix => value === `${prefix}${name}`));
}

/** Extended event IRIs retain their namespace when returned by the query API. */
export function compactEpcisEventType(value: string): string {
  return standardEpcisEventType(value) ?? value;
}

/** Canonicalize query types, including the legacy compact extension-name form. */
export function normalizeEpcisEventType(value: string): string {
  const standard = standardEpcisEventType(value);
  if (standard) return `${EPCIS_TYPE_PREFIX}${standard}`;
  if (isSafeIri(value)) return value;
  // Older responses compacted every class in this namespace. Retain those
  // local-name filters without mistaking them for standard schema classes.
  if (/^[A-Za-z][A-Za-z0-9._-]*$/.test(value)) return `${EPCIS_TYPE_PREFIX}${value}`;
  throw new EpcisQueryValidationError('eventType must be a standard EPCIS event name or an absolute event type IRI');
}
