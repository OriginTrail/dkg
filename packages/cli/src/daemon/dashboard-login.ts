import type { IncomingMessage, ServerResponse } from "node:http";
import { extractBearerToken, verifyToken } from "../auth.js";
import { jsonResponse } from "./http-utils.js";
import { getDashboardSessionCookie, setDashboardSessionCookie } from "./dashboard-session-cookie.js";
import { dashboardSessionResponse } from "./dashboard-session-response.js";
import {
  DashboardSessionStore,
  type AuthenticatedDashboardSession,
} from "./dashboard-session-store.js";

export type DashboardLoginVerification =
  | { ok: true; credentialFingerprint: string }
  | { ok: false; reason?: "missing" | "invalid" | "mismatch" };

export interface DashboardLoginOptions {
  verifyCredentials: (username: string, password: string) => Promise<DashboardLoginVerification>;
  selectCompatToken: () => string | undefined;
  attemptLimiter?: DashboardLoginAttemptLimiter;
  isCredentialFingerprintCurrent?: (credentialFingerprint: string) => boolean;
}

export interface DashboardLoginCompatTokenSelectionOptions {
  validTokens: Set<string>;
  bridgeAuthToken?: string;
  resolveAgentByToken: (token: string) => string | undefined | null;
  refreshValidTokens?: () => void;
}

export function selectDashboardLoginCompatToken(options: DashboardLoginCompatTokenSelectionOptions): string | undefined {
  options.refreshValidTokens?.();
  const isNodeAdminToken = (token: string) =>
    options.validTokens.has(token) && !options.resolveAgentByToken(token);
  if (options.bridgeAuthToken && isNodeAdminToken(options.bridgeAuthToken)) {
    return options.bridgeAuthToken;
  }
  for (const token of options.validTokens) {
    if (isNodeAdminToken(token)) return token;
  }
  return undefined;
}

interface DashboardLoginAttempt {
  failures: number;
  inFlight: number;
  firstFailureAt: number;
  lockedUntil?: number;
}

export class DashboardLoginAttemptLimiter {
  private attempts = new Map<string, DashboardLoginAttempt>();

  constructor(private readonly options: {
    maxFailures?: number;
    failureWindowMs?: number;
    lockoutMs?: number;
    maxTrackedKeys?: number;
    now?: () => number;
  } = {}) {}

  reserve(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = this.now();
    this.prune(now);
    let attempt = this.attempts.get(key);
    if (attempt?.lockedUntil && attempt.lockedUntil > now) {
      return { ok: false, retryAfterMs: attempt.lockedUntil - now };
    }
    if (!attempt) {
      if (!this.evictForNewKey()) {
        return { ok: false, retryAfterMs: this.lockoutMs() };
      }
      attempt = { failures: 0, inFlight: 0, firstFailureAt: now };
    }
    if (attempt.failures + attempt.inFlight >= this.maxFailures()) {
      attempt.lockedUntil = now + this.lockoutMs();
      this.attempts.set(key, attempt);
      return { ok: false, retryAfterMs: this.lockoutMs() };
    }
    attempt.inFlight += 1;
    if (attempt.failures + attempt.inFlight >= this.maxFailures()) {
      attempt.lockedUntil = now + this.lockoutMs();
    }
    this.attempts.set(key, attempt);
    return { ok: true };
  }

  check(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = this.now();
    this.prune(now);
    const attempt = this.attempts.get(key);
    if (!attempt) return { ok: true };
    if (attempt.lockedUntil && attempt.lockedUntil > now) {
      return { ok: false, retryAfterMs: attempt.lockedUntil - now };
    }
    return { ok: true };
  }

  completeFailure(key: string): void {
    const now = this.now();
    const attempt = this.attempts.get(key);
    if (!attempt) return;
    attempt.inFlight = Math.max(0, attempt.inFlight - 1);
    attempt.failures += 1;
    if (attempt.failures + attempt.inFlight >= this.maxFailures()) {
      attempt.lockedUntil = now + this.lockoutMs();
    }
    this.attempts.set(key, attempt);
  }

  releaseReservation(key: string): void {
    const attempt = this.attempts.get(key);
    if (!attempt) return;
    attempt.inFlight = Math.max(0, attempt.inFlight - 1);
    if (attempt.failures === 0 && attempt.inFlight === 0) {
      this.attempts.delete(key);
      return;
    }
    if (attempt.failures + attempt.inFlight < this.maxFailures()) {
      delete attempt.lockedUntil;
    }
    this.attempts.set(key, attempt);
  }

  recordFailure(key: string): void {
    const reserved = this.reserve(key);
    if (reserved.ok) this.completeFailure(key);
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

  private maxTrackedKeys(): number {
    return Math.max(1, this.options.maxTrackedKeys ?? 1024);
  }

  private prune(now: number): void {
    for (const [key, attempt] of this.attempts) {
      if (attempt.lockedUntil) {
        if (attempt.lockedUntil <= now) this.attempts.delete(key);
        continue;
      }
      if (attempt.inFlight === 0 && now - attempt.firstFailureAt > this.failureWindowMs()) {
        this.attempts.delete(key);
      }
    }
  }

  private evictForNewKey(): boolean {
    if (this.attempts.size < this.maxTrackedKeys()) return true;
    const oldestIdleKey = this.oldestAttemptKey((attempt) => attempt.inFlight === 0);
    if (!oldestIdleKey) return false;
    this.attempts.delete(oldestIdleKey);
    return true;
  }

  private oldestAttemptKey(predicate: (attempt: DashboardLoginAttempt) => boolean = () => true): string | undefined {
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, attempt] of this.attempts) {
      if (!predicate(attempt)) continue;
      if (attempt.firstFailureAt < oldestAt) {
        oldestAt = attempt.firstFailureAt;
        oldestKey = key;
      }
    }
    return oldestKey;
  }
}

