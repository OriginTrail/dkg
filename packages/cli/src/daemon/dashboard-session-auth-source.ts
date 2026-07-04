import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { verifyToken } from "../auth.js";
import type { RequestAuthDecision, RequestAuthSource } from "../auth.js";
import type { AuthenticatedDashboardSession } from "./dashboard-session-store.js";
import { hasTrustedDashboardOrigin, isUnsafeHttpMethod } from "./dashboard-session-policy.js";

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

export interface DashboardSessionAuthorizationOptions {
  corsOrigin?: string | null;
  verifyCsrf?: (req: IncomingMessage, session: AuthenticatedDashboardSession) => boolean;
}

export type DashboardSessionAuthorization =
  | { ok: true; csrfRequired: boolean; csrfValidated: boolean }
  | { ok: false; status: 403; error: string };

export function authorizeDashboardSessionRequest(
  req: IncomingMessage,
  session: AuthenticatedDashboardSession,
  options: DashboardSessionAuthorizationOptions = {},
): DashboardSessionAuthorization {
  const unsafe = isUnsafeHttpMethod(req.method);
  const verifyCsrfForRequest = options.verifyCsrf ?? verifyDashboardCsrf;
  const csrfValidated = unsafe ? verifyCsrfForRequest(req, session) : false;
  if (unsafe && !csrfValidated) {
    return {
      ok: false,
      status: 403,
      error: "Invalid or missing dashboard CSRF token",
    };
  }
  if (unsafe && !hasTrustedDashboardOrigin(req, options.corsOrigin)) {
    return {
      ok: false,
      status: 403,
      error: "Untrusted dashboard request origin",
    };
  }
  return { ok: true, csrfRequired: unsafe, csrfValidated };
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

      const authorization = authorizeDashboardSessionRequest(req, session, {
        corsOrigin,
        verifyCsrf: options.verifyCsrf,
      });
      if (!authorization.ok) {
        return {
          ok: false,
          status: authorization.status,
          error: authorization.error,
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
            required: authorization.csrfRequired,
            validated: authorization.csrfValidated,
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
