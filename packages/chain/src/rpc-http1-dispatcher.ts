// SPDX-License-Identifier: Apache-2.0

/**
 * Keeps chain JSON-RPC calls on HTTP/1.1 on every supported Node line (#2828).
 *
 * Node 26 bundles undici 8, whose `fetch` negotiates HTTP/2 with any TLS
 * server that offers it. Node 22 and 24 bundle undici 6 and 7, which stay on
 * HTTP/1.1 unless asked. So a daemon on Node 26 sent every chain RPC call over
 * HTTP/2, a path no release was tested on, and one such daemon stalled in
 * Node's native HTTP/2 write buffering until its worker was killed.
 *
 * Where `fetch` is undici 8 or later, a chain RPC call goes through the
 * dispatcher `fetch` would use anyway, with `allowH2: false` added to the
 * request. undici's dispatchers for many origins honour it: an `Agent`
 * (Node's default) uses a separate HTTP/1.1-only pool per origin, built from
 * its own options, and a `ProxyAgent`, or the `EnvHttpProxyAgent` that
 * `NODE_USE_ENV_PROXY` / `--use-env-proxy` installs, connects the tunnelled
 * endpoint with HTTP/1.1 only.
 * Proxy routing, TLS settings and interceptors stay as configured; only
 * HTTP/2 is refused. A `Pool` or `Client` fixes its protocol when it connects
 * and sends every request to its own origin, so one installed as the global
 * dispatcher pins the transport of every fetch in the process, and chain RPC
 * calls keep the protocol it was configured with. On Node 22 and 24 `fetch`
 * runs unchanged. On an undici this release has not been verified with,
 * `fetch` also runs unchanged, and a warning says so once.
 */

type Dispatch = (options: Record<string, unknown>, handler: object) => boolean;

interface ComposableDispatcher {
  compose(interceptor: (dispatch: Dispatch) => Dispatch): object;
}

/**
 * What each bundled undici major needs, as verified on Node 22 (undici 6),
 * Node 24 (7) and Node 26 (8). `null`: its fetch offers HTTP/2 only when
 * configured to, so fetch runs unchanged. A symbol: the registry key under
 * which that undici keeps the dispatcher its fetch uses. undici copies share
 * the key (undici 8's public getGlobalDispatcher() reads it) and bump it only
 * on a breaking Dispatcher API change. A major missing here has not been
 * verified: fetch runs unchanged and a warning says so.
 */
const FETCH_GLOBAL_DISPATCHER_KEYS: ReadonlyMap<number, symbol | null> = new Map([
  [6, null],
  [7, null],
  [8, Symbol.for('undici.globalDispatcher.2')],
]);

/** HTTP/1.1-only views of the global dispatchers seen so far, so connections are reused. */
const http1Dispatchers = new WeakMap<object, object>();

const warnings = new Set<string>();

const refuseHttp2 = (dispatch: Dispatch): Dispatch => (options, handler) =>
  dispatch({ ...options, allowH2: false }, handler);

function warnOnce(reason: string): void {
  if (warnings.has(reason)) return;
  warnings.add(reason);
  console.warn(`[chain] RPC calls may use HTTP/2 (#2828): ${reason}`);
}

function fetchGlobalDispatcher(key: symbol): unknown {
  const slots = globalThis as unknown as Record<symbol, unknown>;
  // Node loads fetch's undici, which installs the default dispatcher, on the
  // first use of fetch or one of its classes. Loading it here keeps even the
  // first chain RPC call off an HTTP/2 session.
  if (slots[key] === undefined) void globalThis.Response;
  return slots[key];
}

function isComposable(dispatcher: unknown): dispatcher is object & ComposableDispatcher {
  return typeof dispatcher === 'object'
    && dispatcher !== null
    && typeof (dispatcher as Partial<ComposableDispatcher>).compose === 'function';
}

/** `RequestInit` with undici's `dispatcher` extension, which the DOM typings omit. */
type ChainRpcRequestInit = RequestInit & { dispatcher?: object };

/** The dispatcher a chain RPC call passes, or undefined to leave `fetch` as it is. */
function http1Dispatcher(): object | undefined {
  const version = process.versions.undici;
  const key = FETCH_GLOBAL_DISPATCHER_KEYS.get(Number.parseInt(version ?? '', 10));
  if (key === null) return undefined;
  if (key === undefined) {
    warnOnce(`Node's fetch is undici ${version ?? '(unknown)'}, which this release has not been verified with`);
    return undefined;
  }
  const active = fetchGlobalDispatcher(key);
  if (!isComposable(active)) {
    warnOnce('the global fetch dispatcher cannot refuse it per request');
    return undefined;
  }
  let dispatcher = http1Dispatchers.get(active);
  if (!dispatcher) {
    dispatcher = active.compose(refuseHttp2);
    http1Dispatchers.set(active, dispatcher);
  }
  return dispatcher;
}

/**
 * The `fetch` every chain RPC call goes through: the global `fetch`, with a
 * dispatcher that refuses HTTP/2 where `fetch` would otherwise negotiate it.
 * A test keeps the other chain sources from calling `fetch` themselves.
 */
export function chainRpcFetch(input: string | URL, init: RequestInit): Promise<Response> {
  const dispatcher = http1Dispatcher();
  const request: ChainRpcRequestInit = dispatcher ? { ...init, dispatcher } : init;
  return fetch(input, request);
}
