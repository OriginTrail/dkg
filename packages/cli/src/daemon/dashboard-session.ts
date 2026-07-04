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
  dashboardLogin?: DashboardLoginOptions;
}

export type DashboardLoginVerification =
  | { ok: true; credentialFingerprint?: string }
  | { ok: false; reason?: "missing" | "invalid" | "mismatch" };

export interface DashboardLoginOptions {
  verifyCredentials: (username: string, password: string) => Promise<DashboardLoginVerification>;
  selectCompatToken: () => string | undefined;
  attemptLimiter?: DashboardLoginAttemptLimiter;
  isCredentialFingerprintCurrent?: (credentialFingerprint: string) => boolean;
}

interface DashboardLoginAttempt {
  count: number;
  firstFailureAt: number;
  lockedUntil?: number;
}

export class DashboardLoginAttemptLimiter {
  private attempts = new Map<string, DashboardLoginAttempt>();

  constructor(private readonly options: {
    maxFailures?: number;
    failureWindowMs?: number;
    lockoutMs?: number;
    now?: () => number;
  } = {}) {}

  check(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = this.now();
    const attempt = this.attempts.get(key);
    if (!attempt) return { ok: true };
    if (attempt.lockedUntil && attempt.lockedUntil > now) {
      return { ok: false, retryAfterMs: attempt.lockedUntil - now };
    }
    if (attempt.lockedUntil || now - attempt.firstFailureAt > this.failureWindowMs()) {
      this.attempts.delete(key);
    }
    return { ok: true };
  }

  recordFailure(key: string): void {
    const now = this.now();
    const existing = this.attempts.get(key);
    const attempt: DashboardLoginAttempt = !existing || now - existing.firstFailureAt > this.failureWindowMs()
      ? { count: 0, firstFailureAt: now }
      : existing;
    attempt.count += 1;
    if (attempt.count >= this.maxFailures()) {
      attempt.lockedUntil = now + this.lockoutMs();
    }
    this.attempts.set(key, attempt);
  }

  recordSuccess(key: string): void {
    this.attempts.delete(key);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private maxFailures(): number {
    return this.options.maxFailures ?? 5;
  }

  private failureWindowMs(): number {
    return this.options.failureWindowMs ?? 5 * 60 * 1000;
  }

  private lockoutMs(): number {
    return this.options.lockoutMs ?? 5 * 60 * 1000;
  }
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
  const rawSession = store.authenticateSessionId(sessionId);
  const session = isStaleDashboardLoginSession(rawSession, options) ? null : rawSession;
  if (rawSession && !session) {
    store.revoke(rawSession.sessionId);
    options.onSessionRevoked?.(rawSession.sessionId);
  }

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
    setDashboardSessionCookie(req, res, created.sessionId, options.corsOrigin);
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
    if (isDashboardLoginBody(body)) {
      await handleDashboardLoginExchange(req, res, store, options, body);
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
    setDashboardSessionCookie(req, res, created.sessionId, options.corsOrigin);
    jsonResponse(res, 200, sessionResponse({
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

async function handleDashboardLoginExchange(
  req: IncomingMessage,
  res: ServerResponse,
  store: DashboardSessionStore,
  options: DashboardSessionHandlerOptions,
  body: unknown,
): Promise<void> {
  const username = typeof (body as { username?: unknown }).username === "string"
    ? (body as { username: string }).username.trim()
    : "";
  const password = typeof (body as { password?: unknown }).password === "string"
    ? (body as { password: string }).password
    : "";
  const token = typeof (body as { token?: unknown }).token === "string"
    ? (body as { token: string }).token.trim()
    : "";
  if (token || extractBearerToken(req.headers.authorization)) {
    jsonResponse(res, 400, { error: "Dashboard session exchange accepts either token or username/password" }, options.corsOrigin);
    return;
  }
  if (!options.dashboardLogin) {
    jsonResponse(res, 503, { error: "Dashboard username/password login is not configured" }, options.corsOrigin);
    return;
  }
  if (!username || !password) {
    jsonResponse(res, 401, { error: "Invalid dashboard username or password" }, options.corsOrigin);
    return;
  }

  const attemptKey = dashboardLoginAttemptKey(req, username);
  const limiterState = options.dashboardLogin.attemptLimiter?.check(attemptKey);
  if (limiterState && !limiterState.ok) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil(limiterState.retryAfterMs / 1000))));
    jsonResponse(res, 429, { error: "Too many dashboard sign-in attempts. Try again later." }, options.corsOrigin);
    return;
  }

  const verified = await options.dashboardLogin.verifyCredentials(username, password);
  if (!verified.ok) {
    if (verified.reason === "missing") {
      jsonResponse(res, 503, {
        error: "Dashboard credentials are not configured. Run dkg auth dashboard reset-password on this machine.",
      }, options.corsOrigin);
      return;
    }
    if (verified.reason === "invalid") {
      jsonResponse(res, 503, {
        error: "Dashboard credentials are unavailable. Run dkg auth dashboard reset-password on this machine.",
      }, options.corsOrigin);
      return;
    }
    options.dashboardLogin.attemptLimiter?.recordFailure(attemptKey);
    jsonResponse(res, 401, { error: "Invalid dashboard username or password" }, options.corsOrigin);
    return;
  }

  options.dashboardLogin.attemptLimiter?.recordSuccess(attemptKey);
  const compatToken = options.dashboardLogin.selectCompatToken();
  if (!verifyToken(compatToken, options.validTokens)) {
    jsonResponse(res, 503, { error: "Dashboard login is unavailable until an API token is configured" }, options.corsOrigin);
    return;
  }
  const created = store.create(
    compatToken!,
    "login",
    Date.now(),
    verified.credentialFingerprint ? { credentialFingerprint: verified.credentialFingerprint } : {},
  );
  setDashboardSessionCookie(req, res, created.sessionId, options.corsOrigin);
  jsonResponse(res, 200, sessionResponse({
    csrfToken: created.record.csrfToken,
    source: created.record.source,
    expiresAt: created.record.expiresAt,
  }), options.corsOrigin);
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

function isDashboardLoginBody(body: unknown): body is { username?: unknown; password?: unknown } {
  return !!body &&
    typeof body === "object" &&
    ("username" in body || "password" in body);
}

function dashboardLoginAttemptKey(req: IncomingMessage, username: string): string {
  return `${req.socket.remoteAddress ?? "unknown"}:${username.trim().toLowerCase()}`;
}

function isStaleDashboardLoginSession(
  session: AuthenticatedDashboardSession | null,
  options: DashboardSessionHandlerOptions,
): boolean {
  if (!session || session.source !== "login") return false;
  if (!options.dashboardLogin?.isCredentialFingerprintCurrent) return false;
  return !session.credentialFingerprint ||
    !options.dashboardLogin.isCredentialFingerprintCurrent(session.credentialFingerprint);
}
