import { EpcisQueryError } from './query-error.js';
import { EpcisQueryValidationError } from './query-validation.js';
export { EpcisQueryError } from './query-error.js';
import { EpcisHttpPage } from './pagination.js';
import { compactEpcisEventType } from './epcis-vocabulary.js';
import { createValidator } from './validation.js';
import { createEpcisQueryPlan } from './query-builder.js';
import { parseEventsRequest, hasValidDateRange, encodePageToken } from './utils.js';
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




/**
 * Strip N-Quads literal wrapping from a SPARQL binding value.
 * The triplestore returns string literals as '"value"' or '"value"^^<type>'.
 *
 * Implemented as a linear scan rather than the prior greedy regex
 * `/^"(.*)"(?:\^\^<.*>)?$/s` — that pattern is vulnerable to catastrophic
 * backtracking on malformed inputs (e.g. repeated typed-literal suffixes)
 * because `(.*)` is greedy with the `s` flag and the optional trailing
 * group forces an exponential backoff. Since the input comes from a
 * remote triplestore, that is reachable input. The linear parser below
 * runs in O(n) regardless of input shape.
 */
export function unwrapLiteral(value: string): string {
  if (!value || value.length < 2 || value.charCodeAt(0) !== 34 /* '"' */) {
    return value;
  }
  // Find the closing quote, honouring backslash escapes per N-Quads.
  let i = 1;
  for (; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    if (ch === 92 /* '\\' */) {
      i++;
      continue;
    }
    if (ch === 34 /* '"' */) break;
  }
  if (i >= value.length) return value; // no closing quote — return as-is
  const inner = value.slice(1, i);
  const tail = value.slice(i + 1);
  // Tail must be empty or a typed-literal suffix `^^<...>`.
  if (tail.length === 0) return inner;
  if (tail.startsWith('^^<') && tail.endsWith('>')) return inner;
  // Anything else: not a recognised literal shape — return as-is.
  return value;
}

/** Reconstruct a proper EPCIS event object from flat SPARQL bindings. */
export function toEpcisEvent(binding: Record<string, string>): Record<string, unknown> {
  const event: Record<string, unknown> = {};

  // Strip eventType URI prefix to short name
  const rawType = unwrapLiteral(binding['eventType'] ?? '');
  if (rawType) event.type = compactEpcisEventType(rawType);

  // Simple string fields — unwrap N-Quads literal quoting, include only when non-empty
  const eventTime = unwrapLiteral(binding['eventTime']);
  if (eventTime) event.eventTime = eventTime;

  const eventTimeZoneOffset = unwrapLiteral(binding['eventTimeZoneOffset']);
  if (eventTimeZoneOffset) event.eventTimeZoneOffset = eventTimeZoneOffset;

  const action = unwrapLiteral(binding['action']);
  if (action) event.action = action;

  const bizStep = unwrapLiteral(binding['bizStep']);
  if (bizStep) event.bizStep = bizStep;

  const disposition = unwrapLiteral(binding['disposition']);
  if (disposition) event.disposition = disposition;

  const parentID = unwrapLiteral(binding['parentID']);
  if (parentID) event.parentID = parentID;

  const configurationId = unwrapLiteral(binding['configurationId']);
  if (configurationId) event.configurationId = configurationId;

  const shipmentId = unwrapLiteral(binding['shipmentId']);
  if (shipmentId) event.shipmentId = shipmentId;

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
const DKG_BASE_IRI = 'http://dkg.io/ontology/';
const DKG_CONTEXT = {
  dkg: DKG_BASE_IRI,
  configurationId: `${DKG_BASE_IRI}epcis/configurationId`,
  shipmentId: `${DKG_BASE_IRI}epcis/shipmentId`,
};

/** Translate only request validation; engine errors retain their original identity. */
function queryRequestBoundary<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) {
    if (error instanceof EpcisQueryValidationError) throw new EpcisQueryError(error.message, 400);
    throw error;
  }
}

export async function handleEventsQuery(
  searchParams: URLSearchParams,
  config: EventsQueryConfig,
): Promise<EventsQueryResult> {
  const { page, plan } = queryRequestBoundary(() => {
    const request = parseEventsRequest(searchParams);
    if (!hasValidDateRange(request.filters)) {
      throw new EpcisQueryValidationError('Invalid date range: "from" must be before or equal to "to"');
    }
    const page = new EpcisHttpPage(request.page);
    return {
      page,
      plan: createEpcisQueryPlan(request.filters, {
        contextGraphId: config.contextGraphId,
        subGraphName: config.subGraphName,
        finalized: request.finalized,
      }, page.queryWindow),
    };
  });
  const result = await config.queryEngine.query(plan.sparql, plan.options);

  const { bindings, nextOffset } = queryRequestBoundary(() => page.take(result.bindings));
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

  if (nextOffset === undefined) {
    return { body };
  }

  // Build Link header with nextPageToken
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
