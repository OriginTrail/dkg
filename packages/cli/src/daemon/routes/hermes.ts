import { randomUUID } from 'node:crypto';

import type { RouteRequestContext } from './context.js';
import {
  jsonResponse,
  readBody,
  resolveCorsOrigin,
  corsHeaders,
  SMALL_BODY_BYTES,
} from '../http-utils.js';
import { daemonState } from '../state.js';
import {
  hasConfiguredLocalAgentChat,
} from '../local-agents.js';
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
  hermesApiServerKeyRemediation,
  hermesApiServerKeyRejectionRemediation,
  pipeHermesStream,
  probeHermesChannelHealth,
  resolveHermesApiServerKey,
  shouldTryNextHermesTarget,
  verifyHermesAttachmentRefsProvenance,
  verifyHermesAttachmentImportResultsProvenance,
  type HermesChatPayload,
  type HermesTurnPersistenceState,
} from '../hermes.js';
import {
  buildOpenClawAttachmentImportContextEntries,
} from '../openclaw.js';

type HermesPersistRouteResult = {
  statusCode: number;
  body: Record<string, unknown>;
};

type NormalizedHermesPersistTurnPayload = Exclude<ReturnType<typeof normalizeHermesPersistTurnPayload>, { error: string }>;

const hermesPersistTurnInflight = new Map<string, Promise<HermesPersistRouteResult>>();

function isHermesBridgeTimeoutError(err: any): boolean {
  const message = String(err?.message ?? err ?? '');
  return err?.name === 'TimeoutError'
    || err?.cause?.name === 'TimeoutError'
    || /agent response timeout|response timeout|aborted due to timeout/i.test(message);
}

function formatTimeoutMs(timeoutMs: number): string {
  return `${Math.round(timeoutMs / 1000)}s`;
}

function buildHermesChannelTimeoutBody(
  correlationId: string,
  target: { name?: string } | undefined,
  details?: string,
): Record<string, unknown> {
  const targetName = target?.name === 'gateway' ? 'gateway' : 'bridge';
  const targetLabel = targetName === 'gateway' ? 'Hermes gateway' : 'Hermes bridge';
  return {
    error: `${targetLabel} response timeout`,
    code: targetName === 'gateway'
      ? 'HERMES_GATEWAY_RESPONSE_TIMEOUT'
      : 'HERMES_BRIDGE_RESPONSE_TIMEOUT',
    source: 'hermes-channel',
    target: targetName,
    details: details || `${targetLabel} did not produce an agent response within ${formatTimeoutMs(HERMES_CHANNEL_RESPONSE_TIMEOUT_MS)}`,
    correlationId,
    timeoutMs: HERMES_CHANNEL_RESPONSE_TIMEOUT_MS,
  };
}

function buildHermesUiPersistenceErrorBody(err: any): Record<string, unknown> {
  return {
    error: 'Hermes UI chat persistence failed',
    code: 'HERMES_UI_PERSISTENCE_ERROR',
    details: err?.message ?? String(err),
  };
}

