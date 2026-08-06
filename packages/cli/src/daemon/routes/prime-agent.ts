/**
 * `/api/prime-agent-channel/*` — the daemon half of the Prime Agent chat surface.
 *
 * Structurally this is `routes/hermes.ts` minus everything Hermes needs and
 * Prime Agent does not: no OpenAI-compatible second protocol, no attachment
 * provenance verification (the Node UI does not offer attachments for this
 * integration yet), and no persist-turn route (Stage 4 owns memory election).
 * What remains is the part that has to be right — target selection, the auth
 * header, and the SSE pump.
 *
 * The one behaviour worth reading carefully is target selection. Hermes has one
 * configured bridge; Prime Agent has one bridge PER LIVE SESSION, discovered
 * from a directory. So an unaddressed message must not be silently broadcast or
 * silently routed to an arbitrary session — see `resolveTargets` below.
 */

import type { RequestContext } from './context.js';
import {
  corsHeaders,
  jsonResponse,
  readBody,
  resolveCorsOrigin,
  SMALL_BODY_BYTES,
} from '../http-utils.js';
import { daemonState } from '../state.js';
import { hasConfiguredLocalAgentChat } from '../local-agents.js';
import {
  PRIME_AGENT_CHANNEL_RESPONSE_TIMEOUT_MS,
  buildPrimeAgentChannelHeaders,
  ensurePrimeAgentBridgeAvailable,
  getPrimeAgentChannelTargets,
  normalizePrimeAgentChatPayload,
  probePrimeAgentChannelHealth,
  type PrimeAgentChannelTarget,
  type PrimeAgentChatPayload,
} from '../prime-agent.js';
import { pipeOpenClawStream } from '../openclaw.js';

function ensurePrimeAgentIntegrationEnabled(
  config: RequestContext['config'],
  res: RequestContext['res'],
): boolean {
  if (hasConfiguredLocalAgentChat(config, 'prime-agent')) return true;
  jsonResponse(res, 409, {
    error: 'Prime Agent local-agent integration is not enabled',
    code: 'INTEGRATION_DISABLED',
  });
  return false;
}

/**
 * An explicit `sessionId` picks exactly one target; a miss is a 409, never a
 * fallback. Without one we use the newest live session and nothing else: trying
 * the rest in turn would, on a transient failure of the session the user is
 * looking at, deliver their message into a different conversation.
 */
function resolveTargets(
  payload: PrimeAgentChatPayload,
  res: RequestContext['res'],
): PrimeAgentChannelTarget[] | null {
  const targets = getPrimeAgentChannelTargets({ sessionId: payload.sessionId });
  if (targets.length === 0) {
    jsonResponse(res, 409, {
      error: payload.sessionId
        ? `No live Prime Agent session ${payload.sessionId}`
        : 'No live Prime Agent session',
      code: 'PRIME_AGENT_NO_SESSION',
      source: 'prime-agent-channel',
      correlationId: payload.correlationId,
    });
    return null;
  }
  return targets.slice(0, 1);
}

function buildPrimeAgentChannelBody(
  payload: PrimeAgentChatPayload,
  target: PrimeAgentChannelTarget,
  requestAgentAddress: string | undefined,
): Record<string, unknown> {
  return {
    text: payload.text,
    correlationId: payload.correlationId,
    sessionId: target.sessionId,
    identity: payload.identity ?? 'owner',
    ...(payload.contextGraphId ? { contextGraphId: payload.contextGraphId } : {}),
    ...(payload.metadata ? { metadata: payload.metadata } : {}),
    ...(requestAgentAddress ? { currentAgentAddress: requestAgentAddress } : {}),
  };
}

function isPrimeAgentTimeoutError(err: unknown): boolean {
  const e = err as { name?: string; cause?: { name?: string }; message?: string };
  return (
    e?.name === 'TimeoutError'
    || e?.cause?.name === 'TimeoutError'
    || /timeout/i.test(String(e?.message ?? err ?? ''))
  );
}

function timeoutBody(correlationId: string, sessionId: string): Record<string, unknown> {
  return {
    error: 'Prime Agent bridge response timeout',
    code: 'PRIME_AGENT_BRIDGE_RESPONSE_TIMEOUT',
    source: 'prime-agent-channel',
    sessionId,
    correlationId,
    timeoutMs: PRIME_AGENT_CHANNEL_RESPONSE_TIMEOUT_MS,
  };
}

async function readPayload(
  ctx: RequestContext,
): Promise<PrimeAgentChatPayload | null> {
  const { req, res } = ctx;
  const body = await readBody(req, SMALL_BODY_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    jsonResponse(res, 400, { error: 'Invalid JSON' });
    return null;
  }
  const payload = normalizePrimeAgentChatPayload(parsed);
  if ('error' in payload) {
    jsonResponse(res, 400, { error: payload.error });
    return null;
  }
  return payload;
}

