import { StoreResponseTooLargeError } from '@origintrail-official/dkg-storage';
import { SYNC_BYTE_BUDGET_RESPONSE_BYTES, SYNC_REQUEST_SAFE_PAGE_SIZE } from '../../dkg-agent-constants.js';
import type { ExactAssetExportCache, ExactAssetExportLease } from './exact-asset-export-cache.js';
import type { SyncRow } from './snapshot-cache.js';
import { SyncRowSnapshotBudgetError } from './snapshot-budget.js';
import { serializedResponderRowByteLength } from './row-serialization.js';

export interface ExactPageReadResult {
  readonly rows: SyncRow[];
  /** The response owns this charge through serialization, compression and its final source fence. */
  readonly responseLease?: ExactAssetExportLease;
}

export interface ExactPageReadRequest {
  readonly offset: number;
  readonly limit: number;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}

export interface ExactPageStoreSource {
  readonly totalRows: number;
  readRows(offset: number, limit: number, maxResponseBytes: number, signal?: AbortSignal): Promise<SyncRow[]>;
  /** Only the store reader records keyset boundaries for a byte-truncated prefix. */
  rememberReturnedPrefix(offset: number, rows: readonly SyncRow[]): void;
}

export interface ExactPageExportScope {
  readonly contextGraphId: string;
  readonly assetUal: string;
  readonly graph: string;
  readonly expectedRows: number;
  readonly cache: ExactAssetExportCache;
}

interface ExactPageReaderOwner {
  read(request: ExactPageReadRequest, initialLease?: ExactAssetExportLease): Promise<ExactPageReadResult>;
}

/** One session chooses one row order, including overlapping first-page reads. */
export class ExactPageSessionReader {
  private reader?: Promise<ExactPageReaderOwner>;

  constructor(private readonly store: ExactPageStoreSource, private readonly exportScope?: ExactPageExportScope,
    private readonly requiresVerifiedExport = false) {}

  async read(request: ExactPageReadRequest): Promise<ExactPageReadResult> {
    request.signal?.throwIfAborted();
    if (!this.reader) {
      const selection = this.selectReader();
      this.reader = selection.then(selected => selected.reader);
      // A failed selection remains failed for every continuation. The first
      // caller also awaits selection, so observe this derived promise locally.
      void this.reader.catch(() => {});
      const selected = await selection;
      return selected.reader.read(request, selected.initialLease);
    }
    return (await this.reader).read(request);
  }

  private async selectReader(): Promise<{ reader: ExactPageReaderOwner; initialLease?: ExactAssetExportLease }> {
    if (this.exportScope) {
      // Selection is shared by concurrent responses. An individual caller's
      // abort must not cancel it; its physical acquisition settles before that
      // caller checks cancellation and releases its response-owned lease.
      const lease = await this.exportScope.cache.acquire(this.exportScope);
      if (lease) return { reader: new ExportExactPageReader(this.exportScope, lease.identity), initialLease: lease };
    }
    if (this.requiresVerifiedExport) throw exportUnavailable();
    return { reader: new StoreExactPageReader(this.store) };
  }
}

class ExportExactPageReader implements ExactPageReaderOwner {
  constructor(private readonly scope: ExactPageExportScope, private readonly identity: string) {}

  async read(request: ExactPageReadRequest, initialLease?: ExactAssetExportLease): Promise<ExactPageReadResult> {
    const lease = initialLease ?? await this.scope.cache.acquire({ ...this.scope,
      expectedIdentity: this.identity, signal: request.signal });
    if (!lease) throw exportUnavailable();
    try {
      request.signal?.throwIfAborted();
      const rows: SyncRow[] = [];
      let bytes = 0;
      const offset = Math.max(0, Math.floor(request.offset));
      const limit = Math.max(0, Math.floor(request.limit));
      for (const row of lease.rows.slice(offset, offset + limit)) {
        const next = serializedResponderRowByteLength(row) + (rows.length > 0 ? 1 : 0);
        if (bytes + next > request.maxBytes) {
          if (rows.length === 0) throw new SyncRowSnapshotBudgetError({
            key: 'exact-export-page', reason: 'snapshot_bytes', rows: 1,
            bytesEstimate: next, limit: request.maxBytes,
          });
          break;
        }
        rows.push(row); bytes += next;
      }
      return { rows, responseLease: lease };
    } catch (error) { lease.release(); throw error; }
  }
}

class StoreExactPageReader implements ExactPageReaderOwner {
  constructor(private readonly source: ExactPageStoreSource) {}

  async read(request: ExactPageReadRequest): Promise<ExactPageReadResult> {
    const rows: SyncRow[] = [];
    let bytes = 0;
    let storePageRows = SYNC_REQUEST_SAFE_PAGE_SIZE;
    const offset = Math.max(0, Math.floor(request.offset));
    const limit = Math.max(0, Math.floor(request.limit));
    while (rows.length < limit && offset + rows.length < this.source.totalRows) {
      request.signal?.throwIfAborted();
      const pageRows = Math.min(storePageRows, limit - rows.length);
      let chunk: SyncRow[];
      try {
        chunk = await this.source.readRows(offset + rows.length, pageRows,
          Math.min(request.maxBytes * 2, SYNC_BYTE_BUDGET_RESPONSE_BYTES * 2), request.signal);
      } catch (error) {
        if (!(error instanceof StoreResponseTooLargeError) || pageRows <= 1) throw error;
        storePageRows = Math.max(1, Math.floor(pageRows / 2));
        continue;
      }
      for (const row of chunk) {
        const next = serializedResponderRowByteLength(row) + (rows.length > 0 ? 1 : 0);
        if (rows.length > 0 && bytes + next > request.maxBytes) {
          this.source.rememberReturnedPrefix(offset, rows);
          return { rows };
        }
        if (next > request.maxBytes) throw new SyncRowSnapshotBudgetError({
          key: 'exact-data-page', reason: 'snapshot_bytes', rows: 1,
          bytesEstimate: next, limit: request.maxBytes,
        });
        rows.push(row); bytes += next;
      }
      if (bytes >= request.maxBytes) break;
    }
    this.source.rememberReturnedPrefix(offset, rows);
    return { rows };
  }
}

function exportUnavailable(): Error {
  return Object.assign(new Error(
    'Sync session exact asset export expired: export unavailable before page completion',
  ), { code: 'SYNC_EXACT_EXPORT_UNAVAILABLE' });
}
