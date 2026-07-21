import type {
  SnapshotPageIndexRecord,
  SnapshotPageIndexStore,
} from '@origintrail-official/dkg-publisher';
import type { DashboardDB } from '@origintrail-official/dkg-node-ui';

interface SnapshotPageIndexRow {
  snapshot_digest: string;
  format_version: number;
  stride: number;
  snapshot_file_size: number;
  modification_fingerprint: string;
  offset_count: number;
  offsets: Buffer;
  checksum: string;
}

export class SqliteSnapshotPageIndexStore implements SnapshotPageIndexStore {
  constructor(private readonly dashboard: DashboardDB) {}

  async get(snapshotDigest: string): Promise<SnapshotPageIndexRecord | null> {
    const row = this.dashboard.db.prepare(`
      SELECT
        snapshot_digest,
        format_version,
        stride,
        snapshot_file_size,
        modification_fingerprint,
        offset_count,
        offsets,
        checksum
      FROM snapshot_page_indexes
      WHERE snapshot_digest = ?
    `).get(snapshotDigest) as SnapshotPageIndexRow | undefined;
    if (!row) return null;
    return {
      snapshotDigest: row.snapshot_digest,
      formatVersion: row.format_version,
      stride: row.stride,
      snapshotFileSize: row.snapshot_file_size,
      modificationFingerprint: row.modification_fingerprint,
      offsetCount: row.offset_count,
      offsetsBlob: new Uint8Array(row.offsets),
      checksum: row.checksum,
    };
  }

  async upsert(record: SnapshotPageIndexRecord): Promise<void> {
    this.dashboard.db.prepare(`
      INSERT INTO snapshot_page_indexes (
        snapshot_digest,
        format_version,
        stride,
        snapshot_file_size,
        modification_fingerprint,
        offset_count,
        offsets,
        checksum
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(snapshot_digest) DO UPDATE SET
        format_version = excluded.format_version,
        stride = excluded.stride,
        snapshot_file_size = excluded.snapshot_file_size,
        modification_fingerprint = excluded.modification_fingerprint,
        offset_count = excluded.offset_count,
        offsets = excluded.offsets,
        checksum = excluded.checksum
    `).run(
      record.snapshotDigest,
      record.formatVersion,
      record.stride,
      record.snapshotFileSize,
      record.modificationFingerprint,
      record.offsetCount,
      Buffer.from(record.offsetsBlob),
      record.checksum,
    );
  }
}
