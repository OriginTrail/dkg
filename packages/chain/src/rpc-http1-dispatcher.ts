// SPDX-License-Identifier: Apache-2.0

import { createRequire } from 'node:module';
import type { Agent } from 'undici';

/**
 * Keeps chain JSON-RPC calls on HTTP/1.1 on every supported Node line (#2828).
 *
 * Node 26 bundles undici 8, whose `fetch` negotiates HTTP/2 with any TLS
 * server that offers it. Node 22 and 24 bundle undici 6 and 7, which stay on
 * HTTP/1.1 unless asked. So a daemon on Node 26 sent every chain RPC call over
 * HTTP/2, a path no release was tested on, and one such daemon stalled in
 * Node's native HTTP/2 write buffering until its worker was killed.
 *
 * Where the bundled undici is 8 or later, RPC calls run on an undici 7 Agent,
 * which never negotiates HTTP/2. An undici 7 Agent accepts the handlers of the
 * undici every supported Node line bundles; the local-agent channel forwards
 * rely on the same. On older lines the default dispatcher stays.
 */
const requireUndici = createRequire(import.meta.url);
let http1Dispatcher: Agent | undefined;

/** Major version of the undici this Node bundles, or null when unknown. */
export function bundledUndiciMajor(version: string | undefined = process.versions.undici): number | null {
  const head = typeof version === 'string' ? version.split('.')[0] : '';
  if (!head || !/^\d+$/.test(head)) return null;
  return Number(head);
}

/**
 * The dispatcher a chain RPC `fetch` passes, or undefined to keep the default:
 * an HTTP/1.1-only undici 7 Agent where the bundled undici would negotiate
 * HTTP/2.
 */
export function rpcFetchDispatcher(version: string | undefined = process.versions.undici): Agent | undefined {
  const major = bundledUndiciMajor(version);
  if (major === null || major < 8) return undefined;
  if (!http1Dispatcher) {
    const undici = requireUndici('undici') as typeof import('undici');
    http1Dispatcher = new undici.Agent({ allowH2: false });
  }
  return http1Dispatcher;
}

/** `fetch` init fields that keep a chain RPC call on HTTP/1.1. */
export function rpcFetchTransportInit(version?: string): { dispatcher?: Agent } {
  const dispatcher = version === undefined ? rpcFetchDispatcher() : rpcFetchDispatcher(version);
  return dispatcher ? { dispatcher } : {};
}
