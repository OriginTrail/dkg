/**
 * `/api/prime-agent-channel/*` — the daemon half of the Prime Agent chat surface.
 *
 * Structurally this is `routes/hermes.ts` minus everything Hermes needs and
 * Prime Agent does not: no OpenAI-compatible second protocol and no attachment
 * provenance verification (the Node UI does not offer attachments for this
 * integration yet).
 * What remains is the part that has to be right — target selection, the auth
 * header, and the SSE pump.
 *
 * The one behaviour worth reading carefully is target selection. Hermes has one
 * configured bridge; Prime Agent has one bridge PER LIVE SESSION, discovered
 * from a directory. So an unaddressed message must not be silently broadcast or
 * silently routed to an arbitrary session — see `resolveTargets` below.
 */

import { randomUUID } from 'node:crypto';
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
  PRIME_AGENT_CHANNEL_HARD_TIMEOUT_MS,
  PRIME_AGENT_CHANNEL_RESPONSE_TIMEOUT_MS,
  buildPrimeAgentChannelHeaders,
  ensurePrimeAgentBridgeAvailable,
  getPrimeAgentChannelTargets,
  normalizePrimeAgentPersistTurnPayload,
  primeAgentDkgSessionId,
  primeAgentRawSessionId,
  normalizePrimeAgentChatPayload,
  probePrimeAgentChannelHealth,
  type PrimeAgentChannelTarget,
  type PrimeAgentChatPayload,
  type PrimeAgentPersistTurnPayload,
} from '../prime-agent.js';
import { writeOpenClawStreamChunk } from '../openclaw.js';

type PrimeAgentPersistRouteResult = {
  statusCode: number;
  body: Record<string, unknown>;
};

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
 * fallback. Without one we use the most-recently-active election winner
 * (`lastActiveAt`, stamped per turn) and nothing else: trying the rest in turn
 * would, on a transient failure of the session the user is looking at, deliver
 * their message into a different conversation.
 */
