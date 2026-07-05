import type { IncomingMessage } from "node:http";
import {
  getRequestAuthContext,
  getRequestAuthDashboardSession,
} from "../auth.js";

export interface DashboardSseSession {
  sessionId: string;
  expiresAt: number;
  compatToken: string;
  credentialFingerprint?: string;
}

export function resolveDashboardSseSession(req: IncomingMessage): DashboardSseSession | undefined {
  const requestAuth = getRequestAuthContext(req);
  const activeDashboardSession = requestAuth?.source === "dashboard-session"
    ? getRequestAuthDashboardSession(req)
    : undefined;
  if (
    requestAuth?.source !== "dashboard-session" ||
    !activeDashboardSession ||
    activeDashboardSession.sessionId !== requestAuth.dashboardSession.sessionId
  ) {
    return undefined;
  }
  return {
    sessionId: activeDashboardSession.sessionId,
    expiresAt: activeDashboardSession.expiresAt,
    compatToken: activeDashboardSession.compatToken,
    ...(activeDashboardSession.credentialFingerprint
      ? { credentialFingerprint: activeDashboardSession.credentialFingerprint }
      : {}),
  };
}