function parseHermesChannelTimeoutDetails(details: string): Record<string, unknown> | null {
  if (!details.trim()) return null;
  try {
    const parsed = JSON.parse(details);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function isHermesChannelTimeoutDetails(details: string): boolean {
  const parsed = parseHermesChannelTimeoutDetails(details);
  return parsed?.source === 'hermes-channel'
    && (
      parsed.code === 'HERMES_BRIDGE_RESPONSE_TIMEOUT'
      || parsed.code === 'HERMES_GATEWAY_RESPONSE_TIMEOUT'
    );
}

function buildHermesStructuredChannelTimeoutBody(
  correlationId: string,
  details: string,
): Record<string, unknown> | null {
  const parsed = parseHermesChannelTimeoutDetails(details);
  if (parsed?.source !== 'hermes-channel'
    || (
      parsed.code !== 'HERMES_BRIDGE_RESPONSE_TIMEOUT'
      && parsed.code !== 'HERMES_GATEWAY_RESPONSE_TIMEOUT'
    )
  ) {
    return null;
  }
  return {
    ...parsed,
    correlationId,
  };
}

function withVerifiedAttachmentImportContextEntries(
  payload: HermesChatPayload,
  attachmentImportResults: HermesChatPayload['attachmentImportResults'],
): HermesChatPayload {
  const importContextEntries = buildOpenClawAttachmentImportContextEntries(attachmentImportResults);
  if (importContextEntries.length === 0) return payload;
  return {
    ...payload,
    contextEntries: [
      ...(payload.contextEntries ?? []),
      ...importContextEntries,
    ],
  };
}

/** Hermes' OpenAI api_server returns 401/403 when the bearer key is wrong/absent. */
function isHermesApiKeyRejection(target: { protocol?: string }, status: number): boolean {
  return target.protocol === 'hermes-openai' && (status === 401 || status === 403);
}

function hermesApiKeyRejectedDetails(
  config: RouteRequestContext['config'],
  apiServerKey: string | undefined,
): string {
  // A 401/403 with a key forwarded means the key is wrong (realign/rotate); with
  // no key forwarded it means one is missing/unresolved (provision + reconnect).
  return apiServerKey
    ? `Hermes API server rejected the API_SERVER_KEY — ${hermesApiServerKeyRejectionRemediation(config)}.`
    : `Hermes API server requires an API_SERVER_KEY but none was resolved — ${hermesApiServerKeyRemediation(config)}.`;
}

/**
 * Enrich the generic unreachable/error detail with an actionable hint when a
 * hermes-openai target exists but no API_SERVER_KEY is resolvable — the most
 * common cause of the api_server never coming up on Hermes v0.15.0+. The
 * remediation is branched on loopback vs remote transport.
 */
function hermesUnreachableDetails(
  details: string | undefined,
  targets: Array<{ protocol?: string }>,
  apiServerKey: string | undefined,
  config: RouteRequestContext['config'],
): string | undefined {
  const needsKey = !apiServerKey && targets.some((t) => t.protocol === 'hermes-openai');
  if (!needsKey) return details;
  const hint = `Hermes api_server is unreachable; since Hermes v0.15.0 it requires API_SERVER_KEY — ${hermesApiServerKeyRemediation(config)}.`;
  return details ? `${details} — ${hint}` : hint;
}

export async function handleHermesRoutes(ctx: RouteRequestContext): Promise<void> {
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
    const attachmentImportResults = await verifyHermesAttachmentImportResultsProvenance(
      agent,
      extractionStatus,
      payload.attachmentImportResults,
    );
    if (payload.attachmentImportResults != null && attachmentImportResults === undefined) {
      return jsonResponse(res, 400, { error: 'Invalid "attachmentImportResults"' });
    }
    const verifiedPayload = withVerifiedAttachmentImportContextEntries(payload, attachmentImportResults);

    const targets = getHermesChannelTargets(config);
    const apiServerKey = resolveHermesApiServerKey(config);
    let lastFailure: { status?: number; details?: string; offline?: boolean } | null = null;

    for (const target of targets) {
      const availability = await ensureHermesBridgeAvailable(target, bridgeAuthToken);
      if (!availability.ok) {
        lastFailure = availability;
        continue;
      }

      try {
        const forwardBody = target.protocol === 'hermes-openai'
          ? buildHermesOpenAiChatBody(verifiedPayload, attachmentRefs, requestAgentAddress, false)
          : buildHermesChannelBody(verifiedPayload, attachmentRefs, requestAgentAddress);
        const forwardRes = await fetch(target.inboundUrl, {
          method: 'POST',
          headers: buildHermesChannelHeaders(target, bridgeAuthToken, {
            'Content-Type': 'application/json',
          }, target.inboundUrl, apiServerKey),
          body: JSON.stringify(forwardBody),
          signal: AbortSignal.timeout(HERMES_CHANNEL_RESPONSE_TIMEOUT_MS),
        });
        if (!forwardRes.ok) {
          const details = await forwardRes.text().catch(() => '');
          if (forwardRes.status === 504 && isHermesChannelTimeoutDetails(details)) {
            // Only our structured timeout payload proves a DKG local-agent
            // channel classified the timeout. Preserve its target/source fields;
            // anonymous 504s keep timeout semantics below without replay.
            return jsonResponse(res, 504, buildHermesStructuredChannelTimeoutBody(
              payload.correlationId,
              details,
            ) ?? buildHermesChannelTimeoutBody(payload.correlationId, target));
          }
          if (forwardRes.status === 504) {
            return jsonResponse(res, 504, buildHermesChannelTimeoutBody(
              payload.correlationId,
              target,
              details || `${target.name} response timeout`,
            ));
          }
          if (isHermesApiKeyRejection(target, forwardRes.status)) {
            return jsonResponse(res, 502, {
              error: 'Hermes API server rejected the API_SERVER_KEY',
              code: 'HERMES_API_KEY_REJECTED',
              details: details || hermesApiKeyRejectedDetails(config, apiServerKey),
            });
          }
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
          const reply = await readHermesOpenAiReply(forwardRes, verifiedPayload);
          let persisted: { sessionId: string; turnId: string };
          try {
            persisted = await persistHermesOpenAiUiTurn(
              ctx,
              verifiedPayload,
              attachmentRefs,
              reply.text,
              reply.sessionId,
            );
          } catch (err: any) {
            return jsonResponse(res, 500, buildHermesUiPersistenceErrorBody(err));
          }
          return jsonResponse(res, 200, {
            ...reply,
            sessionId: persisted.sessionId,
            turnId: persisted.turnId,
          });
        }

        const reply = await forwardRes.json();
        return jsonResponse(res, 200, reply);
      } catch (err: any) {
        if (isHermesBridgeTimeoutError(err)) {
          return jsonResponse(res, 504, buildHermesChannelTimeoutBody(payload.correlationId, target));
        }
        lastFailure = { details: err.message, offline: true };
      }
    }

    return jsonResponse(res, lastFailure?.offline ? 503 : 502, {
      error: lastFailure?.offline ? 'Hermes bridge unreachable' : 'Hermes bridge error',
      code: lastFailure?.offline ? 'BRIDGE_OFFLINE' : 'BRIDGE_ERROR',
      details: hermesUnreachableDetails(lastFailure?.details, targets, apiServerKey, config),
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
    const attachmentImportResults = await verifyHermesAttachmentImportResultsProvenance(
      agent,
      extractionStatus,
      payload.attachmentImportResults,
    );
    if (payload.attachmentImportResults != null && attachmentImportResults === undefined) {
      return jsonResponse(res, 400, { error: 'Invalid "attachmentImportResults"' });
    }
    const verifiedPayload = withVerifiedAttachmentImportContextEntries(payload, attachmentImportResults);

    const targets = getHermesChannelTargets(config);
    const apiServerKey = resolveHermesApiServerKey(config);
    let lastFailure: { status?: number; details?: string; offline?: boolean } | null = null;

    for (const target of targets) {
      const availability = await ensureHermesBridgeAvailable(target, bridgeAuthToken);
      if (!availability.ok) {
        lastFailure = availability;
        continue;
      }

      try {
        const forwardBody = target.protocol === 'hermes-openai'
          ? buildHermesOpenAiChatBody(verifiedPayload, attachmentRefs, requestAgentAddress, true)
          : buildHermesChannelBody(verifiedPayload, attachmentRefs, requestAgentAddress);
        const streamUrl = target.streamUrl ?? target.inboundUrl;
        const transportRes = await fetch(streamUrl, {
          method: 'POST',
          headers: buildHermesChannelHeaders(target, bridgeAuthToken, {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          }, streamUrl, apiServerKey),
          body: JSON.stringify(forwardBody),
          signal: AbortSignal.timeout(HERMES_CHANNEL_RESPONSE_TIMEOUT_MS),
        });

        if (!transportRes.ok) {
          const details = await transportRes.text().catch(() => '');
          if (transportRes.status === 504 && isHermesChannelTimeoutDetails(details)) {
            // Only our structured timeout payload proves a DKG local-agent
            // channel classified the timeout. Preserve its target/source fields;
            // anonymous 504s keep timeout semantics below without replay.
            return jsonResponse(res, 504, buildHermesStructuredChannelTimeoutBody(
              payload.correlationId,
              details,
            ) ?? buildHermesChannelTimeoutBody(payload.correlationId, target));
          }
          if (transportRes.status === 504) {
            return jsonResponse(res, 504, buildHermesChannelTimeoutBody(
              payload.correlationId,
              target,
              details || `${target.name} response timeout`,
            ));
          }
          if (isHermesApiKeyRejection(target, transportRes.status)) {
            return jsonResponse(res, 502, {
              error: 'Hermes API server rejected the API_SERVER_KEY',
              code: 'HERMES_API_KEY_REJECTED',
              details: details || hermesApiKeyRejectedDetails(config, apiServerKey),
            });
          }
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
                verifiedPayload,
                transportRes,
              );
              let persisted: { sessionId: string; turnId: string };
              try {
                persisted = await persistHermesOpenAiUiTurn(
                  ctx,
                  verifiedPayload,
                  attachmentRefs,
                  streamed.text,
                  streamed.sessionId,
                );
              } catch (err: any) {
                if (!res.writableEnded) {
                  res.write(`data: ${JSON.stringify({
                    type: 'error',
                    ...buildHermesUiPersistenceErrorBody(err),
                  })}\n\n`);
                  res.end();
                }
                return;
              }
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
              const event = isHermesBridgeTimeoutError(err)
                ? { type: 'error', ...buildHermesChannelTimeoutBody(payload.correlationId, target) }
                : { type: 'error', error: err.message };
              res.write(`data: ${JSON.stringify(event)}\n\n`);
            }
          }
          if (!res.writableEnded) res.end();
          return;
        }

        const reply = target.protocol === 'hermes-openai'
          ? await readHermesOpenAiReply(transportRes, verifiedPayload)
          : await transportRes.json();
        let persisted: { sessionId: string; turnId: string } | null = null;
        if (target.protocol === 'hermes-openai') {
          try {
            persisted = await persistHermesOpenAiUiTurn(ctx, verifiedPayload, attachmentRefs, reply.text ?? '', reply.sessionId);
          } catch (err: any) {
            return jsonResponse(res, 500, buildHermesUiPersistenceErrorBody(err));
          }
        }
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
        if (isHermesBridgeTimeoutError(err)) {
          return jsonResponse(res, 504, buildHermesChannelTimeoutBody(payload.correlationId, target));
        }
        lastFailure = { details: err.message, offline: true };
      }
    }

    return jsonResponse(res, lastFailure?.offline ? 503 : 502, {
      error: lastFailure?.offline ? 'Hermes bridge unreachable' : 'Hermes bridge error',
      code: lastFailure?.offline ? 'BRIDGE_OFFLINE' : 'BRIDGE_ERROR',
      details: hermesUnreachableDetails(lastFailure?.details, targets, apiServerKey, config),
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
    const health = await probeHermesChannelHealth(config, bridgeAuthToken);
    return jsonResponse(res, 200, health);
  }
}

function ensureHermesIntegrationEnabled(config: RouteRequestContext['config'], res: RouteRequestContext['res']): boolean {
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
    ...(payload.persistUserMessage ? { persistUserMessage: payload.persistUserMessage } : {}),
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
        content: buildHermesOpenAiUserMessage(payload, attachmentRefs),
      },
    ],
  };
}

