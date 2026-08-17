/**
 * GH#2270 — the ONE owner of retry-tuning validation and defaults.
 *
 * Both the publisher constructor and the daemon config boundary
 * (`resolvePublisherRetryTuning` in the CLI) call this resolver, so the
 * accepted ranges, the cross-field backoff invariant, and the defaults cannot
 * drift between standalone library use and daemon boot. The CLI passes a
 * config-key label so operator-facing errors name the `config.json` path.
 *
 * Defaults live HERE (exported) rather than as private constructor statics:
 * a boundary that cannot see the defaults cannot validate a half-configured
 * pair against them — the config layer would either duplicate the values
 * (drift) or invent stricter rules (the shape review round 1 flagged).
 */

export const DEFAULT_RETRY_BACKOFF_BASE_MS = 5_000;
export const DEFAULT_RETRY_BACKOFF_MAX_MS = 60_000;
export const DEFAULT_RETRY_JITTER_RATIO = 0.2;

export interface AsyncLiftRetryTuning {
  /** Master switch for the AUTOMATIC lane only; manual `retry()` and re-submit reaccept are unaffected. */
  readonly autoRetryEnabled?: boolean;
  /** Symmetric multiplicative jitter ratio, `0 ≤ r < 1`, applied before the cap. */
  readonly retryJitterRatio?: number;
  readonly retryBackoffBaseMs?: number;
  readonly retryBackoffMaxMs?: number;
}

export interface AsyncLiftRetryTuningInput {
  readonly autoRetryEnabled?: unknown;
  readonly retryJitterRatio?: unknown;
  readonly retryBackoffBaseMs?: unknown;
  readonly retryBackoffMaxMs?: unknown;
}

function requireOptionalPositiveMs(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `${field} must be a positive safe integer number of milliseconds (received ${JSON.stringify(value)})`,
    );
  }
  return value;
}

/**
 * Validate a partial retry-tuning object. Unset knobs stay `undefined` so the
 * publisher keeps owning the effective defaults; the cross-field invariant is
 * checked against the EFFECTIVE values (explicit or default), so a base-only
 * or max-only configuration is legal exactly when the pair it induces is.
 */
export function resolveAsyncLiftRetryTuning(
  input: AsyncLiftRetryTuningInput | null | undefined,
  label = 'retry tuning',
): AsyncLiftRetryTuning {
  const autoRetryEnabled = input?.autoRetryEnabled;
  if (autoRetryEnabled !== undefined && typeof autoRetryEnabled !== 'boolean') {
    throw new Error(
      `${label}.autoRetryEnabled must be a boolean (received ${JSON.stringify(autoRetryEnabled)})`,
    );
  }
  const retryJitterRatio = input?.retryJitterRatio;
  if (retryJitterRatio !== undefined
    && (typeof retryJitterRatio !== 'number'
      || !Number.isFinite(retryJitterRatio)
      || retryJitterRatio < 0
      || retryJitterRatio >= 1)) {
    throw new Error(
      `${label}.retryJitterRatio must be a number at least 0 and below 1 ` +
      `(received ${JSON.stringify(retryJitterRatio)})`,
    );
  }
  const retryBackoffBaseMs = requireOptionalPositiveMs(
    input?.retryBackoffBaseMs, `${label}.retryBackoffBaseMs`,
  );
  const retryBackoffMaxMs = requireOptionalPositiveMs(
    input?.retryBackoffMaxMs, `${label}.retryBackoffMaxMs`,
  );
  const effectiveBase = retryBackoffBaseMs ?? DEFAULT_RETRY_BACKOFF_BASE_MS;
  const effectiveMax = retryBackoffMaxMs ?? DEFAULT_RETRY_BACKOFF_MAX_MS;
  if (effectiveMax < effectiveBase) {
    throw new Error(
      `${label}.retryBackoffMaxMs (${effectiveMax}${retryBackoffMaxMs === undefined ? ', the default' : ''}) ` +
      `must be at least ${label}.retryBackoffBaseMs (${effectiveBase}` +
      `${retryBackoffBaseMs === undefined ? ', the default' : ''})`,
    );
  }
  return {
    ...(autoRetryEnabled !== undefined ? { autoRetryEnabled } : {}),
    ...(retryJitterRatio !== undefined ? { retryJitterRatio } : {}),
    ...(retryBackoffBaseMs !== undefined ? { retryBackoffBaseMs } : {}),
    ...(retryBackoffMaxMs !== undefined ? { retryBackoffMaxMs } : {}),
  };
}
