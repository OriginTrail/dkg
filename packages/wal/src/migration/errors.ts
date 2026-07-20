export type WalMigrationErrorCode =
  | 'WAL_MIGRATION_INVALID'
  | 'WAL_MIGRATION_DUPLICATE_STATE'
  | 'WAL_MIGRATION_MIXED_CONTEXT'
  | 'WAL_MIGRATION_PROVENANCE'
  | 'WAL_MIGRATION_PRIVATE_ENCODING'
  | 'WAL_MIGRATION_LEGACY_BINDING'
  | 'WAL_MIGRATION_UNAUTHORIZED'
  | 'WAL_MIGRATION_ABORTED'
  | 'WAL_MIGRATION_INCOMPLETE_TARGET'
  | 'WAL_MIGRATION_NETWORK_ON_LOCAL_REBUILD'
  | 'WAL_MIGRATION_JOURNAL_CONFLICT'
  | 'WAL_MIGRATION_AUTHORITY_CHANGED'
  | 'WAL_MIGRATION_BARRIER_CONFLICT'
  | 'WAL_MIGRATION_SHADOW_GAP';

export class WalMigrationError extends Error {
  constructor(
    readonly code: WalMigrationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WalMigrationError';
  }
}

export function migrationError(
  code: WalMigrationErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new WalMigrationError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}
