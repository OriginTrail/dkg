import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContextGraphSubscriptionRecord } from '@origintrail-official/dkg-agent';
import { DashboardDB } from '@origintrail-official/dkg-node-ui';
import {
  contextGraphSubscriptionRecordFromRow,
  contextGraphSubscriptionRecordToRow,
} from '../src/daemon/context-graph-subscription-store.js';

describe('daemon context-graph subscription store boundary', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('round-trips automatic-public admission through SQLite', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dkg-subscription-admission-'));
    directories.push(directory);
    const db = new DashboardDB({ dataDir: directory });
    const record: ContextGraphSubscriptionRecord = {
      id: 'public-coverage',
      subscribed: true,
      synced: false,
      sharedMemorySynced: false,
      metaSynced: true,
      onChainId: '14',
      syncAdmission: 'automatic-public',
      syncScoped: false,
    };

    try {
      db.upsertContextGraphSubscription(contextGraphSubscriptionRecordToRow(record, 1234));
      const persisted = db.getContextGraphSubscription(record.id);

      expect(persisted).toMatchObject({
        context_graph_id: record.id,
        sync_admission: 'automatic-public',
        sync_scoped: 0,
        updated_at: 1234,
      });
      expect(contextGraphSubscriptionRecordFromRow(persisted!)).toEqual(record);
    } finally {
      db.close();
    }
  });

  it('keeps a legacy sync_scoped row distinguishable from current admission', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dkg-subscription-legacy-'));
    directories.push(directory);
    const db = new DashboardDB({ dataDir: directory });

    try {
      db.upsertContextGraphSubscription({
        context_graph_id: 'legacy-explicit',
        subscribed: 1,
        synced: 0,
        sync_scoped: 1,
        updated_at: 1234,
      });
      const loaded = contextGraphSubscriptionRecordFromRow(
        db.getContextGraphSubscription('legacy-explicit')!,
      );

      expect(loaded.syncAdmission).toBeUndefined();
      expect(loaded.syncScoped).toBe(true);
    } finally {
      db.close();
    }
  });
});
