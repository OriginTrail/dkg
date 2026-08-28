import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  computeControlObjectDigestHex,
  type Digest32V1,
  type SignedControlEnvelopeV1,
  type UnsignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DKGAgent } from '../src/dkg-agent.js';
import { ContextGraphMembershipPersistScheduler } from '../src/context-graph-membership-persist-scheduler.js';
import { FinalizationRuntime } from '../src/finalization-runtime.js';
import {
  INVENTORY_V1_RELATIVE_PATH,
  openInventoryV1,
} from '../src/rfc64/inventory-v1/index.js';
import {
  RFC64_CONTROL_OBJECT_STORE_RELATIVE_PATH,
  type StageVerifiedControlObjectV1,
} from '../src/rfc64/control-object-store-v1.js';
import { openRfc64PersistenceV1 } from '../src/rfc64/persistence-v1.js';
import { openRfc64ControlObjectStoreForOwnedPersistenceRootV1 } from '../src/rfc64/control-object-store-v1-internal.js';
import { getRfc64PersistenceRootOwnershipForInventoryV1 } from '../src/rfc64/persistence-root-ownership-v1-internal.js';
import {
  RFC64_PERSISTENCE_ROOT_RELATIVE_PATH_V1,
} from '../src/rfc64/persistence-layout-v1.js';
import { SelectedSwmBootstrapAdmission } from '../src/sync/selected-swm-bootstrap-admission.js';

const temporaryDirectories: string[] = [];
const childProcesses = new Set<ChildProcessWithoutNullStreams>();
const CHILD_FIXTURE = resolve(
  import.meta.dirname,
  'fixtures/rfc64-agent-inventory-lifecycle-child.ts',
);
const CONTROL_STORE_WALLET = new ethers.Wallet(`0x${'52'.repeat(32)}`);

function temporaryDataDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dkg-rfc64-agent-')));
  temporaryDirectories.push(directory);
  return directory;
}

function syntheticAgent(dataDirectory?: string): any {
  const agent = Object.create(DKGAgent.prototype) as any;
  Object.assign(agent, {
    config: dataDirectory === undefined ? {} : { dataDir: dataDirectory },
    contextGraphMembershipPersistence: new ContextGraphMembershipPersistScheduler(),
    finalizationRuntime: new FinalizationRuntime(),
    rfc64PersistenceV1: undefined,
    selectedSwmBootstrapAdmission: new SelectedSwmBootstrapAdmission(),
  });
  return agent;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolvePromiseInput) => {
    resolvePromise = resolvePromiseInput;
  });
  return { promise, resolve: () => resolvePromise?.() };
}

async function signedControlObjectFixture(
  sequence: string,
): Promise<StageVerifiedControlObjectV1> {
  const unsigned = {
    issuer: CONTROL_STORE_WALLET.address.toLowerCase(),
    objectType: 'dkg-rfc64-persistence-lifecycle-test-v1',
    payload: { sequence },
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  } satisfies UnsignedControlEnvelopeV1;
  const objectDigest = computeControlObjectDigestHex(unsigned);
  const envelope = {
    ...unsigned,
    objectDigest,
    signature: await CONTROL_STORE_WALLET.signMessage(ethers.getBytes(objectDigest)),
  } as SignedControlEnvelopeV1;
  return {
    envelope,
    issuerSignature: await verifyControlEnvelopeIssuerSignatureV1(envelope),
  };
}

function u64be(value: bigint): Buffer {
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64BE(value);
  return encoded;
}

