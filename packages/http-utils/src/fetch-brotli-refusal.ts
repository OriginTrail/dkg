/**
 * Outbound HTTP refuses Brotli-encoded responses (CVE-2026-111497).
 *
 * Node's fetch decodes a response whose Content-Encoding names `br` with the
 * Brotli decoder Node bundles, which has an out-of-bounds write before Node
 * 22.23.4, 24.22.1 and 26.12.1. Upgrading Node is the fix. For a process that
 * still runs an affected Node, this undici dispatcher interceptor:
 *
 * - takes `br` out of the request's Accept-Encoding, so a server has no reason
 *   to choose it (a wildcard gets `br;q=0`, and a list of only `br` becomes
 *   `identity`);
 * - fails a response whose Content-Encoding names `br` in the headers
 *   callback, with a BrotliResponseRefusedError that names only the host, so
 *   fetch never sees the headers, never creates a decoder and never reads a
 *   body byte.
 *
 * It wraps the handler API of each undici that Node bundles: `onConnect` /
 * `onHeaders` handlers on undici 6 (Node 22), and the `onRequestStart` /
 * `onResponseStart` handlers that undici 7 composes to (Node 24) and that
 * undici 8 uses (Node 26). The file has no imports and only erasable
 * TypeScript, so a test child process can load it as it is.
 */

/** undici's `dispatch(options, handler)`, typed only as far as this module reads it. */
export type DispatchFunction = (options: Record<string, unknown>, handler: object) => boolean;

/** A dispatcher whose `compose()` wraps it with interceptors, as every undici since 6 has. */
export interface ComposableDispatcher {
  compose(...interceptors: Array<(dispatch: DispatchFunction) => DispatchFunction>): ComposableDispatcher;
}

export class BrotliResponseRefusedError extends Error {
  readonly code = 'DKG_BROTLI_RESPONSE_REFUSED';
  readonly host: string;

  constructor(host: string) {
    super(`Refused a Brotli-encoded response from ${host}`);
    this.name = 'BrotliResponseRefusedError';
    this.host = host;
  }
}

const BROTLI = 'br';

function originHost(origin: unknown): string {
  try {
    return new URL(String(origin)).host || 'an unknown host';
  } catch {
    return 'an unknown host';
  }
}

function headerText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('latin1');
  }
  return String(value);
}

function isHeader(name: unknown, expected: string): boolean {
  return headerText(name).trim().toLowerCase() === expected;
}

/**
 * A content coding by its letters, digits and hyphens alone, without
 * parameters, so no spacing or other byte a decoder would trim can hide `br`.
 */
function codingName(coding: string): string {
  return coding.split(';', 1)[0].toLowerCase().replace(/[^a-z0-9-]/g, '');
}

function namesBrotli(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((entry) => namesBrotli(entry));
  return headerText(value).split(',').some((coding) => codingName(coding) === BROTLI);
}

/** Whether raw (`[name, value, ...]`) or parsed (`{ name: value }`) response headers name `br` as a content coding. */
function contentEncodingNamesBrotli(headers: unknown): boolean {
  if (Array.isArray(headers)) {
    for (let i = 0; i + 1 < headers.length; i += 2) {
      if (isHeader(headers[i], 'content-encoding') && namesBrotli(headers[i + 1])) return true;
    }
    return false;
  }
  if (typeof headers !== 'object' || headers === null) return false;
  return Object.entries(headers).some(([name, value]) => isHeader(name, 'content-encoding') && namesBrotli(value));
}

function acceptEncodingWithoutBrotli(value: string): string {
  const codings = value.split(',').map((coding) => coding.trim()).filter((coding) => coding !== '');
  const kept = codings.filter((coding) => codingName(coding) !== BROTLI);
  const wildcard = kept.some((coding) => coding.split(';', 1)[0].trim() === '*');
  if (kept.length === codings.length && !wildcard) return value;
  if (wildcard) kept.push(`${BROTLI};q=0`);
  return kept.length > 0 ? kept.join(', ') : 'identity';
}

