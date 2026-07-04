import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extractBearerToken, verifyToken } from "../auth.js";
import type { RequestAuthDecision, RequestAuthPrincipal, RequestAuthSource } from "../auth.js";
import { jsonResponse, readBody, SMALL_BODY_BYTES } from "./http-utils.js";

export const DASHBOARD_SESSION_COOKIE = "dkg_ui_session";
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_COOKIE_AGE_SECONDS = Math.floor(DEFAULT_SESSION_TTL_MS / 1000);

export interface DashboardSessionRecord {
  compatToken: string;
  principal: RequestAuthPrincipal;
  csrfToken: string;
  source: "loopback" | "exchange";
  issuedAt: number;
  expiresAt: number;
  lastUsedAt: number;
}

export interface AuthenticatedDashboardSession {
  sessionId: string;
  compatToken: string;
  principal: RequestAuthPrincipal;
  csrfToken: string;
  source: DashboardSessionRecord["source"];
  expiresAt: number;
}

export class DashboardSessionStore {
  private sessions = new Map<string, DashboardSessionRecord>();

  create(
    compatToken: string,
    source: DashboardSessionRecord["source"],
    principal: RequestAuthPrincipal,
    now = Date.now(),
  ): {
    sessionId: string;
    record: DashboardSessionRecord;
  } {
    this.prune(now);
    const sessionId = randomBytes(32).toString("base64url");
    const record: DashboardSessionRecord = {
      compatToken,
      principal,
      csrfToken: randomBytes(32).toString("base64url"),
      source,
      issuedAt: now,
      expiresAt: now + DEFAULT_SESSION_TTL_MS,
      lastUsedAt: now,
    };
    this.sessions.set(hashSessionId(sessionId), record);
    return { sessionId, record };
  }

  authenticate(req: IncomingMessage, now = Date.now()): AuthenticatedDashboardSession | null {
    this.prune(now);
    const sessionId = getCookie(req, DASHBOARD_SESSION_COOKIE);
    if (!sessionId) return null;
    const record = this.sessions.get(hashSessionId(sessionId));
    if (!record || record.expiresAt <= now) return null;
    record.lastUsedAt = now;
    return {
      sessionId,
      compatToken: record.compatToken,
      principal: record.principal,
      csrfToken: record.csrfToken,
      source: record.source,
      expiresAt: record.expiresAt,
    };
  }

  revoke(sessionId: string | null | undefined): void {
    if (!sessionId) return;
    this.sessions.delete(hashSessionId(sessionId));
  }

  private prune(now: number): void {
    for (const [key, record] of this.sessions) {
      if (record.expiresAt <= now) this.sessions.delete(key);
    }
  }
}

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

  const session = store.authenticate(req);

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
    setSessionCookie(req, res, created.sessionId);
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
    setSessionCookie(req, res, created.sessionId);
    jsonResponse(res, 200, sessionResponse({
      csrfToken: created.record.csrfToken,
      source: created.record.source,
      expiresAt: created.record.expiresAt,
    }), options.corsOrigin);
    return true;
  }

  if (req.method === "POST" && path === "/api/dashboard/session/logout") {
    const sessionId = session?.sessionId ?? getCookie(req, DASHBOARD_SESSION_COOKIE);
    store.revoke(sessionId);
    if (sessionId) options.onSessionRevoked?.(sessionId);
    clearSessionCookie(req, res);
    jsonResponse(res, 200, { ok: true }, options.corsOrigin);
    return true;
  }

  jsonResponse(res, 404, { error: "Unknown dashboard session route" }, options.corsOrigin);
  return true;
}

