// OT-RFC-27 buyer gateway error objects: the OpenAI-style error envelope and
// the one mapping from agent-thrown errors to HTTP status + `type` + `code`
// (spec §9.6). Agent errors are matched by their stable `name` (set in their
// constructors), never `instanceof`, so this module has no value import from
// the agent package at all.

/** `{ error: { message, type, param, code, dkg } }` — every gateway error body. */
export interface GatewayErrorBody {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string;
    dkg: {
      reason?: string;
      rejections?: Array<{ offerId: string; reason: string }>;
      /** Decimal wei: exactly the cost this call's spend guard settled ('0' when none). */
      charged_wei: string;
      retryable: boolean;
    };
  };
}

/** A mapped error before the per-call `charged_wei` is attached. */
export interface GatewayErrorReply {
  status: number;
  type: string;
  code: string;
  message: string;
  param?: string | null;
  reason?: string;
  rejections?: Array<{ offerId: string; reason: string }>;
  retryable?: boolean;
}

/**
 * The error envelope. A call that was charged is never `retryable`: a retry is
 * a NEW routed call with a new authorization and a new charge.
 */
export function gatewayErrorBody(reply: GatewayErrorReply, chargedWei: bigint = 0n): GatewayErrorBody {
  return {
    error: {
      message: reply.message,
      type: reply.type,
      param: reply.param ?? null,
      code: reply.code,
      dkg: {
        ...(reply.reason !== undefined ? { reason: reply.reason } : {}),
        ...(reply.rejections !== undefined ? { rejections: reply.rejections } : {}),
        charged_wei: chargedWei.toString(),
        retryable: (reply.retryable ?? false) && chargedWei === 0n,
      },
    },
  };
}

/**
 * The retry header OpenAI SDKs honor BEFORE their status rule (openai-node /
 * openai-python retry 408/409/429/≥500 by default and never read the body):
 * it mirrors `dkg.retryable`, so a charged 5xx is never silently re-sent.
 */
export function gatewayRetryHeader(body: GatewayErrorBody): { 'x-should-retry': 'true' | 'false' } {
  return { 'x-should-retry': body.error.dkg.retryable ? 'true' : 'false' };
}

/** The generic 500 — details stay in the log (callId + keyId only), never in the body. */
export const INTERNAL_ERROR_REPLY: GatewayErrorReply = {
  status: 500,
  type: 'api_error',
  code: 'internal_error',
  message: 'The gateway hit an internal error; the node log has the call id.',
};

/** The gateway-wide concurrency cap (taken only after the body is read and the key's scope checked). */
export const GATEWAY_BUSY_REPLY: GatewayErrorReply = {
  status: 503,
  type: 'api_error',
  code: 'gateway_busy',
  message: 'the gateway is at its concurrency limit; retry shortly',
  retryable: true,
};

export const MARKETPLACE_UNAVAILABLE_REPLY: GatewayErrorReply = {
  status: 503,
  type: 'service_unavailable',
  code: 'marketplace_unavailable',
  message: 'The marketplace is not available on this node.',
  retryable: true,
};

// The mixin's requireRuntime gate and the buyer service's capability checks
// (same patterns as routes/marketplace.ts): a deployment gap, not a caller error.
export function isMarketplaceOffMessage(msg: string): boolean {
  return /marketplace is not running on this node/i.test(msg)
    || /chain adapter does not support marketplace/i.test(msg)
    || /chain adapter (?:cannot|reports no)/i.test(msg)
    || /No blockchain configured/i.test(msg);
}

/** Seller refusals that name an upstream/connector fault (spec §9.6 → 502 upstream_error). */
const UPSTREAM_FAULT_CODES = new Set([
  'UPSTREAM_ERROR', 'UPSTREAM_AUTH', 'EXECUTION_FAILED', 'CONNECTOR_UNAVAILABLE',
  'SELLER_NOT_READY', 'EMPTY_RESULT', 'METERING_OVERRUN',
]);
const RECEIPT_FAULT_CODES = new Set(['BAD_RECEIPT', 'MALFORMED_RECEIPT', 'MALFORMED_RESULT', 'UNVERIFIABLE_SELLER']);
const SELLER_REJECTED_REQUEST_CODES = new Set(['BAD_PAYLOAD', 'MODEL_MISMATCH', 'TOOLS_UNSUPPORTED']);