function buildHermesOpenAiUserMessage(
  payload: HermesChatPayload,
  attachmentRefs: OpenClawAttachmentRef[] | undefined,
): string {
  if (payload.text.trim()) return payload.text;
  const lines: string[] = [];
  if (payload.contextGraphId) {
    lines.push(`Current DKG context graph id: ${formatHermesPromptValue(payload.contextGraphId)}`);
  }
  if (payload.contextEntries?.length) {
    lines.push('Node UI context entries:');
    for (const entry of payload.contextEntries) {
      lines.push(`- ${formatHermesPromptValue(entry.label || entry.key)}: ${formatHermesPromptValue(entry.value)}`);
    }
  }
  if (attachmentRefs?.length) {
    lines.push('Node UI attachment assertion refs:');
    for (const attachment of attachmentRefs) {
      lines.push(formatHermesAttachmentPromptLine(attachment));
    }
  }
  return lines.join('\n') || payload.text;
}

function buildHermesOpenAiPersistedUserMessage(
  payload: HermesChatPayload,
  attachmentRefs: OpenClawAttachmentRef[] | undefined,
): string {
  return payload.persistUserMessage ?? buildHermesOpenAiUserMessage(payload, attachmentRefs);
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
      lines.push(`- ${formatHermesPromptValue(entry.label || entry.key)}: ${formatHermesPromptValue(entry.value)}`);
    }
  }
  if (attachmentRefs?.length) {
    lines.push('Node UI attachment assertion refs:');
    for (const attachment of attachmentRefs) {
      lines.push(formatHermesAttachmentPromptLine(attachment));
    }
    lines.push('For completed imported attachments, read Markdown with dkg_knowledge_asset_import_artifact_read_markdown when needed, inspect assertion quads with dkg_knowledge_asset_query when useful, and append model-derived triples to the imported assertion with dkg_knowledge_asset_semantic_enrichment_write.');
    lines.push('Use dkg_knowledge_asset_import_artifact_resolve only when you need to re-check artifact metadata. Do not promote or publish enrichment output unless explicitly instructed.');
  }
  return lines.join('\n');
}

