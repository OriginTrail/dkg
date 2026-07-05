import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { RequestAuthPrincipal, RequestAuthSource } from "../auth.js";
import type { AuthenticatedDashboardSession } from "./dashboard-session-store.js";
import { hasTrustedDashboardOrigin, isUnsafeHttpMethod } from "./dashboard-session-policy.js";

export const DASHBOARD_CSRF_ERROR_CODE = "DASHBOARD_CSRF_INVALID";
export const DASHBOARD_CSRF_ERROR_MESSAGE = "Invalid or missing dashboard CSRF token";

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
  | { ok: false; status: 403; error: string; code?: string };

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
      error: DASHBOARD_CSRF_ERROR_MESSAGE,
      code: DASHBOARD_CSRF_ERROR_CODE,
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
  resolvePrincipal: (token: string) => RequestAuthPrincipal;
  verifyCsrf: (req: IncomingMessage, session: AuthenticatedDashboardSession) => boolean;
}

export function createDashboardSessionAuthSource(
  options: DashboardSessionAuthSourceOptions,
): RequestAuthSource {
  return {
    resolve(req: IncomingMessage, corsOrigin?: string | null) {
      const session = options.authenticate(req);
      if (!session) return null;

      return {
        ok: true,
        credentialToken: session.compatToken,
        accept: () => {
          const authorization = authorizeDashboardSessionRequest(req, session, {
            corsOrigin,
            verifyCsrf: options.verifyCsrf,
          });
          if (!authorization.ok) {
            return {
              ok: false,
              status: authorization.status,
              error: authorization.error,
              code: authorization.code,
            };
          }
          const principal = options.resolvePrincipal(session.compatToken);
          return {
            ok: true,
            credentialToken: session.compatToken,
            context: {
              source: "dashboard-session",
              internalCredentialToken: session.compatToken,
              principal,
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
    },
  };
}
