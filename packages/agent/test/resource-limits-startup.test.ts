import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { PROTOCOL_SYNC, backpressureRegistry, createOperationContext, Logger, type LogRecord } from '@origintrail-official/dkg-core';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import type { DKGAgent as Agent } from '../src/dkg-agent.js';
import type { StartupResourcePolicy } from '../src/resource-policy.js';
import type { LegacyResolvedDKGAgentConfig, ResolvedDKGAgentConfig } from '../src/resolved-agent-config.js';
import { linesFromNquads } from './_helpers/sync-responder.js';

it('starts a real local agent with bounded VM limits and emits one redacted configuration warning', async () => {
  // Importing a pure parser must not freeze the agent's later runtime snapshot.
  vi.stubEnv('DKG_VM_RECONCILE_BATCH_SIZE', '11');
  const { resourceInteger } = await import('../src/resource-limits.js');
  expect(resourceInteger(2, { min: 1, max: 10 }, 'example')).toBe(2);
  const { resolveVmReconcileStartupMaxDelayMs } = await import('../src/startup-jitter.js');
  expect(resolveVmReconcileStartupMaxDelayMs('0', 60_000)).toBe(0);
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
  const onReplicationEvent = vi.fn();
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
      ackHandlerDeadlineMs: 12_001, ackSendTimeoutMs: 17_002, onReplicationEvent,
      syncGlobalMaxInflight: 3, syncGlobalQueueLimit: 6,
      syncReconcilerIntervalMs: Infinity,
      syncResponderSnapshotLimits: { global: { rows: 1234 }, local: { rows: 0 } },
    });
    expect(resolveSnapshot).toHaveBeenCalledOnce();
    const runtimeConfig = (agent as unknown as { config: ResolvedDKGAgentConfig }).config;
    expect(runtimeConfig).not.toHaveProperty('rfc64CatalogActivation');
    expect(runtimeConfig).not.toHaveProperty('ackHandlerDeadlineMs');
    expect(runtimeConfig).not.toHaveProperty('ackSendTimeoutMs');
    expect(runtimeConfig.storageAckTiming).toMatchObject({ handlerDeadlineMs: 12_001, sendTimeoutMs: 17_002 });
    expect(runtimeConfig.storageAckTiming.maxConcurrentCollections).toBeGreaterThan(0);
    expect(runtimeConfig.rfc64CatalogExecutionPlan).toBeDefined();
    expect(runtimeConfig.onReplicationEvent).toBe(onReplicationEvent);
    expect(runtimeConfig.store).toBe(store);
    const effective = (agent as unknown as { config: { resourcePolicy: StartupResourcePolicy } }).config.resourcePolicy;
    // Raw timing inputs never reach the canonical runtime object. The fields
    // the pre-policy declaration exposed survive through a read-only facade
    // with their historical caller-input semantics; effective values live only
    // in resourcePolicy.
    const runtime = (agent as unknown as { config: LegacyResolvedDKGAgentConfig }).config;
    for (const input of [
      'syncReconcilerIntervalMs', 'syncStalenessThresholdMs',
      'syncBackoffBaseMs', 'syncBackoffMaxMs', 'syncBackoffJitter',
    ]) {
      expect(runtime).not.toHaveProperty(input);
    }
    expect(runtime.syncReconcilerTiming).toEqual(effective.reconcilerTiming);
    expect(runtime.syncReconcilerTiming).not.toBe(effective.reconcilerTiming);
    expect(runtime.syncGlobalMaxInflight).toBe(3);
    expect(runtime.syncGlobalLimit).toBeUndefined();
    expect(runtime.syncGlobalQueueLimit).toBe(6);
    expect(runtime.syncAdmission).toBeUndefined();
    expect(effective.snapshot.budget.maxSnapshotRows).toBe(1234);
    expect(runtime.syncResponderSnapshotLimits).toEqual({
      global: { rows: 1234 },
      local: { rows: 0 },
    });
    for (const alias of [
      'syncReconcilerTiming', 'syncGlobalMaxInflight', 'syncGlobalLimit',
      'syncGlobalQueueLimit', 'syncAdmission', 'syncResponderSnapshotLimits',
    ]) {
      expect(Object.hasOwn(runtime, alias)).toBe(false);
      expect(Object.keys(runtime)).not.toContain(alias);
    }
    expect(() => {
      (runtime as unknown as { syncGlobalLimit: number }).syncGlobalLimit = 999;
    }).toThrow(TypeError);
    const compatibilitySnapshot = runtime.syncResponderSnapshotLimits!;
    compatibilitySnapshot.local!.rows = 999;
    expect(runtime.syncResponderSnapshotLimits?.local?.rows).toBe(0);
    expect(effective.snapshot.budget.maxSnapshotRows).toBe(1234);
    // Construction owns numeric resolution. Later environment edits cannot
    // make execution disagree with the policy that startup will report.
    vi.stubEnv('DKG_SYNC_GLOBAL_MAX_INFLIGHT', '7');
    vi.stubEnv('DKG_SYNC_RESPONDER_GLOBAL_SNAPSHOT_ROW_LIMIT', '9999');
    // Future internal policy objects must not become a serialization requirement
    // of the real startup log. Keep the same admission/snapshot objects in use.
    const internalState: { self?: unknown } = {};
    internalState.self = internalState;
    (agent as unknown as { config: { resourcePolicy: StartupResourcePolicy } }).config.resourcePolicy =
      Object.freeze({ ...effective, internalState });
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
    const diagnostic = JSON.parse(resolved!.message.slice('Resolved sync policy '.length));
    expect(Object.keys(diagnostic)).toEqual([
      'vm', 'catchup', 'reconcilerTiming', 'admission', 'snapshot', 'initialSwmPass', 'configuredPriorities',
    ]);
    expect(diagnostic).not.toHaveProperty('diagnostics');
    expect(diagnostic).not.toHaveProperty('vm.rejected');
    expect(diagnostic).not.toHaveProperty('snapshot.diagnostics');
    expect(diagnostic).not.toHaveProperty('internalState');
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