async function seedStaleCandidateLoads(dataDirectory: string, count: number): Promise<void> {
  const foundation = await openInventoryV1(dataDirectory);
  foundation.close();

  const database = new DatabaseSync(join(dataDirectory, INVENTORY_V1_RELATIVE_PATH));
  try {
    const insert = database.prepare(`
      INSERT INTO rfc64_candidate_bucket_loads_v1 (
        session_id, catalog_scope_digest, author_address,
        target_catalog_head_digest, subgraph_name, catalog_era_u64be,
        bucket_count_u64be, bucket_id_u64be, bucket_object_digest,
        row_count_u64be, payload_byte_length_u64be
      ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
    `);
    for (let index = 0; index < count; index += 1) {
      const session = Buffer.alloc(32);
      session.writeUInt32BE(index + 1, 28);
      insert.run(
        session,
        Buffer.alloc(32, 0x22),
        Buffer.alloc(20, 0x33),
        Buffer.alloc(32, 0x44),
        u64be(0n),
        u64be(1n),
        u64be(0n),
        Buffer.alloc(32),
        u64be(0n),
        u64be(0n),
      );
    }
  } finally {
    database.close();
  }
}

function candidateLoadCount(dataDirectory: string): number {
  const database = new DatabaseSync(join(dataDirectory, INVENTORY_V1_RELATIVE_PATH));
  try {
    const row = database.prepare(
      'SELECT count(*) AS count FROM rfc64_candidate_bucket_loads_v1',
    ).get() as { count: number };
    return row.count;
  } finally {
    database.close();
  }
}

function minimalStartedAgent(
  order: string[],
  inventoryClose: () => void | Promise<void>,
  recoveryClose: () => void | Promise<void> = () => {
    order.push('recovery');
  },
): any {
  const agent = syntheticAgent();
  agent.finalizationRuntime.attachRecoveryStore({ close: recoveryClose } as any);
  agent.finalizationRuntime.markStarted({
    localPeerId: '12D3KooWLifecycleTest',
    localNodeIdentityId: '1',
  });
  Object.assign(agent, {
    started: true,
    chainPoller: null,
    coreHostRecordingsClosed: false,
    drainCoreHostRecordings: vi.fn(async () => {}),
    messenger: { stopOutboxDrain: vi.fn(async () => {}) },
    clearRandomSamplingBindRetry: vi.fn(),
    clearStorageACKRegistrationRetry: vi.fn(),
    storageACKRegistrationRetryInFlight: false,
    randomSamplingHandle: null,
    inFlightSubstrateFanOutCount: () => 0,
    router: { closePooling: vi.fn(async () => {}) },
    node: { stop: vi.fn(async () => { order.push('node'); }) },
    syncVerifyWorker: { close: vi.fn(async () => { order.push('sync-worker'); }) },
    rfc64PersistenceV1: {
      close: () => {
        order.push('control-store');
        return inventoryClose();
      },
    },
    store: { close: vi.fn(async () => { order.push('store'); }) },
    log: { warn: vi.fn() },
  });
  return agent;
}

function spawnLifecycleHolder(dataDirectory: string): ChildProcessWithoutNullStreams {
  const child = spawn(
    process.execPath,
    ['--experimental-sqlite', '--import', 'tsx', CHILD_FIXTURE],
    {
      cwd: resolve(import.meta.dirname, '../../..'),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DKG_RFC64_AGENT_INVENTORY_DATA_DIR: dataDirectory,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  childProcesses.add(child);
  child.once('exit', () => childProcesses.delete(child));
  return child;
}

async function waitForReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  await new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      rejectReady(new Error(`agent inventory holder did not become ready: ${stderr}`));
    }, 20_000);
    const onData = (): void => {
      if (!stdout.includes('READY\n')) return;
      clearTimeout(timeout);
      resolveReady();
    };
    child.stdout.on('data', onData);
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectReady(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      rejectReady(new Error(
        `agent inventory holder exited before ready: code=${code} signal=${signal} stderr=${stderr}`,
      ));
    });
  });
}

async function terminate(
  child: ChildProcessWithoutNullStreams,
  signal: 'SIGTERM' | 'SIGKILL',
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => child.once('exit', (code, exitSignal) => resolveExit({
      code,
      signal: exitSignal,
    })),
  );
  child.kill(signal);
  return await exit;
}

