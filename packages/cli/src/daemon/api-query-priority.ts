export type ApiQueryPriority = 'normal' | 'background';

export interface ApiQueryPriorityLogger {
  info(message: string): void;
  warn(message: string): void;
}

let effectiveApiQueryPriority: ApiQueryPriority = 'background';

/** Resolve the reversible API-read lane, defaulting fail-safe to background. */
export function resolveApiQueryPriority(raw: string | undefined): ApiQueryPriority {
  return raw?.trim().toLowerCase() === 'normal' ? 'normal' : 'background';
}

/**
 * Resolve and log the API-query lane once during daemon startup.
 *
 * Empty/unset values intentionally select the protective background lane.
 * Non-empty typos also fail safe, but are warned so an operator cannot believe
 * an incident override took effect when it did not.
 */
export function configureApiQueryPriority(
  raw: string | undefined,
  logger: ApiQueryPriorityLogger,
): ApiQueryPriority {
  const normalized = raw?.trim().toLowerCase();
  if (normalized && normalized !== 'normal' && normalized !== 'background') {
    const printable = JSON.stringify(raw?.trim().slice(0, 64));
    logger.warn(
      `Invalid DKG_API_QUERY_PRIORITY=${printable}; expected "background" or "normal". ` +
      'Falling back to "background".',
    );
  }

  effectiveApiQueryPriority = resolveApiQueryPriority(raw);
  logger.info(
    `API query store priority: ${effectiveApiQueryPriority} ` +
    '(DKG_API_QUERY_PRIORITY; effective until daemon restart)',
  );
  return effectiveApiQueryPriority;
}

export function getApiQueryPriority(): ApiQueryPriority {
  return effectiveApiQueryPriority;
}
