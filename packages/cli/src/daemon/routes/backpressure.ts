import { backpressureRegistry } from '@origintrail-official/dkg-core';
import { jsonResponse } from '../http-utils.js';
import type { RequestContext } from './context.js';

/**
 * Node-admin diagnostics for every registered scheduler/backlog source.
 *
 * The response contains bounded, sanitized operation labels and aggregate
 * timings only. It never exposes work closures, request bodies, SPARQL text,
 * graph identifiers, peer identifiers, or durable queue payloads.
 */
export async function handleBackpressureRoutes(ctx: RequestContext): Promise<void> {
  const {
    req,
    res,
    agent,
    config,
    validTokens,
    path,
    requestToken,
  } = ctx;

  if (req.method !== 'GET' || path !== '/api/diagnostics/backpressure') return;

  const authEnabled = config.auth?.enabled !== false;
  const isNodeAdminCaller =
    !authEnabled
    || (
      !!requestToken
      && validTokens.has(requestToken)
      && !agent.resolveAgentByToken(requestToken)
    );
  if (!isNodeAdminCaller) {
    return jsonResponse(res, 403, {
      error:
        'GET /api/diagnostics/backpressure requires a node-level admin token '
        + '(~/.dkg/auth.token); agent-scoped tokens cannot inspect node-wide scheduler work.',
    });
  }

  return jsonResponse(res, 200, backpressureRegistry.capture());
}
