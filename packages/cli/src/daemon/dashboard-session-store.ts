import { createHash, randomBytes } from "node:crypto";

export const DASHBOARD_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export type DashboardSessionSource = "loopback" | "exchange" | "login";
export type NonLoginDashboardSessionSource = Exclude<DashboardSessionSource, "login">;

export type DashboardSessionRecord =
  | DashboardSessionBaseRecord<NonLoginDashboardSessionSource>
  | (DashboardSessionBaseRecord<"login"> & { credentialFingerprint: string });

interface DashboardSessionBaseRecord<TSource extends DashboardSessionSource> {
  compatToken: string;
  csrfToken: string;
  source: TSource;
  issuedAt: number;
  expiresAt: number;
  lastUsedAt: number;
}

export type AuthenticatedDashboardSession =
  | AuthenticatedDashboardSessionBase<NonLoginDashboardSessionSource>
  | (AuthenticatedDashboardSessionBase<"login"> & { credentialFingerprint: string });

interface AuthenticatedDashboardSessionBase<TSource extends DashboardSessionSource> {
  sessionId: string;
  compatToken: string;
  csrfToken: string;
  source: TSource;
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
    if ((source as DashboardSessionSource) === "login") {
      throw new Error("Login dashboard sessions require createLoginSession() with a credential fingerprint");
    }
    this.prune(now);
    const record: DashboardSessionRecord = {
      compatToken,
      csrfToken: randomBytes(32).toString("base64url"),
      source,
      issuedAt: now,
      expiresAt: now + DASHBOARD_SESSION_TTL_MS,
      lastUsedAt: now,
    };
    return this.storeRecord(record);
  }

  createLoginSession(
    compatToken: string,
    credentialFingerprint: string,
    now = Date.now(),
  ): {
    sessionId: string;
    record: DashboardSessionRecord;
  } {
    this.prune(now);
    const record: DashboardSessionRecord = {
      compatToken,
      csrfToken: randomBytes(32).toString("base64url"),
      source: "login",
      credentialFingerprint,
      issuedAt: now,
      expiresAt: now + DASHBOARD_SESSION_TTL_MS,
      lastUsedAt: now,
    };
    return this.storeRecord(record);
  }

  authenticateSessionId(sessionId: string | null | undefined, now = Date.now()): AuthenticatedDashboardSession | null {
    this.prune(now);
    if (!sessionId) return null;
    const record = this.sessions.get(hashSessionId(sessionId));
    if (!record || record.expiresAt <= now) return null;
    record.lastUsedAt = now;
    const authenticated = {
      sessionId,
      compatToken: record.compatToken,
      csrfToken: record.csrfToken,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
    };
    if (record.source === "login") {
      return {
        ...authenticated,
        source: "login",
        credentialFingerprint: record.credentialFingerprint,
      };
    }
    return {
      ...authenticated,
      source: record.source,
    };
  }

  revoke(sessionId: string | null | undefined): void {
    if (!sessionId) return;
    this.sessions.delete(hashSessionId(sessionId));
  }

  private storeRecord(record: DashboardSessionRecord): {
    sessionId: string;
    record: DashboardSessionRecord;
  } {
    const sessionId = randomBytes(32).toString("base64url");
    this.sessions.set(hashSessionId(sessionId), record);
    return { sessionId, record };
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
