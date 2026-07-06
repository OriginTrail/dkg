import type { IncomingMessage } from "node:http";
import { getRequestAuthContext, type RequestAuthContext } from "../auth.js";
import type { AuthenticatedDashboardSession } from "./dashboard-session-store.js";
import type { SseDashboardSession } from "./sse-hub.js";

export type DashboardSseSessionAuthenticator = (
  req: IncomingMessage,
) => AuthenticatedDashboardSession | null;

export function resolveDashboardSseSessionFromAuthContext(
  req: IncomingMessage,
  authenticateDashboardSession: DashboardSseSessionAuthenticator,
  requestAuth: RequestAuthContext | undefined,
): SseDashboardSession | undefined {
  if (requestAuth?.source !== "dashboard-session") return undefined;
  const activeSession = authenticateDashboardSession(req);
  if (
    !activeSession ||
    activeSession.sessionId !== requestAuth.dashboardSession.sessionId ||
    activeSession.compatToken !== requestAuth.internalCredentialToken
  ) {
    return undefined;
  }
  return {
    sessionId: activeSession.sessionId,
    expiresAt: activeSession.expiresAt,
    compatToken: activeSession.compatToken,
    ...(activeSession.source === "login"
      ? { credentialFingerprint: activeSession.credentialFingerprint }
      : {}),
  };
}

export function resolveDashboardSseSessionFromAttachedAuthContext(
  req: IncomingMessage,
  authenticateDashboardSession: DashboardSseSessionAuthenticator,
): SseDashboardSession | undefined {
  return resolveDashboardSseSessionFromAuthContext(req, authenticateDashboardSession, getRequestAuthContext(req));
}
