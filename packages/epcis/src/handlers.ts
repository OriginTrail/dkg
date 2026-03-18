import { createValidator } from './validation.js';
import { buildEpcisQuery } from './query-builder.js';
import { parseQueryParams, hasValidDateRange, encodePageToken } from './utils.js';
import type { Publisher, CaptureResult, CaptureOptions, QueryEngine, EPCISQueryDocumentResponse } from './types.js';

export interface CaptureConfig {
  paranetId: string;
  publisher: Publisher;
}

export interface CaptureRequest {
  epcisDocument: unknown;
  publishOptions?: CaptureOptions;
}

export class EpcisValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`EPCIS validation failed: ${errors.join('; ')}`);
    this.name = 'EpcisValidationError';
  }
}

export class EpcisQueryError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'EpcisQueryError';
  }
}

export interface EventsQueryConfig {
  paranetId: string;
  queryEngine: QueryEngine;
  basePath: string;
}

export interface EventsQueryResult {
  body: EPCISQueryDocumentResponse;
  headers?: { link?: string };
}

const DEFAULT_PER_PAGE = 30;
const MAX_PER_PAGE = 1000;

const EPCIS_TYPE_PREFIX = 'https://gs1.github.io/EPCIS/';

/** Reconstruct a proper EPCIS event object from flat SPARQL bindings. */
export function toEpcisEvent(binding: Record<string, string>): Record<string, unknown> {
  const event: Record<string, unknown> = {};

  // Strip eventType URI prefix to short name
  const rawType = binding['eventType'] ?? '';
  if (rawType.startsWith(EPCIS_TYPE_PREFIX)) {
    event.type = rawType.slice(EPCIS_TYPE_PREFIX.length);
  } else if (rawType) {
    event.type = rawType;
  }

  // Simple string fields — include only when non-empty
  const eventTime = binding['eventTime'];
  if (eventTime) event.eventTime = eventTime;

  const action = binding['action'];
  if (action) event.action = action;

  const bizStep = binding['bizStep'];
  if (bizStep) event.bizStep = bizStep;

  const disposition = binding['disposition'];
  if (disposition) event.disposition = disposition;

  const parentID = binding['parentID'];
  if (parentID) event.parentID = parentID;

  // DKG provenance — namespaced field
  const ual = binding['ual'];
  if (ual) event['dkg:ual'] = ual;

  // Wrap location fields in { id } objects
  const readPoint = binding['readPoint'];
  if (readPoint) {
    event.readPoint = { id: readPoint };
  }
  const bizLocation = binding['bizLocation'];
  if (bizLocation) {
    event.bizLocation = { id: bizLocation };
  }

  // Split GROUP_CONCAT strings into arrays
  const concatFields: Array<[string, string]> = [
    ['epcList', 'epcList'],
    ['childEPCList', 'childEPCs'],
    ['inputEPCs', 'inputEPCList'],
    ['outputEPCs', 'outputEPCList'],
  ];
  for (const [bindingKey, eventKey] of concatFields) {
    const val = binding[bindingKey];
    if (val) {
      event[eventKey] = val.split(', ').map((s) => s.trim()).filter(Boolean);
    }
  }

  return event;
}

const GS1_EPCIS_CONTEXT = 'https://ref.gs1.org/standards/epcis/2.0.0/epcis-context.jsonld';
const DKG_CONTEXT = { dkg: 'http://dkg.io/ontology/' };

export async function handleEventsQuery(
  searchParams: URLSearchParams,
  config: EventsQueryConfig,
): Promise<EventsQueryResult> {
  const params = parseQueryParams(searchParams);

  if (!hasValidDateRange(params)) {
    throw new EpcisQueryError('Invalid date range: "from" must be before or equal to "to"', 400);
  }

  const perPage = Math.min(Math.max(params.perPage ?? DEFAULT_PER_PAGE, 1), MAX_PER_PAGE);
  const offset = Math.max(params.offset ?? 0, 0);

  // Request one extra row to detect if more pages exist
  const sparql = buildEpcisQuery({ ...params, limit: perPage + 1, offset }, config.paranetId);
  const result = await config.queryEngine.query(sparql, { paranetId: config.paranetId });

  const hasMore = result.bindings.length > perPage;
  const bindings = hasMore ? result.bindings.slice(0, perPage) : result.bindings;
  const eventList = bindings.map(toEpcisEvent);

  const body: EPCISQueryDocumentResponse = {
    '@context': [GS1_EPCIS_CONTEXT, DKG_CONTEXT],
    type: 'EPCISQueryDocument',
    schemaVersion: '2.0',
    epcisBody: {
      queryResults: {
        queryName: 'SimpleEventQuery',
        resultsBody: {
          eventList,
        },
      },
    },
  };

  if (!hasMore) {
    return { body };
  }

  // Build Link header with nextPageToken
  const nextOffset = offset + perPage;
  const nextToken = encodePageToken(nextOffset);
  const url = new URL(config.basePath, 'http://localhost');
  // Preserve original query params
  searchParams.forEach((value, key) => {
    if (key !== 'nextPageToken' && key !== 'offset') {
      url.searchParams.set(key, value);
    }
  });
  url.searchParams.set('nextPageToken', nextToken);

  const link = `<${url.pathname}?${url.searchParams.toString()}>; rel="next"`;

  return { body, headers: { link } };
}

const validator = createValidator();

export async function handleCapture(
  request: CaptureRequest,
  config: CaptureConfig,
): Promise<CaptureResult> {
  const validation = validator.validate(request.epcisDocument);

  if (!validation.valid) {
    throw new EpcisValidationError(validation.errors!);
  }

  const opts = request.publishOptions
    ? { accessPolicy: request.publishOptions.accessPolicy, allowedPeers: request.publishOptions.allowedPeers }
    : undefined;

  const result = await config.publisher.publish(config.paranetId, request.epcisDocument, opts);

  return {
    ual: result.ual,
    kcId: result.kcId,
    receivedAt: new Date().toISOString(),
    eventCount: validation.eventCount!,
    status: result.status,
  };
}