export function verifyDashboardCsrf(
  req: IncomingMessage,
  session: Pick<AuthenticatedDashboardSession, "csrfToken">,
): boolean {
  const suppliedRaw = req.headers["x-dkg-csrf"];
  const supplied = Array.isArray(suppliedRaw) ? suppliedRaw[0] : suppliedRaw;
  if (!supplied) return false;
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(session.csrfToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface DashboardSessionAuthSourceOptions {
  authenticate: (req: IncomingMessage) => AuthenticatedDashboardSession | null;
  verifyCsrf: (req: IncomingMessage, session: AuthenticatedDashboardSession) => boolean;
}

export function createDashboardSessionAuthSource(
  options: DashboardSessionAuthSourceOptions,
): RequestAuthSource {
  return {
    resolve(req: IncomingMessage, validTokens: Set<string>, corsOrigin?: string | null): RequestAuthDecision | null {
      const session = options.authenticate(req);
      if (!session || !verifyToken(session.compatToken, validTokens)) return null;

      const unsafe = isUnsafeHttpMethod(req.method);
      const csrfValidated = unsafe ? options.verifyCsrf(req, session) : false;
      if (unsafe && !csrfValidated) {
        return {
          ok: false,
          status: 403,
          error: "Invalid or missing dashboard CSRF token",
        };
      }
      if (unsafe && !hasTrustedDashboardOrigin(req, corsOrigin)) {
        return {
          ok: false,
          status: 403,
          error: "Untrusted dashboard request origin",
        };
      }

      return {
        ok: true,
        credentialToken: session.compatToken,
        context: {
          source: "dashboard-session",
          internalCredentialToken: session.compatToken,
          principal: session.principal,
          csrf: {
            required: unsafe,
            validated: csrfValidated,
          },
          dashboardSession: {
            sessionId: session.sessionId,
            source: session.source,
            expiresAt: session.expiresAt,
          },
        },
      };
    },
  };
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

function hashSessionId(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

function getCookie(req: IncomingMessage, name: string): string | null {
  const cookie = req.headers.cookie;
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (key !== name) continue;
    const value = part.slice(idx + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

function setSessionCookie(req: IncomingMessage, res: ServerResponse, sessionId: string): void {
  const attrs = [
    `${DASHBOARD_SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${MAX_COOKIE_AGE_SECONDS}`,
  ];
  if (isHttpsRequest(req)) attrs.push("Secure");
  appendSetCookie(res, attrs.join("; "));
}

function clearSessionCookie(req: IncomingMessage, res: ServerResponse): void {
  const attrs = [
    `${DASHBOARD_SESSION_COOKIE}=`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    "Max-Age=0",
  ];
  if (isHttpsRequest(req)) attrs.push("Secure");
  appendSetCookie(res, attrs.join("; "));
}

function appendSetCookie(res: ServerResponse, value: string): void {
  const existing = res.getHeader("Set-Cookie");
  if (!existing) {
    res.setHeader("Set-Cookie", value);
  } else if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing.map(String), value]);
  } else {
    res.setHeader("Set-Cookie", [String(existing), value]);
  }
}

function isHttpsRequest(req: IncomingMessage): boolean {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  return proto === "https" || Boolean((req.socket as unknown as { encrypted?: boolean }).encrypted);
}

function isLoopbackRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress ?? "";
  if (!isLoopbackAddress(remote)) return false;
  if (hasProxyForwardingHeaders(req)) return false;
  return isAllowedLoopbackHost(req.headers.host) && hasLocalBrowserAddressing(req);
}

function isLoopbackAddress(addr: string): boolean {
  return addr === "::1" ||
    addr === "127.0.0.1" ||
    addr === "::ffff:127.0.0.1" ||
    addr.startsWith("127.");
}

function isAllowedLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const rawHost = hostHeader.trim().toLowerCase();
  const host = rawHost.startsWith("[")
    ? rawHost.slice(1, rawHost.indexOf("]"))
    : rawHost.split(":")[0];
  return isAllowedLoopbackHostname(host);
}

const PROXY_FORWARDING_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "x-client-ip",
  "cf-connecting-ip",
  "true-client-ip",
] as const;

function hasProxyForwardingHeaders(req: IncomingMessage): boolean {
  return PROXY_FORWARDING_HEADERS.some((header) => headerHasValue(req.headers[header]));
}

function headerHasValue(value: string | string[] | undefined): boolean {
  if (Array.isArray(value)) return value.some((item) => item.trim().length > 0);
  return typeof value === "string" && value.trim().length > 0;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function isUnsafeHttpMethod(method: string | undefined): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function parseOrigin(value: string | undefined): string | undefined {
  if (!value || value === "*") return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function requestOrigin(req: IncomingMessage): string | undefined {
  const host = firstHeaderValue(req.headers.host);
  if (!host) return undefined;
  const forwardedProto = firstHeaderValue(req.headers["x-forwarded-proto"])
    ?.split(",")[0]
    ?.trim()
    ?.toLowerCase();
  const proto = forwardedProto === "https" ? "https" : "http";
  return parseOrigin(`${proto}://${host}`);
}

function trustedDashboardOrigins(req: IncomingMessage, corsOrigin?: string | null): Set<string> {
  const origins = new Set<string>();
  const ownOrigin = requestOrigin(req);
  if (ownOrigin) origins.add(ownOrigin);
  const allowedCorsOrigin = parseOrigin(corsOrigin ?? undefined);
  if (allowedCorsOrigin) origins.add(allowedCorsOrigin);
  return origins;
}

function hasTrustedDashboardOrigin(req: IncomingMessage, corsOrigin?: string | null): boolean {
  const fetchSite = firstHeaderValue(req.headers["sec-fetch-site"])?.toLowerCase();
  if (fetchSite === "cross-site") return false;

  const allowed = trustedDashboardOrigins(req, corsOrigin);
  const originHeader = firstHeaderValue(req.headers.origin);
  if (originHeader && !isTrustedDashboardHeaderOrigin(req, originHeader, allowed)) return false;

  const refererHeader = firstHeaderValue(req.headers.referer);
  if (refererHeader && !isTrustedDashboardHeaderOrigin(req, refererHeader, allowed)) return false;

  return true;
}

function isTrustedDashboardHeaderOrigin(req: IncomingMessage, raw: string, allowed: Set<string>): boolean {
  const origin = parseOrigin(raw);
  if (!origin) return false;
  if (allowed.has(origin)) return true;
  return isLoopbackDashboardRequest(req) && isLocalOrigin(raw);
}

function isLoopbackDashboardRequest(req: IncomingMessage): boolean {
  return isLoopbackAddress(req.socket.remoteAddress ?? "") && isAllowedLoopbackHost(req.headers.host);
}

function hasLocalBrowserAddressing(req: IncomingMessage): boolean {
  return isLocalOrigin(firstHeaderValue(req.headers.origin)) ||
    isLocalOrigin(firstHeaderValue(req.headers.referer));
}

function isLocalOrigin(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      isAllowedLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function isAllowedLoopbackHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}
