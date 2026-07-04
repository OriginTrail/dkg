import type { IncomingMessage, ServerResponse } from "node:http";
import { extractBearerToken, verifyToken } from "../auth.js";
import type { RequestAuthPrincipal } from "../auth.js";
import { jsonResponse, readBody, SMALL_BODY_BYTES } from "./http-utils.js";
import {
  clearDashboardSessionCookie,
  getDashboardSessionCookie,
  setDashboardSessionCookie,
} from "./dashboard-session-cookie.js";
import { isLoopbackRequest } from "./dashboard-session-policy.js";
import {
  DashboardSessionStore,
  type AuthenticatedDashboardSession,
} from "./dashboard-session-store.js";

export { DASHBOARD_SESSION_COOKIE, getDashboardSessionCookie } from "./dashboard-session-cookie.js";
export {
  createDashboardSessionAuthSource,
  verifyDashboardCsrf,
  type DashboardSessionAuthSourceOptions,
} from "./dashboard-session-auth-source.js";
export {
  isAllowedLoopbackHostname,
  isLoopbackAddress,
} from "./dashboard-session-policy.js";
export {
  DashboardSessionStore,
  type AuthenticatedDashboardSession,
  type DashboardSessionRecord,
} from "./dashboard-session-store.js";

export interface DashboardSessionHandlerOptions {
  authEnabled: boolean;
  validTokens: Set<string>;
  loopbackToken?: string;
  refreshValidTokens?: () => void;
  resolveLoopbackToken?: () => string | undefined;
  resolvePrincipal: (token: string) => RequestAuthPrincipal;
  corsOrigin?: string | null;
  onSessionRevoked?: (sessionId: string) => void;
}

export async function handleDashboardSessionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store: DashboardSessionStore,
  options: DashboardSessionHandlerOptions,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith("/api/dashboard/session")) return false;

  const sessionId = getDashboardSessionCookie(req);
  const session = store.authenticateSessionId(sessionId);

  if (req.method === "GET" && path === "/api/dashboard/session/status") {
    if (!options.authEnabled) {
      jsonResponse(res, 200, { authenticated: true, authDisabled: true }, options.corsOrigin);
      return true;
    }
    if (!session || !verifyToken(session.compatToken, options.validTokens)) {
      jsonResponse(res, 200, { authenticated: false }, options.corsOrigin);
      return true;
    }
    jsonResponse(res, 200, sessionResponse(session), options.corsOrigin);
    return true;
  }

  if (req.method === "GET" && path === "/api/dashboard/session/csrf") {
    if (!session || !verifyToken(session.compatToken, options.validTokens)) {
      jsonResponse(res, 401, { error: "Dashboard session required" }, options.corsOrigin);
      return true;
    }
    jsonResponse(res, 200, { csrfToken: session.csrfToken, expiresAt: session.expiresAt }, options.corsOrigin);
    return true;
  }

  if (req.method === "POST" && path === "/api/dashboard/session/loopback") {
    if (!options.authEnabled) {
      jsonResponse(res, 200, { authenticated: true, authDisabled: true }, options.corsOrigin);
      return true;
    }
    if (!isLoopbackRequest(req)) {
      jsonResponse(res, 403, { error: "Loopback dashboard session is only available from localhost" }, options.corsOrigin);
      return true;
    }
    const loopbackToken = resolveCurrentLoopbackToken(options);
    if (!loopbackToken) {
      jsonResponse(res, 503, { error: "No valid dashboard bootstrap token is available" }, options.corsOrigin);
      return true;
    }
    const created = store.create(loopbackToken, "loopback", options.resolvePrincipal(loopbackToken));
    setDashboardSessionCookie(req, res, created.sessionId);
    jsonResponse(res, 200, sessionResponse({
      csrfToken: created.record.csrfToken,
      source: created.record.source,
      expiresAt: created.record.expiresAt,
    }), options.corsOrigin);
    return true;
  }

  if (req.method === "POST" && path === "/api/dashboard/session/exchange") {
    let body: unknown = {};
    try {
      const raw = await readBody(req, SMALL_BODY_BYTES);
      body = raw ? JSON.parse(raw) : {};
    } catch {
      jsonResponse(res, 400, { error: "Invalid JSON body" }, options.corsOrigin);
      return true;
    }
    const bodyToken = typeof (body as { token?: unknown }).token === "string"
      ? ((body as { token: string }).token).trim()
      : undefined;
    const token = bodyToken || extractBearerToken(req.headers.authorization);
    if (!verifyToken(token, options.validTokens)) {
      jsonResponse(res, 401, { error: "Invalid dashboard session token" }, options.corsOrigin);
      return true;
    }
    const created = store.create(token!, "exchange", options.resolvePrincipal(token!));
    setDashboardSessionCookie(req, res, created.sessionId);
    jsonResponse(res, 200, sessionResponse({
      csrfToken: created.record.csrfToken,
      source: created.record.source,
      expiresAt: created.record.expiresAt,
    }), options.corsOrigin);
    return true;
  }

  if (req.method === "POST" && path === "/api/dashboard/session/logout") {
    const revokedSessionId = session?.sessionId ?? sessionId;
    store.revoke(revokedSessionId);
    if (revokedSessionId) options.onSessionRevoked?.(revokedSessionId);
    clearDashboardSessionCookie(req, res);
    jsonResponse(res, 200, { ok: true }, options.corsOrigin);
    return true;
  }

  jsonResponse(res, 404, { error: "Unknown dashboard session route" }, options.corsOrigin);
  return true;
}

function sessionResponse(session: Pick<AuthenticatedDashboardSession, "csrfToken" | "source" | "expiresAt">) {
  return {
    authenticated: true,
    source: session.source,
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt,
  };
}

function resolveCurrentLoopbackToken(options: DashboardSessionHandlerOptions): string | undefined {
  options.refreshValidTokens?.();
  const token = options.resolveLoopbackToken?.() ?? options.loopbackToken;
  return token && options.validTokens.has(token) ? token : undefined;
}
