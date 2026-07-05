import type { IncomingMessage, ServerResponse } from "node:http";
import { extractBearerToken, verifyToken } from "../auth.js";
import { jsonResponse, readBody, SMALL_BODY_BYTES } from "./http-utils.js";
import {
  clearDashboardSessionCookie,
  setDashboardSessionCookie,
} from "./dashboard-session-cookie.js";
import { authorizeDashboardSessionRequest, verifyDashboardCsrf } from "./dashboard-session-auth-source.js";
import { hasTrustedDashboardOrigin, isLoopbackRequest } from "./dashboard-session-policy.js";
import { dashboardSessionResponse } from "./dashboard-session-response.js";
import {
  DashboardSessionStore,
  type AuthenticatedDashboardSession,
} from "./dashboard-session-store.js";
import {
  authenticateDashboardSessionRequest,
  handleDashboardLoginExchange,
  parseDashboardSessionExchange,
  type DashboardLoginOptions,
  type DashboardSessionAuthenticatorOptions,
} from "./dashboard-login.js";

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
  authenticateDashboardSessionRequest,
  DashboardLoginAttemptLimiter,
  handleDashboardLoginExchange,
  parseDashboardSessionExchange,
  selectDashboardLoginCompatToken,
  type DashboardLoginCompatTokenSelectionOptions,
  type DashboardLoginOptions,
  type DashboardLoginVerification,
  type DashboardSessionAuthenticatorOptions,
  type DashboardSessionExchangeInvalidRequest,
  type DashboardSessionExchangeLoginRequest,
  type DashboardSessionExchangeRequest,
  type DashboardSessionExchangeTokenRequest,
} from "./dashboard-login.js";
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
  authenticateSession?: (req: IncomingMessage) => AuthenticatedDashboardSession | null;
  dashboardLogin?: DashboardLoginOptions;
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

  const authenticateSession = options.authenticateSession ?? ((request: IncomingMessage) =>
    authenticateDashboardSessionRequest(request, store, options));
  const session = authenticateSession(req);

  if (req.method === "GET" && path === "/api/dashboard/session/status") {
    if (!options.authEnabled) {
      jsonResponse(res, 200, { authenticated: true, authDisabled: true }, options.corsOrigin);
      return true;
    }
    if (!session || !verifyToken(session.compatToken, options.validTokens)) {
      jsonResponse(res, 200, { authenticated: false }, options.corsOrigin);
      return true;
    }
    jsonResponse(res, 200, dashboardSessionResponse(session), options.corsOrigin);
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
    setDashboardSessionCookie(req, res, created.sessionId, options.corsOrigin);
    jsonResponse(res, 200, dashboardSessionResponse({
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
    const exchangeRequest = parseDashboardSessionExchange(body, req.headers.authorization);
    if (exchangeRequest.kind === "invalid") {
      jsonResponse(res, exchangeRequest.status, { error: exchangeRequest.error }, options.corsOrigin);
      return true;
    }
    if (exchangeRequest.kind === "login") {
      await handleDashboardLoginExchange(req, res, store, options, exchangeRequest);
      return true;
    }
    const token = exchangeRequest.token;
    if (!verifyToken(token, options.validTokens)) {
      jsonResponse(res, 401, { error: "Invalid dashboard session token" }, options.corsOrigin);
      return true;
    }
    const created = store.create(token!, "exchange");
    setDashboardSessionCookie(req, res, created.sessionId, options.corsOrigin);
    jsonResponse(res, 200, dashboardSessionResponse({
      csrfToken: created.record.csrfToken,
      source: created.record.source,
      expiresAt: created.record.expiresAt,
    }), options.corsOrigin);
    return true;
  }

  if (req.method === "POST" && path === "/api/dashboard/session/logout") {
    const revokeSession = (active: AuthenticatedDashboardSession): void => {
      store.revoke(active.sessionId);
      options.onSessionRevoked?.(active.sessionId);
    };
    if (!session || !verifyToken(session.compatToken, options.validTokens)) {
      if (session) revokeSession(session);
      clearDashboardSessionCookie(req, res, options.corsOrigin);
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
    revokeSession(session);
    clearDashboardSessionCookie(req, res, options.corsOrigin);
    jsonResponse(res, 200, { ok: true }, options.corsOrigin);
    return true;
  }

  jsonResponse(res, 404, { error: "Unknown dashboard session route" }, options.corsOrigin);
  return true;
}

function hasJsonContentType(req: IncomingMessage): boolean {
  const raw = req.headers["content-type"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.split(";")[0]?.trim().toLowerCase() === "application/json";
}
