import type { ServerResponse } from 'node:http';
import {
  asyncAdmissionUsage,
  type AsyncAdmissionPhase,
  type AsyncAdmissionRoute,
} from '@origintrail-official/dkg-core';

/**
 * Follows one async admission request (`POST .../swm/share-async` and `.../vm/publish-async`)
 * from its arrival to its close and records its outcome once: route, the step that answered,
 * the HTTP status and error code, and how long it took (OT-RFC-73 P1b).
 *
 * The phase says which step answered, so a rejection can be pinned on one pre-queue read:
 *   request             before any read: availability, option and body validation, rate and
 *                       in-flight shedding, authentication
 *   write_preflight     the context-graph write preflight and its readiness wait
 *   intent_resolution   the publish route's intent resolution reads
 *   snapshot_preflight  the publish route's snapshot reads
 *   enqueue             the enqueue itself, and every 2xx answer
 *
 * A route marks a step with {@link admissionStep}. A step that finishes hands the request back
 * to the phase it was in; a step that throws leaves the phase on the step, because the error is
 * then answered inside it. A request the client abandons before any answer is recorded with
 * status 0 and code `client_closed`, in the step it was in.
 *
 * Every other request finds no trace and pays one `WeakMap` miss per hook.
 */

const API_PREFIX = '/api/knowledge-assets/';
/** The error body is parsed for its `code` only when it is this small. */
const MAX_PARSED_BODY_CHARS = 16 * 1024;

/** Matches the route's own path parsing (`knowledge-assets.ts`): extra segments are ignored there too. */
export function matchAsyncAdmissionRoute(method: string | undefined, pathname: string): AsyncAdmissionRoute | null {
  if (method !== 'POST' || !pathname.startsWith(API_PREFIX)) return null;
  let segments: string[];
  try {
    segments = pathname.slice(API_PREFIX.length).split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return null; // malformed percent-encoding: the route answers 400 before it reaches a verb
  }
  if (segments[1] === 'swm' && segments[2] === 'share-async') return 'share_async';
  if (segments[1] === 'vm' && segments[2] === 'publish-async') return 'publish_async';
  return null;
}

interface AdmissionTrace {
  readonly route: AsyncAdmissionRoute;
  readonly startedAtMs: number;
  readonly clock: () => number;
  /** The step the request is in now. */
  phase: AsyncAdmissionPhase;
  /** The first answer, with the phase it was given in. */
  answer?: { status: number; code: string; phase: AsyncAdmissionPhase; atMs: number };
}

const traces = new WeakMap<ServerResponse, AdmissionTrace>();

/** Starts the clock for a matching request and records its outcome when the response closes. */
export function beginAsyncAdmissionTrace(
  method: string | undefined,
  pathname: string,
  res: ServerResponse,
  clock: () => number = () => performance.now(),
): void {
  const route = matchAsyncAdmissionRoute(method, pathname);
  if (route === null) return;
  const trace: AdmissionTrace = { route, startedAtMs: clock(), clock, phase: 'request' };
  traces.set(res, trace);
  res.once('close', () => finishTrace(res, trace));
}

/** Runs one admission step and keeps the request in `phase` while it runs. */
export async function admissionStep<T>(
  res: ServerResponse,
  phase: AsyncAdmissionPhase,
  run: () => Promise<T>,
): Promise<T> {
  const trace = traces.get(res);
  if (trace === undefined) return run();
  const previous = trace.phase;
  trace.phase = phase;
  const result = await run();
  trace.phase = previous;
  return result;
}

/** The first answer a traced request sends wins; `body` is the serialized JSON the route sends. */
export function noteAdmissionResponse(res: ServerResponse, status: number, body: string): void {
  const trace = traces.get(res);
  if (trace === undefined || trace.answer !== undefined) return;
  const ok = status >= 200 && status < 300;
  trace.answer = {
    status,
    code: ok ? '-' : errorCode(body),
    phase: ok ? 'enqueue' : trace.phase,
    atMs: trace.clock(),
  };
}

function errorCode(body: string): string {
  if (typeof body !== 'string' || body.length > MAX_PARSED_BODY_CHARS) return '-';
  try {
    const code = (JSON.parse(body) as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : '-';
  } catch {
    return '-';
  }
}

function finishTrace(res: ServerResponse, trace: AdmissionTrace): void {
  if (traces.get(res) !== trace) return;
  traces.delete(res);
  const { answer } = trace;
  // An answer sent outside the JSON helper (rate limiting, load shedding) is seen only here.
  const status = answer?.status ?? (res.headersSent ? res.statusCode : 0);
  const ok = status >= 200 && status < 300;
  asyncAdmissionUsage.recordHttpOutcome({
    route: trace.route,
    phase: answer?.phase ?? (ok ? 'enqueue' : trace.phase),
    status,
    code: answer?.code ?? (status === 0 ? 'client_closed' : '-'),
    latencyMs: (answer?.atMs ?? trace.clock()) - trace.startedAtMs,
  });
}
