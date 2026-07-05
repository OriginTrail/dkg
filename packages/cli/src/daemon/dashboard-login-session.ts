import type { IncomingMessage } from "node:http";
import { getDashboardSessionCookie } from "./dashboard-session-cookie.js";
import {
  DashboardSessionStore,
  type AuthenticatedDashboardSession,
} from "./dashboard-session-store.js";
import type { DashboardLoginSessionPolicy } from "./dashboard-login-options.js";

export interface DashboardSessionAuthenticatorOptions {
  dashboardLogin?: DashboardLoginSessionPolicy;
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

function isStaleDashboardLoginSession(
  session: AuthenticatedDashboardSession | null,
  options: DashboardSessionAuthenticatorOptions,
): boolean {
  if (!session || session.source !== "login") return false;
  if (!options.dashboardLogin?.isCredentialFingerprintCurrent) return false;
  return !options.dashboardLogin.isCredentialFingerprintCurrent(session.credentialFingerprint);
}
