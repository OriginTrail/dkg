import type { RequestContext } from "./context.js";
import { readBody, jsonResponse } from "../http-utils.js";
import {
  openAiMessagesToShared,
  buildOpenAIChatCompletion,
  openAiErrorBody,
  type SharedModelMessage,
} from "@origintrail-official/dkg-agent";

const SMALL_BODY_BYTES = 256 * 1024;

const SHARED_MODEL_ROLES = new Set(["system", "user", "assistant"]);

/** Coerce a body field to a finite number, or undefined if it isn't one. */
function numOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Validate the native `/model/invoke` `messages` payload BEFORE it reaches the
 * agent, so a structurally-broken element (e.g. `[{"role":"user"}]` with no
 * `content`, or `{"content":1}`) returns a clear 400 instead of throwing deep
 * in the provider call and surfacing as a 500. Mirrors the wire decoder's
 * element contract: `role` ∈ {system,user,assistant} and `content` is a string.
 */
function validateSharedModelMessages(
  raw: unknown,
): { ok: true; messages: SharedModelMessage[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "messages (non-empty array) is required" };
  }
  const messages: SharedModelMessage[] = [];
  for (let i = 0; i < raw.length; i++) {
    const m = raw[i] as { role?: unknown; content?: unknown } | null;
    if (!m || typeof m !== "object") {
      return { ok: false, error: `messages[${i}] must be an object` };
    }
    if (typeof m.role !== "string" || !SHARED_MODEL_ROLES.has(m.role)) {
      return { ok: false, error: `messages[${i}].role must be one of system|user|assistant` };
    }
    if (typeof m.content !== "string") {
      return { ok: false, error: `messages[${i}].content must be a string` };
    }
    messages.push({ role: m.role as SharedModelMessage["role"], content: m.content });
  }
  return { ok: true, messages };
}

/**
 * Shared curator AI-model access (MVP).
 *
 *   POST /api/context-graph/:id/model/share          { enabled, modelId? }
 *   GET  /api/context-graph/:id/model/grant
 *   POST /api/context-graph/:id/model/invoke         { messages, maxTokens?, temperature? }
 *   POST /api/context-graph/:id/model/v1/chat/completions   (OpenAI-compatible)
 *   POST /api/context-graph/:id/invite-with-model    { agentAddress, shareModel?, modelId? }
 *
 * The last route is the "same user journey" entry point: it invites an agent
 * to the CG's shared working memory AND (optionally) shares the curator's
 * model in one call.
 */
