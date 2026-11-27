import { inheritInventoryPersistenceFailure } from '../inventory-persistence-failure.js';

export type InventoryV1OpenErrorCode =
  | 'sqlite-unavailable'
  | 'foreign-database'
  | 'newer-schema'
  | 'ambiguous-database'
  | 'unsafe-path'
  | 'pragma-mismatch'
  | 'database-busy'
  | 'durability-unavailable'
  | 'database-closed'
  | 'database-io';

export class InventoryV1OpenError extends Error {
  constructor(
    readonly code: InventoryV1OpenErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'InventoryV1OpenError';
    if (code === 'database-io' || code === 'database-busy' || code === 'database-closed') {
      inheritInventoryPersistenceFailure(this, options.cause);
    }
  }
}

