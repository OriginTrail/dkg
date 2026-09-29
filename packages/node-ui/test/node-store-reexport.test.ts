import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as nodeStore from '@origintrail-official/dkg-node-store';
import * as nodeUi from '../src/index.js';
import * as dbModule from '../src/db.js';

/**
 * Protocol persistence moved to `@origintrail-official/dkg-node-store`. The
 * daemon (and every other importer) still imports the stores from
 * `@origintrail-official/dkg-node-ui`, so each one must stay reachable from both
 * node-ui entry points, and must be the SAME class object: the daemon's
 * `toBeInstanceOf` wiring checks and any `instanceof` in downstream code break
 * on a second copy of a class.
 */
const MOVED_STORES = [
  'SqliteChainEventCursorStore',
  'SqliteChainEventLogStore',
  'SqliteChangelogCursorStore',
  'SqliteChangelogEraGuard',
  'SqliteContextGraphAuthorityHistoryStore',
  'SqliteContextGraphAuthorityIndexStore',
  'SqliteContextGraphRegistryScanCursorStore',
  'SqliteContextGraphStorageDiscoveryStore',
  'SqliteKaNumberStore',
  'SqliteMessageIdempotencyStore',
  'SqliteProtocolOutboxStore',
  'SqliteSyncCheckpointStore',
] as const;

/** What `db.ts` has always re-exported: everything moved except the chain log store. */
const DB_MODULE_STORES = MOVED_STORES.filter((name) => name !== 'SqliteChainEventLogStore');

describe('node-ui re-exports the moved protocol stores', () => {
  it.each(MOVED_STORES)('%s is the node-store class from the package entry point', (name) => {
    expect((nodeUi as Record<string, unknown>)[name]).toBeTypeOf('function');
    expect((nodeUi as Record<string, unknown>)[name]).toBe((nodeStore as Record<string, unknown>)[name]);
  });

  it.each(DB_MODULE_STORES)('%s is the node-store class from the db module', (name) => {
    expect((dbModule as Record<string, unknown>)[name]).toBe((nodeStore as Record<string, unknown>)[name]);
  });

  it('keeps DashboardDB, the schema version and the observability classes in node-ui', () => {
    for (const name of ['DashboardDB', 'SCHEMA_VERSION', 'StructuredLogger', 'OperationTracker', 'MetricsCollector']) {
      expect((nodeUi as Record<string, unknown>)[name], name).toBeDefined();
      expect((nodeStore as Record<string, unknown>)[name], name).toBeUndefined();
    }
  });
});

describe('node-ui constructs the moved stores against its own DashboardDB', () => {
  let dir: string;
  let dashboard: InstanceType<typeof nodeUi.DashboardDB>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dkg-node-ui-reexport-'));
    dashboard = new nodeUi.DashboardDB({ dataDir: dir });
  });

  afterEach(() => {
    dashboard.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens one node-ui.db and lets every moved store round-trip through it', async () => {
    const outbox = new nodeUi.SqliteProtocolOutboxStore(dashboard);
    outbox.enqueue('peer', '/dkg/10.0.1/message', 'm1', new Uint8Array([1]), 'reset', 1_000);
    const checkpoints = new nodeUi.SqliteSyncCheckpointStore(dashboard);
    checkpoints.set('peer|cg|durable|data', 5);
    new nodeUi.SqliteChangelogCursorStore(dashboard).set('peer', 'cg', 'era', 2);
    expect(new nodeUi.SqliteKaNumberStore(dashboard).allocate('0xabc')).toBe(0n);
    await new nodeUi.SqliteChainEventCursorStore(dashboard, { scope: 's' }).saveLane('lane', 9);

    // The rows are in the dashboard's own tables (same file, same schema).
    const count = (table: string) =>
      (dashboard.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
    expect(count('protocol_outbox')).toBe(1);
    expect(count('sync_checkpoints')).toBe(1);
    expect(count('changelog_cursors')).toBe(1);
    expect(count('ka_numbers')).toBe(1);
    expect(count('runtime_cursors')).toBe(1);
    expect(readdirSync(dir).filter((name) => name.endsWith('.db'))).toEqual(['node-ui.db']);
  });
});
