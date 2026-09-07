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
