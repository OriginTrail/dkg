// SPDX-License-Identifier: Apache-2.0

/** Configured store identity and a detached runtime-monitor status snapshot. */
import { isExternalBackend } from '@origintrail-official/dkg-storage';
import type { DkgConfig } from '../config.js';
import { resolveManagedOxigraphPort } from './oxigraph-managed.js';
import type { StoreMonitorStats } from './store-runtime-monitor.js';

export interface StoreStatusProjection {
  storeBackend: string;
  storeUrl: string | null;
  storeMonitor: StoreMonitorStats | null;
}

export function projectStoreStatus(
  store: DkgConfig['store'],
  monitor: { readonly stats: StoreMonitorStats } | null,
): StoreStatusProjection {
  // External backend visibility (RFC 120 / plan PR 1 item 3). For
  // local backends the URL/count stay null and count status/age are omitted.
  let storeUrl: string | null = null;
  const opts = (store?.options ?? {}) as Record<string, unknown>;
  if (isExternalBackend(store?.backend)) {
    storeUrl = typeof opts.url === 'string' ? opts.url
      : typeof opts.queryEndpoint === 'string' ? opts.queryEndpoint
      : null;
  } else if (store?.backend === 'oxigraph-server') {
    // Managed local server: report its loopback endpoint so `dkg status`
    // renders the external-store health path (storeQuads/unreachable)
    // instead of printing it like a quad-less local store.
    const port = resolveManagedOxigraphPort(opts);
    storeUrl = `http://127.0.0.1:${port}/query`;
  }
  return {
    storeBackend: store?.backend ?? 'oxigraph-worker',
    storeUrl,
    // Runtime store monitor (store.monitor.*) — null for local backends
    // or pre-boot. Counters let operators see probe failures / automatic
    // container restarts without grepping journald.
    storeMonitor: monitor ? { ...monitor.stats } : null,
  };
}
