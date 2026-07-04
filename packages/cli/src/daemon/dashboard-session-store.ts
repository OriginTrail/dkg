import { createHash, randomBytes } from "node:crypto";

export const DASHBOARD_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export type DashboardSessionSource = "loopback" | "exchange" | "login";
export type NonLoginDashboardSessionSource = Exclude<DashboardSessionSource, "login">;

export type DashboardSessionRecord =
  | DashboardSessionBaseRecord<"loopback" | "exchange">
  | (DashboardSessionBaseRecord<"login"> & { credentialFingerprint: string });

interface DashboardSessionBaseRecord<TSource extends DashboardSessionSource> {
  compatToken: string;
  csrfToken: string;
  source: TSource;
  issuedAt: number;
  expiresAt: number;
  lastUsedAt: number;
}

export interface AuthenticatedDashboardSession {
  sessionId: string;
  compatToken: string;
  csrfToken: string;
  source: DashboardSessionSource;
  credentialFingerprint?: string;
  issuedAt: number;
  expiresAt: number;
}

export class DashboardSessionStore {
  private sessions = new Map<string, DashboardSessionRecord>();

  create(
    compatToken: string,
    source: NonLoginDashboardSessionSource,
    now = Date.now(),
  ): {
    sessionId: string;
    record: DashboardSessionRecord;
  } {
    return this.createRecord(compatToken, source, now);
  }

  createLoginSession(
    compatToken: string,
    credentialFingerprint: string,
    now = Date.now(),
  ): {
    sessionId: string;
    record: DashboardSessionRecord;
  } {
    return this.createRecord(compatToken, "login", now, { credentialFingerprint });
  }

  private createRecord(
    compatToken: string,
    source: DashboardSessionSource,
    now: number,
    options: { credentialFingerprint?: string } = {},
  ): {
    sessionId: string;
    record: DashboardSessionRecord;
  } {
    this.prune(now);
    const sessionId = randomBytes(32).toString("base64url");
    const record = {
      compatToken,
      csrfToken: randomBytes(32).toString("base64url"),
      source,
      ...(source === "login" ? { credentialFingerprint: options.credentialFingerprint } : {}),
      issuedAt: now,
      expiresAt: now + DASHBOARD_SESSION_TTL_MS,
      lastUsedAt: now,
    } as DashboardSessionRecord;
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
      ...(record.source === "login" ? { credentialFingerprint: record.credentialFingerprint } : {}),
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
