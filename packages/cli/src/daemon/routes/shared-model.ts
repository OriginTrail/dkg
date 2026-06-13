import type { RequestContext } from "./context.js";
import { readBody, jsonResponse } from "../http-utils.js";
import type { SharedModelMessage } from "@origintrail-official/dkg-agent";

const SMALL_BODY_BYTES = 256 * 1024;

/**
 * Shared curator AI-model access (MVP).
 *
 *   POST /api/context-graph/:id/model/share          { enabled, modelId? }
 *   GET  /api/context-graph/:id/model/grant
 *   POST /api/context-graph/:id/model/invoke         { messages, maxTokens?, temperature? }
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
