import { createValidator } from './validation.js';
import { buildEpcisQuery } from './query-builder.js';
import { parseQueryParams, hasAtLeastOneFilter, hasValidDateRange } from './utils.js';
import type { Publisher, CaptureResult, CaptureOptions, QueryEngine, EventsQueryResult, EpcisEventResult } from './types.js';

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
}

export async function handleEventsQuery(
  searchParams: URLSearchParams,
  config: EventsQueryConfig,
): Promise<EventsQueryResult> {
  const params = parseQueryParams(searchParams);

  if (!hasAtLeastOneFilter(params)) {
    throw new EpcisQueryError('At least one filter parameter is required', 400);
  }

  if (!hasValidDateRange(params)) {
    throw new EpcisQueryError('Invalid date range: "from" must be before or equal to "to"', 400);
  }

  const sparql = buildEpcisQuery(params, config.paranetId);
  const result = await config.queryEngine.query(sparql, { paranetId: config.paranetId });

  const events: EpcisEventResult[] = result.bindings.map((row) => ({
    eventType: row['eventType'] ?? '',
    eventTime: row['eventTime'] ?? '',
    bizStep: row['bizStep'] ?? '',
    bizLocation: row['bizLocation'] ?? '',
    disposition: row['disposition'] ?? '',
    readPoint: row['readPoint'] ?? '',
    action: row['action'] ?? '',
    parentID: row['parentID'] ?? '',
    epcList: row['epcList'] ?? '',
    childEPCList: row['childEPCList'] ?? '',
    inputEPCs: row['inputEPCs'] ?? '',
    outputEPCs: row['outputEPCs'] ?? '',
    ual: row['ual'] ?? '',
  }));

  return {
    events,
    count: events.length,
    pagination: {
      limit: Math.min(Math.max(params.limit ?? 100, 1), 1000),
      offset: Math.max(params.offset ?? 0, 0),
    },
  };
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
