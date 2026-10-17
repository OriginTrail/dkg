import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphManager, OxigraphStore } from '@origintrail-official/dkg-storage';
import { AsyncLiftRunner } from '../../publisher/src/async-lift-runner.js';
import { TripleStoreAsyncLiftPublisher } from '../../publisher/src/async-lift-publisher-impl.js';
import { createPublisherLiveControl, publisherDesiredStatePath } from '../src/publisher-live-control.js';
import { beginGracefulShutdown } from '../src/daemon/teardown.js';
import { handlePublisherLiveControlRoute } from '../src/daemon/routes/publisher-live-control.js';
import { createAllowedHttpAuthentication } from '../src/auth.js';
import { KA_VM_EXECUTOR_TX_HASH, kaVmPublishRequest, stageKnowledgeAssetShareSnapshot } from '../../../scripts/testing/ka-vm-publish.js';

const persistenceBarrier = vi.hoisted(() => ({ directory: null as string | null,
  entered: null as (() => void) | null, release: null as Promise<void> | null }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const file = await actual.open(...args);
    if (args[1] === 'wx' && persistenceBarrier.directory && String(args[0]).startsWith(persistenceBarrier.directory)) {
      persistenceBarrier.directory = null;
      const sync = file.sync.bind(file);
      file.sync = async () => { persistenceBarrier.entered?.(); await persistenceBarrier.release; await sync(); };
    }
    return file;
  } };
});

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(directory?: string, publisher?: TripleStoreAsyncLiftPublisher, startPaused = false) {
  const dataDir = directory ?? await mkdtemp(join(tmpdir(), 'dkg-publisher-control-'));
  if (!directory) cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const store = new OxigraphStore();
  cleanup.push(() => store.close());
  publisher ??= new TripleStoreAsyncLiftPublisher(store);
  const runner = new AsyncLiftRunner({ publisher, walletIds: ['one', 'two'], pollIntervalMs: 60_000 });
  cleanup.push(() => runner.stop());
  const control = await createPublisherLiveControl(runner, dataDir, startPaused);
  cleanup.push(() => control.close());
  return { dataDir, publisher, runner, control };
}

