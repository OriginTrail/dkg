export const CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE =
  'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE' as const;

export const CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_ERROR_NAME =
  'ContextGraphAuthorityUnavailableError' as const;

export class ContextGraphAuthorityUnavailableError extends Error {
  readonly code = CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE;
  readonly reason: string;
  readonly detail?: string;

  constructor(message: string, options: { reason: string; detail?: string }) {
    super(message);
    this.name = CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_ERROR_NAME;
    this.reason = options.reason;
    if (options.detail !== undefined) this.detail = options.detail;
  }
}

/** Structural so errors retain their identity across package/bundle boundaries. */
export function isContextGraphAuthorityUnavailableError(
  value: unknown,
): value is ContextGraphAuthorityUnavailableError {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return false;
  }
  try {
    return Reflect.get(value, 'code') === CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE;
  } catch {
    return false;
  }
}
