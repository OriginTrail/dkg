import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EVMChainAdapter,
  RpcRequestGovernorQueueFullError,
} from '@origintrail-official/dkg-chain';
import { generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { AsyncLiftRunner, TripleStoreAsyncLiftPublisher } from '@origintrail-official/dkg-publisher';
import { createTripleStore, OxigraphStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { type DkgConfig } from '../src/config.js';
import { createPublisherRuntime, startPublisherRuntimeIfEnabled, type PublisherRuntime } from '../src/publisher-runner.js';
import { addPublisherWallet } from '../src/publisher-wallets.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('publisher startup ownership and cancellation', () => {
  let dataDir: string | undefined;
  let store: TripleStore | undefined;
  const startups: Promise<PublisherRuntime | null>[] = [];
  const releasePending: (() => void)[] = [];
  const chains = new Set<EVMChainAdapter>();
  const destroyChain = EVMChainAdapter.prototype.destroy;

  afterEach(async () => {
    // Release every barrier even after a failed assertion; never strand a real
    // runner inside recovery while its borrowed store is being closed.
    for (const release of releasePending.splice(0)) release();
    for (const result of await Promise.allSettled(startups.splice(0))) {
      if (result.status === 'fulfilled') await result.value?.stop();
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const chain of chains) destroyChain.call(chain);
    chains.clear();
    await store?.close();
    store = undefined;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  async function fixture(walletCount = 1) {
    vi.stubEnv('DKG_PUBLISHER_START_PAUSED', '');
    dataDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-startup-lifecycle-'));
    store = await createTripleStore({ backend: 'oxigraph' });
    for (let i = 0; i < walletCount; i += 1) {
      await addPublisherWallet(dataDir, ethers.Wallet.createRandom().privateKey);
    }
    // Keep real wallet adapters, publisher construction and AsyncLiftRunner.
    // Only identity I/O is replaced: no endpoint or daemon is ever contacted.
    const identity = vi.spyOn(EVMChainAdapter.prototype, 'getIdentityId')
      .mockImplementation(async function (this: EVMChainAdapter) {
        chains.add(this);
        return 11n;
      });
    const destroy = vi.spyOn(EVMChainAdapter.prototype, 'destroy');
    const start = vi.spyOn(AsyncLiftRunner.prototype, 'start');
    const stop = vi.spyOn(AsyncLiftRunner.prototype, 'stop');
    const processNext = vi.spyOn(TripleStoreAsyncLiftPublisher.prototype, 'processNext')
      .mockResolvedValue(null);
    const closeStore = vi.spyOn(store, 'close');
    const controller = new AbortController();
    const args: Parameters<typeof startPublisherRuntimeIfEnabled>[0] = {
      dataDir,
      store,
      keypair: await generateEd25519Keypair(),
      config: {
        name: 'publisher-startup-lifecycle-test',
        apiPort: 0,
        listenPort: 0,
        nodeRole: 'edge',
        publisher: { enabled: true, pollIntervalMs: 600_000 },
      } as DkgConfig,
      chainBase: {
        rpcUrl: 'http://127.0.0.1:1',
        hubAddress: '0x1111111111111111111111111111111111111111',
        chainId: 'evm:31337',
      },
      startupSignal: controller.signal,
      log: vi.fn(),
    };
    return {
      store, identity, destroy, start, stop, processNext, closeStore, controller,
      begin() {
        const startup = startPublisherRuntimeIfEnabled(args);
        startups.push(startup);
        // Observe rejection immediately, including if a barrier assertion fails.
        void startup.catch(() => {});
        return startup;
      },
    };
  }

  async function expectBorrowedStoreOpen(f: Awaited<ReturnType<typeof fixture>>) {
    expect(f.closeStore).not.toHaveBeenCalled();
    await expect(f.store.query('ASK {}')).resolves.toMatchObject({ type: 'boolean', value: true });
  }

  it('latches stop during real runner recovery and never claims after abort', async () => {
    const f = await fixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    releasePending.push(() => release.resolve());
    const createGraph = f.store.createGraph.bind(f.store);
    vi.spyOn(f.store, 'createGraph').mockImplementationOnce(async (graph) => {
      entered.resolve();
      await release.promise;
      return createGraph(graph);
    });

    const startup = f.begin();
    await entered.promise;
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.destroy).not.toHaveBeenCalled();
    const reason = new Error('shutdown while startup recovery owns the store');
    f.controller.abort(reason);
    // No timer/microtask advance: stop must latch in the abort dispatch itself.
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(f.stop.mock.contexts[0]).toBe(f.start.mock.contexts[0]);
    expect(f.destroy).not.toHaveBeenCalled();

    release.resolve();
    await expect(startup.then(() => undefined)).rejects.toBe(reason);
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.stop).toHaveBeenCalledTimes(2);
    expect(f.processNext).not.toHaveBeenCalled();
    expect(f.destroy.mock.contexts).toEqual(f.identity.mock.contexts);
    await expectBorrowedStoreOpen(f);
  });

  it('never retries runner.start even when recovery returns typed local capacity', async () => {
    const f = await fixture();
    const failure = new RpcRequestGovernorQueueFullError(1);
    const createGraph = vi.spyOn(f.store, 'createGraph').mockRejectedValueOnce(failure);

    await expect(f.begin().then(() => undefined)).rejects.toBe(failure);
    expect(f.identity).toHaveBeenCalledTimes(1);
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(createGraph).toHaveBeenCalledTimes(1);
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(f.processNext).not.toHaveBeenCalled();
    expect(f.destroy.mock.contexts).toEqual(f.identity.mock.contexts);
    await expectBorrowedStoreOpen(f);
  });

  it('cleans previous and failing adapters without masking identity failure if one destroy throws', async () => {
    const f = await fixture(3);
    const failure = new Error('permanent identity lookup failure');
    let identityCalls = 0;
    f.identity.mockImplementation(async function (this: EVMChainAdapter) {
      chains.add(this);
      identityCalls += 1;
      if (identityCalls === 2) throw failure;
      return 11n;
    });
    f.destroy.mockImplementationOnce(function (this: EVMChainAdapter) {
      destroyChain.call(this);
      throw new Error('first adapter cleanup failed');
    });

    await expect(f.begin().then(() => undefined)).rejects.toBe(failure);
    expect(f.identity).toHaveBeenCalledTimes(2);
    expect(f.destroy).toHaveBeenCalledTimes(2);
    expect(f.destroy.mock.contexts).toEqual(f.identity.mock.contexts);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.processNext).not.toHaveBeenCalled();
    await expectBorrowedStoreOpen(f);
  });

  it('rejects a late identity success after abort and retires its adapter before runner.start', async () => {
    const f = await fixture();
    const entered = deferred<void>();
    const release = deferred<bigint>();
    releasePending.push(() => release.resolve(11n));
    f.identity.mockImplementationOnce(function (this: EVMChainAdapter) {
      chains.add(this);
      entered.resolve();
      return release.promise;
    });
    const startup = f.begin();
    await entered.promise;
    const reason = new Error('shutdown during identity bootstrap');
    let outcome: unknown;
    const settled = startup.catch(error => { outcome = error; });
    f.controller.abort(reason);
    // Shutdown must release the factory and destroy its adapter BEFORE a
    // noncooperating physical read returns, not merely reject a late result.
    await vi.waitFor(() => expect(outcome).toBe(reason));
    expect(f.start).not.toHaveBeenCalled();
    expect(f.processNext).not.toHaveBeenCalled();
    expect(f.destroy.mock.contexts).toEqual(f.identity.mock.contexts);
    await expectBorrowedStoreOpen(f);
    release.resolve(11n);
    await settled;
    await Promise.resolve();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.destroy).toHaveBeenCalledTimes(1);
  });

  it('does not construct or start a publisher for an already-aborted startup', async () => {
    const f = await fixture();
    const reason = new Error('shutdown before deferred startup');
    f.controller.abort(reason);
    await expect(f.begin().then(() => undefined)).rejects.toBe(reason);
    expect(f.identity).not.toHaveBeenCalled();
    expect(f.destroy).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    await expectBorrowedStoreOpen(f);
  });

  it('hands healthy adapters to the runtime and keeps the borrowed store open on normal stop', async () => {
    const f = await fixture(2);
    const runtime = await f.begin();
    expect(runtime).not.toBeNull();
    expect(runtime?.wallets).toHaveLength(2);
    expect(f.identity).toHaveBeenCalledTimes(2);
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.processNext).toHaveBeenCalledTimes(2);
    expect(f.destroy).not.toHaveBeenCalled();
    await runtime!.stop();
    expect(f.destroy.mock.contexts).toEqual(f.identity.mock.contexts);
    await expectBorrowedStoreOpen(f);
  });

  it.each([false, true])('closes its standalone store once and preserves identity failure (close fails: %s)', async (closeFails) => {
    const f = await fixture();
    const failure = new Error('standalone identity lookup failure');
    f.identity.mockImplementationOnce(async function (this: EVMChainAdapter) {
      chains.add(this);
      throw failure;
    });
    const close = OxigraphStore.prototype.close;
    const closeOwnedStore = vi.spyOn(OxigraphStore.prototype, 'close')
      .mockImplementation(async function (this: OxigraphStore) {
        await close.call(this);
        if (closeFails) throw new Error('standalone store close failure');
      });
    const startup = createPublisherRuntime({
      dataDir: dataDir!,
      config: {
        name: 'standalone-publisher-startup-test',
        apiPort: 0,
        listenPort: 0,
        nodeRole: 'edge',
        store: { backend: 'oxigraph' },
        largeLiteralStorage: { enabled: false },
        chain: {
          type: 'evm',
          rpcUrl: 'http://127.0.0.1:1',
          hubAddress: '0x1111111111111111111111111111111111111111',
          chainId: 'evm:31337',
        },
      },
    });
    startups.push(startup);

    await expect(startup).rejects.toBe(failure);
    expect(closeOwnedStore).toHaveBeenCalledTimes(1);
    expect(closeOwnedStore.mock.contexts[0]).not.toBe(f.store);
    expect(f.identity).toHaveBeenCalledTimes(1);
    expect(f.destroy.mock.contexts).toEqual(f.identity.mock.contexts);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.processNext).not.toHaveBeenCalled();
    await expectBorrowedStoreOpen(f);
  });
});
