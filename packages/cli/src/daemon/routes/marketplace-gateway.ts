// SPDX-License-Identifier: Apache-2.0
//
// The marketplace gateway (OT-RFC-27): `GET /api/marketplace/v1/models` and
// `POST /api/marketplace/v1/chat/completions`, OpenAI-compatible. They pass the
// daemon's token guard and check their caller here, before the body is read:
// an access key of this node. Anyone else gets 401, loopback included; a node
// or agent token is not a key. Keys are made under /api/marketplace/keys,
// with the node-admin token, the UI's playground's included.

import { PEER_LIMITS } from '@origintrail-official/dkg-marketplace';
import { jsonResponse, readBody } from '../http-utils.js';
import { MARKETPLACE_GATEWAY_ROUTES, isMarketplaceGatewayRoute } from './marketplace-gateway-paths.js';
import type { RequestContext } from './context.js';

/** A chat call's body: no more than a seller takes in one message. */
const CHAT_BODY_BYTES = PEER_LIMITS.serveRequestBytes;

const refuse = (code: string, message: string) => ({ error: { code, message, type: 'marketplace' } });

/** Answer the gateway's two routes; any other request is left to the other routes. */
export async function handleMarketplaceGatewayRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, path } = ctx;
  if (!isMarketplaceGatewayRoute(req.method, path)) return;
  const gateway = ctx.marketplaceGateway;
  if (!gateway) return jsonResponse(res, 503, refuse('MarketplaceOff', 'The marketplace is off on this node'));
  const checked = await gateway.callerOf(ctx.actor.authentication.presentedToken);
  if ('answer' in checked) return jsonResponse(res, checked.answer.status, checked.answer.body);
  if (path === MARKETPLACE_GATEWAY_ROUTES.models.path) {
    const answer = await gateway.models();
    return jsonResponse(res, answer.status, answer.body);
  }
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req, CHAT_BODY_BYTES));
  } catch {
    return jsonResponse(res, 400, refuse('bad_request', 'the body must be JSON'));
  }
  const answer = await gateway.chatCompletion(checked.caller, body);
  return jsonResponse(res, answer.status, answer.body, undefined, answer.headers);
}
