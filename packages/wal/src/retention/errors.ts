export type WalRetentionErrorCode =
  | 'WAL_RETENTION_INVALID'
  | 'WAL_RETENTION_DELETE_CAUSAL'
  | 'WAL_RETENTION_EXPIRY_EVIDENCE'
  | 'WAL_RETENTION_UNAUTHORIZED'
  | 'WAL_RETENTION_SNAPSHOT_BINDING'
  | 'WAL_RETENTION_SNAPSHOT_CLOSURE'
  | 'WAL_RETENTION_SNAPSHOT_STATE'
  | 'WAL_RETENTION_BASELINE_REQUIRED'
  | 'WAL_RETENTION_CUSTODY_INVALID'
  | 'WAL_RETENTION_CUSTODY_INSUFFICIENT'
  | 'WAL_RETENTION_VECTOR_REQUIRED'
  | 'WAL_RETENTION_GRACE_ACTIVE'
  | 'WAL_RETENTION_GC_NOT_AUTHORIZED';

export class WalRetentionError extends Error {
  constructor(
    readonly code: WalRetentionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WalRetentionError';
  }
}

export function retentionError(
  code: WalRetentionErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new WalRetentionError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}