afterEach(async () => {
  await Promise.all([...childProcesses].map(async (child) => {
    if (child.exitCode === null && child.signalCode === null) {
      await terminate(child, 'SIGKILL');
    }
  }));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('DKGAgent RFC-64 inventory lifecycle', () => {
  it('stays dormant without dataDir and performs no in-memory fallback', async () => {
    const agent = syntheticAgent();

    await agent.prepareRfc64PersistenceV1();
    await agent.prepareRfc64PersistenceV1();

    expect(agent.rfc64PersistenceV1).toBeUndefined();
    await expect(agent.closeRfc64PersistenceV1()).resolves.toBeUndefined();
    await expect(agent.closeRfc64PersistenceV1()).resolves.toBeUndefined();
  });

  it('preserves capacity exhaustion when canonical receipt support is unavailable', async () => {
    const agent = syntheticAgent();
    agent.chain = { chainId: 'none' };
    agent.finalizationRuntime.attachRecoveryStore({
      health: async () => ({
        available: true,
        closed: false,
        ready: false,
        degradedReason: 'capacity-exhausted',
        stateCounts: { RECEIVED: 64 },
        livePayloadBytes: 1,
        dueEntries: 64,
      }),
    } as any);

    await expect(agent.getFinalizationRecoveryHealth()).resolves.toMatchObject({
      ready: false,
      canonicalReceiptCapability: 'unsupported',
      degradedReason: 'capacity-exhausted',
    });
  });

  it('owns one persistent foundation and purges every stale candidate in bounded yielding batches', async () => {
    const dataDirectory = temporaryDataDirectory();
    await seedStaleCandidateLoads(dataDirectory, 17);
    const agent = syntheticAgent(dataDirectory);
    const yieldBatch = vi.fn(async () => {});
    agent.yieldRfc64InventoryV1StartupBatch = yieldBatch;

    await agent.prepareRfc64PersistenceV1();
    const ownedPersistence = agent.rfc64PersistenceV1;
    const inventory = ownedPersistence.inventory;
    const controlObjects = ownedPersistence.controlObjects;
    await agent.prepareRfc64PersistenceV1();

    expect(agent.rfc64PersistenceV1).toBe(ownedPersistence);
    expect(ownedPersistence.rootPath).toBe(
      join(dataDirectory, RFC64_PERSISTENCE_ROOT_RELATIVE_PATH_V1),
    );
    expect(realpathSync(join(dataDirectory, RFC64_CONTROL_OBJECT_STORE_RELATIVE_PATH)))
      .toBe(join(dataDirectory, RFC64_CONTROL_OBJECT_STORE_RELATIVE_PATH));
    expect(yieldBatch).toHaveBeenCalledTimes(3);
    expect(() => inventory.createCandidateSession()).not.toThrow();
    expect(Object.isFrozen(controlObjects)).toBe(true);
    expect(controlObjects).not.toHaveProperty('rootPath');
    expect(controlObjects).not.toHaveProperty('closed');
    expect(controlObjects).not.toHaveProperty('close');
    expect(Object.isFrozen(inventory)).toBe(true);
    expect(inventory).not.toHaveProperty('databasePath');
    expect(inventory).not.toHaveProperty('closed');
    expect(inventory).not.toHaveProperty('close');

    await agent.closeRfc64PersistenceV1();
    expect(agent.rfc64PersistenceV1).toBeUndefined();
    expect(ownedPersistence.closed).toBe(true);
    expect(candidateLoadCount(dataDirectory)).toBe(0);
    await expect(agent.closeRfc64PersistenceV1()).resolves.toBeUndefined();
  });

  it('retains the inventory lease until the control store drain settles', async () => {
    const dataDirectory = temporaryDataDirectory();
    const agent = syntheticAgent(dataDirectory);
    await agent.prepareRfc64PersistenceV1();
    const persistence = agent.rfc64PersistenceV1;
    const fixture = await signedControlObjectFixture('lease-read-drain');
    const staged = await persistence.controlObjects.stageVerifiedObjects([fixture]);
    const entered = deferred();
    const release = deferred();
    const read = persistence.controlObjects.getVerifiedObject({
      objectDigest: fixture.envelope.objectDigest as Digest32V1,
      signatureVariantDigest: staged.objects[0].signatureVariantDigest,
      verifyIssuerSignature: async (envelope) => {
        entered.resolve();
        await release.promise;
        return verifyControlEnvelopeIssuerSignatureV1(envelope);
      },
    });
    await entered.promise;

    const close = agent.closeRfc64PersistenceV1();
    expect(agent.rfc64PersistenceV1).toBeUndefined();
    expect(persistence.closed).toBe(true);
    for (const operation of Object.values(persistence.inventory)) {
      expect(() => (operation as (...arguments_: unknown[]) => unknown)())
        .toThrow('RFC-64 persistence owner is closed');
    }
    for (const operation of Object.values(persistence.swmAuthorInventory)) {
      expect(() => (operation as (...arguments_: unknown[]) => unknown)())
        .toThrow('RFC-64 persistence owner is closed');
    }
    await expect(openInventoryV1(dataDirectory))
      .rejects.toMatchObject({ code: 'database-busy' });

    release.resolve();
    await expect(read).resolves.toMatchObject({ envelope: fixture.envelope });
    await expect(close).resolves.toBeUndefined();
    const replacement = await openInventoryV1(dataDirectory);
    replacement.close();
  });

  it('invalidates package-internal persistence-root ownership when inventory closes', async () => {
    const dataDirectory = temporaryDataDirectory();
    const inventory = await openInventoryV1(dataDirectory);
    const ownership = getRfc64PersistenceRootOwnershipForInventoryV1(inventory);
    inventory.close();

    await expect(openRfc64ControlObjectStoreForOwnedPersistenceRootV1(ownership))
      .rejects.toMatchObject({ code: 'database-closed' });
  });

  it('fails startup before node.start when inventory acquisition or recovery fails', async () => {
    const failure = new Error('inventory unavailable');
    const nodeStart = vi.fn(async () => {});
    const agent = syntheticAgent();
    Object.assign(agent, {
      started: false,
      coreHostRecordingGeneration: 0,
      prepareRfc64PersistenceV1: vi.fn(async () => { throw failure; }),
      node: { start: nodeStart },
      log: { info: vi.fn(), warn: vi.fn() },
    });

    await expect(agent.start()).rejects.toBe(failure);
    expect(nodeStart).not.toHaveBeenCalled();
    expect(agent.started).toBe(false);
  });

  it.runIf(process.platform !== 'win32')(
    'releases inventory ownership when control-store topology is unsafe',
    async () => {
      const dataDirectory = temporaryDataDirectory();
      const outside = temporaryDataDirectory();
      const initialPersistence = await openRfc64PersistenceV1(dataDirectory, {
        yieldAfterPurgeBatch: async () => {},
      });
      await initialPersistence.close();
      const objectsPath = join(
        dataDirectory,
        RFC64_CONTROL_OBJECT_STORE_RELATIVE_PATH,
        'objects',
      );
      rmSync(objectsPath, { recursive: true, force: true });
      symlinkSync(outside, objectsPath, 'dir');
      const agent = syntheticAgent(dataDirectory);

      await expect(agent.prepareRfc64PersistenceV1())
        .rejects.toMatchObject({ code: 'control-store-unsafe-path' });
      expect(agent.rfc64PersistenceV1).toBeUndefined();

      const replacement = await openInventoryV1(dataDirectory);
      replacement.close();
    },
  );

  it('awaits finalization inbox cleanup and clears its field before rejecting startup', async () => {
    const failure = new Error('node start failed');
    const cleanup = deferred();
    const recoveryClose = vi.fn(() => cleanup.promise);
    const inventoryClose = vi.fn(async () => {});
    const agent = syntheticAgent();
    Object.assign(agent, {
      started: false,
      coreHostRecordingGeneration: 0,
      prepareRfc64PersistenceV1: vi.fn(async () => {
        agent.rfc64PersistenceV1 = { close: inventoryClose };
      }),
      prepareFinalizationRecoveryStore: vi.fn(async () => {
        agent.finalizationRuntime.attachRecoveryStore({ close: recoveryClose } as any);
      }),
      node: { start: vi.fn(async () => { throw failure; }) },
      log: { info: vi.fn(), warn: vi.fn() },
    });

    const start = agent.start();
    let settled = false;
    void start.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await vi.waitFor(() => expect(recoveryClose).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(agent.finalizationRuntime.getRecoveryStore()).toBeUndefined();
    expect(inventoryClose).not.toHaveBeenCalled();

    cleanup.resolve();
    await expect(start).rejects.toBe(failure);
    expect(recoveryClose).toHaveBeenCalledOnce();
    expect(inventoryClose).toHaveBeenCalledOnce();
    expect(agent.finalizationRuntime.getRecoveryStore()).toBeUndefined();
    expect(agent.rfc64PersistenceV1).toBeUndefined();
    expect(agent.started).toBe(false);
  });

  it('aggregates finalization and RFC-64 cleanup failures with startup failure', async () => {
    const startupFailure = new Error('node start failed');
    const recoveryCleanupFailure = new Error('finalization cleanup failed');
    const inventoryCleanupFailure = new Error('RFC-64 cleanup failed');
    const recoveryClose = vi.fn(async () => { throw recoveryCleanupFailure; });
    const inventoryClose = vi.fn(async () => { throw inventoryCleanupFailure; });
    const agent = syntheticAgent();
    Object.assign(agent, {
      started: false,
      coreHostRecordingGeneration: 0,
      prepareRfc64PersistenceV1: vi.fn(async () => {
        agent.rfc64PersistenceV1 = { close: inventoryClose };
      }),
      prepareFinalizationRecoveryStore: vi.fn(async () => {
        agent.finalizationRuntime.attachRecoveryStore({ close: recoveryClose } as any);
      }),
      node: { start: vi.fn(async () => { throw startupFailure; }) },
      log: { info: vi.fn(), warn: vi.fn() },
    });

    const rejection = await agent.start().catch((cause: unknown) => cause);
    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).errors).toEqual([
      startupFailure,
      recoveryCleanupFailure,
      inventoryCleanupFailure,
    ]);
    expect(recoveryClose).toHaveBeenCalledOnce();
    expect(inventoryClose).toHaveBeenCalledOnce();
    expect(agent.finalizationRuntime.getRecoveryStore()).toBeUndefined();
    expect(agent.rfc64PersistenceV1).toBeUndefined();
    expect(agent.started).toBe(false);
  });

  it('closes after network consumers and before the triple store, with idempotent stop', async () => {
    const order: string[] = [];
    const inventoryClose = vi.fn(() => { order.push('inventory'); });
    const agent = minimalStartedAgent(order, inventoryClose);

    await agent.stop();
    await agent.stop();

    expect(order).toEqual([
      'node',
      'sync-worker',
      'recovery',
      'control-store',
      'inventory',
      'store',
    ]);
    expect(inventoryClose).toHaveBeenCalledOnce();
    expect(agent.finalizationRuntime.getRecoveryStore()).toBeUndefined();
    expect(agent.rfc64PersistenceV1).toBeUndefined();
    expect(agent.started).toBe(false);
  });

  it('awaits finalization inbox drain before RFC-64 persistence and store teardown', async () => {
    const order: string[] = [];
    const drain = deferred();
    const recoveryClose = vi.fn(async () => {
      await drain.promise;
      order.push('recovery');
    });
    const agent = minimalStartedAgent(
      order,
      () => { order.push('inventory'); },
      recoveryClose,
    );

    const stop = agent.stop();
    let settled = false;
    void stop.finally(() => { settled = true; });
    await vi.waitFor(() => expect(recoveryClose).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(order).toEqual(['node', 'sync-worker']);
    expect(agent.store.close).not.toHaveBeenCalled();
    expect(agent.started).toBe(true);
    expect(settled).toBe(false);

    drain.resolve();
    await expect(stop).resolves.toBeUndefined();
    expect(order).toEqual([
      'node',
      'sync-worker',
      'recovery',
      'control-store',
      'inventory',
      'store',
    ]);
    expect(agent.started).toBe(false);
  });

  it('keeps shutdown active and the triple store open until persistence drain settles', async () => {
    const order: string[] = [];
    const drain = deferred();
    const persistenceClose = vi.fn(async () => {
      await drain.promise;
      order.push('inventory');
    });
    const agent = minimalStartedAgent(order, persistenceClose);

    const stop = agent.stop();
    let settled = false;
    void stop.finally(() => { settled = true; });
    await vi.waitFor(() => expect(persistenceClose).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(order).toEqual(['node', 'sync-worker', 'recovery', 'control-store']);
    expect(agent.store.close).not.toHaveBeenCalled();
    expect(agent.started).toBe(true);
    expect(settled).toBe(false);

    drain.resolve();
    await expect(stop).resolves.toBeUndefined();
    expect(order).toEqual([
      'node',
      'sync-worker',
      'recovery',
      'control-store',
      'inventory',
      'store',
    ]);
    expect(agent.started).toBe(false);
  });

  it('finishes store teardown but rejects shutdown when asynchronous persistence close fails', async () => {
    const order: string[] = [];
    const failure = new Error('inventory close failed');
    const agent = minimalStartedAgent(order, async () => {
      await Promise.resolve();
      order.push('inventory');
      throw failure;
    });

    await expect(agent.stop()).rejects.toBe(failure);

    expect(order).toEqual([
      'node',
      'sync-worker',
      'recovery',
      'control-store',
      'inventory',
      'store',
    ]);
    expect(agent.rfc64PersistenceV1).toBeUndefined();
    expect(agent.started).toBe(false);
    await expect(agent.stop()).resolves.toBeUndefined();
  });

  it('continues teardown and aggregates finalization and RFC-64 close failures', async () => {
    const order: string[] = [];
    const recoveryFailure = new Error('finalization recovery close failed');
    const inventoryFailure = new Error('inventory close failed');
    const agent = minimalStartedAgent(
      order,
      async () => {
        order.push('inventory');
        throw inventoryFailure;
      },
      async () => {
        order.push('recovery');
        throw recoveryFailure;
      },
    );

    const rejection = await agent.stop().catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).errors).toEqual([
      recoveryFailure,
      inventoryFailure,
    ]);
    expect(order).toEqual([
      'node',
      'sync-worker',
      'recovery',
      'control-store',
      'inventory',
      'store',
    ]);
    expect(agent.finalizationRuntime.getRecoveryStore()).toBeUndefined();
    expect(agent.rfc64PersistenceV1).toBeUndefined();
    expect(agent.started).toBe(false);
    await expect(agent.stop()).resolves.toBeUndefined();
  });

  it.runIf(process.platform !== 'win32')(
    'restarts after graceful SIGTERM inventory release',
    async () => {
      const dataDirectory = temporaryDataDirectory();
      const first = spawnLifecycleHolder(dataDirectory);
      await waitForReady(first);
      expect(await terminate(first, 'SIGTERM')).toEqual({ code: 0, signal: null });

      const restarted = spawnLifecycleHolder(dataDirectory);
      await waitForReady(restarted);
      expect(await terminate(restarted, 'SIGTERM')).toEqual({ code: 0, signal: null });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'recovers the operating-system lease after SIGKILL without cleanup',
    async () => {
      const dataDirectory = temporaryDataDirectory();
      const first = spawnLifecycleHolder(dataDirectory);
      await waitForReady(first);
      expect(await terminate(first, 'SIGKILL')).toEqual({ code: null, signal: 'SIGKILL' });

      const restarted = spawnLifecycleHolder(dataDirectory);
      await waitForReady(restarted);
      expect(await terminate(restarted, 'SIGTERM')).toEqual({ code: 0, signal: null });
    },
  );
});