export interface DashboardSessionAuthenticatorOptions {
  dashboardLogin?: Pick<DashboardLoginOptions, "isCredentialFingerprintCurrent">;
  onSessionRevoked?: (sessionId: string) => void;
}

export function authenticateDashboardSessionRequest(
  req: IncomingMessage,
  store: DashboardSessionStore,
  options: DashboardSessionAuthenticatorOptions = {},
): AuthenticatedDashboardSession | null {
  const sessionId = getDashboardSessionCookie(req);
  const session = store.authenticateSessionId(sessionId);
  if (!session) return null;
  if (!isStaleDashboardLoginSession(session, options)) return session;
  store.revoke(session.sessionId);
  options.onSessionRevoked?.(session.sessionId);
  return null;
}

export interface DashboardLoginExchangeOptions {
  validTokens: Set<string>;
  corsOrigin?: string | null;
  dashboardLogin?: DashboardLoginOptions;
}

export async function handleDashboardLoginExchange(
  req: IncomingMessage,
  res: ServerResponse,
  store: DashboardSessionStore,
  options: DashboardLoginExchangeOptions,
  body: DashboardSessionExchangeLoginRequest,
): Promise<void> {
  const { username, password } = body;
  if (!options.dashboardLogin) {
    jsonResponse(res, 503, { error: "Dashboard username/password login is not configured" }, options.corsOrigin);
    return;
  }
  if (!username || !password) {
    jsonResponse(res, 401, { error: "Invalid dashboard username or password" }, options.corsOrigin);
    return;
  }

  const attemptKey = dashboardLoginAttemptKey(req);
  const limiterState = options.dashboardLogin.attemptLimiter?.reserve(attemptKey);
  if (limiterState && !limiterState.ok) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil(limiterState.retryAfterMs / 1000))));
    jsonResponse(res, 429, { error: "Too many dashboard sign-in attempts. Try again later." }, options.corsOrigin);
    return;
  }

  let verified: DashboardLoginVerification;
  try {
    verified = await options.dashboardLogin.verifyCredentials(username, password);
  } catch (err) {
    options.dashboardLogin.attemptLimiter?.releaseReservation(attemptKey);
    throw err;
  }
  if (!verified.ok) {
    if (verified.reason === "missing") {
      options.dashboardLogin.attemptLimiter?.releaseReservation(attemptKey);
      jsonResponse(res, 503, {
        error: "Dashboard credentials are not configured. Run dkg auth dashboard reset-password on the node host using this daemon's DKG_HOME.",
      }, options.corsOrigin);
      return;
    }
    if (verified.reason === "invalid") {
      options.dashboardLogin.attemptLimiter?.releaseReservation(attemptKey);
      jsonResponse(res, 503, {
        error: "Dashboard credentials are unavailable. Run dkg auth dashboard reset-password on the node host using this daemon's DKG_HOME.",
      }, options.corsOrigin);
      return;
    }
    options.dashboardLogin.attemptLimiter?.completeFailure(attemptKey);
    jsonResponse(res, 401, { error: "Invalid dashboard username or password" }, options.corsOrigin);
    return;
  }

  options.dashboardLogin.attemptLimiter?.recordSuccess(attemptKey);
  const compatToken = options.dashboardLogin.selectCompatToken();
  if (!verifyToken(compatToken, options.validTokens)) {
    jsonResponse(res, 503, { error: "Dashboard login is unavailable until an API token is configured" }, options.corsOrigin);
    return;
  }
  const created = store.createLoginSession(
    compatToken!,
    verified.credentialFingerprint,
    Date.now(),
  );
  setDashboardSessionCookie(req, res, created.sessionId, options.corsOrigin);
  jsonResponse(res, 200, dashboardSessionResponse(created.record), options.corsOrigin);
}

export type DashboardSessionExchangeRequest =
  | DashboardSessionExchangeTokenRequest
  | DashboardSessionExchangeLoginRequest
  | DashboardSessionExchangeInvalidRequest;

export interface DashboardSessionExchangeTokenRequest {
  kind: "token";
  token?: string;
}

export interface DashboardSessionExchangeLoginRequest {
  kind: "login";
  username: string;
  password: string;
}

export interface DashboardSessionExchangeInvalidRequest {
  kind: "invalid";
  status: 400;
  error: string;
}

export function parseDashboardSessionExchange(
  body: unknown,
  authorizationHeader: IncomingMessage["headers"]["authorization"],
): DashboardSessionExchangeRequest {
  const objectBody = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const hasLoginFields = "username" in objectBody || "password" in objectBody;
  const bodyToken = typeof objectBody.token === "string" ? objectBody.token.trim() : undefined;
  const bearerToken = extractBearerToken(authorizationHeader);
  if (hasLoginFields) {
    if (bodyToken || bearerToken) {
      return {
        kind: "invalid",
        status: 400,
        error: "Dashboard session exchange accepts either token or username/password",
      };
    }
    return {
      kind: "login",
      username: typeof objectBody.username === "string" ? objectBody.username.trim() : "",
      password: typeof objectBody.password === "string" ? objectBody.password : "",
    };
  }
  return { kind: "token", token: bodyToken || bearerToken };
}

function dashboardLoginAttemptKey(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

function isStaleDashboardLoginSession(
  session: AuthenticatedDashboardSession | null,
  options: DashboardSessionAuthenticatorOptions,
): boolean {
  if (!session || session.source !== "login") return false;
  if (!options.dashboardLogin?.isCredentialFingerprintCurrent) return false;
  return !options.dashboardLogin.isCredentialFingerprintCurrent(session.credentialFingerprint);
}
