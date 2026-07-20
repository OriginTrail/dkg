export const WAL_AUTHORITY_ERROR_CODES = Object.freeze([
  'WAL_AUTHORITY_INVALID',
  'WAL_AUTHORITY_UNAUTHORIZED',
  'WAL_AUTHORITY_STALE',
  'WAL_AUTHORITY_EXPIRED',
  'WAL_AUTHORITY_ROLLBACK',
  'WAL_AUTHORITY_FORK',
  'WAL_AUTHORITY_WRONG_VIEW',
  'WAL_AUTHORITY_WRONG_POLICY',
  'WAL_AUTHORITY_LIMIT_EXCEEDED',
  'WAL_AUTHORITY_BLOCKED',
  'WAL_AUTHORITY_IO',
] as const);

export type WalAuthorityErrorCode = (typeof WAL_AUTHORITY_ERROR_CODES)[number];

export class WalAuthorityError extends Error {
  constructor(
    readonly code: WalAuthorityErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WalAuthorityError';
  }
}

export function authorityError(code: WalAuthorityErrorCode, message: string, cause?: unknown): never {
  throw new WalAuthorityError(code, message, cause === undefined ? undefined : { cause });
}
