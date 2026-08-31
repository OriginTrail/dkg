export type Rfc64AuthorCommitCasResultV1 = 'committed' | 'conflict';

export interface Rfc64AuthorCommitCasExecutionV1 {
  /** Dispatch the one backend-transactional semantic update. */
  readonly executeUpdate: () => void | Promise<void>;
  /** Read the private receipt after the update request has settled. */
  readonly readReceipt: () => unknown | Promise<unknown>;
  /** Best-effort removal of receipt and staging graphs. */
  readonly cleanup: () => void | Promise<void>;
  /** Adapter-specific bookkeeping that is valid only for a committed CAS. */
  readonly onCommitted?: () => void | Promise<void>;
}

/**
 * Execute the receipt-bearing RFC-64 CAS protocol identically on every backend.
 *
 * Cleanup never replaces the semantic update or receipt error. A false receipt
 * is the only clean conflict; missing or malformed receipts remain
 * indeterminate failures because the update may already have committed.
 */
export async function executeRfc64AuthorCommitCasV1(
  execution: Rfc64AuthorCommitCasExecutionV1,
): Promise<Rfc64AuthorCommitCasResultV1> {
  try {
    await execution.executeUpdate();
  } catch (error) {
    await bestEffortRfc64Cleanup(execution.cleanup);
    throw error;
  }

  let committed: boolean;
  try {
    committed = normalizeRfc64AuthorCommitReceipt(await execution.readReceipt());
  } finally {
    await bestEffortRfc64Cleanup(execution.cleanup);
  }

  if (committed) await execution.onCommitted?.();
  return committed ? 'committed' : 'conflict';
}

function normalizeRfc64AuthorCommitReceipt(receipt: unknown): boolean {
  if (typeof receipt === 'boolean') return receipt;
  if (
    receipt !== null
    && typeof receipt === 'object'
    && (receipt as { type?: unknown }).type === 'boolean'
    && typeof (receipt as { value?: unknown }).value === 'boolean'
  ) {
    return (receipt as { value: boolean }).value;
  }
  throw new Error('RFC-64 author commit receipt query returned a non-boolean result');
}

async function bestEffortRfc64Cleanup(cleanup: () => void | Promise<void>): Promise<void> {
  try {
    await cleanup();
  } catch {
    // Receipt/staging cleanup is auxiliary. Preserve the semantic outcome or
    // the original indeterminate transport failure.
  }
}
