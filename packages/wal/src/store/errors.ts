export type WalObjectStoreErrorCode =
  | 'WAL_STORE_INVALID_OBJECT_ID'
  | 'WAL_STORE_INVALID_CONFIGURATION'
  | 'WAL_STORE_OBJECT_NOT_FOUND'
  | 'WAL_STORE_INVALID_READ_RANGE'
  | 'WAL_STORE_OBJECT_TOO_LARGE'
  | 'WAL_STORE_INVALID_OBJECT'
  | 'WAL_STORE_OBJECT_ID_MISMATCH'
  | 'WAL_STORE_PATH_UNSAFE'
  | 'WAL_STORE_CORRUPT'
  | 'WAL_STORE_IO'
  | 'WAL_STAGE_INVALID_RANGE'
  | 'WAL_STAGE_TOTAL_LENGTH_MISMATCH'
  | 'WAL_STAGE_RANGE_CONFLICT'
  | 'WAL_STAGE_PART_LIMIT'
  | 'WAL_STAGE_QUOTA_EXCEEDED'
  | 'WAL_STAGE_CONCURRENCY_LIMIT'
  | 'WAL_STAGE_INCOMPLETE'
  | 'WAL_STAGE_METADATA_INVALID'
  | 'WAL_STAGE_CANCELLED';

export class WalObjectStoreError extends Error {
  constructor(
    readonly code: WalObjectStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WalObjectStoreError';
  }
}

export function storeError(
  code: WalObjectStoreErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new WalObjectStoreError(code, message, cause === undefined ? undefined : { cause });
}
