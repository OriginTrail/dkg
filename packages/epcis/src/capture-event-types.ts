const EPCIS_EVENT_TYPES = new Set([
  'ObjectEvent', 'AggregationEvent', 'TransactionEvent', 'TransformationEvent', 'AssociationEvent',
]);

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
        if (typeof record.type !== 'string' || !EPCIS_EVENT_TYPES.has(record.type)) return event;
        const type = `https://gs1.github.io/EPCIS/${record.type}`;
        // Full IRIs and the JSON-LD keyword are independent of @vocab and of
        // document-, property-, or event-scoped aliases for the `type` key.
        const existing = record['@type'];
        const types = existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
        return { ...record, '@type': [...new Set([...types, type])] };
      }),
    },
  };
}
