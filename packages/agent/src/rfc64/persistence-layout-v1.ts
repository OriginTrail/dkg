import { resolve } from 'node:path';

export const RFC64_PERSISTENCE_ROOT_RELATIVE_PATH_V1 = 'rfc64-sync' as const;
export const RFC64_INVENTORY_DATABASE_FILENAME_V1 = 'inventory-v1.sqlite3' as const;

/** Canonical boundary shared by every resource protected by the RFC-64 lease. */
export function resolveRfc64PersistenceRootV1(dataDir: string): string {
  return resolve(dataDir, RFC64_PERSISTENCE_ROOT_RELATIVE_PATH_V1);
}

export function resolveRfc64InventoryDatabasePathV1(dataDir: string): string {
  return resolve(
    resolveRfc64PersistenceRootV1(dataDir),
    RFC64_INVENTORY_DATABASE_FILENAME_V1,
  );
}
