import { resolve } from 'node:path';

export const RFC64_PERSISTENCE_ROOT_RELATIVE_PATH_V1 = 'rfc64-sync' as const;
export const RFC64_INVENTORY_DATABASE_FILENAME_V1 = 'inventory-v1.sqlite3' as const;
export const RFC64_CONTROL_OBJECT_STORE_DIRECTORY_NAME_V1 = 'control-objects-v1' as const;
export const RFC64_KA_BUNDLE_STORE_DIRECTORY_NAME_V1 = 'ka-bundles-v1' as const;
export const RFC64_CONTROL_OBJECT_STORE_RELATIVE_PATH =
  `${RFC64_PERSISTENCE_ROOT_RELATIVE_PATH_V1}/${RFC64_CONTROL_OBJECT_STORE_DIRECTORY_NAME_V1}` as const;
export const RFC64_KA_BUNDLE_STORE_RELATIVE_PATH =
  `${RFC64_PERSISTENCE_ROOT_RELATIVE_PATH_V1}/${RFC64_KA_BUNDLE_STORE_DIRECTORY_NAME_V1}` as const;

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

export function resolveRfc64ControlObjectStorePathV1(rfc64RootPath: string): string {
  return resolve(rfc64RootPath, RFC64_CONTROL_OBJECT_STORE_DIRECTORY_NAME_V1);
}

export function resolveRfc64KaBundleStorePathV1(rfc64RootPath: string): string {
  return resolve(rfc64RootPath, RFC64_KA_BUNDLE_STORE_DIRECTORY_NAME_V1);
}
