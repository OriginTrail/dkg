import type { IncomingMessage, ServerResponse } from "node:http";
import { extractBearerToken, verifyToken } from "../auth.js";
import { jsonResponse } from "./http-utils.js";
import { setDashboardSessionCookie } from "./dashboard-session-cookie.js";
import { dashboardSessionResponse } from "./dashboard-session-response.js";
import {
  DashboardSessionStore,
} from "./dashboard-session-store.js";
import { dashboardLoginAttemptKey } from "./dashboard-login-limiter.js";
import type {
  DashboardLoginExchangeConfig,
  DashboardLoginVerification,
} from "./dashboard-login-options.js";

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

export interface DashboardLoginExchangeOptions {
  validTokens: Set<string>;
  corsOrigin?: string | null;
  dashboardLogin?: DashboardLoginExchangeConfig;
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

  const reservation = options.dashboardLogin.attemptLimiter?.reserveAttempt(dashboardLoginAttemptKey(req));
  if (reservation && !reservation.ok) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil(reservation.retryAfterMs / 1000))));
    jsonResponse(res, 429, { error: "Too many dashboard sign-in attempts. Try again later." }, options.corsOrigin);
    return;
  }

  let verified: DashboardLoginVerification;
  try {
    verified = await options.dashboardLogin.verifyCredentials(username, password);
  } catch (err) {
    reservation?.release();
    throw err;
  }
  if (!verified.ok) {
    if (verified.reason === "missing") {
      reservation?.release();
      jsonResponse(res, 503, {
        error: "Dashboard credentials are not configured. Run dkg auth dashboard reset-password on the node host using this daemon's DKG_HOME.",
      }, options.corsOrigin);
      return;
    }
    if (verified.reason === "invalid") {
      reservation?.release();
      jsonResponse(res, 503, {
        error: "Dashboard credentials are unavailable. Run dkg auth dashboard reset-password on the node host using this daemon's DKG_HOME.",
      }, options.corsOrigin);
      return;
    }
    reservation?.fail();
    jsonResponse(res, 401, { error: "Invalid dashboard username or password" }, options.corsOrigin);
    return;
  }

  reservation?.succeed();
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
