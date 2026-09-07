const EPCIS_EVENT_TYPES = new Set([
  'ObjectEvent', 'AggregationEvent', 'TransactionEvent', 'TransformationEvent', 'AssociationEvent',
]);
const EPCIS_TYPE_PREFIX = 'https://gs1.github.io/EPCIS/';

/** Preserve caller vocabulary mappings while making standard EPCIS event types explicit. */
export function normalizeCaptureEventTypes(document: unknown): unknown {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return document;
  const doc = document as Record<string, unknown>;
  const body = doc.epcisBody;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return document;
  const eventList = (body as Record<string, unknown>).eventList;
  if (!Array.isArray(eventList)) return document;
  return {
    ...doc,
    epcisBody: {
      ...body,
      eventList: eventList.map((event: unknown) => {
        if (!event || typeof event !== 'object' || Array.isArray(event)) return event;
        const record = event as Record<string, unknown>;
        if (typeof record.type !== 'string') return event;
        const name = record.type.startsWith(EPCIS_TYPE_PREFIX)
          ? record.type.slice(EPCIS_TYPE_PREFIX.length)
          : record.type;
        if (!EPCIS_EVENT_TYPES.has(name)) return event;
        const type = `${EPCIS_TYPE_PREFIX}${name}`;
        // Full IRIs and the JSON-LD keyword are independent of @vocab and of
        // document-, property-, or event-scoped aliases for the `type` key.
        const existing = record['@type'];
        const types = existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
        return { ...record, '@type': [...new Set([...types, type])] };
      }),
    },
  };
}