export async function handleSharedModelRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, agent, path, requestAgentAddress } = ctx;

  const shareMatch = path.match(/^\/api\/context-graph\/([^/]+)\/model\/share$/);
  if (req.method === "POST" && shareMatch) {
    const id = decodeURIComponent(shareMatch[1]);
    const { enabled, modelId } = JSON.parse(await readBody(req, SMALL_BODY_BYTES));
    if (typeof enabled !== "boolean") return jsonResponse(res, 400, { error: "enabled (boolean) is required" });
    try {
      await agent.setContextGraphModelSharing(id, enabled, { callerAgentAddress: requestAgentAddress, modelId });
      return jsonResponse(res, 200, { ok: true, contextGraphId: id, enabled });
    } catch (err) {
      return jsonResponse(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  const grantMatch = path.match(/^\/api\/context-graph\/([^/]+)\/model\/grant$/);
  if (req.method === "GET" && grantMatch) {
    const id = decodeURIComponent(grantMatch[1]);
    const grant = await agent.getContextGraphModelGrant(id);
    return jsonResponse(res, 200, { contextGraphId: id, ...grant });
  }

  const invokeMatch = path.match(/^\/api\/context-graph\/([^/]+)\/model\/invoke$/);
  if (req.method === "POST" && invokeMatch) {
    const id = decodeURIComponent(invokeMatch[1]);
    let body: { messages?: unknown; maxTokens?: unknown; temperature?: unknown };
    try {
      body = JSON.parse(await readBody(req, SMALL_BODY_BYTES));
    } catch {
      return jsonResponse(res, 400, { error: "request body must be valid JSON" });
    }
    const validation = validateSharedModelMessages(body.messages);
    if (!validation.ok) {
      return jsonResponse(res, 400, { error: validation.error });
    }
    const messages = validation.messages;
    const result = await agent.invokeContextGraphModel(
      id,
      messages,
      { maxTokens: numOrUndefined(body.maxTokens), temperature: numOrUndefined(body.temperature) },
      requestAgentAddress,
    );
    return jsonResponse(res, result.ok ? 200 : 403, result);
  }

  // OpenAI-compatible surface so a member can point any OpenAI client (the
  // hermes gateway, node-UI chat, Cursor, the OpenAI SDK) at the curator's
  // shared model — i.e. set OPENAI_BASE_URL to
  //   http://<member-node>/api/context-graph/<id>/model/v1
  // and the member's agent transparently runs ON the curator's model.
  const openaiMatch = path.match(/^\/api\/context-graph\/([^/]+)\/model\/v1\/chat\/completions$/);
  if (req.method === "POST" && openaiMatch) {
    const id = decodeURIComponent(openaiMatch[1]);
    let body: { messages?: unknown; max_tokens?: unknown; temperature?: unknown; model?: unknown };
    try {
      body = JSON.parse(await readBody(req, SMALL_BODY_BYTES));
    } catch {
      // A malformed body must surface as an OpenAI-shaped 400, never a 500.
      return jsonResponse(res, 400, openAiErrorBody("request body must be valid JSON"));
    }
    // `openAiMessagesToShared` already validates element shapes (drops non-string
    // content, coerces unsupported roles to `user`); an empty result means the
    // caller sent nothing usable.
    const messages = openAiMessagesToShared(body.messages);
    if (messages.length === 0) {
      return jsonResponse(res, 400, openAiErrorBody("messages (non-empty array) is required"));
    }
    const result = await agent.invokeContextGraphModel(
      id,
      messages,
      { maxTokens: numOrUndefined(body.max_tokens), temperature: numOrUndefined(body.temperature) },
      requestAgentAddress,
    );
    if (!result.ok) {
      return jsonResponse(res, 403, openAiErrorBody(result.denied ?? "denied"));
    }
    return jsonResponse(res, 200, buildOpenAIChatCompletion({
      contextGraphId: id,
      content: result.content ?? "",
      model: result.model ?? (typeof body.model === "string" ? body.model : "shared-model"),
      createdSec: Math.floor(Date.now() / 1000),
    }));
  }

  const inviteMatch = path.match(/^\/api\/context-graph\/([^/]+)\/invite-with-model$/);
  if (req.method === "POST" && inviteMatch) {
    const id = decodeURIComponent(inviteMatch[1]);
    let parsed: { agentAddress?: unknown; shareModel?: unknown; modelId?: unknown };
    try {
      parsed = JSON.parse(await readBody(req, SMALL_BODY_BYTES));
    } catch {
      return jsonResponse(res, 400, { error: "request body must be valid JSON" });
    }
    const { agentAddress, shareModel, modelId } = parsed;
    if (!agentAddress || typeof agentAddress !== "string") {
      return jsonResponse(res, 400, { error: "agentAddress is required" });
    }
    // The invite is the membership-granting step. If it throws, nothing was
    // applied → 400 and the caller may safely retry.
    try {
      await agent.inviteAgentToContextGraph(id, agentAddress, requestAgentAddress);
    } catch (err) {
      return jsonResponse(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    // Invite succeeded — membership is now granted and DURABLE. If the optional
    // model-share step fails, do NOT report a 400 (the caller would retry the
    // whole call against partially-applied state, double-applying the invite).
    // Instead return 200 with an explicit partial-success body so the caller
    // sees the invite landed and only the share needs attention.
    if (shareModel !== true) {
      return jsonResponse(res, 200, { ok: true, contextGraphId: id, agentAddress, modelShared: false });
    }
    try {
      await agent.setContextGraphModelSharing(id, true, {
        callerAgentAddress: requestAgentAddress,
        modelId: typeof modelId === "string" ? modelId : undefined,
      });
      return jsonResponse(res, 200, { ok: true, contextGraphId: id, agentAddress, modelShared: true });
    } catch (err) {
      return jsonResponse(res, 200, {
        ok: true,
        contextGraphId: id,
        agentAddress,
        modelShared: false,
        modelShareError: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
