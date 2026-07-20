export const WAL_PRIVATE_PAYLOAD_ERROR_CODES = Object.freeze([
  'WAL_PRIVATE_INVALID',
  'WAL_PRIVATE_AUTH_FAILED',
  'WAL_PRIVATE_NONCE_REUSE',
  'WAL_PRIVATE_DOWNGRADE',
  'WAL_PRIVATE_DENIED',
] as const);

export type WalPrivatePayloadErrorCode = (typeof WAL_PRIVATE_PAYLOAD_ERROR_CODES)[number];

export class WalPrivatePayloadError extends Error {
  constructor(
    readonly code: WalPrivatePayloadErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WalPrivatePayloadError';
  }
}

export function privatePayloadError(
  code: WalPrivatePayloadErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new WalPrivatePayloadError(code, message, cause === undefined ? undefined : { cause });
}
