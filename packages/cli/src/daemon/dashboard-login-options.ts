import type { DashboardLoginAttemptLimiter } from "./dashboard-login-limiter.js";

export type DashboardLoginVerification =
  | { ok: true; credentialFingerprint: string }
  | { ok: false; reason?: "missing" | "invalid" | "mismatch" };

export interface DashboardLoginExchangeConfig {
  verifyCredentials: (username: string, password: string) => Promise<DashboardLoginVerification>;
  selectCompatToken: () => string | undefined;
  attemptLimiter?: DashboardLoginAttemptLimiter;
}

export interface DashboardLoginSessionPolicy {
  isCredentialFingerprintCurrent?: (credentialFingerprint: string) => boolean;
}

export type DashboardLoginOptions =
  DashboardLoginExchangeConfig &
  DashboardLoginSessionPolicy;
