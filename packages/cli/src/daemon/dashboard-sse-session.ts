import type { IncomingMessage } from "node:http";
import { getRequestAuthContext } from "../auth.js";

export interface DashboardSseSession {
  sessionId: string;
  expiresAt: number;
  compatToken: string;
  credentialFingerprint?: string;
}

export function resolveDashboardSseSession(req: IncomingMessage): DashboardSseSession | undefined {
  const requestAuth = getRequestAuthContext(req);
  if (requestAuth?.source !== "dashboard-session") return undefined;
  return {
    sessionId: requestAuth.dashboardSession.sessionId,
    expiresAt: requestAuth.dashboardSession.expiresAt,
    compatToken: requestAuth.internalCredentialToken,
    ...(requestAuth.dashboardSession.credentialFingerprint
      ? { credentialFingerprint: requestAuth.dashboardSession.credentialFingerprint }
      : {}),
  };
}
