// daemon/routes/openclaw.ts
//
// Route handlers for OpenClaw agent listing, chat, channel send/stream/persist-turn/health.
//
// Extracted verbatim from the legacy monolithic `handleRequest` —
// every block is a contiguous slice of the original source with zero
// edits to route bodies. Dispatch is driven by the surviving
// `handle-request.ts` shell, which awaits each group handler in
// sequence and uses `res.writableEnded` to short-circuit once a
// route claims the request.
//
// See `packages/cli/scripts/split-handle-request.mjs` for the
// extraction driver.

import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";

// Namespace import: our Phase-8 install-context builder (~line 290) calls
// `osModule.homedir()`, and the later agent-identity probe (~line 6851)
// uses `osModule.hostname()` + `osModule.userInfo()`. v10-rc's new
// OpenClaw config helper (~line 2535) uses a bare `homedir()` — aliased
// below so both sites coexist without a duplicate-module import.
import * as osModule from 'node:os';
const { homedir } = osModule;

import { createRequire } from 'node:module';

// Lazy resolver used by the manifest-install flow: find the
// @origintrail-official/dkg-mcp package via Node's own resolution
// algorithm, so the daemon can write workspace-level configs that
// point at a valid MCP server install regardless of whether it's
// running from a monorepo checkout, an npm-global `dkg`, or a
// `pnpm dlx` tarball.
const daemonRequire = createRequire(import.meta.url);

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// Phase 8 — project-manifest publish + install (UI-driven onboarding flow).
// Daemon constructs a self-pointing DkgClient (localhost:listenPort) and
// reuses the same publish/fetch/plan/write helpers the CLI uses, so wire
// format stays identical between curator/joiner/CLI paths.

// Daemon sub-module imports — every public symbol from sibling
// modules is pulled in here because the legacy monolithic file used
// them all without explicit imports. Unused ones are tolerated by
// the project's tsconfig (`noUnusedLocals` is off).
import { daemonState } from '../state.js';

import { _autoUpdateIo } from '../manifest.js';
import {
  resolveNameToPeerId,
  jsonResponse,
  SMALL_BODY_BYTES,
  readBody,
  resolveCorsOrigin,
  corsHeaders,
} from '../http-utils.js';

import {
  OPENCLAW_CHANNEL_RESPONSE_TIMEOUT_MS,
  type OpenClawChannelTarget,
  getOpenClawChannelTargets,
  probeOpenClawChannelHealth,
  shouldTryNextOpenClawTarget,
  buildOpenClawChannelHeaders,
  ensureOpenClawBridgeAvailable,
  pipeOpenClawStream,
  isValidOpenClawPersistTurnPayload,
  type OpenClawAttachmentRef,
  normalizeOpenClawAttachmentRefs,
  normalizeOpenClawAttachmentImportResults,
  dedupeOpenClawAttachmentImportResults,
  verifyOpenClawAttachmentImportResultsProvenance,
  buildOpenClawAttachmentImportContextEntries,
  type OpenClawChatContextEntry,
  normalizeOpenClawChatContextEntriesWithAttachmentImportResults,
  hasOpenClawChatTurnContent,
  verifyOpenClawAttachmentRefsProvenance,
} from '../openclaw.js';

import type { RequestContext } from './context.js';

function isOpenClawBridgeTimeoutError(err: any): boolean {
  const message = String(err?.message ?? err ?? '');
  return err?.name === 'TimeoutError'
    || err?.cause?.name === 'TimeoutError'
    || /agent response timeout|response timeout|aborted due to timeout/i.test(message);
}

function formatTimeoutMs(timeoutMs: number): string {
  return `${Math.round(timeoutMs / 1000)}s`;
}

