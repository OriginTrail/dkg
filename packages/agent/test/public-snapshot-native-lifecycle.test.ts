import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, readdir, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PublicCheckpointMethods } from '../src/dkg-agent-public-checkpoint.js';
import { createFreshPublicCheckpointEdge, openFreshPublicCheckpointEdge } from '../src/snapshot-fresh-edge.js';
import { resumePublicCheckpointEdge, openResumablePublicCheckpointEdge } from '../src/snapshot-resume-edge.js';
import { VmReconcileShutdownTimeoutError } from '../src/vm-reconcile-service.js';
import { startSnapshotNativeProcess } from '../src/snapshot-native-process.js';
import { handoffFixture } from './helpers/native-checkpoint-fixture.js';

const lifecycle = vi.hoisted(() => ({ events: [] as string[], current: true, startupFails: false, startFails: false,
  startup: vi.fn(), create: vi.fn(), stop: vi.fn(), sync: vi.fn(), close: vi.fn(), processStop: vi.fn() }));
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), statfs: vi.fn() }));
vi.mock('../src/snapshot-native-process.js', () => ({ startSnapshotNativeProcess: vi.fn() }));
vi.mock('@origintrail-official/dkg-storage', async original => ({
  ...await original<typeof import('@origintrail-official/dkg-storage')>(),
  BlazegraphStore: class { async close() { await lifecycle.close(); } },
}));
vi.mock('../src/dkg-agent.js', () => ({ DKGAgent: { create: lifecycle.create } }));
beforeEach(() => {
  vi.clearAllMocks(); lifecycle.startup.mockReset(); lifecycle.events.length = 0; lifecycle.current = true; lifecycle.startupFails = false; lifecycle.startFails = false;
  vi.mocked(statfs).mockResolvedValue({ bavail: 20 * 2 ** 30, bsize: 1 } as never);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
  lifecycle.processStop.mockImplementation(async () => { lifecycle.events.push('process stopped'); });
  lifecycle.close.mockImplementation(async () => { lifecycle.events.push('store closed'); });
  vi.mocked(startSnapshotNativeProcess).mockResolvedValue({ stop: lifecycle.processStop, assertRunning: vi.fn(), closed: Promise.resolve(0) });
  lifecycle.create.mockImplementation(async config => {
    let started = false;
    lifecycle.stop.mockImplementation(async () => { if (started) await config.store.close(); });
    lifecycle.sync.mockImplementation(async () => { lifecycle.events.push('catchup'); return { current: lifecycle.current, alreadyPresent: 1, completeAsOfSnapshot: true, assets: 1, committed: 1, inventoryDigest: 'c'.repeat(64) }; });
    return { start: async () => { if (lifecycle.startFails) throw new Error('listen failed'); started = true; lifecycle.events.push('start'); },
      waitForPublicCheckpointStartup: async (graph: string, signal: AbortSignal) => {
        await lifecycle.startup(graph, signal);
        lifecycle.events.push('startup barrier'); if (lifecycle.startupFails) throw new Error('startup failed');
      }, syncPublicGraphSnapshot: lifecycle.sync, stop: lifecycle.stop };
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('fresh checkpoint Edge and restart ownership', () => {
  it.each(['fresh', 'resume'] as const)('preserves the %s store on retirement timeout and retries shutdown', async mode => {
    const f = await handoffFixture();
    if (mode === 'resume') {
      const initial = await createFreshPublicCheckpointEdge(f.options);
      await initial.agent.stop();
    }
    lifecycle.close.mockClear(); lifecycle.processStop.mockClear();
    const session = await (mode === 'fresh' ? openFreshPublicCheckpointEdge : openResumablePublicCheckpointEdge)(f.options);
    try {
      await session.agent.start();
      const timeout = new VmReconcileShutdownTimeoutError(30_000);
      lifecycle.stop.mockRejectedValueOnce(timeout);
      const first = session.close();
      expect(session.close()).toBe(first);
      await expect(first).rejects.toBe(timeout);
      expect(lifecycle.close).not.toHaveBeenCalled();
      expect(lifecycle.processStop).not.toHaveBeenCalled();
      await expect(session.close()).resolves.toBeUndefined();
      expect(lifecycle.stop).toHaveBeenCalledTimes(mode === 'resume' ? 3 : 2);
      expect(lifecycle.close).toHaveBeenCalledTimes(1);
      expect(lifecycle.processStop).toHaveBeenCalledTimes(1);
      await session.close();
      expect(lifecycle.stop).toHaveBeenCalledTimes(mode === 'resume' ? 3 : 2);
    } finally { session.dispose(); }
  });
  it.each(['fresh', 'resume'] as const)('closes the native store when the %s agent never starts', async mode => {
    const f = await handoffFixture();
    if (mode === 'resume') {
      const initial = await createFreshPublicCheckpointEdge(f.options);
      await initial.agent.stop();
    }
    lifecycle.close.mockClear(); lifecycle.processStop.mockClear();
    lifecycle.startFails = true;
    const start = mode === 'fresh' ? createFreshPublicCheckpointEdge : resumePublicCheckpointEdge;
    await expect(start(f.options)).rejects.toThrow('listen failed');
    expect(lifecycle.close).toHaveBeenCalledTimes(1);
    expect(lifecycle.processStop).toHaveBeenCalledTimes(1);
  });
  it('keeps fresh and resumed Edges alive after their former job deadlines and caller cancellation', async () => {
    const f = await handoffFixture(), caller = new AbortController(); f.options.signal = caller.signal;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const fresh = await createFreshPublicCheckpointEdge(f.options);
    const firstSignal = lifecycle.sync.mock.calls.at(-1)![0].signal as AbortSignal;
    vi.advanceTimersByTime(3_600_001);
    expect(firstSignal.aborted).toBe(false); expect(lifecycle.processStop).not.toHaveBeenCalled();
    await fresh.agent.stop();
    const resumed = await resumePublicCheckpointEdge(f.options);
    const resumedSignal = lifecycle.sync.mock.calls.at(-1)![0].signal as AbortSignal;
    caller.abort(new Error('caller ended')); vi.advanceTimersByTime(3_600_001);
    expect(resumedSignal.aborted).toBe(false); expect(lifecycle.processStop).toHaveBeenCalledTimes(1);
    await resumed.agent.stop(); expect(lifecycle.processStop).toHaveBeenCalledTimes(2);
  });
  it('waits for startup and ordinary exact catchup before sealing; restart reuses the private journal', async () => {
    const f = await handoffFixture();
    lifecycle.sync.mockImplementationOnce(async () => {
      expect(await readdir(f.folder)).not.toContain('BOOTSTRAP-COMPLETE.json');
      return { current: true, alreadyPresent: 1, completeAsOfSnapshot: true, assets: 1, committed: 1, inventoryDigest: 'c'.repeat(64) };
    });
    const fresh = await createFreshPublicCheckpointEdge(f.options);
    expect(lifecycle.events.slice(0, 2)).toEqual(['start', 'startup barrier']);
    expect(lifecycle.sync).toHaveBeenCalledWith(expect.objectContaining({ transport: 'exact', signal: expect.any(AbortSignal) }));
    expect(JSON.parse(await readFile(join(f.folder, 'BOOTSTRAP-COMPLETE.json'), 'utf8'))).toMatchObject({
      chainId: 'base:84532', deploymentId: 'fixture', result: { current: true }, runtimeSha256: f.runtime.jarSha256,
    });
    expect(await readFile(f.options.native.journal, 'utf8')).toBe('journal');
    expect(await readFile(join(f.folder, 'store.jnl'), 'utf8')).toBe('journal');
    await fresh.agent.stop();
    expect(lifecycle.events.slice(-2)).toEqual(['store closed', 'process stopped']);
    lifecycle.events.length = 0;
    const resumed = await resumePublicCheckpointEdge(f.options);
    expect(resumed.result.current).toBe(true);
    expect(lifecycle.events).toEqual(['start', 'startup barrier', 'catchup']);
    await resumed.agent.stop();
    expect(lifecycle.processStop).toHaveBeenCalledTimes(2);
    expect(lifecycle.create.mock.calls.every(([config]) => config.nodeRole === 'edge')).toBe(true);
  });
  it('reaches owned store cleanup on cancellation while the shared startup poll remains pending', async () => {
    const f = await handoffFixture(), caller = new AbortController(); f.options.signal = caller.signal;
    let release!: () => void;
    const poll = new Promise<void>(resolve => { release = resolve; });
    const host = { chainPoller: { waitForCurrentPoll: () => poll }, waitForContextGraphSubscriptionActivation: vi.fn() };
    lifecycle.startup.mockImplementation((graph, signal) => PublicCheckpointMethods.prototype.waitForPublicCheckpointStartup.call(host as never, graph, signal));
    const work = createFreshPublicCheckpointEdge(f.options);
    const rejected = expect(work).rejects.toThrow('operator cancelled');
    try {
      await expect.poll(() => lifecycle.startup.mock.calls.length).toBe(1);
      caller.abort(new Error('operator cancelled'));
      await expect.poll(() => lifecycle.processStop.mock.calls.length, { timeout: 500 }).toBe(1);
      expect(lifecycle.sync).not.toHaveBeenCalled();
      expect(await readdir(f.folder)).not.toContain('BOOTSTRAP-COMPLETE.json');
    } finally { release(); await rejected; }
  });
  it.each(['startup', 'catchup'] as const)('never seals a failed %s and physically stops its store', async failure => {
    const f = await handoffFixture();
    if (failure === 'startup') lifecycle.startupFails = true; else lifecycle.current = false;
    await expect(createFreshPublicCheckpointEdge(f.options)).rejects.toThrow(failure === 'startup' ? 'startup failed' : 'current coverage');
    expect(await readdir(f.folder)).not.toContain('BOOTSTRAP-COMPLETE.json');
    expect(lifecycle.close).toHaveBeenCalled(); expect(lifecycle.processStop).toHaveBeenCalled();
    if (failure === 'startup') expect(lifecycle.sync).not.toHaveBeenCalled();
    expect(await readFile(f.options.native.journal, 'utf8')).toBe('journal');
  });
  it.each(['runtime', 'properties', 'space', 'binding'] as const)('refuses a changed restart %s before starting a process', async failure => {
    const f = await handoffFixture();
    const fresh = await createFreshPublicCheckpointEdge(f.options); await fresh.agent.stop();
    vi.mocked(startSnapshotNativeProcess).mockClear();
    if (failure === 'runtime') await writeFile(join(f.folder, 'runtime.jar'), 'tampered');
    if (failure === 'properties') await writeFile(join(f.folder, 'store.properties'), 'unsafe=true');
    if (failure === 'space') vi.mocked(statfs).mockResolvedValue({ bavail: 7 * 2 ** 30, bsize: 1 } as never);
    if (failure === 'binding') f.options.sync.onChainId = '15';
    await expect(resumePublicCheckpointEdge(f.options)).rejects.toThrow(/runtime changed|reserve|binding/);
    expect(startSnapshotNativeProcess).not.toHaveBeenCalled();
  });
  it('rejects insufficient space on a fresh Edge without touching the source journal', async () => {
    const f = await handoffFixture();
    vi.mocked(statfs).mockResolvedValue({ bavail: 7 * 2 ** 30, bsize: 1 } as never);
    await expect(createFreshPublicCheckpointEdge(f.options)).rejects.toThrow('Insufficient space');
    expect(startSnapshotNativeProcess).not.toHaveBeenCalled();
    expect(await readFile(f.options.native.journal, 'utf8')).toBe('journal');
  });
  it('rejects injected loader properties before starting the fresh store', async () => {
    const f = await handoffFixture();
    await writeFile(join(f.prepared.directory, 'native/load.properties'), 'unsafe=true');
    await expect(createFreshPublicCheckpointEdge(f.options)).rejects.toThrow('properties changed');
    expect(startSnapshotNativeProcess).not.toHaveBeenCalled();
    expect(await readdir(f.folder)).not.toContain('BOOTSTRAP-COMPLETE.json');
  });
  it('cancels failed readiness probes and stops the owned process without creating an agent', async () => {
    const f = await handoffFixture(); const abort = new AbortController(); f.options.signal = abort.signal;
    vi.stubGlobal('fetch', vi.fn(async () => { abort.abort(new Error('operator cancelled')); throw abort.signal.reason; }));
    await expect(createFreshPublicCheckpointEdge(f.options)).rejects.toThrow('operator cancelled');
    expect(lifecycle.create).not.toHaveBeenCalled(); expect(lifecycle.processStop).toHaveBeenCalled();
    expect(await readdir(f.folder)).not.toContain('BOOTSTRAP-COMPLETE.json');
  });
});
