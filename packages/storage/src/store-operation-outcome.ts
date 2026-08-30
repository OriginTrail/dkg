/** Stable protocol tag for failures that declare one store operation's outcome. */
export const STORE_OPERATION_OUTCOME_TAG = 'dkg.store-operation-outcome.v1' as const;

/** Public TripleStore operations that may be classified by the outcome protocol. */
export const STORE_OPERATIONS = [
  'insert',
  'delete',
  'deleteByPattern',
  'query',
  'construct',
  'hasGraph',
  'createGraph',
  'dropGraph',
  'replaceGraph',
  'replaceGraphAndSubject',
  'replaceSubject',
  'listGraphs',
  'listGraphsByPrefix',
  'deleteBySubjectPrefix',
  'update',
  'countQuads',
  'flush',
  'close',
] as const;

export type StoreOperation = typeof STORE_OPERATIONS[number];
export type StoreOperationOutcome = 'not_started' | 'indeterminate';

const STORE_OPERATION_SET: ReadonlySet<string> = new Set(STORE_OPERATIONS);
const READ_ONLY_STORE_OPERATION_SET: ReadonlySet<StoreOperation> = new Set([
  'query',
  'construct',
  'hasGraph',
  'listGraphs',
  'listGraphsByPrefix',
  'countQuads',
]);

/** Runtime validator for public operation metadata crossing package boundaries. */
export function isStoreOperation(value: unknown): value is StoreOperation {
  return typeof value === 'string' && STORE_OPERATION_SET.has(value);
}

/** Canonical storage-owned classification of operations that cannot mutate state. */
export function isReadOnlyStoreOperation(
  operation: StoreOperation,
): boolean {
  return READ_ONLY_STORE_OPERATION_SET.has(operation);
}

export interface StoreOperationOutcomeTagged {
  readonly storeOperationOutcomeTag: typeof STORE_OPERATION_OUTCOME_TAG;
  readonly storeOperation?: StoreOperation;
  readonly outcome: StoreOperationOutcome;
}

/**
 * Structural contract for failures whose effect on one canonical store
 * operation is known. The operation binding is deliberately separate from a
 * scheduler source label: a nested query can be rejected before dispatch even
 * after its enclosing replace has committed.
 */
export interface StoreOperationOutcomeErrorLike extends StoreOperationOutcomeTagged {
  readonly storeOperation: StoreOperation;
}

export function hasStoreOperationOutcome(
  error: unknown,
  storeOperation: StoreOperation,
  outcome: StoreOperationOutcome,
): error is StoreOperationOutcomeErrorLike {
  if (!error || typeof error !== 'object') return false;
  const shaped = error as Partial<StoreOperationOutcomeErrorLike>;
  return shaped.storeOperationOutcomeTag === STORE_OPERATION_OUTCOME_TAG
    && shaped.storeOperation === storeOperation
    && shaped.outcome === outcome;
}
