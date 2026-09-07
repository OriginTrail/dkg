import { isSafeIri } from '@origintrail-official/dkg-core';

export const EPCIS_TYPE_PREFIX = 'https://gs1.github.io/EPCIS/';
export const EPCIS_STANDARD_EVENT_TYPES = Object.freeze([
  'ObjectEvent', 'AggregationEvent', 'TransactionEvent', 'TransformationEvent', 'AssociationEvent',
] as const);

export type StandardEpcisEventType = typeof EPCIS_STANDARD_EVENT_TYPES[number];

/** Recognize only the five standard classes, in compact or canonical form. */
export function standardEpcisEventType(value: string): StandardEpcisEventType | undefined {
  return EPCIS_STANDARD_EVENT_TYPES.find((name) => value === name || value === `${EPCIS_TYPE_PREFIX}${name}`);
}

/** Extended event IRIs retain their namespace when returned by the query API. */
export function compactEpcisEventType(value: string): string {
  return standardEpcisEventType(value) ?? value;
}

export class EpcisEventTypeError extends Error {
  constructor() {
    super('eventType must be a standard EPCIS event name or an absolute event type IRI');
    this.name = 'EpcisEventTypeError';
  }
}

/** Expand only defined EPCIS short names; other inputs must already be absolute IRIs. */
export function normalizeEpcisEventType(value: string): string {
  const standard = standardEpcisEventType(value);
  if (standard) return `${EPCIS_TYPE_PREFIX}${standard}`;
  if (!isSafeIri(value)) throw new EpcisEventTypeError();
  return value;
}
