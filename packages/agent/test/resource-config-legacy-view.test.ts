import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import type { ResolvedDKGAgentConfig as LegacyResolvedConfig } from
  '@origintrail-official/dkg-agent/dist/dkg-agent-types.js';
import { DKGAgent } from '../src/dkg-agent.js';
import type { DKGAgentConfig } from '../src/dkg-agent-types.js';
import type { ResolvedDKGAgentConfig } from '../src/resolved-agent-config.js';

function readLegacyConfig(config: LegacyResolvedConfig) {
  return {
    timing: config.syncReconcilerTiming,
    inflight: config.syncGlobalMaxInflight,
    alias: config.syncGlobalLimit,
    queue: config.syncGlobalQueueLimit,
    admission: config.syncAdmission,
    snapshots: config.syncResponderSnapshotLimits,
  };
}

it.each([
  { mode: 'shared', admission: { mode: 'shared' }, limit: 4, queue: 9 },
  { mode: 'partitioned', admission: { mode: 'partitioned', fast: { maxInflight: 1 },
    slow: { maxInflight: 3, foregroundReserved: 1, backgroundMaxInflight: 2 } }, limit: 4, queue: 9 },
  { mode: 'disabled', admission: { mode: 'shared' }, limit: 0, queue: 0 },
] satisfies { mode: string; admission: DKGAgentConfig['syncAdmission']; limit: number; queue: number }[])(
  'preserves the legacy resolved-config view for $mode admission', async ({ admission, limit, queue }) => {
    vi.stubEnv('DKG_SYNC_ADMISSION_MODE', '');
    vi.stubEnv('DKG_SYNC_GLOBAL_LIMIT', '');
    vi.stubEnv('DKG_SYNC_GLOBAL_MAX_INFLIGHT', String(limit));
    vi.stubEnv('DKG_SYNC_GLOBAL_QUEUE_LIMIT', String(queue));
    vi.stubEnv('DKG_SYNC_RESPONDER_GLOBAL_SNAPSHOT_ROW_LIMIT', '18');
    vi.stubEnv('DKG_SYNC_RESPONDER_PER_SNAPSHOT_ROW_LIMIT', '1');
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-legacy-config-'));
    const store = new OxigraphStore();
    let agent: DKGAgent | undefined;
    try {
      agent = await DKGAgent.create({
        name: 'Legacy config consumer', dataDir, store, chainAdapter: new NoChainAdapter(),
        rfc64CatalogActivation: { enabled: false },
        syncReconcilerIntervalMs: 25, syncGlobalMaxInflight: 2,
        syncGlobalLimit: 99, syncGlobalQueueLimit: 3, syncAdmission: admission,
        syncResponderSnapshotLimits: { global: { rows: 20 }, local: { rows: 2 } },
      });
      // Read the actual object through the old published declaration.
      const config = (agent as unknown as {
        config: ResolvedDKGAgentConfig & LegacyResolvedConfig;
      }).config;
      vi.stubEnv('DKG_SYNC_GLOBAL_MAX_INFLIGHT', '100');
      vi.stubEnv('DKG_SYNC_RESPONDER_PER_SNAPSHOT_ROW_LIMIT', '500');
      const legacy = readLegacyConfig(config);
      expect(legacy).toMatchObject({
        timing: { intervalMs: 25 }, inflight: limit, alias: limit, queue,
        admission: { mode: admission?.mode, globalMaxInflight: limit },
        snapshots: { global: { rows: 18 }, local: { rows: 1 } },
      });
      if (admission?.mode === 'partitioned') {
        expect(config.resourcePolicy.admission.partitions).toBeDefined();
        expect(legacy.admission).toMatchObject(config.resourcePolicy.admission.partitions!);
        legacy.admission!.fast!.maxInflight = 999;
        expect(config.resourcePolicy.admission.partitions?.fast.maxInflight).toBe(1);
      }
      // Legacy objects remain mutable copies; they cannot mutate canonical policy.
      legacy.timing.intervalMs = 999;
      legacy.snapshots!.local!.rows = 999;
      expect(config.resourcePolicy.reconcilerTiming.intervalMs).toBe(25);
      expect(config.resourcePolicy.snapshot.budget.maxSnapshotRows).toBe(1);
    } finally {
      try { await agent?.stop(); } finally {
        vi.unstubAllEnvs();
        await store.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  },
);
