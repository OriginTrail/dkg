import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DashboardDB, SCHEMA_VERSION } from '@origintrail-official/dkg-node-ui';
import type { SnapshotPageIndexRecord } from '@origintrail-official/dkg-publisher';
import { SqliteSnapshotPageIndexStore } from '../src/daemon/snapshot-page-index-store.js';
import { createPublicSnapshotStore } from '../src/publisher-runner.js';

const DIGEST = `sha256:${'c'.repeat(64)}`;

describe('SqliteSnapshotPageIndexStore', () => {
  let directory: string | undefined;
  let dashboard: DashboardDB | undefined;

  afterEach(async () => {
    dashboard?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    dashboard = undefined;
    directory = undefined;
  });

  it('upserts one binary row per digest and preserves it across database reopen', async () => {
    directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-index-db-'));
    dashboard = new DashboardDB({ dataDir: directory });
    const store = new SqliteSnapshotPageIndexStore(dashboard);
    const first = makeRecord(new Uint8Array(16), 'first-checksum');
    const replacement = makeRecord(
      Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 44]),
      'replacement-checksum',
    );

    await store.upsert(first);
    await store.upsert(replacement);
    expect(await store.get(DIGEST)).toEqual(replacement);
    expect(await store.get(`sha256:${'d'.repeat(64)}`)).toBeNull();

    dashboard.close();
    dashboard = new DashboardDB({ dataDir: directory });
    const reopenedStore = new SqliteSnapshotPageIndexStore(dashboard);
    expect(await reopenedStore.get(DIGEST)).toEqual(replacement);
  });

  it('persists a new snapshot index and serves pages after SQLite and store reopen', async () => {
    directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-index-db-'));
    dashboard = new DashboardDB({ dataDir: directory });
    const pageIndexes = new SqliteSnapshotPageIndexStore(dashboard);
    const snapshots = createPublicSnapshotStore(directory, undefined, pageIndexes)!;
    const quads = Array.from({ length: 300 }, (_, index) => ({
      subject: `urn:snapshot:sqlite:reopen:${index}`,
      predicate: 'http://schema.org/value',
      object: `"${index}"`,
      graph: '',
    }));

    await snapshots.putSnapshot({
      digest: DIGEST,
      quads,
    });

    expect(await pageIndexes.get(DIGEST)).toMatchObject({
      snapshotDigest: DIGEST,
      formatVersion: 1,
      stride: 128,
      offsetCount: 3,
    });

    dashboard.close();
    dashboard = new DashboardDB({ dataDir: directory });
    const reopenedSnapshots = createPublicSnapshotStore(
      directory,
      undefined,
      new SqliteSnapshotPageIndexStore(dashboard),
    )!;
    await expect(reopenedSnapshots.getSnapshotPage!(DIGEST, 257, 20))
      .resolves.toEqual(quads.slice(257, 277));
  });

  it('migrates an existing version-30 node database before adapter use', async () => {
    directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-index-db-'));
    dashboard = new DashboardDB({ dataDir: directory });
    dashboard.db.exec('DROP TABLE snapshot_page_indexes;');
    dashboard.db.pragma('user_version = 30');
    dashboard.close();

    dashboard = new DashboardDB({ dataDir: directory });
    const pageIndexes = new SqliteSnapshotPageIndexStore(dashboard);
    const record = makeRecord(new Uint8Array(16), 'migrated-checksum');
    await pageIndexes.upsert(record);

    expect(await pageIndexes.get(DIGEST)).toEqual(record);
    expect(dashboard.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  });

  it('falls back to the snapshot when the real SQLite connection cannot read or write', async () => {
    directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-index-db-'));
    dashboard = new DashboardDB({ dataDir: directory });
    const pageIndexes = new SqliteSnapshotPageIndexStore(dashboard);
    const quads = Array.from({ length: 260 }, (_, index) => ({
      subject: `urn:snapshot:sqlite-failure:${index}`,
      predicate: 'http://schema.org/value',
      object: `"${index}"`,
      graph: '',
    }));
    await createPublicSnapshotStore(directory, undefined, pageIndexes)!
      .putSnapshot({ digest: DIGEST, quads });
    dashboard.close();
    dashboard = undefined;

    const fallbackStore = createPublicSnapshotStore(directory, undefined, pageIndexes)!;
    await expect(fallbackStore.getSnapshotPage!(DIGEST, 257, 20))
      .resolves.toEqual(quads.slice(257));
    await expect(fallbackStore.putSnapshot({
      digest: `sha256:${'d'.repeat(64)}`,
      quads,
    })).resolves.toMatchObject({ ref: `sha256:${'d'.repeat(64)}` });
  });
});

function makeRecord(offsetsBlob: Uint8Array, checksum: string): SnapshotPageIndexRecord {
  return {
    snapshotDigest: DIGEST,
    formatVersion: 1,
    stride: 128,
    snapshotFileSize: 300,
    modificationFingerprint: 'mtimeMs:1;ctimeMs:2',
    offsetCount: 2,
    offsetsBlob,
    checksum,
  };
}