function acceptEncodingValueWithoutBrotli(value: unknown): unknown {
  if (typeof value === 'string') return acceptEncodingWithoutBrotli(value);
  if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === 'string')) return value;
  const rewritten = value.map((entry) => acceptEncodingWithoutBrotli(entry));
  return rewritten.every((entry, i) => entry === value[i]) ? value : rewritten;
}

/**
 * Request options whose Accept-Encoding no longer names `br`. Headers given
 * as an array (`[name, value, ...]`) or a plain object are rewritten in a
 * copy; headers given as another iterable are left as they are, and the
 * response check still applies to them.
 */
function withoutBrotliAcceptEncoding(options: Record<string, unknown>): Record<string, unknown> {
  const { headers } = options;
  if (Array.isArray(headers)) {
    if (headers.length % 2 !== 0) return options;
    let rewritten: unknown[] | undefined;
    for (let i = 0; i < headers.length; i += 2) {
      if (!isHeader(headers[i], 'accept-encoding')) continue;
      const value = acceptEncodingValueWithoutBrotli(headers[i + 1]);
      if (value === headers[i + 1]) continue;
      rewritten ??= [...headers];
      rewritten[i + 1] = value;
    }
    return rewritten ? { ...options, headers: rewritten } : options;
  }
  if (typeof headers !== 'object' || headers === null || Symbol.iterator in headers) return options;
  let rewritten: Record<string, unknown> | undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (!isHeader(name, 'accept-encoding')) continue;
    const next = acceptEncodingValueWithoutBrotli(value);
    if (next === value) continue;
    rewritten ??= { ...headers };
    rewritten[name] = next;
  }
  return rewritten ? { ...options, headers: rewritten } : options;
}

interface LegacyHandler {
  onConnect?(abort: (reason: Error) => void, context?: unknown): unknown;
  onHeaders?(statusCode: number, rawHeaders: unknown, resume: () => void, statusText?: string): unknown;
  onUpgrade?(statusCode: number, rawHeaders: unknown, socket: unknown): unknown;
  onData?(chunk: unknown): unknown;
  onComplete?(trailers: unknown): unknown;
  onError?(error: Error): unknown;
  onBodySent?(chunk: unknown): unknown;
  onRequestSent?(): unknown;
  onResponseStarted?(): unknown;
}

interface DispatchController {
  abort(reason: Error): void;
  /** The response's raw header bytes, which undici 8 keeps here and its fetch reads. */
  rawHeaders?: unknown;
}

interface ModernHandler {
  onRequestStart?(controller: DispatchController, context?: unknown): unknown;
  onRequestUpgrade?(controller: DispatchController, statusCode: number, headers: unknown, socket: unknown): unknown;
  onResponseStart?(controller: DispatchController, statusCode: number, headers: unknown, statusMessage?: string): unknown;
  onResponseData?(controller: DispatchController, chunk: unknown): unknown;
  onResponseEnd?(controller: DispatchController, trailers: unknown): unknown;
  onResponseError?(controller: DispatchController | null, error: Error): unknown;
  onBodySent?(chunk: unknown): unknown;
  onRequestSent?(): unknown;
  onResponseStarted?(): unknown;
}

/** An `onConnect` / `onHeaders` handler that fails a Brotli response at its headers. */
class LegacyBrotliRefusingHandler {
  readonly #handler: LegacyHandler;
  readonly #host: string;
  #abort: ((reason: Error) => void) | undefined;

  constructor(handler: LegacyHandler, host: string) {
    this.#handler = handler;
    this.#host = host;
  }

  onConnect(abort: (reason: Error) => void, context?: unknown): unknown {
    this.#abort = abort;
    return this.#handler.onConnect?.(abort, context);
  }

