import { createHash, randomBytes } from "node:crypto";

export const DASHBOARD_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export interface DashboardSessionRecord {
  compatToken: string;
  csrfToken: string;
  source: "loopback" | "exchange" | "login";
  credentialFingerprint?: string;
  issuedAt: number;
  expiresAt: number;
  lastUsedAt: number;
}

export interface AuthenticatedDashboardSession {
  sessionId: string;
  compatToken: string;
  csrfToken: string;
  source: DashboardSessionRecord["source"];
  credentialFingerprint?: string;
  issuedAt: number;
  expiresAt: number;
}

export class DashboardSessionStore {
  private sessions = new Map<string, DashboardSessionRecord>();

  create(
    compatToken: string,
    source: DashboardSessionRecord["source"],
    now = Date.now(),
    options: { credentialFingerprint?: string } = {},
  ): {
    sessionId: string;
    record: DashboardSessionRecord;
  } {
    this.prune(now);
    const sessionId = randomBytes(32).toString("base64url");
    const record: DashboardSessionRecord = {
      compatToken,
      csrfToken: randomBytes(32).toString("base64url"),
      source,
      ...(options.credentialFingerprint ? { credentialFingerprint: options.credentialFingerprint } : {}),
      issuedAt: now,
      expiresAt: now + DASHBOARD_SESSION_TTL_MS,
      lastUsedAt: now,
    };
    this.sessions.set(hashSessionId(sessionId), record);
    return { sessionId, record };
  }

  authenticateSessionId(sessionId: string | null | undefined, now = Date.now()): AuthenticatedDashboardSession | null {
    this.prune(now);
    if (!sessionId) return null;
    const record = this.sessions.get(hashSessionId(sessionId));
    if (!record || record.expiresAt <= now) return null;
    record.lastUsedAt = now;
    return {
      sessionId,
      compatToken: record.compatToken,
      csrfToken: record.csrfToken,
      source: record.source,
      ...(record.credentialFingerprint ? { credentialFingerprint: record.credentialFingerprint } : {}),
      issuedAt: record.issuedAt,
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

function hashSessionId(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}
