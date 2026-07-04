import type { IncomingMessage, ServerResponse } from "node:http";
import { extractBearerToken, verifyToken } from "../auth.js";
import { jsonResponse, readBody, SMALL_BODY_BYTES } from "./http-utils.js";
import {
  clearDashboardSessionCookie,
  getDashboardSessionCookie,
  setDashboardSessionCookie,
} from "./dashboard-session-cookie.js";
import { authorizeDashboardSessionRequest, verifyDashboardCsrf } from "./dashboard-session-auth-source.js";
import { hasTrustedDashboardOrigin, isLoopbackRequest } from "./dashboard-session-policy.js";
import {
  DashboardSessionStore,
  type AuthenticatedDashboardSession,
} from "./dashboard-session-store.js";

export { DASHBOARD_SESSION_COOKIE, getDashboardSessionCookie } from "./dashboard-session-cookie.js";
export {
  authorizeDashboardSessionRequest,
  createDashboardSessionAuthSource,
  verifyDashboardCsrf,
  type DashboardSessionAuthorization,
  type DashboardSessionAuthorizationOptions,
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
  refreshValidTokens?: () => void;
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
    options.refreshValidTokens?.();
    const token = extractBearerToken(req.headers.authorization);
    if (!verifyToken(token, options.validTokens)) {
      jsonResponse(res, 401, { error: "Valid API token required for loopback dashboard session" }, options.corsOrigin);
      return true;
    }
    const created = store.create(token!, "loopback");
    setDashboardSessionCookie(req, res, created.sessionId);
    jsonResponse(res, 200, sessionResponse({
      csrfToken: created.record.csrfToken,
      source: created.record.source,
      expiresAt: created.record.expiresAt,
    }), options.corsOrigin);
    return true;
  }

  if (req.method === "POST" && path === "/api/dashboard/session/exchange") {
    if (!hasTrustedDashboardOrigin(req, options.corsOrigin)) {
      jsonResponse(res, 403, { error: "Untrusted dashboard request origin" }, options.corsOrigin);
      return true;
    }
    let body: unknown = {};
    try {
      const raw = await readBody(req, SMALL_BODY_BYTES);
      if (raw) {
        if (!hasJsonContentType(req)) {
          jsonResponse(res, 415, { error: "Dashboard session exchange requires application/json" }, options.corsOrigin);
          return true;
        }
        body = JSON.parse(raw);
      }
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
    const created = store.create(token!, "exchange");
    setDashboardSessionCookie(req, res, created.sessionId);
    jsonResponse(res, 200, sessionResponse({
      csrfToken: created.record.csrfToken,
      source: created.record.source,
      expiresAt: created.record.expiresAt,
    }), options.corsOrigin);
    return true;
  }

  if (req.method === "POST" && path === "/api/dashboard/session/logout") {
    if (!session || !verifyToken(session.compatToken, options.validTokens)) {
      clearDashboardSessionCookie(req, res);
      jsonResponse(res, 200, { ok: true }, options.corsOrigin);
      return true;
    }
    const authorization = authorizeDashboardSessionRequest(req, session, {
      corsOrigin: options.corsOrigin,
    });
    if (!authorization.ok) {
      jsonResponse(res, authorization.status, { error: authorization.error }, options.corsOrigin);
      return true;
    }
    store.revoke(session.sessionId);
    options.onSessionRevoked?.(session.sessionId);
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

function hasJsonContentType(req: IncomingMessage): boolean {
  const raw = req.headers["content-type"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.split(";")[0]?.trim().toLowerCase() === "application/json";
}
