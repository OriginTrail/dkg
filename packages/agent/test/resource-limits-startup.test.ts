import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { backpressureRegistry, createOperationContext, Logger, type LogRecord } from '@origintrail-official/dkg-core';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import type { DKGAgent as Agent } from '../src/dkg-agent.js';
import type { StartupResourcePolicy } from '../src/resource-policy.js';

it('starts a real local agent with bounded VM limits and emits one redacted configuration warning', async () => {
  // Importing a pure parser must not freeze the agent's later runtime snapshot.
  vi.stubEnv('DKG_VM_RECONCILE_BATCH_SIZE', '11');
  const { resourceInteger } = await import('../src/resource-limits.js');
  expect(resourceInteger(2, { min: 1, max: 10 }, 'example')).toBe(2);
  vi.stubEnv('DKG_VM_RECONCILE_BATCH_SIZE', '17');
  vi.stubEnv('DKG_VM_RECONCILE_CONCURRENCY', 'Infinity');
  vi.stubEnv('DKG_VM_RECONCILE_ORDINAL_CONCURRENCY', 'Infinity');
  vi.stubEnv('DKG_VM_RECONCILE_QUEUE_MAX_PENDING', 'Infinity');
  vi.stubEnv('DKG_VM_RECONCILE_CACHE_MAX_ENTRIES', 'Infinity');
  vi.stubEnv('DKG_VM_RECONCILE_SHUTDOWN_TIMEOUT_MS', 'Infinity');
  vi.stubEnv('DKG_SWM_CATCHUP_MAX_PASSES', 'secret-invalid-value');
  vi.stubEnv('DKG_SYNC_GLOBAL_MAX_INFLIGHT', 'secret-invalid-value');
  vi.stubEnv('DKG_SYNC_GLOBAL_LIMIT', '');
  vi.stubEnv('DKG_SYNC_GLOBAL_QUEUE_LIMIT', 'Infinity');
  vi.stubEnv('DKG_SYNC_RESPONDER_GLOBAL_SNAPSHOT_ROW_LIMIT', 'secret-invalid-value');
  const records: LogRecord[] = [];
  Logger.setSink((record) => records.push(record));
  const dataDir = await mkdtemp(join(tmpdir(), 'dkg-resource-limits-'));
  const store = new OxigraphStore();
  const snapshotPolicy = await import('../src/sync/responder/snapshot-policy.js');
  const resolveSnapshot = vi.spyOn(snapshotPolicy, 'resolveSyncResponderSnapshotDiagnostics');
  let agent: Agent | undefined;
  try {
    const { DKGAgent } = await import('../src/dkg-agent.js');
    expect(DKGAgent.VM_RECONCILE_BATCH_SIZE).toBe(17);
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
      syncResponderSnapshotLimits: { global: { rows: 1234 }, local: { rows: 0 } },
    });
    expect(resolveSnapshot).toHaveBeenCalledOnce();
    const effective = (agent as unknown as { config: { resourcePolicy: StartupResourcePolicy } }).config.resourcePolicy;
    for (const input of ['syncGlobalMaxInflight', 'syncGlobalLimit', 'syncGlobalQueueLimit', 'syncAdmission', 'syncResponderSnapshotLimits']) {
      expect((agent as unknown as { config: object }).config).not.toHaveProperty(input);
    }
    // Construction owns numeric resolution. Later environment edits cannot
    // make execution disagree with the policy that startup will report.
    vi.stubEnv('DKG_SYNC_GLOBAL_MAX_INFLIGHT', '7');
    vi.stubEnv('DKG_SYNC_RESPONDER_GLOBAL_SNAPSHOT_ROW_LIMIT', '9999');
    await agent.start();
    expect(resolveSnapshot).toHaveBeenCalledOnce();
    const warnings = records.filter((record) => record.level === 'warn' && record.message.includes('resource setting'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('DKG_VM_RECONCILE_CONCURRENCY');
    expect(warnings[0].message).toContain('syncReconcilerIntervalMs');
    expect(warnings[0].message).toContain('syncResponderSnapshotLimits.local.rows');
    expect(warnings[0].message).toContain('DKG_SWM_CATCHUP_MAX_PASSES');
    expect(warnings[0].message.length).toBeLessThanOrEqual(4_096);
    expect(warnings[0].message).not.toContain('secret-invalid-value');
    const resolved = records.find((record) => record.message.startsWith('Resolved sync policy '));
    expect(resolved).toBeDefined();
    expect(JSON.parse(resolved!.message.slice('Resolved sync policy '.length))).toMatchObject({
      admission: { limit: 3, queueLimit: 6 },
      snapshot: { budget: { maxRows: 1234 } },
      vm: { values: { DKG_VM_RECONCILE_BATCH_SIZE: DKGAgent.VM_RECONCILE_BATCH_SIZE } },
    });
    const { diagnostics: _diagnostics, ...canonicalPolicy } = effective;
    expect(JSON.parse(resolved!.message.slice('Resolved sync policy '.length)))
      .toMatchObject(JSON.parse(JSON.stringify(canonicalPolicy)));
    expect(Object.isFrozen(effective.diagnostics.rejected)).toBe(true);
    const { getSyncBackpressureSnapshot } = await import('../src/sync/backpressure.js');
    // Enter the real agent admission path, including its evolving selected-CG
    // scope overlay, instead of independently reconstructing an equal policy.
    await (agent as any).runContextGraphSyncWithBackpressure(
      createOperationContext('sync'), 'resource-bounds', 'durable', 'resource-bounds', async () => {
        expect(getSyncBackpressureSnapshot(effective.admission)).toMatchObject({ inflight: 1, limit: 3, queueLimit: 6 });
        expect(backpressureRegistry.capture().schedulers.find((entry) => entry.scheduler === 'sync-global'))
          .toMatchObject({ totals: { inflight: 1, inflightLimit: effective.admission.limit, queueLimit: effective.admission.queueLimit } });
      }, { source: 'reconcile' },
    );
    expect(records.filter((record) => record.level === 'warn' && record.message.includes('resource setting'))).toHaveLength(1);
  } finally {
    try { await agent?.stop(); } finally {
      resolveSnapshot.mockRestore();
      Logger.setSink(null);
      vi.unstubAllEnvs();
      await store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }
});

it('rejects invalid admission before allocating a wallet or internally owned store', async () => {
  const storage = await import('@origintrail-official/dkg-storage');
  const createStore = vi.spyOn(storage, 'createTripleStore')
    .mockRejectedValue(new Error('unexpected store allocation'));
  const dataDir = await mkdtemp(join(tmpdir(), 'dkg-resource-preflight-'));
  try {
    const { DKGAgent } = await import('../src/dkg-agent.js');
    await expect(DKGAgent.create({
      name: 'Invalid admission', dataDir, chainAdapter: new NoChainAdapter(),
      rfc64CatalogActivation: { enabled: false },
      syncAdmission: { mode: 'partitioned', globalMaxInflight: 1 },
    })).rejects.toThrow(/global.*inflight|globalMaxInflight/i);
    expect(createStore).not.toHaveBeenCalled();
    expect(await readdir(dataDir)).toEqual([]);
  } finally {
    createStore.mockRestore();
    await rm(dataDir, { recursive: true, force: true });
  }
});

it.each([null, [], { local: [] }, { global: null }])(
  'rejects malformed snapshot containers before wallet/store allocation: %j', async (shape) => {
    const storage = await import('@origintrail-official/dkg-storage');
    const { DKGAgentWallet } = await import('../src/agent-wallet.js');
    const createStore = vi.spyOn(storage, 'createTripleStore');
    const loadWallet = vi.spyOn(DKGAgentWallet, 'load');
    const generateWallet = vi.spyOn(DKGAgentWallet, 'generate');
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-snapshot-preflight-'));
    try {
      const { DKGAgent } = await import('../src/dkg-agent.js');
      await expect(DKGAgent.create({
        name: 'Invalid snapshot shape', dataDir, chainAdapter: new NoChainAdapter(),
        rfc64CatalogActivation: { enabled: false },
        syncResponderSnapshotLimits: shape as never,
      })).rejects.toThrow(/Invalid syncResponderSnapshotLimits/);
      expect(createStore).not.toHaveBeenCalled();
      expect(loadWallet).not.toHaveBeenCalled();
      expect(generateWallet).not.toHaveBeenCalled();
      expect(await readdir(dataDir)).toEqual([]);
    } finally {
      createStore.mockRestore();
      loadWallet.mockRestore();
      generateWallet.mockRestore();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);


it.each(['constructed', 'failed'] as const)('a %s second agent cannot overwrite live admission capacity', async (second) => {
  const { DKGAgent } = await import('../src/dkg-agent.js');
  const dataDir = await mkdtemp(join(tmpdir(), 'dkg-resource-ownership-'));
  const stores = [new OxigraphStore(), new OxigraphStore()];
  const agents: Agent[] = [];
  try {
    for (const [index, limit] of (second === 'constructed' ? [1, 10] : [1]).entries()) {
      agents.push(await DKGAgent.create({
        name: `Admission owner ${index}`, dataDir: join(dataDir, String(index)),
        listenPort: 0, listenHost: '127.0.0.1', nodeRole: 'edge', skills: [],
        store: stores[index], chainAdapter: new NoChainAdapter(),
        rfc64CatalogActivation: { enabled: false },
        syncGlobalMaxInflight: limit, syncGlobalQueueLimit: limit * 2,
      }));
    }
    await agents[0].start();
    await (agents[0] as any).runContextGraphSyncWithBackpressure(
      createOperationContext('sync'), 'ownership', 'durable', 'ownership', async () => {
        const capacity = () => backpressureRegistry.capture().schedulers.find((entry) => entry.scheduler === 'sync-global')!.totals;
        expect(capacity()).toMatchObject({ inflight: 1, inflightLimit: 1, queueLimit: 2 });
        if (second === 'failed') {
          const { DKGAgentWallet } = await import('../src/agent-wallet.js');
          const generate = vi.spyOn(DKGAgentWallet, 'generate').mockRejectedValueOnce(new Error('wallet unavailable'));
          try {
            // This valid policy resolves before wallet allocation fails.
            await expect(DKGAgent.create({
              name: 'Failed owner', chainAdapter: new NoChainAdapter(),
              rfc64CatalogActivation: { enabled: false },
              syncGlobalMaxInflight: 20, syncGlobalQueueLimit: 40,
            })).rejects.toThrow('wallet unavailable');
            expect(generate).toHaveBeenCalledOnce();
          } finally { generate.mockRestore(); }
        }
        expect(capacity()).toMatchObject({ inflight: 1, inflightLimit: 1, queueLimit: 2 });
      }, { source: 'reconcile' },
    );
  } finally {
    await Promise.allSettled(agents.map((agent) => agent.stop()));
    await Promise.all(stores.map((store) => store.close()));
    await rm(dataDir, { recursive: true, force: true });
  }
});
