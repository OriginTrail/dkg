export type WalControlStoreErrorCode =
  | 'WAL_CONTROL_INVALID_CONFIGURATION'
  | 'WAL_CONTROL_UNSUPPORTED_SCHEMA'
  | 'WAL_CONTROL_PATH_UNSAFE'
  | 'WAL_CONTROL_IO'
  | 'WAL_CONTROL_CORRUPT'
  | 'WAL_CONTROL_BLOCKED'
  | 'WAL_CONTROL_NOT_FOUND'
  | 'WAL_CONTROL_IDEMPOTENCY_CONFLICT'
  | 'WAL_CONTROL_LANE_CONFLICT'
  | 'WAL_CONTROL_STALE_BASE'
  | 'WAL_CONTROL_LIMIT_EXCEEDED'
  | 'WAL_CONTROL_LEASE_CONFLICT'
  | 'WAL_CONTROL_NONCE_REUSE'
  | 'WAL_CONTROL_ROLLBACK_REJECTED';

export class WalControlStoreError extends Error {
  constructor(
    readonly code: WalControlStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WalControlStoreError';
  }
}

export function controlError(
  code: WalControlStoreErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new WalControlStoreError(code, message, cause === undefined ? undefined : { cause });
}
