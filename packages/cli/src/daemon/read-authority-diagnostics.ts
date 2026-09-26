import { Logger, type OperationContext } from '@origintrail-official/dkg-core';

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

const ATTRIBUTION_TOKEN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** An attribution token as the agent emits them; anything else logs as `unknown`. */
function attributionToken(value: string): string {
  return ATTRIBUTION_TOKEN.test(value) ? value : 'unknown';
}

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
      const detail = `source=${attributionToken(attribution.source)}`
        + ` reason=${attributionToken(attribution.reason)}`
        + ` dependency=${attributionToken(attribution.dependency)}`;
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
