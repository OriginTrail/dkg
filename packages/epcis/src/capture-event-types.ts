import { EPCIS_TYPE_PREFIX, standardEpcisEventType } from './epcis-vocabulary.js';

/** Preserve caller vocabulary mappings while making standard EPCIS event types explicit. */
export function normalizeCaptureEventTypes(document: unknown): unknown {
  return mapEpcisEventList(document, (record) => {
    if (typeof record.type !== 'string') return record;
    const name = standardEpcisEventType(record.type);
    if (!name) return record;
    const type = `${EPCIS_TYPE_PREFIX}${name}`;
    // Full IRIs and the JSON-LD keyword are independent of @vocab and of
    // document-, property-, or event-scoped aliases for the `type` key.
    const existing = record['@type'];
    const types = existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
    return { ...record, '@type': [...new Set([...types, type])] };
  });
}

/** Adapt only event-list discriminators for the unmodified bundled GS1 schema. */
export function epcisDocumentForValidation(document: unknown): unknown {
  return mapEpcisEventList(document, (event) => {
    const name = typeof event.type === 'string' ? standardEpcisEventType(event.type) : undefined;
    return name ? { ...event, type: name } : event;
  });
}

function mapEpcisEventList(
  document: unknown,
  transform: (event: Record<string, unknown>) => Record<string, unknown>,
): unknown {
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
        return transform(event as Record<string, unknown>);
      }),
    },
  };
}
