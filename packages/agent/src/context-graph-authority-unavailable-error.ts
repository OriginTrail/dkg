export const CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE =
  'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE' as const;

export const CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_ERROR_NAME =
  'ContextGraphAuthorityUnavailableError' as const;

export const CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_REASONS = [
  'chain-name-binding-unavailable',
  'local-chain-binding-unavailable',
  'local-existence-unavailable',
  'chain-access-policy-unavailable',
  'chain-access-policy-timeout',
  'chain-participant-authority-unavailable',
  'rfc64-private-read-roster-unavailable',
] as const;

export type ContextGraphAuthorityUnavailableReason =
  typeof CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_REASONS[number];

/**
 * The narrow, serialization-safe disposition consumed across package and
 * bundle boundaries. Callers must not infer Error fields from this marker.
 */
export interface ContextGraphAuthorityUnavailableMarker {
  readonly code: typeof CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE;
}

export class ContextGraphAuthorityUnavailableError extends Error {
  readonly code = CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE;
  readonly reason: ContextGraphAuthorityUnavailableReason;
  readonly detail?: string;

  constructor(
    message: string,
    options: { reason: ContextGraphAuthorityUnavailableReason; detail?: string },
  ) {
    super(message);
    this.name = CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_ERROR_NAME;
    this.reason = options.reason;
    if (options.detail !== undefined) this.detail = options.detail;
  }
}

/** Structural so retry disposition survives serialization and package copies. */
export function isContextGraphAuthorityUnavailableMarker(
  value: unknown,
): value is ContextGraphAuthorityUnavailableMarker {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return false;
  }
  try {
    return Reflect.get(value, 'code') === CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE;
  } catch {
    return false;
  }
}
