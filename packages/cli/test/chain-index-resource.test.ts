import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardDB } from '@origintrail-official/dkg-node-ui';
import {
  createDaemonChainIndexResource,
  createStartupChainIndexCloseGuard,
  rethrowAfterStartupCleanup,
} from '../src/daemon/chain-index-resource.js';
import { closeDaemonBackingStoresAfterTeardown } from '../src/daemon/teardown.js';

describe('process-owned chain-index resource', () => {
  const databases: DashboardDB[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) {
      if (db.db.open) db.close();
      rmSync(db.dataDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  function database() {
    const db = new DashboardDB({ dataDir: mkdtempSync(join(tmpdir(), 'chain-index-resource-')) });
    databases.push(db);
    return db;
  }

  it('shares a fixed reader and dependency drain across concurrent close requests', async () => {
    const db = database();
    const closeDb = vi.spyOn(db, 'close');
    let retire!: () => void;
    const gate = new Promise<void>((resolve) => { retire = resolve; });
    const reader = { close: vi.fn(() => gate), createReadModel: vi.fn() };
    const createReader = vi.fn(() => reader);
    let drained!: () => void;
    const dependencyGate = new Promise<void>((resolve) => { drained = resolve; });
    const drain = vi.fn(() => dependencyGate);
    const options = { log: () => {}, beforeDatabaseClose: drain, createReader };
    const resource = createDaemonChainIndexResource(db, options);
    // Ownership is fixed at construction, even if the caller mutates its options.
    options.beforeDatabaseClose = vi.fn(async () => {});
    expect(createReader.mock.calls[0]).toEqual([
      join(db.dataDir, 'node-ui.db'), resource.capability.store,
      { onDiagnostic: expect.any(Function) },
    ]);
    expect(resource.capability.readModelFactory).toBe(reader.createReadModel);

    const first = resource.close();
    const concurrent = resource.close();
    expect(concurrent).toBe(first);
    await Promise.resolve();
    expect(reader.close).toHaveBeenCalledOnce();
    expect(closeDb).not.toHaveBeenCalled();
    expect(db.db.open).toBe(true);
    retire();
    await vi.waitUntil(() => drain.mock.calls.length === 1);
    expect(resource.close()).toBe(first);
    expect(closeDb).not.toHaveBeenCalled();
    expect(options.beforeDatabaseClose).not.toHaveBeenCalled();
    drained();
    await first;
    expect(drain).toHaveBeenCalledOnce();
    expect(resource.close()).toBe(first);
    expect(closeDb).toHaveBeenCalledOnce();
    expect(db.db.open).toBe(false);
  });

  it('keeps the database live when reader retirement fails', async () => {
    const db = database();
    const failure = new Error('reader still active');
    const reader = { close: vi.fn(async () => { throw failure; }), createReadModel: vi.fn() };
    const resource = createDaemonChainIndexResource(db, { log: () => {}, beforeDatabaseClose: async () => {}, createReader: () => reader });
    await expect(resource.close()).rejects.toBe(failure);
    await expect(resource.close()).rejects.toBe(failure);
    expect(reader.close).toHaveBeenCalledOnce();
    expect(db.db.open).toBe(true);
  });

  it('awaits a started agent on failed boot before closing its writable database', async () => {
    const db = database();
    const events: string[] = [];
    const guard = createStartupChainIndexCloseGuard();
    let release!: () => void;
    let stopping!: () => void;
    const retirement = new Promise<void>((resolve) => { release = resolve; });
    const stopStarted = new Promise<void>((resolve) => { stopping = resolve; });
    guard.agentCreated(async () => {
      events.push('agent-stopping');
      stopping();
      await retirement;
      events.push('agent-stopped');
    });
    const actualClose = db.close.bind(db);
    vi.spyOn(db, 'close').mockImplementation(() => { events.push('database'); actualClose(); });
    const resource = createDaemonChainIndexResource(db, {
      log: () => {}, beforeDatabaseClose: guard.beforeDatabaseClose,
      createReader: () => ({ createReadModel: vi.fn(), close: async () => { events.push('reader'); } }),
    });
    const bootFailure = new Error('boot failed after agent started');
    const failure = rethrowAfterStartupCleanup(bootFailure,
      () => resource.close()).catch((error: unknown) => error);
    await stopStarted;
    expect(events).toEqual(['reader', 'agent-stopping']);
    expect(db.db.open).toBe(true);
    // In-flight agent work can still access its backing DB until retirement.
    db.db.prepare('SELECT count(*) FROM chain_events').get();
    release();
    expect(await failure).toBe(bootFailure);
    expect(events).toEqual(['reader', 'agent-stopping', 'agent-stopped', 'database']);
  });

  it.each(['failed agent stop', 'later daemon consumers'])('retires the reader but preserves DB for %s', async (reason) => {
    const db = database();
    const guard = createStartupChainIndexCloseGuard();
    const stopFailure = new Error('physical agent retirement unproved');
    const stop = vi.fn(async () => { throw stopFailure; });
    guard.agentCreated(stop);
    if (reason === 'later daemon consumers') guard.daemonConsumersStarted();
    const reader = { createReadModel: vi.fn(), close: vi.fn(async () => {}) };
    const resource = createDaemonChainIndexResource(db, { log: () => {}, beforeDatabaseClose: guard.beforeDatabaseClose, createReader: () => reader });
    const bootFailure = new Error('original late startup error');
    const error = await rethrowAfterStartupCleanup(bootFailure,
      () => resource.close()).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).cause).toBe(bootFailure);
    expect((error as AggregateError).errors[0]).toBe(bootFailure);
    expect((error as AggregateError).errors[1]).toBeInstanceOf(Error);
    expect(reader.close).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledTimes(reason === 'failed agent stop' ? 1 : 0);
    expect(db.db.open).toBe(true);
  });

  it('uses the same owner during normal backing-store teardown', async () => {
    const db = database();
    const events: string[] = [];
    const guard = createStartupChainIndexCloseGuard();
    guard.daemonConsumersStarted();
    const actualClose = db.close.bind(db);
    vi.spyOn(db, 'close').mockImplementation(() => { events.push('database'); actualClose(); });
    const resource = createDaemonChainIndexResource(db, {
      log: () => {}, beforeDatabaseClose: guard.beforeDatabaseClose,
      createReader: () => ({
        createReadModel: vi.fn(), close: async () => { events.push('reader'); },
      }),
    });
    await closeDaemonBackingStoresAfterTeardown({ failures: [], dependencyQuarantined: false }, {
      retryAgentStop: async () => {},
      stopManagedOxigraph: async () => { events.push('managed-store'); },
      closeDashboardDb: () => {
        guard.dependenciesDrained();
        return resource.close();
      },
      log: () => {},
    });
    expect(events).toEqual(['managed-store', 'reader', 'database']);
    await resource.close();
    expect(events).toEqual(['managed-store', 'reader', 'database']);
  });

  it('closes the database if constructing its reader fails', () => {
    const db = database();
    expect(() => createDaemonChainIndexResource(db, {
      log: () => {}, beforeDatabaseClose: async () => {}, createReader: () => { throw new Error('reader construction failed'); },
    })).toThrow('reader construction failed');
    expect(db.db.open).toBe(false);
  });
});
