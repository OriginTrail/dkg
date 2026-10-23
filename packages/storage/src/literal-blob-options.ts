export type LiteralBlobPersistence = 'files' | 'sqlite-wal';

export interface SharedMemoryLiteralBlobStoreOptions {
  /** Directory of immutable serialized RDF terms; legacy files are named by SHA-256. */
  blobDir: string;
  /** Externalize SWM literal terms strictly larger than this UTF-8 byte size. */
  thresholdBytes: number;
  /** Physical layout. Defaults to legacy files; sqlite-wal groups durable commits. */
  persistence?: LiteralBlobPersistence;
}

export interface LargeLiteralStorageConfig {
  /** Defaults to true when present. */
  enabled?: boolean;
  /** Externalize literal object terms larger than this UTF-8 byte size. */
  thresholdBytes?: number;
  /** Defaults to `<dirname(options.path)>/literal-blobs` when a persistent path is available. */
  directory?: string;
  /** Defaults to legacy files; sqlite-wal enables durable group commit. */
  persistence?: LiteralBlobPersistence;
}

/** Pure validation shared by direct construction and the factory's preallocation boundary. */
export function assertLiteralBlobStoreOptions(options: SharedMemoryLiteralBlobStoreOptions): void {
  if (typeof options.blobDir !== 'string' || !options.blobDir.trim()) {
    throw new Error('SharedMemoryLiteralBlobStore requires options.blobDir');
  }
  if (!Number.isSafeInteger(options.thresholdBytes) || options.thresholdBytes < 0) {
    throw new Error('SharedMemoryLiteralBlobStore requires a non-negative integer thresholdBytes');
  }
  if (options.persistence !== undefined && options.persistence !== 'files' && options.persistence !== 'sqlite-wal') {
    throw new Error('Unsupported literal blob persistence layout');
  }
}
