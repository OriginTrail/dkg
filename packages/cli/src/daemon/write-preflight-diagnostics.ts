import type { ServerResponse } from 'node:http';
import { Logger, createOperationContext, type OperationContext } from '@origintrail-official/dkg-core';
import { sanitizeWritePreflightFailures, type WritePreflightDiagnosticFailure } from './write-preflight-attribution.js';
export type { WritePreflightDiagnosticFailure } from './write-preflight-attribution.js';
import { createWarningGate } from './read-authority-diagnostics.js';

export type WritePreflightRescueOutcome = 'not-attempted' | 'unsupported' | 'denied' | 'deadline' | 'failed' | 'accepted';
export interface WritePreflightDiagnostic {
  readonly failures: readonly WritePreflightDiagnosticFailure[];
  readonly rescue: WritePreflightRescueOutcome;
}
export interface WritePreflightDiagnostics {
  record(ctx: OperationContext, diagnostic: WritePreflightDiagnostic): void;
}
const rescueOutcomes: readonly string[] = ['not-attempted', 'unsupported', 'denied', 'deadline', 'failed', 'accepted'];

export function createWritePreflightDiagnostics(options: {
  logger?: Pick<Logger, 'info' | 'warn'>; now?: () => number; intervalMs?: number; cacheMax?: number;
} = {}): WritePreflightDiagnostics {
  const logger = options.logger ?? new Logger('write-preflight');
  const warn = createWarningGate(options.now ?? (() => performance.now()), options.intervalMs ?? 60_000, options.cacheMax ?? 128);
  return { record(ctx, diagnostic) {
    const failures = sanitizeWritePreflightFailures(diagnostic.failures);
    const rescue = rescueOutcomes.includes(diagnostic.rescue) ? diagnostic.rescue : 'not-attempted';
    const detail = `failures=${JSON.stringify(failures)} rescue=${rescue}`;
    const decision = warn(detail);
    const message = `Context Graph write preflight unavailable, answered 503: ${detail}`;
    if (decision.warn) return logger.warn(ctx, `${message} repeats=${decision.heldBack}`);
    return logger.info(ctx, message);
  } };
}

const diagnostics = createWritePreflightDiagnostics();
const answered = new WeakMap<ServerResponse, string>();
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** One safe event per actual response; observer failure must never affect HTTP. */
export function recordWritePreflightUnavailable(
  res: ServerResponse, failures: readonly WritePreflightDiagnosticFailure[], rescue: WritePreflightRescueOutcome,
  observer: WritePreflightDiagnostics = diagnostics,
): string {
  const previous = answered.get(res); if (previous) return previous;
  let ctx = createOperationContext('resolve');
  try {
    const previousId = res.getHeader?.('x-dkg-operation-id');
    if (typeof previousId === 'string' && uuid.test(previousId)) ctx = { ...ctx, operationId: previousId };
  } catch { /* Do not reflect arbitrary correlation input. */ }
  answered.set(res, ctx.operationId);
  try { void Promise.resolve(observer.record(ctx, { failures: sanitizeWritePreflightFailures(failures), rescue })).catch(() => {}); }
  catch { /* Diagnostics must not change access, response, reads or retries. */ }
  return ctx.operationId;
}
