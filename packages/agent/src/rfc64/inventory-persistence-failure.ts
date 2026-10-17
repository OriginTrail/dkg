/** Provenance attached only where inventory SQL persistence or bounded CAS contention fails.
 * Keep the original error identity, code and cause for legacy observers and callers.
 */
const persistenceFailure = Symbol('inventory-persistence-failure');
type PersistenceFailure = Error & { readonly [persistenceFailure]: true };
export function inventoryPersistenceFailure<T extends Error>(error: T): T {
  if (hasPermanentNativeSqliteFailure(error)) return error;
  Object.defineProperty(error, persistenceFailure, { value: true });
  return error;
}
export function isInventoryPersistenceFailure(error: unknown): error is PersistenceFailure {
  return error instanceof Error && (error as Partial<PersistenceFailure>)[persistenceFailure] === true;
}

/** Called by native persistence adapters, never by promotion or user-message classifiers. */
export function inheritInventoryPersistenceFailure<T extends Error>(error: T, cause: unknown): T {
  if (isInventoryPersistenceFailure(cause) || isNativeStorageUnavailable(cause)) return inventoryPersistenceFailure(error);
  return error;
}
function isNativeStorageUnavailable(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  const native = cause as Error & { code?: unknown; errcode?: unknown; syscall?: unknown };
  // SQLite extended result codes retain the primary result in their low byte.
  if (native.code === 'ERR_SQLITE_ERROR' && typeof native.errcode === 'number') {
    return [5, 6, 7, 10, 13, 14].includes(native.errcode & 255);
  }
  return typeof native.syscall === 'string' && typeof native.code === 'string'
    && ['EIO', 'EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE', 'ENOSPC'].includes(native.code);
}

/** Native integrity/schema failures require inspection even when wrapped by SQL bookkeeping. */
function hasPermanentNativeSqliteFailure(error: unknown): boolean {
  const visited = new Set<Error>();
  for (let current = error; current instanceof Error && !visited.has(current); current = current.cause) {
    visited.add(current);
    const native = current as Error & { code?: unknown; errcode?: unknown };
    if (native.code === 'ERR_SQLITE_ERROR' && typeof native.errcode === 'number'
      && [1, 2, 11, 17, 18, 19, 20, 21, 25, 26].includes(native.errcode & 255)) return true;
  }
  return false;
}
