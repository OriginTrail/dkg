import type { RequestContext } from "./context.js";
import { readBody, jsonResponse } from "../http-utils.js";
import {
  openAiMessagesToShared,
  buildOpenAIChatCompletion,
  openAiErrorBody,
  type SharedModelMessage,
} from "@origintrail-official/dkg-agent";

const SMALL_BODY_BYTES = 256 * 1024;

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
    const body = JSON.parse(await readBody(req, SMALL_BODY_BYTES));
    const messages = body.messages as SharedModelMessage[];
    if (!Array.isArray(messages) || messages.length === 0) {
      return jsonResponse(res, 400, { error: "messages (non-empty array) is required" });
    }
    const result = await agent.invokeContextGraphModel(
      id,
      messages,
      { maxTokens: body.maxTokens, temperature: body.temperature },
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
    const body = JSON.parse(await readBody(req, SMALL_BODY_BYTES));
    const messages = openAiMessagesToShared(body.messages);
    if (messages.length === 0) {
      return jsonResponse(res, 400, openAiErrorBody("messages (non-empty array) is required"));
    }
    const result = await agent.invokeContextGraphModel(
      id,
      messages,
      { maxTokens: body.max_tokens, temperature: body.temperature },
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
    const { agentAddress, shareModel, modelId } = JSON.parse(await readBody(req, SMALL_BODY_BYTES));
    if (!agentAddress || typeof agentAddress !== "string") {
      return jsonResponse(res, 400, { error: "agentAddress is required" });
    }
    try {
      await agent.inviteAgentToContextGraph(id, agentAddress, requestAgentAddress);
      let modelShared = false;
      if (shareModel === true) {
        await agent.setContextGraphModelSharing(id, true, { callerAgentAddress: requestAgentAddress, modelId });
        modelShared = true;
      }
      return jsonResponse(res, 200, { ok: true, contextGraphId: id, agentAddress, modelShared });
    } catch (err) {
      return jsonResponse(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }
}
