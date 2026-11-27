// SPDX-License-Identifier: Apache-2.0

import {
  fetchGlobalDispatcher,
  isComposableDispatcher,
  withBrotliRefusal,
  type DispatchFunction,
} from '@origintrail-official/dkg-http-utils';

/**
 * Keeps chain JSON-RPC calls on HTTP/1.1 on every supported Node line
 * (#2828), and refuses Brotli-encoded responses to them (CVE-2026-111497).
 *
 * Node 26 bundles undici 8, whose `fetch` negotiates HTTP/2 with any TLS
 * server that offers it. Node 22 and 24 bundle undici 6 and 7, which stay on
 * HTTP/1.1 unless asked. So a daemon on Node 26 sent every chain RPC call over
 * HTTP/2, a path no release was tested on, and one such daemon stalled in
 * Node's native HTTP/2 write buffering until its worker was killed.
 *
 * A chain RPC call goes through the dispatcher `fetch` would use anyway,
 * composed with http-utils' refuseBrotliResponses, and where `fetch` is
 * undici 8 or later with `allowH2: false` added to the request. undici's
 * dispatchers for many origins honour it: an `Agent` (Node's default) uses a
 * separate HTTP/1.1-only pool per origin, built from its own options, and a
 * `ProxyAgent`, or the `EnvHttpProxyAgent` that `NODE_USE_ENV_PROXY` /
 * `--use-env-proxy` installs, connects the tunnelled endpoint with HTTP/1.1
 * only. Proxy routing, TLS settings and interceptors stay as configured; only
 * HTTP/2 and Brotli are refused. A `Pool` or `Client` fixes its protocol when
 * it connects and sends every request to its own origin, so one installed as
 * the global dispatcher pins the transport of every fetch in the process, and
 * chain RPC calls keep the protocol it was configured with. On an undici this
 * release has not been verified with, `fetch` runs unchanged, and a warning
 * says so once.
 */

/** Bundled undici majors from this one on offer HTTP/2 to `fetch` unless refused per request. */
const FETCH_OFFERS_HTTP2_FROM_UNDICI = 8;

/** The views of the global dispatchers seen so far that chain RPC calls use, so connections are reused. */
const rpcDispatchers = new WeakMap<object, object>();

const warnings = new Set<string>();

const refuseHttp2 = (dispatch: DispatchFunction): DispatchFunction => (options, handler) =>
  dispatch({ ...options, allowH2: false }, handler);

function warnOnce(reason: string): void {
  if (warnings.has(reason)) return;
  warnings.add(reason);
  console.warn(`[chain] RPC calls may use HTTP/2 (#2828) and accept Brotli-encoded responses: ${reason}`);
}

/** `RequestInit` with undici's `dispatcher` extension, which the DOM typings omit. */
type ChainRpcRequestInit = RequestInit & { dispatcher?: object };

/** The dispatcher a chain RPC call passes, or undefined to leave `fetch` as it is. */
function chainRpcDispatcher(): object | undefined {
  // Loading fetch's undici here, if nothing has yet, keeps even the first
  // chain RPC call off an HTTP/2 session.
  const fetchDispatcher = fetchGlobalDispatcher();
  if ('unverified' in fetchDispatcher) {
    warnOnce(`Node's fetch is undici ${fetchDispatcher.unverified}, which this release has not been verified with`);
    return undefined;
  }
  const active = fetchDispatcher.dispatcher;
  if (!isComposableDispatcher(active)) {
    warnOnce('the global fetch dispatcher cannot refuse them per request');
    return undefined;
  }
  let dispatcher = rpcDispatchers.get(active);
  if (!dispatcher) {
    const refusing = withBrotliRefusal(active);
    dispatcher = fetchDispatcher.undiciMajor >= FETCH_OFFERS_HTTP2_FROM_UNDICI
      ? refusing.compose(refuseHttp2)
      : refusing;
    rpcDispatchers.set(active, dispatcher);
  }
  return dispatcher;
}

/**
 * The `fetch` every chain RPC call goes through: the global `fetch`, with a
 * dispatcher that refuses Brotli, and HTTP/2 where `fetch` would otherwise
 * negotiate it.
 * A test keeps the other chain sources from calling `fetch` themselves.
 */
export function chainRpcFetch(input: string | URL, init: RequestInit): Promise<Response> {
  const dispatcher = chainRpcDispatcher();
  const request: ChainRpcRequestInit = dispatcher ? { ...init, dispatcher } : init;
  return fetch(input, request);
}
