import { rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  openSqliteFinalizationRecoveryStore,
  type SqliteFinalizationRecoveryStore,
} from '../src/finalization-recovery-sqlite-store.js';
import { evidence, received, temporaryDirectory } from './finalization-recovery-sqlite-test-helpers.js';
import type { FinalizationRecoveryRetentionOptions } from '../src/finalization-recovery-sqlite-policy.js';

const SOURCE_A = '12D3KooWSourceA';
const SOURCE_B = '12D3KooWSourceB';

function entry(index: number, overrides: Record<string, unknown> = {}) {
  return received({
    key: `entry-${index}`,
    txHash: `0x${index.toString(16).padStart(64, '0')}`,
    ual: `did:dkg:base:84532/0x1111111111111111111111111111111111111111/${index}`,
    kaId: String(index),
    batchId: String(index),
    ...overrides,
  });
}

async function withStore(
  options: FinalizationRecoveryRetentionOptions,
  run: (open: () => Promise<SqliteFinalizationRecoveryStore>) => Promise<void>,
): Promise<void> {
  const directory = await temporaryDirectory();
  const opened: SqliteFinalizationRecoveryStore[] = [];
  try {
    await run(async () => {
      const store = await openSqliteFinalizationRecoveryStore(directory, options);
      opened.push(store);
      return store;
    });
  } finally {
    for (const store of opened) await store.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

describe('finalization recovery readiness', () => {
  it('stays ready while one source holds its full quota, and admits other sources', async () => {
    await withStore({ maxPerPeer: 2 }, async (open) => {
      const store = await open();
      await expect(store.receive(entry(1, { sourcePeerId: SOURCE_A })))
        .resolves.toMatchObject({ status: 'inserted' });
      await expect(store.receive(entry(2, { sourcePeerId: SOURCE_A })))
        .resolves.toMatchObject({ status: 'inserted' });

      const health = await store.health();
      expect(health).toMatchObject({
        available: true,
        ready: true,
        fullQuotas: { sourcePeers: 1, contextGraphs: 0 },
        stateCounts: { RECEIVED: 2 },
      });
      expect(health).not.toHaveProperty('degradedReason');

      // The limit itself is unchanged: the full source waits in the spool.
      await expect(store.receive(entry(3, { sourcePeerId: SOURCE_A })))
        .resolves.toEqual({ status: 'pending' });
      await expect(store.receive(entry(4, { sourcePeerId: SOURCE_B })))
        .resolves.toMatchObject({ status: 'inserted' });
      expect(await store.health()).toMatchObject({
        ready: true,
        fullQuotas: { sourcePeers: 1, contextGraphs: 0 },
        stateCounts: { RECEIVED: 3 },
        deferredEntries: 1,
      });
    });
  });

  it('stays ready while one Context Graph holds its full quota', async () => {
    await withStore({ maxPerContextGraph: 1 }, async (open) => {
      const store = await open();
      await store.receive(entry(1, { contextGraphId: 'graph-a', sourcePeerId: SOURCE_A }));
      await expect(store.receive(entry(2, { contextGraphId: 'graph-a', sourcePeerId: SOURCE_B })))
        .resolves.toEqual({ status: 'pending' });
      await expect(store.receive(entry(3, { contextGraphId: 'graph-b', sourcePeerId: SOURCE_B })))
        .resolves.toMatchObject({ status: 'inserted' });

      const health = await store.health();
      expect(health).toMatchObject({
        ready: true,
        fullQuotas: { sourcePeers: 0, contextGraphs: 2 },
        deferredEntries: 1,
      });
      expect(health).not.toHaveProperty('degradedReason');
    });
  });

  it('is not ready once a node-wide limit is reached', async () => {
    await withStore({ maxEntries: 2 }, async (open) => {
      const store = await open();
      await store.receive(entry(1, { contextGraphId: 'graph-a', sourcePeerId: SOURCE_A }));
      expect(await store.health()).toMatchObject({ ready: true });
      await store.receive(entry(2, { contextGraphId: 'graph-b', sourcePeerId: SOURCE_B }));

      expect(await store.health()).toMatchObject({
        ready: false,
        degradedReason: 'capacity-exhausted',
        fullQuotas: { sourcePeers: 0, contextGraphs: 0 },
      });
      await expect(store.receive(entry(3, { contextGraphId: 'graph-c', sourcePeerId: '12D3KooWSourceC' })))
        .resolves.toEqual({ status: 'pending' });
    });
  });

  it('is not ready once the live payload reaches its node-wide byte limit', async () => {
    await withStore({ maxTotalBytes: 8 }, async (open) => {
      const store = await open();
      await store.receive(entry(1, { rawMessage: new Uint8Array(8) }));
      expect(await store.health()).toMatchObject({
        ready: false,
        degradedReason: 'capacity-exhausted',
        livePayloadBytes: 8,
      });
    });
  });

  it('counts a settled entry that still owes a publisher upgrade against its quota', async () => {
    await withStore({ maxPerPeer: 1 }, async (open) => {
      const store = await open();
      const settling = entry(1, { sourcePeerId: SOURCE_A });
      await store.receive(settling);
      // A SETTLED row carries its receipt evidence.
      await expect(store.commitVerifiedEvidence('entry-1', 0, {
        evidence: evidence({ transactionHash: settling.txHash }),
        placement: 'original',
      })).resolves.toMatchObject({ status: 'verified' });
      await store.transition('entry-1', 0, 'SETTLED');
      expect(await store.health()).toMatchObject({
        fullQuotas: { sourcePeers: 0, contextGraphs: 0 },
      });
      await expect(store.recordSettledPublisherUpgrade('entry-1', 0, '12D3KooWPublisher'))
        .resolves.toMatchObject({ status: 'recorded' });
      expect(await store.health()).toMatchObject({
        ready: true,
        fullQuotas: { sourcePeers: 1, contextGraphs: 0 },
      });
    });
  });

  it('keeps a source quota and its readiness across a restart', async () => {
    await withStore({ maxPerPeer: 1 }, async (open) => {
      const first = await open();
      await first.receive(entry(1, { sourcePeerId: SOURCE_A }));
      await first.close();

      const reopened = await open();
      const health = await reopened.health();
      expect(health).toMatchObject({
        ready: true,
        fullQuotas: { sourcePeers: 1, contextGraphs: 0 },
        stateCounts: { RECEIVED: 1 },
      });
      expect(health).not.toHaveProperty('degradedReason');
      await expect(reopened.receive(entry(2, { sourcePeerId: SOURCE_A })))
        .resolves.toEqual({ status: 'pending' });
      await expect(reopened.receive(entry(3, { sourcePeerId: SOURCE_B })))
        .resolves.toMatchObject({ status: 'inserted' });
    });
  });
});
