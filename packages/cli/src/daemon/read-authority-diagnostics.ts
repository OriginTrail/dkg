import { Logger, type OperationContext } from '@origintrail-official/dkg-core';
import type {
  ContextGraphReadAuthoritySource,
  ContextGraphReadAuthorityDependency,
  RegisteredContextGraphAuthorityUnavailableReason,
} from '@origintrail-official/dkg-agent';

/** Where an unavailable read authority came from, as the agent attributes it. */
export interface ContextGraphReadAuthorityAttribution {
  readonly source: string;
  readonly reason: string;
  readonly dependency: string;
}

export interface ReadAuthorityDiagnosticsOptions {
  readonly logger?: Pick<Logger, 'info' | 'warn'>;
  /** Monotonic milliseconds; defaults to `performance.now()`. */
  readonly now?: () => number;
  /** How often one attribution may raise a warning. */
  readonly intervalMs?: number;
  /** How many attributions are remembered at once, least recently warned first out. */
  readonly cacheMax?: number;
}

export interface ReadAuthorityDiagnostics {
  /** Logs one line for a read-authority 503 under `ctx`'s operation id. */
  record(ctx: OperationContext, attribution: ContextGraphReadAuthorityAttribution): void;
}

/** Read-only fallback reasons in addition to the registered authority vocabulary. */
type ReadSpecificAuthorityUnavailableReason =
  | 'registered-authority-error'
  | 'remote-local-authority-unaccepted'
  | 'rfc64-private-read-roster-unavailable'
  | 'no-read-authority'
  | 'unexpected-authority-error'
  | 'pending-authoritative-metadata'
  | 'local-access-policy-unavailable'
  | 'peer-authority-unavailable'
  | 'local-agent-authority-unavailable'
  | 'legacy-participant-authority-unavailable';

const SAFE_READ_AUTHORITY_REASONS = new Set(Object.keys({
  'finalized-name-absence-unaccepted': true,
  'chain-name-binding-unavailable': true,
  'registered-authority-error': true,
  'authority-circuit-open': true,
  'local-chain-binding-unavailable': true,
  'local-existence-unavailable': true,
  'chain-access-policy-unavailable': true,
  'chain-access-policy-timeout': true,
  'chain-access-policy-unknown': true,
  'chain-participant-authority-unavailable': true,
  'chain-participant-authority-unsupported': true,
  'chain-participant-authority-invalid': true,
  'remote-local-authority-unaccepted': true,
  'rfc64-private-read-roster-unavailable': true,
  'no-read-authority': true,
  'unexpected-authority-error': true,
  'pending-authoritative-metadata': true,
  'local-access-policy-unavailable': true,
  'peer-authority-unavailable': true,
  'local-agent-authority-unavailable': true,
  'legacy-participant-authority-unavailable': true,
} as const satisfies Record<RegisteredContextGraphAuthorityUnavailableReason | ReadSpecificAuthorityUnavailableReason, true>));

const SAFE_READ_AUTHORITY_SOURCES = new Set(Object.keys({
  'system': true,
  'registered-chain': true,
  'rfc64-private': true,
  'rfc64-public': true,
  'legacy-local': true,
} as const satisfies Record<ContextGraphReadAuthoritySource, true>));

const SAFE_READ_AUTHORITY_DEPENDENCIES = new Set(Object.keys({
  'store': true,
  'chain': true,
  'local-state': true,
  'unknown': true,
} as const satisfies Record<ContextGraphReadAuthorityDependency, true>));

/** Whether an attribution warns now, and how many repeats it held back since its last warning. */
type WarningDecision = { readonly warn: true; readonly heldBack: number } | { readonly warn: false };

/**
 * One warning per key per interval, over a bounded key set that evicts the
 * least recently warned key first. A window that starts in the future (the
 * clock stepped back) has expired.
 */
function createWarningGate(
  now: () => number,
  intervalMs: number,
  cacheMax: number,
): (key: string) => WarningDecision {
  const windows = new Map<string, { warnedAt: number; heldBack: number }>();
  return (key) => {
    const at = now();
    const window = windows.get(key);
    if (window !== undefined) {
      const elapsed = at - window.warnedAt;
      if (elapsed >= 0 && elapsed < intervalMs) {
        window.heldBack += 1;
        return { warn: false };
      }
    } else if (windows.size >= cacheMax) {
      const oldest = windows.keys().next();
      if (!oldest.done) windows.delete(oldest.value);
    }
    windows.delete(key);
    windows.set(key, { warnedAt: at, heldBack: 0 });
    return { warn: true, heldBack: window?.heldBack ?? 0 };
  };
}

/**
 * Server-side attribution for read-authority 503s (#2834): the authority
 * source, its reason and the dependency that could not answer (store, chain,
 * local state or unknown). Every 503 gets exactly one line under its own
 * operation id, so the id a response carries can always be found. The first
 * 503 of an attribution in a window is a warning, which reports how many
 * repeats it held back since the previous one; repeats in between are info
 * lines. Only attribution tokens are logged, never graph ids, callers or raw
 * dependency errors.
 */
export function createReadAuthorityDiagnostics(
  options: ReadAuthorityDiagnosticsOptions = {},
): ReadAuthorityDiagnostics {
  const logger = options.logger ?? new Logger('read-authority');
  const warningDue = createWarningGate(
    options.now ?? (() => performance.now()),
    options.intervalMs ?? 60_000,
    options.cacheMax ?? 128,
  );
  return {
    record(ctx, attribution) {
      const detail = `source=${(SAFE_READ_AUTHORITY_SOURCES.has(attribution.source) ? attribution.source : 'unknown')}`
        + ` reason=${(SAFE_READ_AUTHORITY_REASONS.has(attribution.reason) ? attribution.reason : 'unknown')}`
        + ` dependency=${(SAFE_READ_AUTHORITY_DEPENDENCIES.has(attribution.dependency) ? attribution.dependency : 'unknown')}`;
      const decision = warningDue(detail);
      if (decision.warn) {
        logger.warn(
          ctx,
          `Context Graph read authority unavailable, answered 503: ${detail}`
            + (decision.heldBack > 0 ? ` (${decision.heldBack} more since the last warning)` : ''),
        );
      } else {
        logger.info(ctx, `Context Graph read authority unavailable, answered 503 (repeat): ${detail}`);
      }
    },
  };
}
