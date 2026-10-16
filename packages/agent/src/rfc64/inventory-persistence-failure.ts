/** Provenance attached only where inventory SQL persistence or bounded CAS contention fails.
 * Keep the original error identity, code and cause for legacy observers and callers.
 */
const persistenceFailure = Symbol('inventory-persistence-failure');
type PersistenceFailure = Error & { readonly [persistenceFailure]: true };
export function inventoryPersistenceFailure<T extends Error>(error: T): T {
  Object.defineProperty(error, persistenceFailure, { value: true });
  return error;
}
export function isInventoryPersistenceFailure(error: unknown): error is PersistenceFailure {
  return error instanceof Error && (error as Partial<PersistenceFailure>)[persistenceFailure] === true;
}
