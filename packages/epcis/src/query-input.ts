import { normalizeEpcisEventType } from './epcis-vocabulary.js';
import type { EpcisQueryParams } from './types.js';

export interface NormalizedEpcisQuery {
  readonly params: Omit<EpcisQueryParams, 'eventType'>;
  readonly eventTypeIri?: string;
}

export type EpcisQueryInputResult =
  | { ok: true; value: NormalizedEpcisQuery }
  | { ok: false; message: string };

/** Query-input errors thrown by the public buildEpcisQuery convenience API. */
export class EpcisQueryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EpcisQueryInputError';
  }
}

/** Normalize request representations before rendering any SPARQL. */
export function normalizeEpcisQueryInput(params: EpcisQueryParams): EpcisQueryInputResult {
  const { eventType, ...rest } = params;
  const eventTypeIri = eventType ? normalizeEpcisEventType(eventType) : undefined;
  if (eventType && !eventTypeIri) {
    return { ok: false, message: 'eventType must be an EPCIS event name or an absolute event type IRI' };
  }
  return { ok: true, value: { params: rest, eventTypeIri } };
}
