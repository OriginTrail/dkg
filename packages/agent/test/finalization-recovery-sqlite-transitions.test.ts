import { describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteFinalizationRecoveryStore } from '../src/finalization-recovery-sqlite-store.js';
import { transitionFinalizationRecoveryEntry } from '../src/finalization-recovery-transition.js';
import { evidence, received, temporaryDirectory } from './finalization-recovery-sqlite-test-helpers.js';

describe('SQLite finalization recovery transitions', () => {
  it('refuses to settle an entry until verified evidence is committed', async () => {
    const directory = await temporaryDirectory();
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory);
      await store.receive(received());

      await expect(store.transition('entry-1', 0, 'SETTLED')).resolves.toEqual({ status: 'missing-evidence' });
      await expect(store.get('entry-1')).resolves.toMatchObject({
        state: 'RECEIVED',
      });

      await expect(store.commitVerifiedEvidence('entry-1', 0, { evidence: evidence(), placement: 'original' }))
        .resolves.toMatchObject({ status: 'verified' });
      await expect(store.transition('entry-1', 0, 'SETTLED')).resolves.toEqual({ status: 'changed' });
      await expect(store.get('entry-1')).resolves.toMatchObject({
        state: 'SETTLED',
        verifiedEvidence: { blockNumber: 123 },
      });
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rolls back a failed settlement, reports the SQL error, and permits a later commit', async () => {
    const directory = await temporaryDirectory();
    const store = await openSqliteFinalizationRecoveryStore(directory);
    const control = new DatabaseSync(store.databasePath);
    try {
      await store.receive(received());
      await store.commitVerifiedEvidence('entry-1', 0, { evidence: evidence(), placement: 'original' });
      const entry = await store.get('entry-1');
      if (!entry) throw new Error('fixture entry missing');
      control.exec(`CREATE TRIGGER reject_settlement BEFORE UPDATE OF state ON finalization_inbox_v1
        WHEN NEW.state = 'SETTLED' BEGIN SELECT RAISE(ABORT, 'settlement write rejected'); END`);
      const warn = vi.fn();
      await expect(transitionFinalizationRecoveryEntry(store, entry, 'SETTLED', undefined, { warn })).resolves.toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('settlement write rejected'));
      await expect(store.get(entry.key)).resolves.toMatchObject({ state: 'VERIFIED', generation: 0, verifiedEvidence: evidence() });
      control.exec('DROP TRIGGER reject_settlement');
      await expect(transitionFinalizationRecoveryEntry(store, entry, 'SETTLED', undefined, { warn })).resolves.toBe(true);
      await expect(store.get(entry.key)).resolves.toMatchObject({ state: 'SETTLED', verifiedEvidence: evidence() });
      expect(warn).toHaveBeenCalledOnce();
    } finally { control.close(); await store.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('rolls back publisher authority and pending work after an AFTER UPDATE failure', async () => {
    const directory = await temporaryDirectory();
    const store = await openSqliteFinalizationRecoveryStore(directory);
    const control = new DatabaseSync(store.databasePath);
    try {
      await store.receive(received({ sourcePeerId: '12D3KooWUntrustedRelay' }));
      await store.commitVerifiedEvidence('entry-1', 0, { evidence: evidence(), placement: 'original' });
      await store.transition('entry-1', 0, 'SETTLED');
      const before = await store.get('entry-1');
      control.exec(`CREATE TRIGGER fail_publisher_upgrade AFTER UPDATE OF trusted_publisher_peer_id ON finalization_inbox_v1
        BEGIN SELECT RAISE(FAIL, 'publisher update failed after mutation'); END`);
      await expect(store.recordSettledPublisherUpgrade('entry-1', 0, '12D3KooWPublisher'))
        .rejects.toThrow('publisher update failed after mutation');
      expect(await store.get('entry-1')).toEqual(before);
      control.exec('DROP TRIGGER fail_publisher_upgrade');
      await expect(store.recordSettledPublisherUpgrade('entry-1', 0, '12D3KooWPublisher')).resolves.toMatchObject({
        status: 'recorded', entry: { trustedPublisherPeerId: '12D3KooWPublisher', publisherUpgradePending: true },
      });
    } finally { control.close(); await store.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('warns for missing evidence while stale generations and closed stores stay silent', async () => {
    const directory = await temporaryDirectory();
    const store = await openSqliteFinalizationRecoveryStore(directory);
    try {
      await store.receive(received());
      const entry = await store.get('entry-1');
      if (!entry) throw new Error('fixture entry missing');
      const warn = vi.fn();
      await expect(transitionFinalizationRecoveryEntry(store, entry, 'SETTLED', undefined, { warn })).resolves.toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('verified evidence missing'));
      warn.mockClear();
      await expect(transitionFinalizationRecoveryEntry(store, { ...entry, generation: 1 }, 'SETTLED', undefined, { warn }))
        .resolves.toBe(false);
      await store.close();
      await expect(transitionFinalizationRecoveryEntry(store, entry, 'SETTLED', undefined, { warn })).resolves.toBe(false);
      expect(warn).not.toHaveBeenCalled();
    } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
