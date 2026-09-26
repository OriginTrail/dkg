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
 * undici 8 dispatchers take `allowH2: false` per request. So where `fetch` is
 * undici 8 or later, a chain RPC call goes through the dispatcher `fetch` would
 * use anyway, with that option added: Node's default agent, the proxy agent of
 * `NODE_USE_ENV_PROXY` / `--use-env-proxy`, or a dispatcher the application
 * installed. Proxy routing, TLS settings and interceptors stay as configured;
 * only HTTP/2 is refused. On Node 22 and 24 `fetch` runs unchanged.
 */

type Dispatch = (options: Record<string, unknown>, handler: object) => boolean;

interface ComposableDispatcher {
  compose(interceptor: (dispatch: Dispatch) => Dispatch): object;
}

/** Where undici 8 and later keep the dispatcher `fetch` uses by default. */
const FETCH_GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.2');

/** HTTP/1.1-only views of the global dispatchers seen so far, so connections are reused. */
const http1Dispatchers = new WeakMap<object, object>();

const refuseHttp2 = (dispatch: Dispatch): Dispatch => (options, handler) =>
  dispatch({ ...options, allowH2: false }, handler);

function fetchNegotiatesHttp2(): boolean {
  return Number.parseInt(process.versions.undici ?? '', 10) >= 8;
}

function fetchGlobalDispatcher(): unknown {
  const slots = globalThis as unknown as Record<symbol, unknown>;
  // Node loads fetch's undici, which installs the default dispatcher, on the
  // first use of fetch or one of its classes.
  if (slots[FETCH_GLOBAL_DISPATCHER] === undefined) void globalThis.Response;
  return slots[FETCH_GLOBAL_DISPATCHER];
}

function isComposable(dispatcher: unknown): dispatcher is object & ComposableDispatcher {
  return typeof dispatcher === 'object'
    && dispatcher !== null
    && typeof (dispatcher as Partial<ComposableDispatcher>).compose === 'function';
}

/**
 * `fetch` options for a chain RPC call: `init`, plus a dispatcher that refuses
 * HTTP/2 where `fetch` would otherwise negotiate it.
 */
export function chainRpcFetchInit(init: RequestInit): RequestInit {
  if (!fetchNegotiatesHttp2()) return init;
  const active = fetchGlobalDispatcher();
  // No dispatcher yet, or the application's own without undici's compose(): fetch runs unchanged.
  if (!isComposable(active)) return init;
  let dispatcher = http1Dispatchers.get(active);
  if (!dispatcher) {
    dispatcher = active.compose(refuseHttp2);
    http1Dispatchers.set(active, dispatcher);
  }
  // `dispatcher` is undici's extension to RequestInit; the DOM typings omit it.
  return { ...init, dispatcher } as RequestInit;
}
