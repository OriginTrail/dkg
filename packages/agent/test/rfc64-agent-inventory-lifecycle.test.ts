import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DKGAgent } from '../src/dkg-agent.js';
import {
  INVENTORY_V1_RELATIVE_PATH,
  openInventoryV1,
} from '../src/rfc64/inventory-v1/index.js';
import {
  RFC64_CONTROL_OBJECT_STORE_RELATIVE_PATH,
  openRfc64ControlObjectStoreV1,
} from '../src/rfc64/control-object-store-v1.js';
import {
  createRfc64PersistenceOwnerCapabilityV1,
  type Rfc64PersistenceOwnerCapabilityV1,
} from '../src/rfc64/persistence-owner-capability-v1.js';

const temporaryDirectories: string[] = [];
const childProcesses = new Set<ChildProcessWithoutNullStreams>();
const CHILD_FIXTURE = resolve(
  import.meta.dirname,
  'fixtures/rfc64-agent-inventory-lifecycle-child.ts',
);

function temporaryDataDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dkg-rfc64-agent-')));
  temporaryDirectories.push(directory);
  return directory;
}

function syntheticAgent(dataDirectory?: string): any {
  const agent = Object.create(DKGAgent.prototype) as any;
  Object.assign(agent, {
    config: dataDirectory === undefined ? {} : { dataDir: dataDirectory },
    rfc64PersistenceV1: undefined,
  });
  return agent;
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
  inventoryClose: () => void,
): any {
  const agent = syntheticAgent();
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
        inventoryClose();
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

    await agent.prepareRfc64InventoryV1();
    await agent.prepareRfc64InventoryV1();

    expect(agent.rfc64PersistenceV1).toBeUndefined();
    expect(() => agent.closeRfc64InventoryV1()).not.toThrow();
    expect(() => agent.closeRfc64InventoryV1()).not.toThrow();
  });

  it('owns one persistent foundation and purges every stale candidate in bounded yielding batches', async () => {
    const dataDirectory = temporaryDataDirectory();
    await seedStaleCandidateLoads(dataDirectory, 17);
    const agent = syntheticAgent(dataDirectory);
    const yieldBatch = vi.fn(async () => {});
    agent.yieldRfc64InventoryV1StartupBatch = yieldBatch;

    await agent.prepareRfc64InventoryV1();
    const ownedPersistence = agent.rfc64PersistenceV1;
    const ownedFoundation = ownedPersistence.inventory;
    const ownedControlObjectStore = ownedPersistence.controlObjectStore;
    await agent.prepareRfc64InventoryV1();

    expect(agent.rfc64PersistenceV1).toBe(ownedPersistence);
    expect(ownedFoundation.databasePath).toBe(
      join(dataDirectory, INVENTORY_V1_RELATIVE_PATH),
    );
    expect(yieldBatch).toHaveBeenCalledTimes(3);
    expect(() => ownedFoundation.createCandidateSession()).not.toThrow();
    expect(ownedControlObjectStore.rootPath).toBe(
      join(dataDirectory, RFC64_CONTROL_OBJECT_STORE_RELATIVE_PATH),
    );

    agent.closeRfc64InventoryV1();
    expect(agent.rfc64PersistenceV1).toBeUndefined();
    expect(ownedPersistence.closed).toBe(true);
    expect(ownedControlObjectStore.closed).toBe(true);
    expect(candidateLoadCount(dataDirectory)).toBe(0);
    expect(() => agent.closeRfc64InventoryV1()).not.toThrow();
  });

  it('fails startup before node.start when inventory acquisition or recovery fails', async () => {
    const failure = new Error('inventory unavailable');
    const nodeStart = vi.fn(async () => {});
    const agent = syntheticAgent();
    Object.assign(agent, {
      started: false,
      coreHostRecordingGeneration: 0,
      prepareRfc64InventoryV1: vi.fn(async () => { throw failure; }),
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
      const inventory = await openInventoryV1(dataDirectory);
      const ownership = createRfc64PersistenceOwnerCapabilityV1(
        dirname(inventory.databasePath),
        () => !inventory.closed,
      );
      const initialStore = await openRfc64ControlObjectStoreV1(
        ownership,
      );
      initialStore.close();
      inventory.close();
      const objectsPath = join(
        dataDirectory,
        RFC64_CONTROL_OBJECT_STORE_RELATIVE_PATH,
        'objects',
      );
      rmSync(objectsPath, { recursive: true, force: true });
      symlinkSync(outside, objectsPath, 'dir');
      const agent = syntheticAgent(dataDirectory);

      await expect(agent.prepareRfc64InventoryV1())
        .rejects.toMatchObject({ code: 'control-store-unsafe-path' });
      expect(agent.rfc64PersistenceV1).toBeUndefined();

      const replacement = await openInventoryV1(dataDirectory);
      replacement.close();
    },
  );

  it('requires an unforgeable live aggregate persistence owner capability', async () => {
    const dataDirectory = temporaryDataDirectory();
    const inventory = await openInventoryV1(dataDirectory);
    const ownership = createRfc64PersistenceOwnerCapabilityV1(
      dirname(inventory.databasePath),
      () => !inventory.closed,
    );

    const store = await openRfc64ControlObjectStoreV1(ownership);
    store.close();
    await expect(openRfc64ControlObjectStoreV1(
      {} as Rfc64PersistenceOwnerCapabilityV1,
    )).rejects.toMatchObject({ code: 'control-store-input' });
    inventory.close();
    await expect(openRfc64ControlObjectStoreV1(ownership))
      .rejects.toMatchObject({ code: 'control-store-input' });
  });

  it('releases an acquired inventory when node startup fails', async () => {
    const failure = new Error('node start failed');
    const close = vi.fn();
    const agent = syntheticAgent();
    Object.assign(agent, {
      started: false,
      coreHostRecordingGeneration: 0,
      prepareRfc64InventoryV1: vi.fn(async () => {
        agent.rfc64PersistenceV1 = { close };
      }),
      node: { start: vi.fn(async () => { throw failure; }) },
      log: { info: vi.fn(), warn: vi.fn() },
    });

    await expect(agent.start()).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
    expect(agent.rfc64PersistenceV1).toBeUndefined();
    expect(agent.started).toBe(false);
  });

  it('closes after network consumers and before the triple store, with idempotent stop', async () => {
    const order: string[] = [];
    const inventoryClose = vi.fn(() => { order.push('inventory'); });
    const agent = minimalStartedAgent(order, inventoryClose);

    await agent.stop();
    await agent.stop();

    expect(order).toEqual(['node', 'sync-worker', 'control-store', 'inventory', 'store']);
    expect(inventoryClose).toHaveBeenCalledOnce();
    expect(agent.rfc64PersistenceV1).toBeUndefined();
    expect(agent.started).toBe(false);
  });

  it('finishes store teardown but rejects shutdown when inventory close fails', async () => {
    const order: string[] = [];
    const failure = new Error('inventory close failed');
    const agent = minimalStartedAgent(order, () => {
      order.push('inventory');
      throw failure;
    });

    await expect(agent.stop()).rejects.toBe(failure);

    expect(order).toEqual(['node', 'sync-worker', 'control-store', 'inventory', 'store']);
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