it.each([
  { timing: 'configured', intervalMs: 25 },
  { timing: 'invalid', intervalMs: Infinity },
])('runs and stops the sync reconciler at its resolved $timing interval', async ({ intervalMs }) => {
  const { DKGAgent } = await import('../src/dkg-agent.js');
  const { SYNC_RECONCILER_INTERVAL_MS } = await import('../src/dkg-agent-constants.js');
  const expectedIntervalMs = Number.isFinite(intervalMs) ? intervalMs : SYNC_RECONCILER_INTERVAL_MS;
  const dataDir = await mkdtemp(join(tmpdir(), 'dkg-reconciler-timing-'));
  const store = new OxigraphStore();
  let agent: Agent | undefined;
  try {
    agent = await DKGAgent.create({
      name: 'Reconciler timer fixture', dataDir, listenPort: 0, listenHost: '127.0.0.1',
      nodeRole: 'edge', store, chainAdapter: new NoChainAdapter(), skills: [],
      rfc64CatalogActivation: { enabled: false },
      syncReconcilerEnabled: true, syncReconcilerIntervalMs: intervalMs,
    });
    const reconcile = vi.spyOn(agent, 'reconcileSyncFromConnectedPeers').mockResolvedValue(undefined);
    // Leave network startup and shutdown timeouts on the real clock while
    // driving the intervals installed by the real agent lifecycle.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await agent.start();
    expect(reconcile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(expectedIntervalMs - 1);
    expect(reconcile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(expectedIntervalMs - 1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reconcile).toHaveBeenCalledTimes(2);

    await agent.stop();
    await vi.advanceTimersByTimeAsync(expectedIntervalMs * 2);
    expect(reconcile).toHaveBeenCalledTimes(2);
  } finally {
    try { await agent?.stop(); } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
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

it.each((['catalog', 'public compatibility'] as const).flatMap(configuration => [
  { configuration, mode: 'legacy' as const, providers: 'complete' as const, killSwitch: false, reserved: true },
  { configuration, mode: 'shadow' as const, providers: 'complete' as const, killSwitch: false, reserved: true },
  { configuration, mode: 'catalog' as const, providers: 'complete' as const, killSwitch: false, reserved: false },
  { configuration, mode: 'legacy' as const, providers: 'absent' as const, killSwitch: false, reserved: false },
  { configuration, mode: 'legacy' as const, providers: 'empty' as const, killSwitch: false, reserved: false },
  { configuration, mode: 'catalog' as const, providers: 'complete' as const, killSwitch: true, reserved: true },
]))(
  'derives RFC-64 admission through create: $configuration / $mode / $providers / killSwitch=$killSwitch',
  async ({ configuration, mode, providers, killSwitch, reserved }) => {
    // Keep these imports lazy: the first startup test controls when agent
    // environment defaults are captured. Reuse the canonical policy fixture.
    const { DKGAgent } = await import('../src/dkg-agent.js');
    const { getSyncBackpressureSnapshot } = await import('../src/sync/backpressure.js');
    const {
      RFC64_ROLLOUT_CONTEXT_GRAPH_ID: selectedCg,
      RFC64_ROLLOUT_DEPLOYMENT: deploymentProfile,
      RFC64_ROLLOUT_NETWORK_ID: chainId,
      rfc64RolloutPolicyEnvelope,
    } = await import('./_helpers/rfc64-rollout-agent-harness.js');
    const { computeNetworkId } = await import('@origintrail-official/dkg-core');
    const accepted = {
      policyEnvelope: rfc64RolloutPolicyEnvelope(), targets: [],
      ...(providers === 'absent' ? {} : {
        completeSwmProviders: providers === 'complete' ? ['12D3KooWStartupCompleteProvider'] : [],
      }),
    };
    const rollout = { killSwitch, contextGraphModes: { [selectedCg]: mode } };
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-resource-wiring-'));
    const store = new OxigraphStore();
    let agent: Agent | undefined;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let releaseSelected!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
    const selectedGate = new Promise<void>(resolve => { releaseSelected = resolve; });
    const work: Promise<unknown>[] = [];
    const events: string[] = [];
    try {
      const creating = DKGAgent.create({
        name: 'RFC-64 startup admission', dataDir, store, chainAdapter: new NoChainAdapter(),
        listenHost: '127.0.0.1', listenPort: 0, bootstrapPeers: [], skills: [],
        // Core and an empty subscription list prevent the live Edge overlay
        // from independently granting the reservation under test.
        nodeRole: 'core', syncContextGraphs: [],
        syncOnConnectEnabled: false, syncReconcilerEnabled: false, agentProfileHeartbeatMs: 0,
        syncAdmission: { mode: 'shared' }, syncGlobalMaxInflight: 2, syncGlobalQueueLimit: 6,
        networkIdentity: { networkId: await computeNetworkId(), chainId },
        ...(configuration === 'catalog' ? {
          rfc64CatalogActivation: {
            enabled: true, deploymentProfile, rollout,
            bootstrap: { acceptedPolicies: [accepted], retryIntervalMs: 0 },
          },
        } : {
          rfc64PublicCatalogActivation: {
            enabled: true, deploymentProfile, rollout,
            bootstrap: { acceptedPublicPolicies: [accepted], retryIntervalMs: 0 },
          },
        }),
      });
      if (providers === 'empty') {
        // An explicitly empty provider list is malformed; omission is the
        // supported non-recovering policy tested separately above.
        await expect(creating).rejects.toThrow(/completeSwmProviders must contain 1\.\.8 peers/);
        return;
      }
      agent = await creating;
      const effective = (agent as unknown as { config: { resourcePolicy: StartupResourcePolicy } }).config.resourcePolicy;
      const policy = effective.admission;
      expect(policy.selectedRecoveryContextGraphIds ?? []).toEqual(reserved ? [selectedCg] : []);
      if (reserved) expect(Object.isFrozen(policy.selectedRecoveryContextGraphIds)).toBe(true);
      const run = (
        contextGraphId: string, label: string, gate: Promise<void>,
        source: 'reconcile' | 'vm-recovery' | 'on-connect', selectedSwmPriority = false,
      ) => agent!.runContextGraphSyncWithBackpressure(
        createOperationContext('sync'), contextGraphId,
        selectedSwmPriority ? 'shared_memory' : 'durable', label,
        async () => { events.push(label); await gate; },
        { source, ...(selectedSwmPriority ? { selectedSwmPriority: true, priorityOverride: 2_000 } : {}) },
      );
      work.push(run('urn:cg:unrelated-first', 'first background', firstGate, 'reconcile'));
      await vi.waitFor(() => expect(events).toEqual(['first background']));
      work.push(run('urn:cg:unrelated-second', 'second background', secondGate, 'vm-recovery'));
      await vi.waitFor(() => {
        expect(getSyncBackpressureSnapshot(policy)).toMatchObject({
          inflight: reserved ? 1 : 2, queued: reserved ? 1 : 0, limit: 2, queueLimit: 6,
        });
        expect(events).toEqual(reserved
          ? ['first background'] : ['first background', 'second background']);
      });
      work.push(run(selectedCg, 'selected recovery', selectedGate, 'on-connect', true));
      await vi.waitFor(() => {
        expect(getSyncBackpressureSnapshot(policy)).toMatchObject({ inflight: 2, queued: 1 });
        expect(events).toEqual(reserved
          ? ['first background', 'selected recovery'] : ['first background', 'second background']);
      });
      if (reserved) {
        expect(events).toEqual(['first background', 'selected recovery']);
        releaseSelected();
        await work[2];
        // Freeing the recovery slot must not let unrelated background work
        // borrow it while the ordinary background slot remains occupied.
        expect(events).toEqual(['first background', 'selected recovery']);
        expect(getSyncBackpressureSnapshot(policy)).toMatchObject({ inflight: 1, queued: 1 });
      } else {
        expect(events).toEqual(['first background', 'second background']);
      }
      releaseFirst();
      await vi.waitFor(() => expect(events).toHaveLength(3));
      expect(events).toEqual(reserved
        ? ['first background', 'selected recovery', 'second background']
        : ['first background', 'second background', 'selected recovery']);
      releaseSecond(); releaseSelected();
      await Promise.all(work);
      expect(getSyncBackpressureSnapshot(policy)).toMatchObject({ inflight: 0, queued: 0 });
    } finally {
      releaseFirst(); releaseSecond(); releaseSelected();
      await Promise.allSettled(work);
      try { await agent?.stop(); } finally {
        await store.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  },
);

it.each([
  { configured: 1, mutated: '1000', served: 'store-bounded pages' },
  { configured: 1000, mutated: '1', served: 'one retained session snapshot' },
])('serves durable pages from $served under the startup-resolved per-snapshot budget of $configured rows', async ({ configured, mutated }) => {
  const { DKGAgent } = await import('../src/dkg-agent.js');
  const contextGraphId = 'responder-budget';
  const graph = `did:dkg:context-graph:${contextGraphId}/data`;
  const dataDir = await mkdtemp(join(tmpdir(), 'dkg-responder-budget-'));
  const store = new OxigraphStore();
  await store.insert([0, 1, 2].map((index) => ({
    graph, subject: `urn:responder-budget:${index}`, predicate: 'http://schema.org/name', object: `"row ${index}"`,
  })));
  // A retained snapshot reads the graph once without paging; the bounded
  // fallback issues ordered OFFSET/LIMIT page queries against the store.
  const pageQueries: string[] = [];
  const originalQuery = store.query.bind(store);
  store.query = (async (sparql: string, ...rest: unknown[]) => {
    const normalized = sparql.replace(/\s+/g, ' ').trim();
    if (normalized.includes(`<${graph}>`) && normalized.includes('ORDER BY') && normalized.includes('OFFSET')) {
      pageQueries.push(normalized);
    }
    return (originalQuery as (sparql: string, ...rest: unknown[]) => ReturnType<OxigraphStore['query']>)(sparql, ...rest);
  }) as OxigraphStore['query'];
  let agent: Agent | undefined;
  try {
    agent = await DKGAgent.create({
      name: 'Responder budget fixture', dataDir, listenPort: 0, listenHost: '127.0.0.1',
      nodeRole: 'edge', store, chainAdapter: new NoChainAdapter(), skills: [],
      rfc64CatalogActivation: { enabled: false },
      syncResponderSnapshotLimits: { local: { rows: configured } },
    });
    // The registered responder must follow the budget resolved at construction,
    // not a fresh environment read at registration or request time.
    vi.stubEnv('DKG_SYNC_RESPONDER_PER_SNAPSHOT_ROW_LIMIT', mutated);
    await agent.start();
    const handlers = (agent as unknown as { router: { handlers: Map<string, unknown> } }).router.handlers;
    const respond = handlers.get(PROTOCOL_SYNC) as (
      data: Uint8Array,
      peerId: { toString(): string },
      options?: { signal?: AbortSignal },
    ) => Promise<Uint8Array>;
    expect(respond).toBeTypeOf('function');
    const page = async (offset: number) => linesFromNquads(new TextDecoder().decode(await respond(
      new TextEncoder().encode(JSON.stringify({
        contextGraphId, includeSharedMemory: false, phase: 'data', offset, limit: 2,
        syncSessionId: 'responder-budget-session',
      })),
      { toString: () => '12D3KooWResponderBudgetRequester' },
      { signal: new AbortController().signal },
    )));

    const first = await page(0);
    const second = await page(2);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(1);
    expect(new Set([...first, ...second]).size).toBe(3);
    if (configured === 1) {
      expect(pageQueries.length).toBeGreaterThan(0);
      expect(pageQueries[0]).toContain('LIMIT 2');
      expect(pageQueries[0]).toContain('OFFSET 0');
    } else {
      expect(pageQueries).toEqual([]);
    }
  } finally {
    try { await agent?.stop(); } finally {
      vi.unstubAllEnvs();
      await store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }
});