  onHeaders(statusCode: number, rawHeaders: unknown, resume: () => void, statusText?: string): unknown {
    if (!contentEncodingNamesBrotli(rawHeaders)) {
      return this.#handler.onHeaders?.(statusCode, rawHeaders, resume, statusText);
    }
    const refused = new BrotliResponseRefusedError(this.#host);
    // undici aborts a request whose onHeaders throws, should onConnect not have run.
    if (!this.#abort) throw refused;
    this.#abort(refused);
    return false;
  }

  onUpgrade(statusCode: number, rawHeaders: unknown, socket: unknown): unknown {
    return this.#handler.onUpgrade?.(statusCode, rawHeaders, socket);
  }

  onData(chunk: unknown): unknown {
    return this.#handler.onData?.(chunk);
  }

  onComplete(trailers: unknown): unknown {
    return this.#handler.onComplete?.(trailers);
  }

  onError(error: Error): unknown {
    if (typeof this.#handler.onError !== 'function') throw error;
    return this.#handler.onError(error);
  }

  onBodySent(chunk: unknown): unknown {
    return this.#handler.onBodySent?.(chunk);
  }

  onRequestSent(): unknown {
    return this.#handler.onRequestSent?.();
  }

  onResponseStarted(): unknown {
    return this.#handler.onResponseStarted?.();
  }
}

/** An `onRequestStart` / `onResponseStart` handler that fails a Brotli response at its headers. */
class ModernBrotliRefusingHandler {
  readonly #handler: ModernHandler;
  readonly #host: string;

  constructor(handler: ModernHandler, host: string) {
    this.#handler = handler;
    this.#host = host;
  }

  onRequestStart(controller: DispatchController, context?: unknown): unknown {
    return this.#handler.onRequestStart?.(controller, context);
  }

  onRequestUpgrade(controller: DispatchController, statusCode: number, headers: unknown, socket: unknown): unknown {
    return this.#handler.onRequestUpgrade?.(controller, statusCode, headers, socket);
  }

  onResponseStart(controller: DispatchController, statusCode: number, headers: unknown, statusMessage?: string): unknown {
    if (!contentEncodingNamesBrotli(headers) && !contentEncodingNamesBrotli(controller?.rawHeaders)) {
      return this.#handler.onResponseStart?.(controller, statusCode, headers, statusMessage);
    }
    const refused = new BrotliResponseRefusedError(this.#host);
    // undici aborts a request whose onResponseStart throws, should it pass no controller.
    if (typeof controller?.abort !== 'function') throw refused;
    controller.abort(refused);
    return undefined;
  }

  onResponseData(controller: DispatchController, chunk: unknown): unknown {
    return this.#handler.onResponseData?.(controller, chunk);
  }

  onResponseEnd(controller: DispatchController, trailers: unknown): unknown {
    return this.#handler.onResponseEnd?.(controller, trailers);
  }

  onResponseError(controller: DispatchController | null, error: Error): unknown {
    if (typeof this.#handler.onResponseError !== 'function') throw error;
    return this.#handler.onResponseError(controller, error);
  }

  onBodySent(chunk: unknown): unknown {
    return this.#handler.onBodySent?.(chunk);
  }

  onRequestSent(): unknown {
    return this.#handler.onRequestSent?.();
  }

  onResponseStarted(): unknown {
    return this.#handler.onResponseStarted?.();
  }
}

/**
 * The undici interceptor (`dispatcher.compose(refuseBrotliResponses)`):
 * Accept-Encoding without `br`, and a Brotli-encoded response failed with a
 * BrotliResponseRefusedError before anything decodes it.
 */
export function refuseBrotliResponses(dispatch: DispatchFunction): DispatchFunction {
  return (options, handler) => {
    if (typeof options !== 'object' || options === null || typeof handler !== 'object' || handler === null) {
      return dispatch(options, handler);
    }
    const host = originHost(options.origin);
    const refusing = typeof (handler as ModernHandler).onRequestStart === 'function'
      ? new ModernBrotliRefusingHandler(handler as ModernHandler, host)
      : new LegacyBrotliRefusingHandler(handler as LegacyHandler, host);
    return dispatch(withoutBrotliAcceptEncoding(options), refusing);
  };
}

/** The Brotli-refusing view of each dispatcher seen so far, so its connections are reused. */
const refusingViews = new WeakMap<object, ComposableDispatcher>();
const refusingDispatchers = new WeakSet<object>();

export function isBrotliRefusing(dispatcher: unknown): boolean {
  return typeof dispatcher === 'object' && dispatcher !== null && refusingDispatchers.has(dispatcher);
}

/**
 * `dispatcher` composed with refuseBrotliResponses, keeping its own protocol,
 * proxy and TLS settings: the same view for the same dispatcher, and a
 * dispatcher that already refuses Brotli as it is.
 */
export function withBrotliRefusal(dispatcher: ComposableDispatcher): ComposableDispatcher {
  if (refusingDispatchers.has(dispatcher)) return dispatcher;
  let refusing = refusingViews.get(dispatcher);
  if (!refusing) {
    refusing = dispatcher.compose(refuseBrotliResponses);
    refusingViews.set(dispatcher, refusing);
    refusingDispatchers.add(refusing);
  }
  return refusing;
}

export function isComposableDispatcher(dispatcher: unknown): dispatcher is ComposableDispatcher {
  return typeof dispatcher === 'object'
    && dispatcher !== null
    && typeof (dispatcher as Partial<ComposableDispatcher>).compose === 'function';
}

const UNDICI_GLOBAL_DISPATCHER_1 = Symbol.for('undici.globalDispatcher.1');
const UNDICI_GLOBAL_DISPATCHER_2 = Symbol.for('undici.globalDispatcher.2');

/**
 * Where the dispatcher Node's fetch uses by default lives, by the major of
 * the undici Node bundles, as verified on Node 22 (undici 6), Node 24 (7) and
 * Node 26 (8). undici copies share these keys and bump them only on a
 * breaking Dispatcher API change. undici 8 also keeps a legacy view of its
 * dispatcher under the older key, which the npm undici 7 that the CLI loads
 * reads.
 */
const FETCH_GLOBAL_DISPATCHER_KEYS: ReadonlyMap<number, symbol> = new Map([
  [6, UNDICI_GLOBAL_DISPATCHER_1],
  [7, UNDICI_GLOBAL_DISPATCHER_1],
  [8, UNDICI_GLOBAL_DISPATCHER_2],
]);

export type FetchGlobalDispatcher =
  | { readonly undiciMajor: number; readonly dispatcher: unknown }
  | { readonly unverified: string };

/**
 * The dispatcher Node's fetch uses when a call passes none. Node loads
 * fetch's undici, which installs its default dispatcher (or the environment
 * proxy of NODE_USE_ENV_PROXY), on the first use of fetch or one of its
 * classes; reading it here loads it first if nothing has yet.
 */
export function fetchGlobalDispatcher(undiciVersion: string | undefined = process.versions.undici): FetchGlobalDispatcher {
  const undiciMajor = Number.parseInt(undiciVersion ?? '', 10);
  const key = FETCH_GLOBAL_DISPATCHER_KEYS.get(undiciMajor);
  if (key === undefined) return { unverified: undiciVersion ?? '(unknown)' };
  const slots = globalThis as unknown as Record<symbol, unknown>;
  if (slots[key] === undefined) void globalThis.Response;
  return { undiciMajor, dispatcher: slots[key] };
}

export type GlobalBrotliRefusal =
  | { readonly installed: true }
  | { readonly installed: false; readonly reason: string };

/**
 * Makes every fetch in this process that passes no dispatcher of its own
 * refuse Brotli, Node's fetch and npm undici's alike: the dispatchers in
 * undici's global slots are replaced by their Brotli-refusing views. A call
 * with its own dispatcher, and a dispatcher installed later, are not covered.
 * Where Node's fetch is an undici this module has not been verified with,
 * nothing changes.
 */
export function installGlobalBrotliRefusal(): GlobalBrotliRefusal {
  const fetchDispatcher = fetchGlobalDispatcher();
  if ('unverified' in fetchDispatcher) {
    return {
      installed: false,
      reason: `Node's fetch is undici ${fetchDispatcher.unverified}, which this release has not been verified with`,
    };
  }
  if (!isComposableDispatcher(fetchDispatcher.dispatcher)) {
    return { installed: false, reason: 'the global fetch dispatcher cannot be composed with an interceptor' };
  }
  const slots = globalThis as unknown as Record<symbol, unknown>;
  for (const key of [UNDICI_GLOBAL_DISPATCHER_2, UNDICI_GLOBAL_DISPATCHER_1]) {
    const dispatcher = slots[key];
    if (isComposableDispatcher(dispatcher)) slots[key] = withBrotliRefusal(dispatcher);
  }
  return { installed: true };
}
