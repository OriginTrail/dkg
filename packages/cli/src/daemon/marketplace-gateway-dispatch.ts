// OT-RFC-27 buyer gateway dispatch — the daemon's ONLY pre-auth carve-out.
//
// `lifecycle.ts` calls `isMarketplaceGatewayPath` immediately after the CORS
// preflight block and BEFORE `authenticateHttpRequest`; a matching request is
// handed to `MarketplaceGatewayDispatch.handle` and never reaches the
// token-authenticated surfaces (no `authenticateHttpRequest`, no
// `handleRequest` / route modules, no node-UI handler, no route plugins, no
// SSE / apps / TTL handlers; no RequestActor). The handler authenticates by a
// scoped gateway key itself (`routes/marketplace-gateway.ts`).
//
// Security invariants (spec §11.3) this module owns:
//   S1 narrow match — the WHATWG pathname equals the base or starts with
//      `base + '/'`; dot segments are resolved by the URL parser first (both
//      sides of the carve-out parse the same `new URL(req.url, host)`), and
//      percent-encoded separators stay encoded, so `…/v1/chat%2F..%2Fstatus`
//      lands IN the gateway (404 after key auth), never elsewhere;
//   S2 sole owner — `handle` always ends the response (500 JSON on an
//      internal fault) and never throws;
//   S6 auth disabled does not open spend — nothing here consults the daemon's
//      auth mode: the gateway ALWAYS requires a key.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { SlidingWindowRateLimiter } from '@origintrail-official/dkg-agent/dist/marketplace/gateway-domain.js';
import { openGatewayKeyStore, type MarketplaceGatewayKeyStore } from '../marketplace-gateway-key-store.js';
import type { ResolvedMarketplaceGatewayConfig } from '../marketplace-config.js';
import { corsHeaders } from './http-utils.js';
import {
  handleMarketplaceGatewayRequest,
  type MarketplaceGatewayAgent,
  type MarketplaceGatewayState,
} from './routes/marketplace-gateway.js';
import { INTERNAL_ERROR_REPLY, gatewayErrorBody, gatewayRetryHeader } from './routes/marketplace-gateway-errors.js';

export const MARKETPLACE_GATEWAY_BASE_PATH = '/api/marketplace/gateway/v1';

/** Exact base or a subpath of it. Operates on the WHATWG-parsed pathname (dot segments already resolved). */
export function isMarketplaceGatewayPath(pathname: string): boolean {
  return pathname === MARKETPLACE_GATEWAY_BASE_PATH || pathname.startsWith(`${MARKETPLACE_GATEWAY_BASE_PATH}/`);
}

export interface MarketplaceGatewayDispatch {
  /** Never throws; always ends `res`. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL, corsOrigin: string | null): Promise<void>;
  /** The shared key store (also opened by the node-admin key routes). */
  readonly store: MarketplaceGatewayKeyStore;
}

/**
 * Body read deadline. A slow sender holds only one of its OWN key's slots
 * meanwhile: the gateway-wide slot is taken after the body is read.
 */
const GATEWAY_BODY_TIMEOUT_MS = 30_000;

/** One key's in-flight cap: half the gateway (at least 1), so no single key can hold every slot. */
export function gatewayMaxConcurrentPerKey(maxConcurrent: number): number {
  return Math.max(1, Math.ceil(maxConcurrent / 2));
}

/** `undefined` ⇔ gateway disabled (marketplace off, or `marketplace.buyer.gateway.enabled === false`). */
export function createMarketplaceGatewayDispatch(input: {
  agent: MarketplaceGatewayAgent;
  gateway: ResolvedMarketplaceGatewayConfig | undefined;
  dataDir: string;
  log: (line: string) => void;
  /** Test seams. */
  nowMs?: () => number;
  store?: MarketplaceGatewayKeyStore;
  bodyTimeoutMs?: number;
}): MarketplaceGatewayDispatch | undefined {
  if (!input.gateway) return undefined;
  const store = input.store ?? openGatewayKeyStore(input.dataDir, { log: input.log });
  const state: MarketplaceGatewayState = {
    agent: input.agent,
    store,
    config: input.gateway,
    limiter: new SlidingWindowRateLimiter({ windowMs: 1000, maxKeys: 10_000 }),
    inFlight: { count: 0 },
    perKeyInFlight: new Map(),
    maxConcurrentPerKey: gatewayMaxConcurrentPerKey(input.gateway.maxConcurrent),
    log: input.log,
    nowMs: input.nowMs ?? Date.now,
    bodyTimeoutMs: input.bodyTimeoutMs ?? GATEWAY_BODY_TIMEOUT_MS,
  };
  return {
    store,
    async handle(req, res, url, corsOrigin) {
      try {
        if (req.method === 'OPTIONS') {
          // Generic preflight (no data); the lifecycle answers it before the carve-out.
          res.writeHead(204, {
            ...corsHeaders(corsOrigin),
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          });
          res.end();
          return;
        }
        const subpath = url.pathname.slice(MARKETPLACE_GATEWAY_BASE_PATH.length);
        await handleMarketplaceGatewayRequest(state, req, res, subpath, corsOrigin);
      } catch (err) {
        state.log(`[marketplace-gateway] dispatch fault: ${(err as Error)?.name ?? 'Error'}: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
        if (!res.headersSent && !res.destroyed) {
          const body = gatewayErrorBody(INTERNAL_ERROR_REPLY);
          const text = JSON.stringify(body);
          res.writeHead(500, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': String(Buffer.byteLength(text)),
            Connection: 'close',
            ...gatewayRetryHeader(body),
            ...corsHeaders(corsOrigin),
          });
          res.end(text);
        }
      } finally {
        if (!res.writableEnded && !res.destroyed) {
          if (res.headersSent) res.end();
          else res.destroy();
        }
      }
    },
  };
}
