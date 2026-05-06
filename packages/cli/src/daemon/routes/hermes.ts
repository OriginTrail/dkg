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
import type { OpenClawAttachmentRef } from '../openclaw.js';
import {
  HERMES_CHANNEL_RESPONSE_TIMEOUT_MS,
  buildStableHermesTurnId,
  buildHermesChannelHeaders,
  ensureHermesBridgeAvailable,
  getPersistedHermesTurnState,
  getHermesChannelTargets,
  hermesPersistTurnKey,
  normalizeHermesChatPayload,
  normalizeHermesPersistTurnPayload,
  pipeHermesStream,
  probeHermesChannelHealth,
  shouldTryNextHermesTarget,
  verifyHermesAttachmentRefsProvenance,
  type HermesChatPayload,
  type HermesTurnPersistenceState,
} from '../hermes.js';

type HermesPersistRouteResult = {
  statusCode: number;
  body: Record<string, unknown>;
};

type NormalizedHermesPersistTurnPayload = Exclude<ReturnType<typeof normalizeHermesPersistTurnPayload>, { error: string }>;

const hermesPersistTurnInflight = new Map<string, Promise<HermesPersistRouteResult>>();

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
        const forwardBody = target.protocol === 'hermes-openai'
          ? buildHermesOpenAiChatBody(payload, attachmentRefs, requestAgentAddress, false)
          : buildHermesChannelBody(payload, attachmentRefs, requestAgentAddress);
        const forwardRes = await fetch(target.inboundUrl, {
          method: 'POST',
          headers: buildHermesChannelHeaders(target, bridgeAuthToken, {
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify(forwardBody),
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
        if (target.protocol === 'hermes-openai') {
          const reply = await readHermesOpenAiReply(forwardRes, payload);
          const persisted = await persistHermesOpenAiUiTurn(
            ctx,
            payload,
            attachmentRefs,
            reply.text,
            reply.sessionId,
          );
          return jsonResponse(res, 200, {
            ...reply,
            sessionId: persisted.sessionId,
            turnId: persisted.turnId,
          });
        }

        const reply = await forwardRes.json();
        return jsonResponse(res, 200, reply);
      } catch (err: any) {
        if (err.name === 'TimeoutError') {
          lastFailure = {
            details: `${target.name} response timeout`,
            offline: true,
          };
          continue;
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
        const forwardBody = target.protocol === 'hermes-openai'
          ? buildHermesOpenAiChatBody(payload, attachmentRefs, requestAgentAddress, true)
          : buildHermesChannelBody(payload, attachmentRefs, requestAgentAddress);
        const transportRes = await fetch(target.streamUrl ?? target.inboundUrl, {
          method: 'POST',
          headers: buildHermesChannelHeaders(target, bridgeAuthToken, {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          }),
          body: JSON.stringify(forwardBody),
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
            if (target.protocol === 'hermes-openai') {
              const streamed = await pipeHermesOpenAiStream(
                res,
                (transportRes.body as any).getReader(),
                payload,
                transportRes,
              );
              const persisted = await persistHermesOpenAiUiTurn(
                ctx,
                payload,
                attachmentRefs,
                streamed.text,
                streamed.sessionId,
              );
              if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify({
                  type: 'final',
                  text: streamed.text,
                  correlationId: payload.correlationId,
                  sessionId: persisted.sessionId,
                  turnId: persisted.turnId,
                })}\n\n`);
              }
            } else {
              await pipeHermesStream(req, res, (transportRes.body as any).getReader());
            }
          } catch (err: any) {
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
            }
          }
          if (!res.writableEnded) res.end();
          return;
        }

        const reply = target.protocol === 'hermes-openai'
          ? await readHermesOpenAiReply(transportRes, payload)
          : await transportRes.json();
        const persisted = target.protocol === 'hermes-openai'
          ? await persistHermesOpenAiUiTurn(ctx, payload, attachmentRefs, reply.text ?? '', reply.sessionId)
          : null;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          ...corsHeaders(resolveCorsOrigin(req, daemonState.moduleCorsAllowed)),
        });
        res.write(`data: ${JSON.stringify({
          type: 'final',
          text: reply.text ?? '',
          correlationId: reply.correlationId ?? payload.correlationId,
          ...(persisted
            ? { sessionId: persisted.sessionId, turnId: persisted.turnId }
            : typeof reply.sessionId === 'string' && reply.sessionId ? { sessionId: reply.sessionId } : {}),
          ...(!persisted && typeof reply.turnId === 'string' && reply.turnId ? { turnId: reply.turnId } : {}),
        })}\n\n`);
        res.end();
        return;
      } catch (err: any) {
        if (err.name === 'TimeoutError') {
          lastFailure = {
            details: `${target.name} response timeout`,
            offline: true,
          };
          continue;
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

    const result = await persistHermesTurnWithDuplicateLock(
      ctx,
      payload,
      verifiedAttachmentRefs,
    );
    return jsonResponse(res, result.statusCode, result.body);
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

function buildHermesChannelBody(
  payload: HermesChatPayload,
  attachmentRefs: OpenClawAttachmentRef[] | undefined,
  requestAgentAddress: string | undefined,
): Record<string, unknown> {
  return {
    text: payload.text,
    correlationId: payload.correlationId,
    identity: payload.identity ?? 'owner',
    ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
    ...(payload.profile ? { profile: payload.profile } : {}),
    ...(attachmentRefs ? { attachmentRefs } : {}),
    ...(payload.contextEntries ? { contextEntries: payload.contextEntries } : {}),
    ...(payload.contextGraphId ? { contextGraphId: payload.contextGraphId } : {}),
    ...(payload.currentAgentAddress ?? requestAgentAddress
      ? { currentAgentAddress: payload.currentAgentAddress ?? requestAgentAddress }
      : {}),
  };
}

function buildHermesOpenAiChatBody(
  payload: HermesChatPayload,
  attachmentRefs: OpenClawAttachmentRef[] | undefined,
  requestAgentAddress: string | undefined,
  stream: boolean,
): Record<string, unknown> {
  return {
    model: 'hermes-agent',
    stream,
    messages: [
      {
        role: 'system',
        content: buildHermesNodeUiSystemPrompt(payload, attachmentRefs, requestAgentAddress),
      },
      {
        role: 'user',
        content: payload.text,
      },
    ],
  };
}

function buildHermesNodeUiSystemPrompt(
  payload: HermesChatPayload,
  attachmentRefs: OpenClawAttachmentRef[] | undefined,
  requestAgentAddress: string | undefined,
): string {
  const lines = [
    'This conversation is coming from the DKG Node UI Hermes integration.',
    'Use the DKG tools normally. When a current context graph is provided, prefer it for project-scoped DKG operations unless the user asks for a different project/context graph.',
  ];
  if (payload.contextGraphId) {
    lines.push(`Current DKG context graph id: ${payload.contextGraphId}`);
  }
  const agentAddress = payload.currentAgentAddress ?? requestAgentAddress;
  if (agentAddress) {
    lines.push(`Current DKG agent address: ${agentAddress}`);
  }
  if (payload.profile) {
    lines.push(`Hermes profile: ${payload.profile}`);
  }
  if (payload.contextEntries?.length) {
    lines.push('Node UI context entries:');
    for (const entry of payload.contextEntries) {
      lines.push(`- ${entry.label || entry.key}: ${entry.value}`);
    }
  }
  if (attachmentRefs?.length) {
    lines.push('Node UI attachment assertion refs:');
    for (const attachment of attachmentRefs) {
      lines.push(`- ${attachment.fileName}: ${attachment.assertionUri} (${attachment.contextGraphId})`);
    }
  }
  return lines.join('\n');
}

async function readHermesOpenAiReply(
  response: Response,
  payload: HermesChatPayload,
): Promise<{ text: string; correlationId: string; sessionId?: string }> {
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const firstChoice = choices[0];
  const message = firstChoice && typeof firstChoice === 'object' && !Array.isArray(firstChoice)
    ? (firstChoice as Record<string, unknown>).message
    : undefined;
  const text = message && typeof message === 'object' && !Array.isArray(message)
    ? (message as Record<string, unknown>).content
    : undefined;
  return {
    text: typeof text === 'string' ? text : '',
    correlationId: payload.correlationId,
    ...(response.headers.get('x-hermes-session-id')
      ? { sessionId: response.headers.get('x-hermes-session-id') ?? undefined }
      : {}),
  };
}

async function persistHermesOpenAiUiTurn(
  ctx: RequestContext,
  payload: HermesChatPayload,
  verifiedAttachmentRefs: OpenClawAttachmentRef[] | undefined,
  assistantReply: string,
  responseSessionId?: string,
): Promise<{ sessionId: string; turnId: string }> {
  const sessionId = payload.sessionId ?? responseSessionId ?? 'hermes:dkg-ui';
  const turnId = buildStableHermesTurnId({
    sessionId,
    correlationId: payload.correlationId,
    profile: payload.profile,
    contextGraphId: payload.contextGraphId,
  });
  const persistPayload = normalizeHermesPersistTurnPayload({
    sessionId,
    userMessage: payload.text,
    assistantReply,
    turnId,
    correlationId: payload.correlationId,
    attachmentRefs: verifiedAttachmentRefs,
    persistenceState: 'stored',
    contextGraphId: payload.contextGraphId,
    profile: payload.profile,
    metadata: { source: 'node-ui-openai' },
  });
  if ('error' in persistPayload) {
    throw new Error(`Invalid Hermes UI persistence payload: ${persistPayload.error}`);
  }

  const result = await persistHermesTurnWithDuplicateLock(
    ctx,
    persistPayload,
    verifiedAttachmentRefs,
  );
  if (result.statusCode !== 200) {
    const error = typeof result.body.error === 'string' ? result.body.error : 'unknown error';
    throw new Error(`Hermes UI chat persistence failed: ${error}`);
  }
  return { sessionId, turnId };
}

async function pipeHermesOpenAiStream(
  res: RequestContext['res'],
  reader: { read: () => Promise<{ done?: boolean; value?: Uint8Array }> },
  payload: HermesChatPayload,
  response: Response,
): Promise<{ text: string; sessionId?: string }> {
  const decoder = new TextDecoder();
  let buffer = '';
  let finalText = '';
  const sessionId = response.headers.get('x-hermes-session-id') ?? undefined;

  const emit = (event: Record<string, unknown>) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };

  const processFrame = (frame: string) => {
    const dataLines = frame
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    for (const data of dataLines) {
      if (data === '[DONE]') {
        continue;
      }
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
        const firstChoice = choices[0];
        const delta = firstChoice && typeof firstChoice === 'object' && !Array.isArray(firstChoice)
          ? (firstChoice as Record<string, unknown>).delta
          : undefined;
        const content = delta && typeof delta === 'object' && !Array.isArray(delta)
          ? (delta as Record<string, unknown>).content
          : undefined;
        if (typeof content === 'string' && content) {
          finalText += content;
          emit({ type: 'delta', text: content, correlationId: payload.correlationId });
        }
      } catch {
        // Ignore non-chat SSE frames such as Hermes tool progress metadata.
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      buffer += decoder.decode(value, { stream: true });
      let boundary = findHermesOpenAiSseBoundary(buffer);
      while (boundary.index !== -1) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        processFrame(frame);
        boundary = findHermesOpenAiSseBoundary(buffer);
      }
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) processFrame(buffer);
  return { text: finalText, sessionId };
}

function findHermesOpenAiSseBoundary(buffer: string): { index: number; length: number } {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1) return { index: crlf, length: crlf === -1 ? 0 : 4 };
  if (crlf === -1) return { index: lf, length: 2 };
  return crlf < lf
    ? { index: crlf, length: 4 }
    : { index: lf, length: 2 };
}

async function persistHermesTurnWithDuplicateLock(
  ctx: RequestContext,
  payload: NormalizedHermesPersistTurnPayload,
  verifiedAttachmentRefs: OpenClawAttachmentRef[] | undefined,
): Promise<HermesPersistRouteResult> {
  const key = hermesPersistTurnKey(payload.sessionId, payload.turnId);
  const existing = hermesPersistTurnInflight.get(key);
  if (existing) {
    const result = await existing;
    if (result.statusCode !== 200) return result;
    const queued = hermesPersistTurnInflight.get(key);
    if (queued && queued !== existing) {
      const queuedResult = await queued;
      if (queuedResult.statusCode !== 200) return queuedResult;
      return persistHermesTurnUnlocked(ctx, payload, verifiedAttachmentRefs);
    }
    const operation = persistHermesTurnUnlocked(ctx, payload, verifiedAttachmentRefs);
    hermesPersistTurnInflight.set(key, operation);
    try {
      return await operation;
    } finally {
      if (hermesPersistTurnInflight.get(key) === operation) {
        hermesPersistTurnInflight.delete(key);
      }
    }
  }

  const operation = persistHermesTurnUnlocked(ctx, payload, verifiedAttachmentRefs);
  hermesPersistTurnInflight.set(key, operation);
  try {
    return await operation;
  } finally {
    if (hermesPersistTurnInflight.get(key) === operation) {
      hermesPersistTurnInflight.delete(key);
    }
  }
}

async function persistHermesTurnUnlocked(
  ctx: RequestContext,
  payload: NormalizedHermesPersistTurnPayload,
  verifiedAttachmentRefs: OpenClawAttachmentRef[] | undefined,
): Promise<HermesPersistRouteResult> {
  const { agent, memoryManager } = ctx;
  try {
    let existingState: HermesTurnPersistenceState | null = null;
    try {
      existingState = await getPersistedHermesTurnState(memoryManager, payload.sessionId, payload.turnId);
    } catch {
      existingState = null;
    }
    if (existingState === 'stored') {
      return {
        statusCode: 200,
        body: {
          ok: true,
          duplicate: true,
          turnId: payload.turnId,
        },
      };
    }
    if (existingState) {
      if (
        existingState === payload.persistenceState
        || persistenceStateRank(payload.persistenceState) < persistenceStateRank(existingState)
      ) {
        return {
          statusCode: 200,
          body: {
            ok: true,
            duplicate: true,
            turnId: payload.turnId,
          },
        };
      }
      const transitioned = await recordHermesTurnPersistenceTransition(memoryManager, payload, verifiedAttachmentRefs);
      if (!transitioned) {
        return {
          statusCode: 409,
          body: {
            error: 'Existing Hermes turn requires a persistence-state transition path',
            turnId: payload.turnId,
          },
        };
      }
      if (payload.persistenceState === 'stored') {
        await importHermesAssistantReply(agent, payload.sessionId, payload.turnId, payload.assistantReply);
      }
      return {
        statusCode: 200,
        body: {
          ok: true,
          transitioned: true,
          turnId: payload.turnId,
        },
      };
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
    if (payload.persistenceState === 'stored') {
      await importHermesAssistantReply(agent, payload.sessionId, payload.turnId, payload.assistantReply);
    }
    return { statusCode: 200, body: { ok: true, turnId: payload.turnId } };
  } catch (err: any) {
    return { statusCode: 500, body: { error: err.message } };
  }
}

function persistenceStateRank(state: HermesTurnPersistenceState): number {
  if (state === 'stored') return 3;
  if (state === 'failed') return 2;
  return 1;
}

async function recordHermesTurnPersistenceTransition(
  memoryManager: RequestContext['memoryManager'],
  payload: NormalizedHermesPersistTurnPayload,
  verifiedAttachmentRefs: OpenClawAttachmentRef[] | undefined,
): Promise<boolean> {
  const recorder = (memoryManager as unknown as {
    recordChatTurnPersistenceTransition?: (
      sessionId: string,
      turnId: string,
      persistenceState: HermesTurnPersistenceState,
      opts?: {
        failureReason?: string | null;
        assistantReply?: string;
        toolCalls?: Array<{ name: string; args: Record<string, unknown>; result: unknown }>;
        attachmentRefs?: OpenClawAttachmentRef[];
      },
    ) => Promise<void>;
  }).recordChatTurnPersistenceTransition;
  if (typeof recorder !== 'function') return false;
  await recorder.call(memoryManager, payload.sessionId, payload.turnId, payload.persistenceState, {
    failureReason: payload.failureReason ?? null,
    assistantReply: payload.assistantReply,
    toolCalls: payload.toolCalls,
    attachmentRefs: verifiedAttachmentRefs,
  });
  return true;
}

async function importHermesAssistantReply(
  agent: RequestContext['agent'],
  sessionId: string,
  turnId: string,
  assistantReply: string,
): Promise<void> {
  if (!assistantReply) return;
  const importer = (agent as unknown as {
    importMemories?: (text: string, source?: string) => Promise<unknown>;
  }).importMemories;
  if (typeof importer !== 'function') return;
  try {
    await importer.call(agent, assistantReply, `hermes-session:${sessionId}:turn:${turnId}`);
  } catch {
    // Chat persistence should remain authoritative even if extraction is unavailable.
  }
}
