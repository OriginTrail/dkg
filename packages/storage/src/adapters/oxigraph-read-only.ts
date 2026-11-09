/**
 * A read-only open of a file-backed Oxigraph store (`oxigraph-persistent`, and
 * `oxigraph-worker` with a persistence path).
 *
 * These stores keep all data in memory and write it back to the persistence
 * file as one snapshot: after each write, on `flush()` and on `close()`. A
 * process that only reads a store another process owns, such as the CLI's
 * offline publisher reads, must never write that snapshot. What it loaded can
 * be older than the file by the time it closes, and writing it back would
 * replace what the owner wrote since. A read-only open loads the file and never
 * writes it.
 */
export interface OxigraphStoreOptions {
  /**
   * Load the persistence file and never write it: a write that would change
   * the data rejects with {@link OxigraphStoreReadOnlyError}, `flush()` and
   * `close()` write nothing, and a file that fails to parse stays in place.
   */
  readOnly?: boolean;
}

export const OXIGRAPH_STORE_READ_ONLY_CODE = 'DKG_STORE_READ_ONLY';

/** A write to a store opened with `readOnly`. The data and the file are unchanged. */
export class OxigraphStoreReadOnlyError extends Error {
  readonly code = OXIGRAPH_STORE_READ_ONLY_CODE;

  constructor(persistPath: string | undefined) {
    super(`OxigraphStore: ${persistPath ?? 'the store'} is open read-only and accepts no writes`);
    this.name = 'OxigraphStoreReadOnlyError';
  }
}