describe('durable control of the active publisher wallet loops', () => {
  it('persists pause and restores it before a recreated runner can claim accepted evidence', async () => {
    const first = await fixture();
    const paused = await first.control.pause();
    expect(paused).toMatchObject({ desiredState: 'paused', effectiveState: 'paused', generation: 1,
      acknowledgedGeneration: 1, wallets: [{ walletId: 'one', paused: true, generation: 1 }, { walletId: 'two', paused: true, generation: 1 }] });
    await first.control.close(); await first.runner.stop();
    const second = await fixture(first.dataDir);
    const jobId = await second.publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const before = await second.publisher.getStatus(jobId);
    await second.runner.start();
    expect(second.control.status()).toMatchObject(paused);
    expect(await second.publisher.claimNext('one')).toBeNull();
    expect(await second.publisher.claimNext('two')).toBeNull();
    expect(await second.publisher.getStatus(jobId)).toEqual(before);
    const resumed = await second.control.resume();
    expect(resumed).toMatchObject({ desiredState: 'running', effectiveState: 'running', generation: 2,
      wallets: [{ walletId: 'one', paused: false, generation: 2 }, { walletId: 'two', paused: false, generation: 2 }] });
    expect(JSON.parse(await readFile(publisherDesiredStatePath(first.dataDir), 'utf8'))).toMatchObject({ desiredState: 'running', generation: 2 });
  });

  it('startup pause overrides persisted running intent before accepted work can execute', async () => {
    const first = await fixture();
    await first.control.pause(); await first.control.resume();
    await first.control.close(); await first.runner.stop();
    const store = new OxigraphStore(); cleanup.push(() => store.close());
    const execute = vi.fn(async () => { throw new Error('test execution boundary reached'); });
    const publisher = new TripleStoreAsyncLiftPublisher(store, { knowledgeAssetVmPublishHandler: { execute } });
    await stageKnowledgeAssetShareSnapshot({ store, graphManager: new GraphManager(store) });
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const accepted = await publisher.getStatus(jobId);
    const second = await fixture(first.dataDir, publisher, true);
    expect(second.control.status()).toMatchObject({ desiredState: 'paused', effectiveState: 'paused',
      generation: 3, acknowledgedGeneration: 3 });
    expect(JSON.parse(await readFile(publisherDesiredStatePath(first.dataDir), 'utf8')))
      .toMatchObject({ desiredState: 'paused', generation: 3 });
    await second.runner.start();
    expect(await publisher.claimNext('probe')).toBeNull();
    expect(await publisher.getStatus(jobId)).toEqual(accepted);
    expect(execute).not.toHaveBeenCalled();
    expect((await second.control.resume()).generation).toBe(4);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
  });

  it('serializes concurrent operators and does not increment generation for an idempotent repeat', async () => {
    const { control, dataDir } = await fixture();
    const responses = await Promise.all([control.pause(), control.pause(), control.resume(), control.pause()]);
    expect(responses.map(s => [s.desiredState, s.generation])).toEqual([['paused', 1], ['paused', 1], ['running', 2], ['paused', 3]]);
    for (const response of responses) expect(response.wallets).toEqual(['one', 'two'].map(walletId => ({ walletId,
      paused: response.desiredState === 'paused', generation: response.generation })));
    expect(JSON.parse(await readFile(publisherDesiredStatePath(dataDir), 'utf8'))).toMatchObject({ desiredState: 'paused', generation: 3 });
  });

  it('cannot reopen a runner after terminal claim closure', async () => {
    const { runner, control } = await fixture();
    await control.pause(); await control.close();
    await expect(runner.releaseClaims()).rejects.toThrow('closed');
    await expect(control.resume()).rejects.toThrow('unavailable');
    expect(control.status().wallets.every(w => w.paused && w.generation === 1)).toBe(true);
  });

  it('keeps every gate closed and returns no acknowledgement when durable intent cannot be written', async () => {
    const { control, dataDir, publisher } = await fixture();
    await rename(dataDir, `${dataDir}.held`);
    cleanup.push(() => rm(`${dataDir}.held`, { recursive: true, force: true }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = { statusCode: 0, body: '', writeHead(code: number) { this.statusCode = code; return this; },
      end(body: string) { this.body = body; return this; } };
    try {
      await handlePublisherLiveControlRoute({
        req: Object.assign(Readable.from([]), { method: 'POST', __dkgPrebufferedBody: Buffer.from('{}') }),
        res, path: '/api/publisher/pause', publisherState: { runtime: { control } },
        authentication: createAllowedHttpAuthentication({ mode: 'authenticated', presentedToken: 'operator',
          acceptedToken: 'operator', resolveAgentByToken: () => undefined }),
      } as unknown as Parameters<typeof handlePublisherLiveControlRoute>[0]);
      expect(res.statusCode).toBe(503);
      expect(res.body).not.toContain(dataDir); expect(res.body).not.toContain('ENOENT');
      expect(log).toHaveBeenCalledOnce();
      expect(log.mock.calls[0]?.[1]).toMatchObject({ cause: { code: 'ENOENT' } });
    } finally { log.mockRestore(); }
    expect(control.status()).toMatchObject({ effectiveState: 'unavailable', acknowledgedGeneration: 0, fault: 'persistence_or_control_failed' });
    expect(control.status().wallets.every(w => w.paused)).toBe(true);
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    expect(await publisher.claimNext('one')).toBeNull();
    await expect(control.resume()).rejects.toThrow('unavailable');
  });

  it('fences a resume waiting on durable persistence when the runtime begins closing', async () => {
    const { dataDir, control, runner, publisher } = await fixture();
    await control.pause(); await runner.start();
    let entered!: () => void; const syncing = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    persistenceBarrier.directory = dataDir; persistenceBarrier.entered = entered; persistenceBarrier.release = held;
    const resuming = control.resume();
    // Attach the rejection assertion before closing can reject the pending operation.
    const rejected = expect(resuming).rejects.toThrow('could not commit');
    await syncing;
    const closing = control.close();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const accepted = await publisher.getStatus(jobId);
    release(); await rejected; await closing;
    expect(runner.claimGateStatus().held).toBe(true);
    expect(await publisher.claimNext('late')).toBeNull();
    expect(await publisher.getStatus(jobId)).toEqual(accepted);
    // The persisted resume is intent for the next incarnation, never permission for this closed one.
    expect(JSON.parse(await readFile(publisherDesiredStatePath(dataDir), 'utf8'))).toMatchObject({ desiredState: 'running', generation: 2 });
  });

  it('fences an HTTP resume at daemon shutdown entry before HTTP requests drain', async () => {
    const { dataDir, control, runner, publisher } = await fixture();
    await control.pause(); await runner.start();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const accepted = await publisher.getStatus(jobId);
    const server = createServer(async (req, res) => {
      await handlePublisherLiveControlRoute({ req, res, path: '/api/publisher/resume',
        authentication: createAllowedHttpAuthentication({ mode: 'authenticated', presentedToken: 'operator',
          acceptedToken: 'operator', resolveAgentByToken: () => undefined }),
        publisherState: { runtime: { control } },
      } as Parameters<typeof handlePublisherLiveControlRoute>[0]);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
    let entered!: () => void; const syncing = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    persistenceBarrier.directory = dataDir; persistenceBarrier.entered = entered; persistenceBarrier.release = held;
    const resuming = fetch(`http://127.0.0.1:${address.port}/api/publisher/resume`, { method: 'POST', body: '{}' });
    let releasePort!: () => void; const portHeld = new Promise<void>(resolve => { releasePort = resolve; });
    let shutdown: Promise<void> | undefined;
    try {
      await syncing;
      shutdown = beginGracefulShutdown({ state: { catchupAcceptingJobs: true },
        publisherControl: control, removeApiPort: () => portHeld, log: () => {} });
      expect(control.status().effectiveState).toBe('unavailable');
      release();
      expect((await resuming).status).toBe(503);
      expect(await publisher.claimNext('late')).toBeNull();
      expect(await publisher.getStatus(jobId)).toEqual(accepted);
      expect(JSON.parse(await readFile(publisherDesiredStatePath(dataDir), 'utf8')))
        .toMatchObject({ desiredState: 'running', generation: 2 });
    } finally { release(); releasePort(); await resuming; await shutdown; }
  });

  it('cannot release claims when close races the publisher resume await', async () => {
    const { control, runner, publisher } = await fixture();
    await control.pause(); await runner.start();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const accepted = await publisher.getStatus(jobId);
    let entered!: () => void; const resumingPublisher = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const originalResume = publisher.resume.bind(publisher);
    vi.spyOn(publisher, 'resume').mockImplementationOnce(async () => {
      entered(); await held; await originalResume();
    });
    const resuming = control.resume();
    const rejected = expect(resuming).rejects.toThrow('could not commit');
    await resumingPublisher;
    const closing = control.close();
    release(); await rejected; await closing;
    expect(runner.claimGateStatus().held).toBe(true);
    expect(await publisher.claimNext('probe')).toBeNull();
    expect(await publisher.getStatus(jobId)).toEqual(accepted);
  });

  it('keeps accepted work fenced until resumed intent finishes fsync', async () => {
    const store = new OxigraphStore(); cleanup.push(() => store.close());
    const execute = vi.fn(async () => { throw new Error('test execution boundary reached'); });
    const publisher = new TripleStoreAsyncLiftPublisher(store, { knowledgeAssetVmPublishHandler: { execute } });
    await stageKnowledgeAssetShareSnapshot({ store, graphManager: new GraphManager(store) });
    const { dataDir, control, runner } = await fixture(undefined, publisher);
    await control.pause();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const accepted = await publisher.getStatus(jobId);
    await runner.start();
    let entered!: () => void; const syncing = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    persistenceBarrier.directory = dataDir; persistenceBarrier.entered = entered; persistenceBarrier.release = held;
    const resuming = control.resume();
    try {
      await syncing;
      expect(runner.claimGateStatus().held).toBe(true);
      expect(await publisher.claimNext('probe')).toBeNull();
      expect(await publisher.getStatus(jobId)).toEqual(accepted);
      expect(execute).not.toHaveBeenCalled();
    } finally { release(); await resuming; }
    expect(JSON.parse(await readFile(publisherDesiredStatePath(dataDir), 'utf8'))).toMatchObject({ desiredState: 'running', generation: 2 });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
  });

  it('fails startup closed on corrupt persisted state instead of silently resuming', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-corrupt-'));
    cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
    await writeFile(publisherDesiredStatePath(dataDir), '{broken');
    const store = new OxigraphStore(); cleanup.push(() => store.close());
    const publisher = new TripleStoreAsyncLiftPublisher(store);
    const runner = new AsyncLiftRunner({ publisher, walletIds: ['one', 'two'] });
    cleanup.push(() => runner.stop());
    expect(!runner.claimGateStatus().held).toBe(true);
    await expect(createPublisherLiveControl(runner, dataDir)).rejects.toBeInstanceOf(SyntaxError);
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    expect(await publisher.claimNext('two')).toBeNull();
    expect(runner.claimGateStatus().held).toBe(true);
  });

  it('lets an execution already in flight record broadcast evidence after pause acknowledgement', async () => {
    const store = new OxigraphStore(); cleanup.push(() => store.close());
    let release!: () => void; const held = new Promise<void>(done => { release = done; });
    let entered!: () => void; const executing = new Promise<void>(done => { entered = done; });
    const publisher = new TripleStoreAsyncLiftPublisher(store, {
      chainProofResolver: async () => ({ status: 'pending-mempool' }),
      knowledgeAssetVmPublishHandler: { execute: async input => {
        entered(); await held;
        await input.publishOptions.onBeforeBroadcast?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
        throw new Error('submission acknowledgement lost');
      } },
    });
    await stageKnowledgeAssetShareSnapshot({ store, graphManager: new GraphManager(store) });
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const { control, runner } = await fixture(undefined, publisher);
    await runner.start(); await executing;
    try {
      expect((await control.pause()).effectiveState).toBe('paused');
      expect(await publisher.claimNext('other')).toBeNull();
    } finally { release(); }
    await vi.waitFor(async () => expect((await publisher.getStatus(jobId))?.status).toBe('broadcast'));
    expect((await publisher.getStatus(jobId))?.broadcast?.txHash).toBe(KA_VM_EXECUTOR_TX_HASH);
  });
});
