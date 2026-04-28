import { randomUUID } from 'node:crypto';

import type { RequestContext } from './context.js';
import {
  jsonResponse,
  readBody,
  resolveCorsOrigin,
  corsHeaders,
  SMALL_BODY_BYTES,
} from '../http-utils.js';
import { daemonState } from '../state.js';
import { hasConfiguredLocalAgentChat } from '../local-agents.js';
import {
  HERMES_CHANNEL_RESPONSE_TIMEOUT_MS,
  buildHermesChannelHeaders,
  ensureHermesBridgeAvailable,
  getHermesChannelTargets,
  hasPersistedHermesTurn,
  normalizeHermesChatPayload,
  normalizeHermesPersistTurnPayload,
  pipeHermesStream,
  probeHermesChannelHealth,
  shouldTryNextHermesTarget,
  verifyHermesAttachmentRefsProvenance,
} from '../hermes.js';

export async function handleHermesRoutes(ctx: RequestContext): Promise<void> {
  const {
    req,
    res,
    agent,
    config,
    memoryManager,
    bridgeAuthToken,
    extractionStatus,
    path,
    requestAgentAddress,
  } = ctx;

  if (req.method === 'POST' && path === '/api/hermes-channel/send') {
    if (!ensureHermesIntegrationEnabled(config, res)) return;

    const body = await readBody(req, SMALL_BODY_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return jsonResponse(res, 400, { error: 'Invalid JSON' });
    }

    const payload = normalizeHermesChatPayload(parsed);
    if ('error' in payload) return jsonResponse(res, 400, { error: payload.error });

    const attachmentRefs = await verifyHermesAttachmentRefsProvenance(
      agent,
      extractionStatus,
      payload.attachmentRefs,
    );
    if (payload.attachmentRefs != null && attachmentRefs === undefined) {
      return jsonResponse(res, 400, { error: 'Invalid "attachmentRefs"' });
    }

    const targets = getHermesChannelTargets(config);
    let lastFailure: { status?: number; details?: string; offline?: boolean } | null = null;

    for (const target of targets) {
      const availability = await ensureHermesBridgeAvailable(target, bridgeAuthToken);
      if (!availability.ok) {
        lastFailure = availability;
        continue;
      }

      try {
        const forwardRes = await fetch(target.inboundUrl, {
          method: 'POST',
          headers: buildHermesChannelHeaders(target, bridgeAuthToken, {
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({
            text: payload.text,
            correlationId: payload.correlationId,
            identity: payload.identity ?? 'owner',
            ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
            ...(payload.profile ? { profile: payload.profile } : {}),
            ...(attachmentRefs ? { attachmentRefs } : {}),
            ...(payload.contextEntries ? { contextEntries: payload.contextEntries } : {}),
            ...(payload.uiContextGraphId ? { uiContextGraphId: payload.uiContextGraphId } : {}),
            ...(payload.currentAgentAddress ?? requestAgentAddress
              ? { currentAgentAddress: payload.currentAgentAddress ?? requestAgentAddress }
              : {}),
          }),
          signal: AbortSignal.timeout(HERMES_CHANNEL_RESPONSE_TIMEOUT_MS),
        });
        if (!forwardRes.ok) {
          const details = await forwardRes.text().catch(() => '');
          if (shouldTryNextHermesTarget(forwardRes.status)) {
            lastFailure = {
              status: forwardRes.status,
              details: details || `${target.name} transport unavailable`,
              offline: forwardRes.status === 503,
            };
            continue;
          }
          return jsonResponse(res, 502, {
            error: 'Hermes bridge error',
            code: 'BRIDGE_ERROR',
            details,
          });
        }
        const reply = await forwardRes.json();
        return jsonResponse(res, 200, reply);
      } catch (err: any) {
        if (err.name === 'TimeoutError') {
          return jsonResponse(res, 504, {
            error: 'Agent response timeout',
            code: 'AGENT_TIMEOUT',
            correlationId: payload.correlationId,
          });
        }
        lastFailure = { details: err.message, offline: true };
      }
    }

    return jsonResponse(res, lastFailure?.offline ? 503 : 502, {
      error: lastFailure?.offline ? 'Hermes bridge unreachable' : 'Hermes bridge error',
      code: lastFailure?.offline ? 'BRIDGE_OFFLINE' : 'BRIDGE_ERROR',
      details: lastFailure?.details,
    });
  }

  if (req.method === 'POST' && path === '/api/hermes-channel/stream') {
    if (!ensureHermesIntegrationEnabled(config, res)) return;

    const body = await readBody(req, SMALL_BODY_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return jsonResponse(res, 400, { error: 'Invalid JSON' });
    }

    const payload = normalizeHermesChatPayload(parsed);
    if ('error' in payload) return jsonResponse(res, 400, { error: payload.error });

    const attachmentRefs = await verifyHermesAttachmentRefsProvenance(
      agent,
      extractionStatus,
      payload.attachmentRefs,
    );
    if (payload.attachmentRefs != null && attachmentRefs === undefined) {
      return jsonResponse(res, 400, { error: 'Invalid "attachmentRefs"' });
    }

    const targets = getHermesChannelTargets(config);
    let lastFailure: { status?: number; details?: string; offline?: boolean } | null = null;

    for (const target of targets) {
      const availability = await ensureHermesBridgeAvailable(target, bridgeAuthToken);
      if (!availability.ok) {
        lastFailure = availability;
        continue;
      }

      try {
        const transportRes = await fetch(target.streamUrl ?? target.inboundUrl, {
          method: 'POST',
          headers: buildHermesChannelHeaders(target, bridgeAuthToken, {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          }),
          body: JSON.stringify({
            text: payload.text,
            correlationId: payload.correlationId,
            identity: payload.identity ?? 'owner',
            ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
            ...(payload.profile ? { profile: payload.profile } : {}),
            ...(attachmentRefs ? { attachmentRefs } : {}),
            ...(payload.contextEntries ? { contextEntries: payload.contextEntries } : {}),
            ...(payload.uiContextGraphId ? { uiContextGraphId: payload.uiContextGraphId } : {}),
            ...(payload.currentAgentAddress ?? requestAgentAddress
              ? { currentAgentAddress: payload.currentAgentAddress ?? requestAgentAddress }
              : {}),
          }),
          signal: AbortSignal.timeout(HERMES_CHANNEL_RESPONSE_TIMEOUT_MS),
        });

        if (!transportRes.ok) {
          const details = await transportRes.text().catch(() => '');
          if (shouldTryNextHermesTarget(transportRes.status)) {
            lastFailure = {
              status: transportRes.status,
              details: details || `${target.name} transport unavailable`,
              offline: transportRes.status === 503,
            };
            continue;
          }
          return jsonResponse(res, 502, {
            error: 'Hermes bridge error',
            code: 'BRIDGE_ERROR',
            details,
          });
        }

        const contentType = (transportRes.headers.get('content-type') ?? '').toLowerCase();
        if (contentType.includes('text/event-stream') && transportRes.body) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            ...corsHeaders(resolveCorsOrigin(req, daemonState.moduleCorsAllowed)),
          });
          try {
            await pipeHermesStream(req, res, (transportRes.body as any).getReader());
          } catch (err: any) {
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
            }
          }
          if (!res.writableEnded) res.end();
          return;
        }

        const reply = await transportRes.json();
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          ...corsHeaders(resolveCorsOrigin(req, daemonState.moduleCorsAllowed)),
        });
        res.write(
          `data: ${JSON.stringify({ type: 'final', text: reply.text ?? '', correlationId: reply.correlationId ?? payload.correlationId })}\n\n`,
        );
        res.end();
        return;
      } catch (err: any) {
        if (err.name === 'TimeoutError') {
          return jsonResponse(res, 504, {
            error: 'Agent response timeout',
            code: 'AGENT_TIMEOUT',
            correlationId: payload.correlationId,
          });
        }
        lastFailure = { details: err.message, offline: true };
      }
    }

    return jsonResponse(res, lastFailure?.offline ? 503 : 502, {
      error: lastFailure?.offline ? 'Hermes bridge unreachable' : 'Hermes bridge error',
      code: lastFailure?.offline ? 'BRIDGE_OFFLINE' : 'BRIDGE_ERROR',
      details: lastFailure?.details,
    });
  }

  if (req.method === 'POST' && path === '/api/hermes-channel/persist-turn') {
    if (!ensureHermesIntegrationEnabled(config, res)) return;

    const body = await readBody(req, SMALL_BODY_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return jsonResponse(res, 400, { error: 'Invalid JSON' });
    }

    const payload = normalizeHermesPersistTurnPayload(parsed);
    if ('error' in payload) return jsonResponse(res, 400, { error: payload.error });

    const verifiedAttachmentRefs = await verifyHermesAttachmentRefsProvenance(
      agent,
      extractionStatus,
      payload.attachmentRefs,
    );
    if (payload.attachmentRefs != null && verifiedAttachmentRefs === undefined) {
      return jsonResponse(res, 400, { error: 'Invalid "attachmentRefs"' });
    }

    try {
      if (await hasPersistedHermesTurn(memoryManager, payload.sessionId, payload.turnId)) {
        return jsonResponse(res, 200, {
          ok: true,
          duplicate: true,
          turnId: payload.turnId,
        });
      }

      await memoryManager.storeChatExchange(
        payload.sessionId,
        payload.userMessage,
        payload.assistantReply,
        payload.toolCalls,
        {
          turnId: payload.turnId || randomUUID(),
          attachmentRefs: verifiedAttachmentRefs,
          persistenceState: payload.persistenceState,
          failureReason: payload.failureReason,
        },
      );
      return jsonResponse(res, 200, { ok: true, turnId: payload.turnId });
    } catch (err: any) {
      return jsonResponse(res, 500, { error: err.message });
    }
  }

  if (req.method === 'GET' && path === '/api/hermes-channel/health') {
    return jsonResponse(res, 200, await probeHermesChannelHealth(config, bridgeAuthToken));
  }
}

function ensureHermesIntegrationEnabled(config: RequestContext['config'], res: RequestContext['res']): boolean {
  if (hasConfiguredLocalAgentChat(config, 'hermes')) return true;
  jsonResponse(res, 409, {
    error: 'Hermes local-agent integration is not enabled',
    code: 'INTEGRATION_DISABLED',
  });
  return false;
}
