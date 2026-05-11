import { createValidator } from './validation.js';
import { buildEpcisQuery } from './query-builder.js';
import { parseQueryParams, hasValidDateRange, encodePageToken } from './utils.js';
import type { AsyncPublisher, CaptureAcceptedResult, CaptureOptions, PublisherCaptureOpts, QueryEngine, EPCISQueryDocumentResponse } from './types.js';

export interface AsyncCaptureConfig {
  contextGraphId: string;
  publisher: AsyncPublisher;
}

export interface CaptureRequest {
  epcisDocument: unknown;
  publishOptions?: CaptureOptions;
  /**
   * Optional per-request override for the target context graph. When
   * present takes precedence over `AsyncCaptureConfig.contextGraphId`,
   * which acts as the daemon-level fallback.
   */
  contextGraphId?: string;
  /**
   * Optional sub-graph name within the target context graph. Threaded
   * straight into the publisher's opts — no fallback, sub-graphs are
   * inherently per-payload.
   */
  subGraphName?: string;
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
  contextGraphId: string;
  /**
   * Optional sub-graph name within the context graph. When set, the
   * query reads from the `<cg>/<sub>/_shared_memory` (or canonical
   * `<cg>/<sub>` for finalized) partition and joins from
   * `<cg>/<sub>/_private`.
   */
  subGraphName?: string;
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

/**
 * Strip N-Quads literal wrapping from a SPARQL binding value.
 * The triplestore returns string literals as '"value"' or '"value"^^<type>'.
 */
function unwrapLiteral(value: string): string {
  if (!value) return value;
  // Handle typed literals: "value"^^<type>
  const typedMatch = value.match(/^"(.*)"(?:\^\^<.*>)?$/s);
  if (typedMatch) return typedMatch[1];
  return value;
}

/** Reconstruct a proper EPCIS event object from flat SPARQL bindings. */
export function toEpcisEvent(binding: Record<string, string>): Record<string, unknown> {
  const event: Record<string, unknown> = {};

  // Strip eventType URI prefix to short name
  const rawType = unwrapLiteral(binding['eventType'] ?? '');
  if (rawType.startsWith(EPCIS_TYPE_PREFIX)) {
    event.type = rawType.slice(EPCIS_TYPE_PREFIX.length);
  } else if (rawType) {
    event.type = rawType;
  }

  // Simple string fields — unwrap N-Quads literal quoting, include only when non-empty
  const eventTime = unwrapLiteral(binding['eventTime']);
  if (eventTime) event.eventTime = eventTime;

  const action = unwrapLiteral(binding['action']);
  if (action) event.action = action;

  const bizStep = unwrapLiteral(binding['bizStep']);
  if (bizStep) event.bizStep = bizStep;

  const disposition = unwrapLiteral(binding['disposition']);
  if (disposition) event.disposition = disposition;

  const parentID = unwrapLiteral(binding['parentID']);
  if (parentID) event.parentID = parentID;

  // DKG provenance — namespaced field
  const ual = unwrapLiteral(binding['ual']);
  if (ual) event['dkg:ual'] = ual;

  // Wrap location fields in { id } objects — unwrap literal quoting from URI values
  const readPoint = unwrapLiteral(binding['readPoint']);
  if (readPoint) {
    event.readPoint = { id: readPoint };
  }
  const bizLocation = unwrapLiteral(binding['bizLocation']);
  if (bizLocation) {
    event.bizLocation = { id: bizLocation };
  }

  // Split GROUP_CONCAT strings into arrays — unwrap literal quoting first
  const concatFields: Array<[string, string]> = [
    ['epcList', 'epcList'],
    ['childEPCList', 'childEPCs'],
    ['inputEPCs', 'inputEPCList'],
    ['outputEPCs', 'outputEPCList'],
  ];
  for (const [bindingKey, eventKey] of concatFields) {
    const val = unwrapLiteral(binding[bindingKey]);
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

  // Request one extra row to detect if more pages exist. Sub-graph
  // selection is per-request (route-level), not derivable from the
  // SPARQL query string, so it lives on the config rather than in
  // `params`.
  const sparql = buildEpcisQuery(
    { ...params, subGraphName: config.subGraphName, limit: perPage + 1, offset },
    config.contextGraphId,
  );
  const result = await config.queryEngine.query(sparql, { contextGraphId: config.contextGraphId });

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

export async function handleCaptureAsync(
  request: CaptureRequest,
  config: AsyncCaptureConfig,
): Promise<CaptureAcceptedResult> {
  const { document, content } = resolveCaptureContent(request.epcisDocument);
  const validation = validator.validate(document);

  if (!validation.valid) {
    throw new EpcisValidationError(validation.errors!);
  }

  const effectiveContextGraphId = request.contextGraphId ?? config.contextGraphId;

  const opts: PublisherCaptureOpts | undefined = (request.publishOptions || request.subGraphName)
    ? {
        ...(request.publishOptions?.accessPolicy !== undefined && { accessPolicy: request.publishOptions.accessPolicy }),
        ...(request.publishOptions?.allowedPeers !== undefined && { allowedPeers: request.publishOptions.allowedPeers }),
        ...(request.subGraphName !== undefined && { subGraphName: request.subGraphName }),
      }
    : undefined;

  const result = await config.publisher.publishAsync(effectiveContextGraphId, content, opts);

  return {
    captureID: result.captureID,
    receivedAt: new Date().toISOString(),
    eventCount: validation.eventCount!,
    status: 'accepted',
  };
}

function resolveCaptureContent(epcisDocument: unknown): { document: unknown; content: unknown } {
  if (!epcisDocument || typeof epcisDocument !== 'object' || Array.isArray(epcisDocument)) {
    return { document: epcisDocument, content: { private: epcisDocument } };
  }

  const obj = epcisDocument as Record<string, unknown>;
  if (obj.type === 'EPCISDocument') {
    return { document: epcisDocument, content: { private: epcisDocument } };
  }

  const hasPublic = Object.prototype.hasOwnProperty.call(obj, 'public');
  const hasPrivate = Object.prototype.hasOwnProperty.call(obj, 'private');
  if (!hasPublic && !hasPrivate) {
    throw new EpcisValidationError(['Privacy envelope requires a public or private EPCIS document']);
  }

  const publicDoc = obj.public;
  const privateDoc = obj.private;
  if (publicDoc === undefined && privateDoc === undefined) {
    throw new EpcisValidationError(['Privacy envelope requires a public or private EPCIS document']);
  }

  const content: Record<string, unknown> = {};
  if (hasPublic) {
    content.public = publicDoc;
  }
  if (hasPrivate) {
    content.private = privateDoc;
  }

  return {
    document: hasPublic ? publicDoc : privateDoc,
    content,
  };
}