function invokeErrorReply(code: string, message: string, unitsParam: string): GatewayErrorReply {
  if (code === 'UNDERFUNDED') {
    return { status: 429, type: 'insufficient_quota', code: 'underfunded', message, reason: code };
  }
  if (code === 'CONTEXT_EXCEEDED') {
    return { status: 400, type: 'invalid_request_error', code: 'context_length_exceeded', message, param: 'messages', reason: code };
  }
  if (code === 'OVER_MAX_UNITS') {
    return { status: 400, type: 'invalid_request_error', code: 'max_units_exceeded', message, param: unitsParam, reason: code };
  }
  if (SELLER_REJECTED_REQUEST_CODES.has(code)) {
    return { status: 400, type: 'invalid_request_error', code: 'seller_rejected_request', message, reason: code };
  }
  if (code === 'UPSTREAM_RATE_LIMITED') {
    return { status: 429, type: 'rate_limit_error', code: 'upstream_rate_limited', message, reason: code, retryable: true };
  }
  if (code === 'UPSTREAM_TIMEOUT') {
    return { status: 504, type: 'api_error', code: 'upstream_timeout', message, reason: code, retryable: true };
  }
  if (UPSTREAM_FAULT_CODES.has(code)) {
    return { status: 502, type: 'api_error', code: 'upstream_error', message, reason: code, retryable: true };
  }
  if (code === 'DELIVERY_UNKNOWN') {
    // Not retryable: the seller may have served — the worst case stays held against the key.
    return { status: 504, type: 'api_error', code: 'delivery_unknown', message, reason: code };
  }
  if (RECEIPT_FAULT_CODES.has(code)) {
    return { status: 502, type: 'api_error', code: 'bad_receipt', message, reason: code };
  }
  return { status: 502, type: 'api_error', code: 'seller_refused', message, reason: code };
}

function routeErrorReply(
  reason: string,
  rejections: Array<{ offerId: string; reason: string }>,
  message: string,
  unitsParam: string,
): GatewayErrorReply {
  if (reason === 'no-bucket') {
    return { status: 403, type: 'permission_error', code: 'no_plan_bucket', message, reason };
  }
  const every = (r: string) => rejections.length > 0 && rejections.every((rejection) => rejection.reason === r);
  if (reason === 'max-units' || every('max-units')) {
    return { status: 400, type: 'invalid_request_error', code: 'max_units_exceeded', message, param: unitsParam, reason, rejections };
  }
  if (every('soft-ceiling')) {
    return { status: 429, type: 'insufficient_quota', code: 'soft_ceiling', message, reason, rejections };
  }
  if (reason === 'no-offers') {
    return { status: 503, type: 'service_unavailable', code: 'no_offers', message, reason, retryable: true };
  }
  return { status: 503, type: 'service_unavailable', code: 'no_route', message, reason, rejections, retryable: true };
}

/**
 * Map one agent-thrown error (spec §9.6). `unitsParam` names the request field
 * that sizes the authorization (`max_tokens` for chat, `max_rows` for query).
 */
export function mapGatewayError(err: unknown, unitsParam: 'max_tokens' | 'max_rows'): GatewayErrorReply {
  const e = (err ?? {}) as { name?: unknown; message?: unknown; code?: unknown; param?: unknown; reason?: unknown; rejections?: unknown };
  const name = typeof e.name === 'string' ? e.name : '';
  const message = typeof e.message === 'string' ? e.message : String(err);
  if (isMarketplaceOffMessage(message)) return MARKETPLACE_UNAVAILABLE_REPLY;
  switch (name) {
    case 'MarketplaceRequestError':
      return {
        status: 400,
        type: 'invalid_request_error',
        code: typeof e.code === 'string' ? e.code : 'invalid_parameter',
        message,
        param: typeof e.param === 'string' ? e.param : null,
      };
    case 'MarketplaceModelNotFoundError':
      return { status: 404, type: 'invalid_request_error', code: 'model_not_found', message, param: 'model' };
    case 'MarketplaceNotSubscribedError':
      return { status: 403, type: 'permission_error', code: 'not_subscribed', message };
    case 'MarketplaceRouteError': {
      const rejections = Array.isArray(e.rejections)
        ? (e.rejections as Array<{ offerId?: unknown; reason?: unknown }>).map((r) => ({
            offerId: String(r?.offerId ?? ''),
            reason: String(r?.reason ?? ''),
          }))
        : [];
      return routeErrorReply(typeof e.reason === 'string' ? e.reason : 'no-eligible-offer', rejections, message, unitsParam);
    }
    case 'MarketplaceSpendRefusedError':
      return { status: 429, type: 'insufficient_quota', code: 'key_budget_exceeded', message };
    case 'MarketplaceInvokeError':
      return invokeErrorReply(typeof e.code === 'string' ? e.code : 'SELLER_ERROR', message, unitsParam);
    case 'MarketplaceInvalidToolResponseError':
      return { status: 502, type: 'api_error', code: 'invalid_tool_response', message };
    default:
      return INTERNAL_ERROR_REPLY;
  }
}
