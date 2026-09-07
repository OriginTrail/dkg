import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Logger, type LogRecord } from '@origintrail-official/dkg-core';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import type { DKGAgent as Agent } from '../src/dkg-agent.js';

it('starts a real local agent with bounded VM limits and emits one redacted configuration warning', async () => {
  // Set restart-scoped inputs before the first agent import in this isolated test file.
  vi.stubEnv('DKG_VM_RECONCILE_BATCH_SIZE', 'Infinity');
  vi.stubEnv('DKG_VM_RECONCILE_CONCURRENCY', 'Infinity');
  vi.stubEnv('DKG_VM_RECONCILE_ORDINAL_CONCURRENCY', 'Infinity');
  vi.stubEnv('DKG_VM_RECONCILE_QUEUE_MAX_PENDING', 'Infinity');
  vi.stubEnv('DKG_VM_RECONCILE_CACHE_MAX_ENTRIES', 'Infinity');
  vi.stubEnv('DKG_VM_RECONCILE_SHUTDOWN_TIMEOUT_MS', 'Infinity');
  vi.stubEnv('DKG_SYNC_GLOBAL_MAX_INFLIGHT', 'secret-invalid-value');
  vi.stubEnv('DKG_SYNC_GLOBAL_LIMIT', '');
  vi.stubEnv('DKG_SYNC_GLOBAL_QUEUE_LIMIT', 'Infinity');
  vi.stubEnv('DKG_SYNC_RESPONDER_GLOBAL_SNAPSHOT_ROW_LIMIT', 'secret-invalid-value');
  const records: LogRecord[] = [];
  Logger.setSink((record) => records.push(record));
  const dataDir = await mkdtemp(join(tmpdir(), 'dkg-resource-limits-'));
  const store = new OxigraphStore();
  let agent: Agent | undefined;
  try {
    const { DKGAgent } = await import('../src/dkg-agent.js');
    expect(DKGAgent.VM_RECONCILE_BATCH_SIZE).toBe(10);
    expect(DKGAgent.VM_RECONCILE_CONCURRENCY).toBe(2);
    expect(DKGAgent.VM_RECONCILE_ORDINAL_CONCURRENCY).toBe(5);
    expect(DKGAgent.VM_RECONCILE_QUEUE_MAX_PENDING).toBe(256);
    expect(DKGAgent.VM_RECONCILE_CACHE_MAX_ENTRIES).toBe(1_000);
    expect(DKGAgent.VM_RECONCILE_SHUTDOWN_TIMEOUT_MS).toBe(5_000);
    agent = await DKGAgent.create({
      name: 'Resource bounds fixture', dataDir, listenPort: 0, listenHost: '127.0.0.1',
      nodeRole: 'edge', store, chainAdapter: new NoChainAdapter(), skills: [],
      rfc64CatalogActivation: { enabled: false },
      syncGlobalMaxInflight: 3, syncGlobalQueueLimit: 6,
      syncReconcilerIntervalMs: Infinity,
      syncResponderSnapshotLimits: { global: { rows: 1234 } },
    });
    await agent.start();
    const warnings = records.filter((record) => record.level === 'warn' && record.message.includes('resource setting'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('DKG_VM_RECONCILE_BATCH_SIZE');
    expect(warnings[0].message).toContain('syncReconcilerIntervalMs');
    expect(warnings[0].message.length).toBeLessThanOrEqual(4_096);
    expect(warnings[0].message).not.toContain('secret-invalid-value');
    const resolved = records.find((record) => record.message.startsWith('Resolved sync policy '));
    expect(resolved).toBeDefined();
    expect(JSON.parse(resolved!.message.slice('Resolved sync policy '.length))).toMatchObject({
      syncGlobalInflightLimit: 3, syncGlobalQueueLimit: 6, snapshotGlobalRows: 1234,
      vmReconcileLimits: { DKG_VM_RECONCILE_BATCH_SIZE: DKGAgent.VM_RECONCILE_BATCH_SIZE },
    });
    const { resolveSyncGlobalBackpressure, getSyncBackpressureSnapshot } = await import('../src/sync/backpressure.js');
    for (let i = 0; i < 20; i++) {
      expect(getSyncBackpressureSnapshot(resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 3, syncGlobalQueueLimit: 6 })))
        .toMatchObject({ limit: 3, queueLimit: 6 });
    }
    expect(records.filter((record) => record.level === 'warn' && record.message.includes('resource setting'))).toHaveLength(1);
  } finally {
    try { await agent?.stop(); } finally {
      Logger.setSink(null);
      vi.unstubAllEnvs();
      await store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }
});
