/** Closed failures shared by private-access producers and API consumers. */
export const ACCESS_ERROR_CODES = [
  'ACCESS_INVALID_REQUEST', 'ACCESS_RESPONSE_TOO_LARGE', 'ACCESS_BUSY',
  'ACCESS_INTEGRITY_FAILED', 'ACCESS_TIMEOUT', 'ACCESS_UNAVAILABLE',
  'ACCESS_REQUEST_OWNED_REQUIRED',
] as const;

export type AccessErrorCode = typeof ACCESS_ERROR_CODES[number];
export type AccessError = Error & { code: AccessErrorCode };

export function accessError(code: AccessErrorCode, message: string, options?: ErrorOptions): AccessError {
  return Object.assign(new Error(message, options), { code });
}

/** Recognizes only declared failures; unknown exceptions keep the sanitized fallback. */
export function isAccessError(error: unknown): error is Pick<AccessError, 'code'> {
  if (error === null || typeof error !== 'object') return false;
  const code = Reflect.get(error, 'code');
  return typeof code === 'string' && ACCESS_ERROR_CODES.some(known => code === known);
}
