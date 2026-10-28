import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, readdir, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFreshPublicCheckpointEdge } from '../src/snapshot-fresh-edge.js';
import { resumePublicCheckpointEdge } from '../src/snapshot-resume-edge.js';
import { startSnapshotNativeProcess } from '../src/snapshot-native-process.js';
import { handoffFixture } from './helpers/native-checkpoint-fixture.js';

const lifecycle = vi.hoisted(() => ({ events: [] as string[], current: true, startupFails: false,
  create: vi.fn(), stop: vi.fn(), sync: vi.fn(), close: vi.fn(), processStop: vi.fn() }));
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), statfs: vi.fn() }));
vi.mock('../src/snapshot-native-process.js', () => ({ startSnapshotNativeProcess: vi.fn() }));
vi.mock('@origintrail-official/dkg-storage', async original => ({
  ...await original<typeof import('@origintrail-official/dkg-storage')>(),
  BlazegraphStore: class { async close() { await lifecycle.close(); } },
}));
vi.mock('../src/dkg-agent.js', () => ({ DKGAgent: { create: lifecycle.create } }));
beforeEach(() => {
  vi.clearAllMocks(); lifecycle.events.length = 0; lifecycle.current = true; lifecycle.startupFails = false;
  vi.mocked(statfs).mockResolvedValue({ bavail: 20 * 2 ** 30, bsize: 1 } as never);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
  lifecycle.processStop.mockImplementation(async () => { lifecycle.events.push('process stopped'); });
  lifecycle.close.mockImplementation(async () => { lifecycle.events.push('store closed'); });
  vi.mocked(startSnapshotNativeProcess).mockResolvedValue({ stop: lifecycle.processStop, assertRunning: vi.fn(), closed: Promise.resolve(0) });
  lifecycle.create.mockImplementation(async config => {
    lifecycle.stop.mockImplementation(async () => { await config.store.close(); });
    lifecycle.sync.mockImplementation(async () => { lifecycle.events.push('catchup'); return { current: lifecycle.current, alreadyPresent: 1 }; });
    return { start: async () => { lifecycle.events.push('start'); },
      waitForPublicCheckpointStartup: async () => {
        lifecycle.events.push('startup barrier'); if (lifecycle.startupFails) throw new Error('startup failed');
      }, syncPublicGraphSnapshot: lifecycle.sync, stop: lifecycle.stop };
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('fresh checkpoint Edge and restart ownership', () => {
  it('waits for startup and ordinary exact catchup before sealing; restart reuses the private journal', async () => {
    const f = await handoffFixture();
    lifecycle.sync.mockImplementationOnce(async () => {
      expect(await readdir(f.folder)).not.toContain('BOOTSTRAP-COMPLETE.json');
      return { current: true, alreadyPresent: 1 };
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
