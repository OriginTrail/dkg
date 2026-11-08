// SPDX-License-Identifier: Apache-2.0
//
// The marketplace gateway (OT-RFC-27): `GET /api/marketplace/v1/models` and
// `POST /api/marketplace/v1/chat/completions`, OpenAI-compatible. They pass the
// daemon's token guard and check their caller here, before the body is read:
// an access key of this node, or the node's admin token (the UI's playground).
// Anyone else gets 401, loopback included, and an agent token is not a key.

import { jsonResponse, readBody } from '../http-utils.js';
import { MARKETPLACE_GATEWAY_ROUTES, isMarketplaceGatewayRoute } from './marketplace-gateway-paths.js';
import type { RequestContext } from './context.js';

/** A chat call's body: its messages and settings. */
const CHAT_BODY_BYTES = 512 * 1024;

const refuse = (code: string, message: string) => ({ error: { code, message, type: 'marketplace' } });

/** Answer the gateway's two routes; any other request is left to the other routes. */
export async function handleMarketplaceGatewayRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, path } = ctx;
  if (!isMarketplaceGatewayRoute(req.method, path)) return;
  const gateway = ctx.marketplaceGateway;
  if (!gateway) return jsonResponse(res, 503, refuse('MarketplaceOff', 'The marketplace is off on this node'));
  const authentication = ctx.actor.authentication;
  const checked = await gateway.callerOf({
    admin: authentication.principal.kind === 'nodeOperator',
    token: authentication.presentedToken,
  });
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
