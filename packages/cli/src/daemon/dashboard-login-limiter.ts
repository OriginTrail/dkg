import type { IncomingMessage } from "node:http";

interface DashboardLoginAttempt {
  failures: number;
  inFlight: number;
  firstFailureAt: number;
  lockedUntil?: number;
}

export type DashboardLoginAttemptReservation =
  | { ok: false; retryAfterMs: number }
  | {
      ok: true;
      fail: () => void;
      release: () => void;
      succeed: () => void;
    };

export class DashboardLoginAttemptLimiter {
  private attempts = new Map<string, DashboardLoginAttempt>();

  constructor(private readonly options: {
    maxFailures?: number;
    failureWindowMs?: number;
    lockoutMs?: number;
    maxTrackedKeys?: number;
    now?: () => number;
  } = {}) {}

  reserve(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = this.now();
    this.prune(now);
    let attempt = this.attempts.get(key);
    if (attempt?.lockedUntil && attempt.lockedUntil > now) {
      return { ok: false, retryAfterMs: attempt.lockedUntil - now };
    }
    if (!attempt) {
      if (!this.evictForNewKey()) {
        return { ok: false, retryAfterMs: this.lockoutMs() };
      }
      attempt = { failures: 0, inFlight: 0, firstFailureAt: now };
    }
    if (attempt.failures + attempt.inFlight >= this.maxFailures()) {
      attempt.lockedUntil = now + this.lockoutMs();
      this.attempts.set(key, attempt);
      return { ok: false, retryAfterMs: this.lockoutMs() };
    }
    attempt.inFlight += 1;
    if (attempt.failures + attempt.inFlight >= this.maxFailures()) {
      attempt.lockedUntil = now + this.lockoutMs();
    }
    this.attempts.set(key, attempt);
    return { ok: true };
  }

  reserveAttempt(key: string): DashboardLoginAttemptReservation {
    const reserved = this.reserve(key);
    if (!reserved.ok) return reserved;
    let finalized = false;
    const finalize = (fn: () => void): void => {
      if (finalized) return;
      finalized = true;
      fn();
    };
    return {
      ok: true,
      fail: () => finalize(() => this.completeFailure(key)),
      release: () => finalize(() => this.releaseReservation(key)),
      succeed: () => finalize(() => this.recordSuccess(key)),
    };
  }

  check(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = this.now();
    this.prune(now);
    const attempt = this.attempts.get(key);
    if (!attempt) return { ok: true };
    if (attempt.lockedUntil && attempt.lockedUntil > now) {
      return { ok: false, retryAfterMs: attempt.lockedUntil - now };
    }
    return { ok: true };
  }

  completeFailure(key: string): void {
    const now = this.now();
    const attempt = this.attempts.get(key);
    if (!attempt) return;
    attempt.inFlight = Math.max(0, attempt.inFlight - 1);
    attempt.failures += 1;
    if (attempt.failures + attempt.inFlight >= this.maxFailures()) {
      attempt.lockedUntil = now + this.lockoutMs();
    }
    this.attempts.set(key, attempt);
  }

  releaseReservation(key: string): void {
    const attempt = this.attempts.get(key);
    if (!attempt) return;
    attempt.inFlight = Math.max(0, attempt.inFlight - 1);
    if (attempt.failures === 0 && attempt.inFlight === 0) {
      this.attempts.delete(key);
      return;
    }
    if (attempt.failures + attempt.inFlight < this.maxFailures()) {
      delete attempt.lockedUntil;
    }
    this.attempts.set(key, attempt);
  }

  recordFailure(key: string): void {
    const reserved = this.reserve(key);
    if (reserved.ok) this.completeFailure(key);
  }

  recordSuccess(key: string): void {
    this.attempts.delete(key);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private maxFailures(): number {
    return this.options.maxFailures ?? 5;
  }

  private failureWindowMs(): number {
    return this.options.failureWindowMs ?? 5 * 60 * 1000;
  }

  private lockoutMs(): number {
    return this.options.lockoutMs ?? 5 * 60 * 1000;
  }

  private maxTrackedKeys(): number {
    return Math.max(1, this.options.maxTrackedKeys ?? 1024);
  }

  private prune(now: number): void {
    for (const [key, attempt] of this.attempts) {
      if (attempt.lockedUntil) {
        if (attempt.lockedUntil <= now) this.attempts.delete(key);
        continue;
      }
      if (attempt.inFlight === 0 && now - attempt.firstFailureAt > this.failureWindowMs()) {
        this.attempts.delete(key);
      }
    }
  }

  private evictForNewKey(): boolean {
    if (this.attempts.size < this.maxTrackedKeys()) return true;
    const oldestIdleKey = this.oldestAttemptKey((attempt) => attempt.inFlight === 0);
    if (!oldestIdleKey) return false;
    this.attempts.delete(oldestIdleKey);
    return true;
  }

  private oldestAttemptKey(predicate: (attempt: DashboardLoginAttempt) => boolean = () => true): string | undefined {
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, attempt] of this.attempts) {
      if (!predicate(attempt)) continue;
      if (attempt.firstFailureAt < oldestAt) {
        oldestAt = attempt.firstFailureAt;
        oldestKey = key;
      }
    }
    return oldestKey;
  }
}

export function dashboardLoginAttemptKey(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}