function buildOpenClawChannelTimeoutBody(
  correlationId: string,
  target: Pick<OpenClawChannelTarget, 'name'> | undefined,
  details?: string,
): Record<string, unknown> {
  const targetName = target?.name === 'gateway' ? 'gateway' : 'bridge';
  const targetLabel = targetName === 'gateway' ? 'OpenClaw gateway' : 'OpenClaw bridge';
  return {
    error: `${targetLabel} response timeout`,
    code: targetName === 'gateway'
      ? 'OPENCLAW_GATEWAY_RESPONSE_TIMEOUT'
      : 'OPENCLAW_BRIDGE_RESPONSE_TIMEOUT',
    source: 'openclaw-channel',
    target: targetName,
    details: details || `${targetLabel} did not produce an agent response within ${formatTimeoutMs(OPENCLAW_CHANNEL_RESPONSE_TIMEOUT_MS)}`,
    correlationId,
    timeoutMs: OPENCLAW_CHANNEL_RESPONSE_TIMEOUT_MS,
  };
}

function parseOpenClawUpstreamDetails(details: string): Record<string, unknown> | null {
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

function isOpenClawChannelTimeoutDetails(details: string): boolean {
  const parsed = parseOpenClawUpstreamDetails(details);
  return parsed?.source === 'openclaw-channel'
    && (
      parsed.code === 'OPENCLAW_BRIDGE_RESPONSE_TIMEOUT'
      || parsed.code === 'OPENCLAW_GATEWAY_RESPONSE_TIMEOUT'
    );
}

function isOpenClawAgentTimeoutDetails(details: string): boolean {
  const parsed = parseOpenClawUpstreamDetails(details);
  return parsed?.source === 'openclaw-agent' && parsed.code === 'AGENT_TIMEOUT';
}

function openClawStructuredTimeoutDetails(details: string): string | undefined {
  const parsed = parseOpenClawUpstreamDetails(details);
  return typeof parsed?.details === 'string' && parsed.details.trim()
    ? parsed.details
    : undefined;
}

function buildOpenClawStructuredChannelTimeoutBody(
  correlationId: string,
  details: string,
): Record<string, unknown> | null {
  const parsed = parseOpenClawUpstreamDetails(details);
  if (parsed?.source !== 'openclaw-channel'
    || (
      parsed.code !== 'OPENCLAW_BRIDGE_RESPONSE_TIMEOUT'
      && parsed.code !== 'OPENCLAW_GATEWAY_RESPONSE_TIMEOUT'
    )
  ) {
    return null;
  }
  return {
    ...parsed,
    correlationId,
  };
}

function buildOpenClawAgentTimeoutBody(
  correlationId: string,
  details?: string,
): Record<string, unknown> {
  return {
    error: 'Agent response timeout',
    code: 'AGENT_TIMEOUT',
    source: 'openclaw-agent',
    details: details || 'OpenClaw agent runtime did not produce a response before its deadline',
    correlationId,
  };
}

export async function handleOpenclawRoutes(ctx: RequestContext): Promise<void> {
  const {
    req,
    res,
    agent,
    publisherControl,
    config,
    startedAt,
    dashDb,
    opWallets,
    network,
    tracker,
    memoryManager,
    bridgeAuthToken,
    nodeVersion,
    nodeCommit,
    catchupTracker,
    extractionRegistry,
    fileStore,
    extractionStatus,
    assertionImportLocks,
    vectorStore,
    embeddingProvider,
    validTokens,
    apiHost,
    apiPortRef,
    url,
    path,
    requestAgentAddress,
  } = ctx;

  // GET /api/openclaw-agents — discover connected OpenClaw agents
  if (req.method === "GET" && path === "/api/openclaw-agents") {
    try {
      const allAgents = await agent.findAgents({ framework: "OpenClaw" });
      const allConns = agent.node.libp2p.getConnections();
      const connectedPeers = new Set(
        allConns.map((c: any) => c.remotePeer.toString()),
      );
      const healthMap = agent.getPeerHealth();

      const enriched = allAgents.map((a: any) => {
        const isConnected = connectedPeers.has(a.peerId);
        const health = healthMap.get(a.peerId);
        return {
          peerId: a.peerId,
          name: a.name,
          description: a.description,
          framework: a.framework,
          connected: isConnected,
          lastSeen: health?.lastSeen ?? null,
          latencyMs: health?.latencyMs ?? null,
        };
      });
      return jsonResponse(res, 200, { agents: enriched });
    } catch (err: any) {
      return jsonResponse(res, 500, { error: err.message });
    }
  }

  // POST /api/chat-openclaw  { peerId: "...", text: "..." }
  // Sends a message to an OpenClaw agent via P2P and waits for a response.
  if (req.method === "POST" && path === "/api/chat-openclaw") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const { peerId: rawPeerId, text } = JSON.parse(body);
    if (!rawPeerId || !text)
      return jsonResponse(res, 400, { error: 'Missing "peerId" or "text"' });

    const peerId = await resolveNameToPeerId(agent, rawPeerId);
    if (!peerId)
      return jsonResponse(res, 404, {
        error: `Agent "${rawPeerId}" not found`,
      });

    const waitStart = Date.now();
    const sendResult = await agent.sendChat(peerId, text);
    try {
      dashDb.insertChatMessage({
        ts: Date.now(),
        direction: "out",
        peer: peerId,
        text,
        delivered: sendResult.delivered,
        messageId: sendResult.messageId,
      });
    } catch {
      /* never crash */
    }

    if (!sendResult.delivered) {
      return jsonResponse(res, 200, {
        delivered: false,
        reply: null,
        timedOut: false,
        error:
          sendResult.error ?? "Message not delivered — agent may be offline",
      });
    }

    // Wait for a reply from the OpenClaw agent (poll incoming messages)
    const TIMEOUT_MS = 30_000;
    const POLL_MS = 500;
    let reply: string | null = null;

    while (Date.now() - waitStart < TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      try {
        const rows = dashDb.getChatMessages({
          peer: peerId,
          since: waitStart - 100,
          limit: 10,
        });
        const incoming = rows.filter(
          (r: any) =>
            r.direction === "in" && r.ts >= waitStart && r.peer === peerId,
        );
        if (incoming.length > 0) {
          reply = incoming[incoming.length - 1].text;
          break;
        }
      } catch {
        /* ignore */
      }
    }

    return jsonResponse(res, 200, {
      delivered: true,
      reply: reply ?? null,
      timedOut: reply === null,
      waitMs: Date.now() - waitStart,
    });
  }

  // -----------------------------------------------------------------------
  // OpenClaw channel bridge — routes DKG UI messages through OpenClaw agent
  // -----------------------------------------------------------------------

  type OpenClawChannelPayloadInput = {
    text?: string;
    correlationId?: string;
    identity?: string;
    persistUserMessage?: unknown;
    attachmentRefs?: unknown;
    attachmentImportResults?: unknown;
    contextEntries?: unknown;
    contextGraphId?: unknown;
  };

  type VerifiedOpenClawChannelForwardPayload = {
    text: string;
    corrId: string;
    identity: string;
    persistUserMessage?: string;
    uiContextGraphId?: string;
    attachmentRefs?: OpenClawAttachmentRef[];
    verifiedContextEntries: OpenClawChatContextEntry[];
  };

  const buildVerifiedOpenClawChannelForwardPayload = async (
    payload: OpenClawChannelPayloadInput,
  ): Promise<
    | { ok: true; value: VerifiedOpenClawChannelForwardPayload }
    | { ok: false; error: string }
  > => {
    const normalizedAttachmentRefs = normalizeOpenClawAttachmentRefs(payload.attachmentRefs);
    if (payload.attachmentRefs != null && normalizedAttachmentRefs === undefined) {
      return { ok: false, error: 'Invalid "attachmentRefs"' };
    }
    const normalizedDirectAttachmentImportResults = normalizeOpenClawAttachmentImportResults(payload.attachmentImportResults);
    if (payload.attachmentImportResults != null && normalizedDirectAttachmentImportResults === undefined) {
      return { ok: false, error: 'Invalid "attachmentImportResults"' };
    }
    const normalizedContextPayload = normalizeOpenClawChatContextEntriesWithAttachmentImportResults(
      payload.contextEntries,
    );
    if (payload.contextEntries != null && normalizedContextPayload === undefined) {
      return { ok: false, error: 'Invalid "contextEntries"' };
    }
    const normalizedContextEntries = normalizedContextPayload?.contextEntries;
    const normalizedLegacyAttachmentImportResults = normalizedContextPayload?.attachmentImportResults;
    const normalizedAttachmentImportResults = dedupeOpenClawAttachmentImportResults(
      normalizedDirectAttachmentImportResults != null || normalizedLegacyAttachmentImportResults?.length
        ? [
          ...(normalizedDirectAttachmentImportResults ?? []),
          ...(normalizedLegacyAttachmentImportResults ?? []),
        ]
        : undefined,
    );
    const uiContextGraphId =
      typeof payload.contextGraphId === "string" && payload.contextGraphId.trim()
        ? payload.contextGraphId.trim()
        : undefined;
    if (payload.text !== undefined && typeof payload.text !== "string") {
      return { ok: false, error: 'Invalid "text"' };
    }
    const text = typeof payload.text === "string" ? payload.text : "";
    if (payload.persistUserMessage != null && typeof payload.persistUserMessage !== "string") {
      return { ok: false, error: 'Invalid "persistUserMessage"' };
    }
    const persistUserMessage =
      typeof payload.persistUserMessage === "string" && payload.persistUserMessage.trim()
        ? payload.persistUserMessage
        : undefined;
    if (!hasOpenClawChatTurnContent(
      text,
      normalizedAttachmentRefs,
      normalizedAttachmentImportResults,
      normalizedContextEntries,
    )) {
      return { ok: false, error: 'Missing "text"' };
    }
    const corrId = payload.correlationId ?? crypto.randomUUID();
    const attachmentRefs = await verifyOpenClawAttachmentRefsProvenance(
      agent,
      extractionStatus,
      normalizedAttachmentRefs,
    );
    if (payload.attachmentRefs != null && attachmentRefs === undefined) {
      return { ok: false, error: 'Invalid "attachmentRefs"' };
    }
    const attachmentImportResults = await verifyOpenClawAttachmentImportResultsProvenance(
      agent,
      extractionStatus,
      normalizedAttachmentImportResults,
    );
    if (
      (payload.attachmentImportResults != null || normalizedLegacyAttachmentImportResults?.length) &&
      attachmentImportResults === undefined
    ) {
      return { ok: false, error: 'Invalid "attachmentImportResults"' };
    }

    return {
      ok: true,
      value: {
        text,
        corrId,
        identity: payload.identity ?? "owner",
        ...(persistUserMessage ? { persistUserMessage } : {}),
        ...(attachmentRefs ? { attachmentRefs } : {}),
        verifiedContextEntries: [
          ...(normalizedContextEntries ?? []),
          ...buildOpenClawAttachmentImportContextEntries(attachmentImportResults),
        ],
        ...(uiContextGraphId ? { uiContextGraphId } : {}),
      },
    };
  };

  // POST /api/openclaw-channel/send  { text, correlationId, identity?, persistUserMessage?, attachmentRefs?, attachmentImportResults?, contextEntries?, contextGraphId? }
  // DKG Node UI frontend calls this to send a message to the local OpenClaw
  // agent.  The daemon forwards to the adapter's channel bridge server and
  // returns the agent's reply. `contextGraphId` carries the UI-selected
  // project context graph so the adapter's memory slot can scope
  // slot-backed recall to the user's current project.
  if (req.method === "POST" && path === "/api/openclaw-channel/send") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    let payload: {
      text?: string;
      correlationId?: string;
      identity?: string;
      persistUserMessage?: unknown;
      attachmentRefs?: unknown;
      attachmentImportResults?: unknown;
      contextEntries?: unknown;
      contextGraphId?: unknown;
    };
    try {
      payload = JSON.parse(body);
    } catch {
      return jsonResponse(res, 400, { error: "Invalid JSON" });
    }

    const verifiedPayload = await buildVerifiedOpenClawChannelForwardPayload(payload);
    if (!verifiedPayload.ok) {
      return jsonResponse(res, 400, { error: verifiedPayload.error });
    }
    const {
      text,
      corrId,
      identity,
      persistUserMessage,
      attachmentRefs,
      verifiedContextEntries,
      uiContextGraphId,
    } = verifiedPayload.value;

    const targets = getOpenClawChannelTargets(config);
    let lastFailure: {
      status?: number;
      details?: string;
      offline?: boolean;
    } | null = null;

    for (const target of targets) {
      const availability = await ensureOpenClawBridgeAvailable(
        target,
        bridgeAuthToken,
      );
      if (!availability.ok) {
        lastFailure = availability;
        continue;
      }

      try {
        const forwardRes = await fetch(target.inboundUrl, {
          method: "POST",
          headers: buildOpenClawChannelHeaders(target, bridgeAuthToken, {
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({
            text,
            correlationId: corrId,
            identity,
            ...(persistUserMessage ? { persistUserMessage } : {}),
            ...(attachmentRefs ? { attachmentRefs } : {}),
            ...(verifiedContextEntries.length > 0
              ? { contextEntries: verifiedContextEntries }
              : {}),
            ...(uiContextGraphId ? { uiContextGraphId } : {}),
          }),
          signal: AbortSignal.timeout(OPENCLAW_CHANNEL_RESPONSE_TIMEOUT_MS),
        });
        if (!forwardRes.ok) {
          const details = await forwardRes.text().catch(() => "");
          if (forwardRes.status === 504) {
            if (isOpenClawAgentTimeoutDetails(details)) {
              return jsonResponse(res, 504, buildOpenClawAgentTimeoutBody(corrId, openClawStructuredTimeoutDetails(details)));
            }
            if (isOpenClawChannelTimeoutDetails(details)) {
              // Only our structured timeout payload proves a DKG local-agent
              // channel classified the timeout. Preserve its target/source fields;
              // anonymous 504s keep timeout semantics below without replay.
              return jsonResponse(res, 504, buildOpenClawStructuredChannelTimeoutBody(
                corrId,
                details,
              ) ?? buildOpenClawChannelTimeoutBody(corrId, target));
            }
            return jsonResponse(res, 504, buildOpenClawChannelTimeoutBody(
              corrId,
              target,
              details || `${target.name} response timeout`,
            ));
          }
          if (shouldTryNextOpenClawTarget(forwardRes.status)) {
            lastFailure = {
              status: forwardRes.status,
              details: details || `${target.name} transport unavailable`,
              offline: forwardRes.status === 503,
            };
            continue;
          }
          return jsonResponse(res, 502, {
            error: "Bridge error",
            code: "BRIDGE_ERROR",
            details,
          });
        }
        if (target.name === "bridge") {
          daemonState.openClawBridgeHealth = { ok: true, ts: Date.now() };
        }
        const reply = await forwardRes.json();
        return jsonResponse(res, 200, reply);
      } catch (err: any) {
        if (isOpenClawBridgeTimeoutError(err)) {
          return jsonResponse(res, 504, buildOpenClawChannelTimeoutBody(corrId, target));
        }
        if (target.name === "bridge") {
          daemonState.openClawBridgeHealth = { ok: false, ts: Date.now() };
        }
        lastFailure = { details: err.message, offline: true };
      }
    }

    return jsonResponse(res, lastFailure?.offline ? 503 : 502, {
      error: lastFailure?.offline
        ? "OpenClaw bridge unreachable"
        : "Bridge error",
      code: lastFailure?.offline ? "BRIDGE_OFFLINE" : "BRIDGE_ERROR",
      details: lastFailure?.details,
    });
  }

  // POST /api/openclaw-channel/stream  { text, correlationId, identity?, persistUserMessage?, attachmentRefs?, attachmentImportResults?, contextEntries?, contextGraphId? }
  // SSE streaming variant — pipes agent response chunks as they arrive.
  if (req.method === "POST" && path === "/api/openclaw-channel/stream") {
    const body = await readBody(req, SMALL_BODY_BYTES);
    let payload: {
      text?: string;
      correlationId?: string;
      identity?: string;
      persistUserMessage?: unknown;
      attachmentRefs?: unknown;
      attachmentImportResults?: unknown;
      contextEntries?: unknown;
      contextGraphId?: unknown;
    };
    try {
      payload = JSON.parse(body);
    } catch {
      return jsonResponse(res, 400, { error: "Invalid JSON" });
    }

    const verifiedPayload = await buildVerifiedOpenClawChannelForwardPayload(payload);
    if (!verifiedPayload.ok) {
      return jsonResponse(res, 400, { error: verifiedPayload.error });
    }
    const {
      text,
      corrId,
      identity,
      persistUserMessage,
      attachmentRefs,
      verifiedContextEntries,
      uiContextGraphId,
    } = verifiedPayload.value;

    const targets = getOpenClawChannelTargets(config);
    let lastFailure: {
      status?: number;
      details?: string;
      offline?: boolean;
    } | null = null;

    for (const target of targets) {
      const availability = await ensureOpenClawBridgeAvailable(
        target,
        bridgeAuthToken,
      );
      if (!availability.ok) {
        lastFailure = availability;
        continue;
      }

      try {
        const transportRes = await fetch(target.streamUrl ?? target.inboundUrl, {
          method: 'POST',
          headers: buildOpenClawChannelHeaders(
            target,
            bridgeAuthToken,
            {
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
            },
          ),
          body: JSON.stringify({
            text,
            correlationId: corrId,
            identity,
            ...(persistUserMessage ? { persistUserMessage } : {}),
            ...(attachmentRefs ? { attachmentRefs } : {}),
            ...(verifiedContextEntries.length > 0
              ? { contextEntries: verifiedContextEntries }
              : {}),
            ...(uiContextGraphId ? { uiContextGraphId } : {}),
          }),
          signal: AbortSignal.timeout(OPENCLAW_CHANNEL_RESPONSE_TIMEOUT_MS),
        });

        if (!transportRes.ok) {
          const details = await transportRes.text().catch(() => "");
          if (transportRes.status === 504) {
            if (isOpenClawAgentTimeoutDetails(details)) {
              return jsonResponse(res, 504, buildOpenClawAgentTimeoutBody(corrId, openClawStructuredTimeoutDetails(details)));
            }
            if (isOpenClawChannelTimeoutDetails(details)) {
              // Only our structured timeout payload proves a DKG local-agent
              // channel classified the timeout. Preserve its target/source fields;
              // anonymous 504s keep timeout semantics below without replay.
              return jsonResponse(res, 504, buildOpenClawStructuredChannelTimeoutBody(
                corrId,
                details,
              ) ?? buildOpenClawChannelTimeoutBody(corrId, target));
            }
            return jsonResponse(res, 504, buildOpenClawChannelTimeoutBody(
              corrId,
              target,
              details || `${target.name} response timeout`,
            ));
          }
          if (shouldTryNextOpenClawTarget(transportRes.status)) {
            lastFailure = {
              status: transportRes.status,
              details: details || `${target.name} transport unavailable`,
              offline: transportRes.status === 503,
            };
            continue;
          }
          return jsonResponse(res, 502, {
            error: "Bridge error",
            code: "BRIDGE_ERROR",
            details,
          });
        }

        if (target.name === "bridge") {
          daemonState.openClawBridgeHealth = { ok: true, ts: Date.now() };
        }

        const contentType = (
          transportRes.headers.get("content-type") ?? ""
        ).toLowerCase();
        if (contentType.includes("text/event-stream") && transportRes.body) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            ...corsHeaders(resolveCorsOrigin(req, daemonState.moduleCorsAllowed)),
          });

          try {
            await pipeOpenClawStream(
              req,
              res,
              (transportRes.body as any).getReader(),
            );
          } catch (err: any) {
            if (!res.writableEnded) {
              const event = isOpenClawBridgeTimeoutError(err)
                ? { type: "error", ...buildOpenClawChannelTimeoutBody(corrId, target) }
                : { type: "error", error: err.message };
              res.write(`data: ${JSON.stringify(event)}\n\n`);
            }
          }
          if (!res.writableEnded) res.end();
          return;
        }

        const reply = await transportRes.json();
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          ...corsHeaders(resolveCorsOrigin(req, daemonState.moduleCorsAllowed)),
        });
        res.write(
          `data: ${JSON.stringify({ type: "final", text: reply.text ?? "", correlationId: reply.correlationId ?? corrId })}\n\n`,
        );
        res.end();
        return;
      } catch (err: any) {
        if (isOpenClawBridgeTimeoutError(err)) {
          return jsonResponse(res, 504, buildOpenClawChannelTimeoutBody(corrId, target));
        }
        if (target.name === "bridge") {
          daemonState.openClawBridgeHealth = { ok: false, ts: Date.now() };
        }
        lastFailure = { details: err.message, offline: true };
      }
    }

    return jsonResponse(res, lastFailure?.offline ? 503 : 502, {
      error: lastFailure?.offline
        ? "OpenClaw bridge unreachable"
        : "Bridge error",
      code: lastFailure?.offline ? "BRIDGE_OFFLINE" : "BRIDGE_ERROR",
      details: lastFailure?.details,
    });
  }

  // POST /api/openclaw-channel/persist-turn  { sessionId, userMessage, assistantReply, attachmentRefs?, ... }
  // Called by the adapter to persist an OpenClaw turn into the `'chat-turns'`
  // Working Memory assertion of the `'agent-context'` context graph (the
  // ChatMemoryManager default since the openclaw-dkg-primary-memory retarget).
  // Uses the same ChatMemoryManager pathway as the node-owned local-agent
  // chat flow — chat-turn content never reaches Shared Working Memory in v1.
  if (req.method === 'POST' && path === '/api/openclaw-channel/persist-turn') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    let payload: any;
    try {
      payload = JSON.parse(body);
    } catch {
      return jsonResponse(res, 400, { error: "Invalid JSON" });
    }

    if (!isValidOpenClawPersistTurnPayload(payload)) {
      return jsonResponse(res, 400, {
        error:
          "Missing required fields: sessionId, userMessage, assistantReply",
      });
    }
    const { sessionId, userMessage, assistantReply, turnId, toolCalls, attachmentRefs, persistenceState, failureReason } =
      payload;
    const normalizedToolCalls = Array.isArray(toolCalls)
      ? (toolCalls as Array<{
          name: string;
          args: Record<string, unknown>;
          result: unknown;
        }>)
      : undefined;
    const normalizedAttachmentRefs = normalizeOpenClawAttachmentRefs(attachmentRefs);
    if (attachmentRefs != null && normalizedAttachmentRefs === undefined) {
      return jsonResponse(res, 400, { error: 'Invalid "attachmentRefs"' });
    }
    const verifiedAttachmentRefs = await verifyOpenClawAttachmentRefsProvenance(agent, extractionStatus, normalizedAttachmentRefs);
    if (attachmentRefs != null && verifiedAttachmentRefs === undefined) {
      return jsonResponse(res, 400, { error: 'Invalid "attachmentRefs"' });
    }
    const normalizedTurnId =
      typeof turnId === "string" ? turnId : crypto.randomUUID();
    const normalizedPersistenceState = persistenceState === 'failed' || persistenceState === 'pending'
      ? persistenceState
      : 'stored';
    const normalizedFailureReason = typeof failureReason === 'string'
      ? failureReason.trim() || undefined
      : undefined;
    try {
      await memoryManager.storeChatExchange(
        sessionId,
        userMessage,
        assistantReply,
        normalizedToolCalls,
        {
          turnId: normalizedTurnId,
          attachmentRefs: verifiedAttachmentRefs,
          persistenceState: normalizedPersistenceState,
          failureReason: normalizedFailureReason,
        },
      );
      return jsonResponse(res, 200, { ok: true });
    } catch (err: any) {
      return jsonResponse(res, 500, { error: err.message });
    }
  }

  // GET /api/openclaw-channel/health — check if the channel bridge is reachable
  if (req.method === 'GET' && path === '/api/openclaw-channel/health') {
    return jsonResponse(res, 200, await probeOpenClawChannelHealth(config, bridgeAuthToken));
  }
}
