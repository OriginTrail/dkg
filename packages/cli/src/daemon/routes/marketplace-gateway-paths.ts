// SPDX-License-Identifier: Apache-2.0
//
// The marketplace gateway's routes (OT-RFC-27): the only routes the daemon's
// token guard lets through to authenticate their own callers, with access keys.
// Exact method and path pairs, never a prefix. This module imports nothing, so
// the guard in auth.ts can ask it.

export const MARKETPLACE_GATEWAY_ROUTES = Object.freeze({
  models: { method: 'GET', path: '/api/marketplace/v1/models' },
  chat: { method: 'POST', path: '/api/marketplace/v1/chat/completions' },
});

/** Whether a request is one of the gateway's routes, which check access keys themselves. */
export function isMarketplaceGatewayRoute(method: string | undefined, path: string): boolean {
  return Object.values(MARKETPLACE_GATEWAY_ROUTES).some((r) => r.method === method && r.path === path);
}