export async function handlePrimeAgentRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, config, bridgeAuthToken, path, requestAgentAddress } = ctx;

  if (req.method === 'POST' && path === '/api/prime-agent-channel/send') {
    if (!ensurePrimeAgentIntegrationEnabled(config, res)) return;
    const payload = await readPayload(ctx);
    if (!payload) return;
    const targets = resolveTargets(payload, res);
    if (!targets) return;

    const target = targets[0];
    const availability = await ensurePrimeAgentBridgeAvailable(target, bridgeAuthToken);
    if (!availability.ok) {
      return jsonResponse(res, 503, {
        error: 'Prime Agent bridge unavailable',
        code: 'PRIME_AGENT_BRIDGE_OFFLINE',
        source: 'prime-agent-channel',
        sessionId: target.sessionId,
        details: availability.details,
        correlationId: payload.correlationId,
      });
    }

    try {
      const forwardRes = await fetch(target.inboundUrl, {
        method: 'POST',
        headers: buildPrimeAgentChannelHeaders(
          target,
          bridgeAuthToken,
          { 'Content-Type': 'application/json', Accept: 'application/json' },
          target.inboundUrl,
        ),
        body: JSON.stringify(buildPrimeAgentChannelBody(payload, target, requestAgentAddress)),
        signal: AbortSignal.timeout(PRIME_AGENT_CHANNEL_RESPONSE_TIMEOUT_MS),
      });
      const text = await forwardRes.text();
      if (!forwardRes.ok) {
        // 429 is the bridge's one-turn-at-a-time guard, and it is a normal
        // outcome the UI should surface as "busy" rather than as a fault.
        return jsonResponse(res, forwardRes.status === 429 ? 429 : 502, {
          error: forwardRes.status === 429 ? 'Prime Agent session is busy' : 'Prime Agent bridge error',
          code: forwardRes.status === 429 ? 'PRIME_AGENT_SESSION_BUSY' : 'BRIDGE_ERROR',
          source: 'prime-agent-channel',
          sessionId: target.sessionId,
          details: text.slice(0, 2000),
          correlationId: payload.correlationId,
        });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { text };
      }
      return jsonResponse(res, 200, {
        ...(parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : { text }),
        sessionId: target.sessionId,
        correlationId: payload.correlationId,
      });
    } catch (err) {
      if (isPrimeAgentTimeoutError(err)) {
        return jsonResponse(res, 504, timeoutBody(payload.correlationId, target.sessionId));
      }
      return jsonResponse(res, 502, {
        error: 'Prime Agent bridge error',
        code: 'BRIDGE_ERROR',
        source: 'prime-agent-channel',
        sessionId: target.sessionId,
        details: String(err).slice(0, 500),
        correlationId: payload.correlationId,
      });
    }
  }

  if (req.method === 'POST' && path === '/api/prime-agent-channel/stream') {
    if (!ensurePrimeAgentIntegrationEnabled(config, res)) return;
    const payload = await readPayload(ctx);
    if (!payload) return;
    const targets = resolveTargets(payload, res);
    if (!targets) return;

    const target = targets[0];
    const availability = await ensurePrimeAgentBridgeAvailable(target, bridgeAuthToken);
    if (!availability.ok) {
      return jsonResponse(res, 503, {
        error: 'Prime Agent bridge unavailable',
        code: 'PRIME_AGENT_BRIDGE_OFFLINE',
        source: 'prime-agent-channel',
        sessionId: target.sessionId,
        details: availability.details,
        correlationId: payload.correlationId,
      });
    }

    try {
      const transportRes = await fetch(target.streamUrl, {
        method: 'POST',
        headers: buildPrimeAgentChannelHeaders(
          target,
          bridgeAuthToken,
          { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          target.streamUrl,
        ),
        body: JSON.stringify(buildPrimeAgentChannelBody(payload, target, requestAgentAddress)),
        signal: AbortSignal.timeout(PRIME_AGENT_CHANNEL_RESPONSE_TIMEOUT_MS),
      });

      if (!transportRes.ok || !transportRes.body) {
        const details = await transportRes.text().catch(() => '');
        return jsonResponse(res, transportRes.status === 429 ? 429 : 502, {
          error: transportRes.status === 429 ? 'Prime Agent session is busy' : 'Prime Agent bridge error',
          code: transportRes.status === 429 ? 'PRIME_AGENT_SESSION_BUSY' : 'BRIDGE_ERROR',
          source: 'prime-agent-channel',
          sessionId: target.sessionId,
          details: details.slice(0, 2000),
          correlationId: payload.correlationId,
        });
      }

      // Declare SSE before the first byte. Without this the browser sees an
      // untyped body, EventSource-style parsing does not engage, and the client
      // fails with "The string did not match the expected pattern" instead of
      // reading frames.
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        ...corsHeaders(resolveCorsOrigin(req, daemonState.moduleCorsAllowed)),
      });

      // Same pump Hermes and OpenClaw use — backpressure handling and
      // terminal-frame detection live in one place on purpose.
      await pipeOpenClawStream(req, res, (transportRes.body as any).getReader());
      if (!res.writableEnded) res.end();
      return;
    } catch (err) {
      if (res.writableEnded || res.headersSent) {
        // Mid-stream failure: the SSE head is already on the wire, so a JSON
        // error body would corrupt the frame sequence. Just end it.
        try {
          res.end();
        } catch {
          /* client already gone */
        }
        return;
      }
      if (isPrimeAgentTimeoutError(err)) {
        return jsonResponse(res, 504, timeoutBody(payload.correlationId, target.sessionId));
      }
      return jsonResponse(res, 502, {
        error: 'Prime Agent bridge error',
        code: 'BRIDGE_ERROR',
        source: 'prime-agent-channel',
        sessionId: target.sessionId,
        details: String(err).slice(0, 500),
        correlationId: payload.correlationId,
      });
    }
  }

  if (req.method === 'GET' && path === '/api/prime-agent-channel/health') {
    const health = await probePrimeAgentChannelHealth(bridgeAuthToken);
    // Always 200. `ok: false` with `sessionCount: 0` is the idle state, not a
    // server fault, and the UI needs the counts either way.
    return jsonResponse(res, 200, health);
  }
}
