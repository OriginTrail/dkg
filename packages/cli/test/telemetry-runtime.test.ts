import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DkgHomeFiles, type DkgConfig } from '../src/config.js';
import { DkgConfigStore } from '../src/daemon-config-store.js';
import * as publication from '../src/fs-utils.js';
import { createTelemetryRuntime } from '../src/daemon/telemetry-runtime.js';

const directories: string[] = [];
async function storeWithTelemetry(enabled: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'dkg-telemetry-runtime-'));
  directories.push(directory);
  const config: DkgConfig = { name: 'telemetry-test', apiPort: 0, listenPort: 0, nodeRole: 'edge', telemetry: { enabled } };
  const files = new DkgHomeFiles(directory);
  await files.saveConfig(config);
  return { store: await DkgConfigStore.open(files, config), path: files.configPath };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('createTelemetryRuntime', () => {
  it('serializes publication and overlapping disable/enable transitions around the live gate', async () => {
    const { store, path } = await storeWithTelemetry(true);
    let exporterActive = true;
    let releasePublication!: () => void;
    let releaseStop!: () => void;
    const publicationGate = new Promise<void>(resolve => { releasePublication = resolve; });
    const stopGate = new Promise<void>(resolve => { releaseStop = resolve; });
    const write = publication.writeFileAtomic;
    const publishing = vi.spyOn(publication, 'writeFileAtomic').mockImplementationOnce(async (...args) => {
      await publicationGate;
      return write(...args);
    });
    const stop = vi.fn(async () => { exporterActive = false; await stopGate; });
    const start = vi.fn(async () => { exporterActive = true; return { ok: true } as const; });
    const runtime = createTelemetryRuntime({ configStore: store, signals: { start, stop } });
    const disabling = runtime.setEnabled(false);
    await vi.waitFor(() => expect(publishing).toHaveBeenCalledOnce());
    const enabling = runtime.setEnabled(true);
    expect(stop).not.toHaveBeenCalled();
    expect(exporterActive).toBe(true);
    releasePublication();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    expect(runtime.isEnabled()).toBe(true);
    expect(store.current.telemetry?.enabled).toBe(true);
    expect(exporterActive).toBe(false);
    releaseStop();
    await Promise.all([disabling, enabling]);
    expect(runtime.isEnabled()).toBe(true);
    expect(exporterActive).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(publishing).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(store.current);
  });

  it('keeps boot startup best-effort without rewriting the durable gate', async () => {
    const { store, path } = await storeWithTelemetry(true);
    const before = await readFile(path, 'utf8');
    const publishing = vi.spyOn(publication, 'writeFileAtomic');
    const stop = vi.fn(async () => undefined);
    const onBootStartFailure = vi.fn();
    const runtime = createTelemetryRuntime({
      configStore: store, signals: { start: async () => ({ ok: false, error: 'log unavailable' }), stop }, onBootStartFailure,
    });
    await runtime.startConfiguredBestEffort();
    expect(runtime.isEnabled()).toBe(true);
    expect(publishing).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(onBootStartFailure).toHaveBeenCalledWith('log unavailable');
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it.each(['rejected', 'thrown'] as const)('compensates partially started signals after a %s enable', async kind => {
    const { store, path } = await storeWithTelemetry(false);
    const before = await readFile(path, 'utf8');
    let partialSignalActive = false;
    const stop = vi.fn(async () => { partialSignalActive = false; });
    const runtime = createTelemetryRuntime({
      configStore: store, signals: {
        start: async () => {
          partialSignalActive = true;
          if (kind === 'thrown') throw new Error('startup exploded');
          return { ok: false, error: 'collector refused' };
        }, stop,
      },
    });
    if (kind === 'thrown') await expect(runtime.setEnabled(true)).rejects.toThrow('startup exploded');
    else await expect(runtime.setEnabled(true)).resolves.toEqual({ ok: false, error: 'collector refused' });
    expect(partialSignalActive).toBe(false);
    expect(runtime.isEnabled()).toBe(false);
    expect(store.current.telemetry?.enabled).toBe(false);
    expect(stop).toHaveBeenCalledOnce();
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it.each([false, true])('does not change signals or the gate when publication fails from enabled=%s', async enabled => {
    const { store, path } = await storeWithTelemetry(enabled);
    const before = await readFile(path, 'utf8');
    const start = vi.fn(async () => ({ ok: true } as const));
    const stop = vi.fn(async () => undefined);
    const runtime = createTelemetryRuntime({ configStore: store, signals: { start, stop } });
    vi.spyOn(publication, 'writeFileAtomic').mockRejectedValueOnce(new Error('disk full'));
    await expect(runtime.setEnabled(!enabled)).rejects.toThrow('disk full');
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(runtime.isEnabled()).toBe(enabled);
    expect(store.current.telemetry?.enabled).toBe(enabled);
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('restores previously enabled signals after a partial disable failure', async () => {
    const { store, path } = await storeWithTelemetry(true);
    const before = await readFile(path, 'utf8');
    let exporterActive = true;
    const stop = vi.fn(async () => { exporterActive = false; });
    stop.mockImplementationOnce(async () => { exporterActive = false; throw new Error('stop failed after mutation'); });
    const start = vi.fn(async () => { exporterActive = true; return { ok: true } as const; });
    const runtime = createTelemetryRuntime({ configStore: store, signals: { start, stop } });
    await expect(runtime.setEnabled(false)).rejects.toThrow('stop failed after mutation');
    expect(exporterActive).toBe(true);
    expect(runtime.isEnabled()).toBe(true);
    expect(store.current.telemetry?.enabled).toBe(true);
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('drains an active transition before orderly shutdown', async () => {
    const { store } = await storeWithTelemetry(false);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const start = vi.fn(async () => { await gate; return { ok: true } as const; });
    const stop = vi.fn(async () => undefined);
    const runtime = createTelemetryRuntime({ configStore: store, signals: { start, stop } });
    const enabling = runtime.setEnabled(true);
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    const shuttingDown = runtime.shutdown();
    expect(stop).not.toHaveBeenCalled();
    await expect(runtime.setEnabled(true)).resolves.toEqual({ ok: false, error: 'Telemetry runtime is shutting down' });
    release();
    await enabling;
    await shuttingDown;
    expect(stop).toHaveBeenCalledOnce();
  });
});
