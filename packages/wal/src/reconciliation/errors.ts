export const RECONCILIATION_ERROR_CODES = [
  'INVALID_BYTES',
  'INVALID_WAL_OBJECT_ID',
  'DUPLICATE_WAL_OBJECT_ID',
  'INVALID_CONFIGURATION',
  'NON_CONTIGUOUS_SYMBOL',
  'MALFORMED_SYMBOL',
  'NON_CANONICAL_SYMBOL',
  'INTEGER_OUT_OF_RANGE',
  'COUNT_OVERFLOW',
  'TRAILING_BYTES',
  'DUPLICATE_DECODED_ID',
  'DECODED_DIFFERENCE_LIMIT',
  'SYMBOL_LIMIT',
  'OPERATION_LIMIT',
  'MEMORY_LIMIT',
  'ELAPSED_TIME_LIMIT',
  'INCOMPLETE_DECODE',
  'COUNT_MISMATCH',
  'ROOT_MISMATCH',
  'FALLBACK_HEAD_MISMATCH',
  'FALLBACK_OFFSET_MISMATCH',
  'FALLBACK_DONE_MISMATCH',
  'FALLBACK_ORDER_MISMATCH'
] as const;

export type ReconciliationErrorCode = (typeof RECONCILIATION_ERROR_CODES)[number];

export class ReconciliationError extends Error {
  constructor(
    readonly code: ReconciliationErrorCode,
    message: string,
    readonly context: Readonly<Record<string, string | number | bigint | boolean>> = {}
  ) {
    super(message);
    this.name = 'ReconciliationError';
  }
}

export function isReconciliationError(error: unknown, code?: ReconciliationErrorCode): error is ReconciliationError {
  return error instanceof ReconciliationError && (code === undefined || error.code === code);
}
