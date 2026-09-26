import {
  Logger,
  createBoundedDenialLogger,
  type OperationContext,
} from '@origintrail-official/dkg-core';

/** Where an unavailable read authority came from, as the agent attributes it. */
export interface ContextGraphReadAuthorityAttribution {
  readonly source?: unknown;
  readonly reason?: unknown;
  readonly dependency?: unknown;
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
function attributionToken(value: unknown): string {
  return typeof value === 'string' && ATTRIBUTION_TOKEN.test(value) ? value : 'unknown';
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
  let current: OperationContext | undefined;
  const warnOncePerWindow = createBoundedDenialLogger({
    log: (message) => logger.warn(current!, message),
    now: options.now ?? (() => performance.now()),
    intervalMs: options.intervalMs ?? 60_000,
    cacheMax: options.cacheMax ?? 128,
  });
  return {
    record(ctx, attribution) {
      const detail = `source=${attributionToken(attribution.source)}`
        + ` reason=${attributionToken(attribution.reason)}`
        + ` dependency=${attributionToken(attribution.dependency)}`;
      let warned = false;
      current = ctx;
      try {
        warnOncePerWindow(detail, () => {
          warned = true;
          return `Context Graph read authority unavailable, answered 503: ${detail}`;
        });
      } finally {
        current = undefined;
      }
      if (!warned) {
        logger.info(ctx, `Context Graph read authority unavailable, answered 503 (repeat): ${detail}`);
      }
    },
  };
}