function formatHermesAttachmentPromptLine(attachment: OpenClawAttachmentRef): string {
  const details = [
    `assertionUri=${formatHermesPromptValue(attachment.assertionUri)}`,
    `contextGraphId=${formatHermesPromptValue(attachment.contextGraphId)}`,
    attachment.assertionName ? `assertionName=${formatHermesPromptValue(attachment.assertionName)}` : null,
    `fileHash=${formatHermesPromptValue(attachment.fileHash)}`,
    attachment.detectedContentType ? `contentType=${formatHermesPromptValue(attachment.detectedContentType)}` : null,
    attachment.extractionStatus ? `status=${formatHermesPromptValue(attachment.extractionStatus)}` : null,
    attachment.tripleCount != null ? `tripleCount=${attachment.tripleCount}` : null,
    attachment.rootEntity ? `rootEntity=${formatHermesPromptValue(attachment.rootEntity)}` : null,
    attachment.mdIntermediateHash ? `mdIntermediateHash=${formatHermesPromptValue(attachment.mdIntermediateHash)}` : null,
    attachment.markdownHash ? `markdownHash=${formatHermesPromptValue(attachment.markdownHash)}` : null,
    attachment.markdownForm ? `markdownForm=${formatHermesPromptValue(attachment.markdownForm)}` : null,
  ].filter((item): item is string => item != null);
  return `- ${formatHermesPromptValue(attachment.fileName)}: ${details.join('; ')}`;
}

function formatHermesPromptValue(value: string): string {
  return JSON.stringify(value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim());
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
  ctx: RouteRequestContext,
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
    userMessage: buildHermesOpenAiPersistedUserMessage(payload, verifiedAttachmentRefs),
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
  res: RouteRequestContext['res'],
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
  ctx: RouteRequestContext,
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
  ctx: RouteRequestContext,
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
  memoryManager: RouteRequestContext['memoryManager'],
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
  agent: RouteRequestContext['agent'],
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