function resolveTargets(
  payload: PrimeAgentChatPayload,
  res: RequestContext['res'],
): PrimeAgentChannelTarget[] | null {
  const targets = getPrimeAgentChannelTargets({
    sessionId: payload.sessionId ? primeAgentRawSessionId(payload.sessionId) : undefined,
  });
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

// Must stay in lock-step with PrimeAgentTurnErrorCode in
// packages/adapter-prime-agent/extension/src/extension.ts (the producer) and
// the per-code branches in
// packages/node-ui/src/ui/components/Shell/PanelRight/local-agent-errors.ts:
// a bridge code missing here degrades to a generic BRIDGE_ERROR on /send
// while /stream forwards the SSE frame verbatim, and the transports diverge.
const SANITIZED_PRIME_AGENT_BRIDGE_FAILURES: Readonly<Record<string, string>> = {
  PRIME_AGENT_PROVIDER_UNAUTHORIZED:
    'Prime Agent provider authentication failed. Check the configured provider credentials.',
  PRIME_AGENT_PROVIDER_ERROR: 'Prime Agent provider request failed.',
  PRIME_AGENT_TURN_ABORTED: 'Prime Agent turn was aborted.',
  PRIME_AGENT_TURN_TIMEOUT: 'Prime Agent turn exceeded its hard limit.',
  PRIME_AGENT_DELIVERY_FAILED: 'Prime Agent rejected the local message before starting the turn.',
};

function sanitizedPrimeAgentBridgeFailure(
  body: Record<string, unknown>,
): { code: string; error: string } | null {
  const code = typeof body.code === 'string' ? body.code : '';
  // Own-property check: a hostile `code` like "constructor" or "__proto__"
  // must fall through to the generic BRIDGE_ERROR envelope, not resolve a
  // truthy value off Object.prototype.
  const error = Object.hasOwn(SANITIZED_PRIME_AGENT_BRIDGE_FAILURES, code)
    ? SANITIZED_PRIME_AGENT_BRIDGE_FAILURES[code]
    : undefined;
  return error ? { code, error } : null;
}

/**
 * `timeoutMs` names the limit that actually fired: the bridge's idle window
 * (the response-timeout constant) when we are relaying its 504 verdict, the
 * daemon's hard cap when the transport itself hung and the abort tripped.
 */
function timeoutBody(
  correlationId: string,
  sessionId: string,
  timeoutMs: number,
): Record<string, unknown> {
  return {
    error: 'Prime Agent bridge response timeout',
    code: 'PRIME_AGENT_BRIDGE_RESPONSE_TIMEOUT',
    source: 'prime-agent-channel',
    sessionId,
    correlationId,
    timeoutMs,
  };
}

function buildPrimeAgentPersistPayload(
  payload: PrimeAgentChatPayload,
  target: PrimeAgentChannelTarget,
  assistantReply: string,
  state: 'stored' | 'failed' = 'stored',
  failureReason?: string,
): PrimeAgentPersistTurnPayload {
  return {
    sessionId: primeAgentDkgSessionId(target.sessionId),
    userMessage: payload.text,
    assistantReply,
    correlationId: payload.correlationId,
    turnId: payload.correlationId,
    persistenceState: state,
    ...(failureReason ? { failureReason } : {}),
    metadata: { source: 'prime-agent-channel' },
  };
}

function persistenceStateRank(state: PrimeAgentPersistTurnPayload['persistenceState']): number {
  if (state === 'stored') return 3;
  if (state === 'failed') return 2;
  return 1;
}

async function persistPrimeAgentTurn(
  ctx: RequestContext,
  payload: PrimeAgentPersistTurnPayload,
): Promise<PrimeAgentPersistRouteResult> {
  const { memoryManager } = ctx;
  const sessionId = primeAgentDkgSessionId(payload.sessionId);
  const turnId = payload.turnId || payload.correlationId || randomUUID();
  try {
    let existingState: PrimeAgentPersistTurnPayload['persistenceState'] | null = null;
    try {
      existingState = await memoryManager.getChatTurnPersistenceState(sessionId, turnId);
    } catch {
      existingState = null;
    }
    if (existingState === 'stored') {
      return { statusCode: 200, body: { ok: true, duplicate: true, turnId, sessionId } };
    }
    if (existingState) {
      if (
        existingState === payload.persistenceState
        || persistenceStateRank(payload.persistenceState) < persistenceStateRank(existingState)
      ) {
        return { statusCode: 200, body: { ok: true, duplicate: true, turnId, sessionId } };
      }
      await memoryManager.recordChatTurnPersistenceTransition(
        sessionId,
        turnId,
        payload.persistenceState,
        {
          failureReason: payload.failureReason ?? null,
          assistantReply: payload.assistantReply,
          toolCalls: payload.toolCalls,
        },
      );
      return { statusCode: 200, body: { ok: true, transitioned: true, turnId, sessionId } };
    }
    await memoryManager.storeChatExchange(
      sessionId,
      payload.userMessage,
      payload.assistantReply,
      payload.toolCalls,
      {
        turnId,
        persistenceState: payload.persistenceState,
        failureReason: payload.failureReason,
      },
    );
    return { statusCode: 200, body: { ok: true, turnId, sessionId } };
  } catch (err: any) {
    return { statusCode: 500, body: { error: err.message } };
  }
}

function parsePrimeAgentSseEvent(frame: string): Record<string, unknown> | null {
  for (const line of frame.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data) continue;
    try {
      const parsed = JSON.parse(data);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function pipePrimeAgentStreamAndCollect(
  ctx: RequestContext,
  reader: { read: () => Promise<{ done: boolean; value?: Uint8Array }>; cancel: () => Promise<unknown>; releaseLock: () => void },
): Promise<{ text: string; terminal: boolean }> {
  const { req, res } = ctx;
  let clientGone = false;
  const cancelUpstream = () => {
    if (clientGone) return;
    clientGone = true;
    void reader.cancel().catch(() => {});
  };

  req.on('aborted', cancelUpstream);
  res.on('close', () => {
    if (!res.writableEnded) cancelUpstream();
  });
  res.on('error', cancelUpstream);

  const decoder = new TextDecoder();
  let frameBuffer = '';
  let text = '';
  let terminal = false;

  const inspectChunk = (chunk: Uint8Array): boolean => {
    frameBuffer += decoder.decode(chunk, { stream: true });
    const separator = /\r?\n\r?\n/;
    let consumed = 0;
    let match = separator.exec(frameBuffer.slice(consumed));
    while (match) {
      const separatorStart = consumed + match.index;
      const frame = frameBuffer.slice(consumed, separatorStart);
      const frameEnd = separatorStart + match[0].length;
      const event = parsePrimeAgentSseEvent(frame);
      if (event?.type === 'delta' && typeof event.text === 'string') {
        text += event.text;
      } else if (event?.type === 'final') {
        if (typeof event.text === 'string') text = event.text;
        terminal = true;
        return true;
      }
      consumed = frameEnd;
      match = separator.exec(frameBuffer.slice(consumed));
    }
    frameBuffer = frameBuffer.slice(consumed);
    if (frameBuffer.length > 1_000_000) frameBuffer = '';
    return false;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || clientGone) break;
      if (value !== undefined) {
        const sawTerminal = inspectChunk(value);
        await writeOpenClawStreamChunk(res, value);
        if (clientGone) break;
        if (sawTerminal) {
          if (!res.writableEnded) res.end();
          cancelUpstream();
          break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { text, terminal };
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
        // Backstop only: the bridge's activity-based idle timeout is the
        // authority on turn liveness (and preserves partial output in its 504);
        // this abort exists to reap a transport that hung without answering.
        signal: AbortSignal.timeout(PRIME_AGENT_CHANNEL_HARD_TIMEOUT_MS),
      });
      const text = await forwardRes.text();
      if (!forwardRes.ok) {
        let bridgeBody: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === 'object') bridgeBody = parsed as Record<string, unknown>;
        } catch {
          /* non-JSON body: the fallback envelopes below still tell the UI what happened */
        }
        if (forwardRes.status === 504) {
          // The bridge's own idle-timeout verdict. Its JSON body carries any
          // partial turn output, which must reach the UI rather than being
          // flattened into a generic bridge fault.
          return jsonResponse(res, 504, {
            ...timeoutBody(payload.correlationId, target.sessionId, PRIME_AGENT_CHANNEL_RESPONSE_TIMEOUT_MS),
            ...('text' in bridgeBody ? { text: bridgeBody.text } : {}),
            ...('timedOut' in bridgeBody ? { timedOut: bridgeBody.timedOut } : {}),
          });
        }
        const terminalFailure = sanitizedPrimeAgentBridgeFailure(bridgeBody);
        if (terminalFailure) {
          // Only forward codes from the fixed allowlist above. The provider's
          // raw error body may contain credential-bearing diagnostics and must
          // not cross the bridge/daemon trust boundary. The partial transcript
          // is the exception: it only ever accumulates verified text_delta
          // frames, and the UI renders it (LocalAgentApiError.text) exactly as
          // it does for the idle-timeout 504 above.
          return jsonResponse(res, 502, {
            ...terminalFailure,
            ...(typeof bridgeBody.text === 'string' ? { text: bridgeBody.text } : {}),
            source: 'prime-agent-channel',
            sessionId: target.sessionId,
            correlationId: payload.correlationId,
            retryable: false,
          });
        }
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
      const assistantReply = parsed && typeof parsed === 'object' && typeof (parsed as { text?: unknown }).text === 'string'
        ? (parsed as { text: string }).text
        : text;
      const persisted = await persistPrimeAgentTurn(ctx, buildPrimeAgentPersistPayload(payload, target, assistantReply));
      if (persisted.statusCode >= 400) return jsonResponse(res, persisted.statusCode, persisted.body);
      return jsonResponse(res, 200, {
        ...(parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : { text }),
        sessionId: primeAgentDkgSessionId(target.sessionId),
        correlationId: payload.correlationId,
        turnId: String(persisted.body.turnId ?? payload.correlationId),
      });
    } catch (err) {
      if (isPrimeAgentTimeoutError(err)) {
        return jsonResponse(
          res,
          504,
          timeoutBody(payload.correlationId, target.sessionId, PRIME_AGENT_CHANNEL_HARD_TIMEOUT_MS),
        );
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
        // Backstop only — see the /send fetch above. An abort at the bridge's
        // own window would kill actively-streaming long turns mid-flight.
        signal: AbortSignal.timeout(PRIME_AGENT_CHANNEL_HARD_TIMEOUT_MS),
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

      const streamed = await pipePrimeAgentStreamAndCollect(ctx, (transportRes.body as any).getReader());
      if (streamed.terminal) {
        await persistPrimeAgentTurn(ctx, buildPrimeAgentPersistPayload(payload, target, streamed.text)).catch(() => undefined);
      }
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
        return jsonResponse(
          res,
          504,
          timeoutBody(payload.correlationId, target.sessionId, PRIME_AGENT_CHANNEL_HARD_TIMEOUT_MS),
        );
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

  if (req.method === 'POST' && path === '/api/prime-agent-channel/persist-turn') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return jsonResponse(res, 400, { error: 'Invalid JSON' });
    }
    const payload = normalizePrimeAgentPersistTurnPayload(parsed);
    if ('error' in payload) return jsonResponse(res, 400, { error: payload.error });
    const result = await persistPrimeAgentTurn(ctx, {
      ...payload,
      sessionId: primeAgentDkgSessionId(payload.sessionId),
    });
    return jsonResponse(res, result.statusCode, result.body);
  }
}
