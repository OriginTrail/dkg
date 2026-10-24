import { describe, expect, it, vi } from 'vitest';
import type { DkgConfig } from '../src/config.js';
import { createTelemetryRuntime } from '../src/daemon/telemetry-runtime.js';

function configWithTelemetry(enabled: boolean): DkgConfig {
  return {
    name: 'telemetry-runtime-test',
    apiPort: 0,
    listenPort: 0,
    nodeRole: 'edge',
    telemetry: { enabled },
  };
}

describe('createTelemetryRuntime', () => {
  it('serializes overlapping disable and enable transitions around the master gate', async () => {
    const config = configWithTelemetry(true);
    let exporterActive = true;
    let releaseStop!: () => void;
    let releaseDisabledSave!: () => void;
    let markStopStarted!: () => void;
    const observedStop = new Promise<void>((resolve) => { markStopStarted = resolve; });
    const stop = vi.fn(async () => {
      exporterActive = false;
      markStopStarted();
      await new Promise<void>((resolve) => { releaseStop = resolve; });
    });
    let persistCalls = 0;
    const persist = vi.fn(async () => {
      persistCalls += 1;
      if (persistCalls === 1) {
        await new Promise<void>((resolve) => { releaseDisabledSave = resolve; });
      }
    });
    const start = vi.fn(async () => {
      expect(config.telemetry?.enabled).toBe(true);
      exporterActive = true;
      return { ok: true };
    });
    const runtime = createTelemetryRuntime({
      config,
      persist,
      signals: { start, stop },
    });

    const disabling = runtime.setEnabled(false);
    await observedStop;
    const enabling = runtime.setEnabled(true);
    expect(exporterActive).toBe(false);
    expect(config.telemetry?.enabled).toBe(true);

    releaseStop();
    await vi.waitFor(() => expect(config.telemetry?.enabled).toBe(false));
    expect(exporterActive).toBe(false);
    releaseDisabledSave();
    await Promise.all([disabling, enabling]);

    expect(runtime.isEnabled()).toBe(true);
    expect(exporterActive).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('keeps boot startup best-effort without rewriting the durable gate', async () => {
    const config = configWithTelemetry(true);
    const persist = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const onBootStartFailure = vi.fn();
    const runtime = createTelemetryRuntime({
      config,
      persist,
      signals: {
        start: vi.fn(async () => ({ ok: false, error: 'log unavailable' })),
        stop,
      },
      onBootStartFailure,
    });

    await runtime.startConfiguredBestEffort();

    expect(runtime.isEnabled()).toBe(true);
    expect(persist).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(onBootStartFailure).toHaveBeenCalledWith('log unavailable');
  });

  it('rolls a failed runtime enable back to a durable disabled state', async () => {
    const config = configWithTelemetry(false);
    const persistedValues: boolean[] = [];
    const stop = vi.fn(async () => undefined);
    const runtime = createTelemetryRuntime({
      config,
      persist: vi.fn(async (current) => {
        persistedValues.push(current.telemetry?.enabled ?? false);
      }),
      signals: {
        start: vi.fn(async () => ({ ok: false, error: 'collector refused' })),
        stop,
      },
    });

    await expect(runtime.setEnabled(true)).resolves.toEqual({
      ok: false,
      error: 'collector refused',
    });

    expect(runtime.isEnabled()).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(persistedValues).toEqual([false]);
  });

  it('stops export and durably disables after enabled-state persistence fails', async () => {
    const config = configWithTelemetry(false);
    const persistedValues: boolean[] = [];
    let exporterActive = false;
    let persistCalls = 0;
    const stop = vi.fn(async () => { exporterActive = false; });
    const runtime = createTelemetryRuntime({
      config,
      persist: vi.fn(async (current) => {
        persistCalls += 1;
        persistedValues.push(current.telemetry?.enabled ?? false);
        if (persistCalls === 1) throw new Error('disk full');
      }),
      signals: {
        start: vi.fn(async () => {
          exporterActive = true;
          return { ok: true };
        }),
        stop,
      },
    });

    await expect(runtime.setEnabled(true)).rejects.toThrow('disk full');

    expect(exporterActive).toBe(false);
    expect(runtime.isEnabled()).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(persistedValues).toEqual([true, false]);
  });

  it('rolls back signal state and the durable gate when startup throws', async () => {
    const config = configWithTelemetry(false);
    const persistedValues: boolean[] = [];
    let partialSignalActive = false;
    const stop = vi.fn(async () => { partialSignalActive = false; });
    const runtime = createTelemetryRuntime({
      config,
      persist: vi.fn(async (current) => {
        persistedValues.push(current.telemetry?.enabled ?? false);
      }),
      signals: {
        start: vi.fn(async () => {
          partialSignalActive = true;
          throw new Error('startup exploded');
        }),
        stop,
      },
    });

    await expect(runtime.setEnabled(true)).rejects.toThrow('startup exploded');

    expect(partialSignalActive).toBe(false);
    expect(runtime.isEnabled()).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(persistedValues).toEqual([false]);
  });

  it('drains an active transition before orderly shutdown', async () => {
    const config = configWithTelemetry(false);
    let releaseStart!: () => void;
    let markStartStarted!: () => void;
    const observedStart = new Promise<void>((resolve) => { markStartStarted = resolve; });
    const stop = vi.fn(async () => undefined);
    const runtime = createTelemetryRuntime({
      config,
      persist: vi.fn(async () => undefined),
      signals: {
        start: vi.fn(async () => {
          markStartStarted();
          await new Promise<void>((resolve) => { releaseStart = resolve; });
          return { ok: true };
        }),
        stop,
      },
    });

    const enabling = runtime.setEnabled(true);
    await observedStart;
    const shuttingDown = runtime.shutdown();
    expect(stop).not.toHaveBeenCalled();
    await expect(runtime.setEnabled(true)).resolves.toEqual({
      ok: false,
      error: 'Telemetry runtime is shutting down',
    });

    releaseStart();
    await enabling;
    await shuttingDown;
    await runtime.shutdown();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
