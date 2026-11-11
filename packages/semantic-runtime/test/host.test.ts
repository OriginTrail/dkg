import { describe, expect, it } from 'vitest';

import { SemanticRuntimeHost } from '../src/host.js';
import {
  WorkerRequestTimeoutError,
  WorkerUnavailableError,
} from '../src/worker-supervisor.js';

const workerUrl = new URL('../dist/worker.js', import.meta.url);

describe('SemanticRuntimeHost', () => {
  it('runs deterministic events in Wasm and restores the same digest from a snapshot', async () => {
    const host = new SemanticRuntimeHost({ workerUrl });
    await host.start();
    try {
      const output = await host.applyEvent({
        kind: 'advance',
        eventId: new Uint8Array(32).fill(0x22),
        logicalTime: 100n,
        delta: 9n,
      });
      const inspection = await host.inspect();
      expect(output.appliedEvents).toBe(1);
      expect(output.accumulator).toBe(9n);
      expect(inspection.stateDigest).toEqual(output.stateDigest);
      expect((await host.snapshotBytes()).byteLength).toBeGreaterThan(32);
    } finally {
      await host.stop();
    }
  });

  it('serializes concurrent host calls into one deterministic partition order', async () => {
    const host = new SemanticRuntimeHost({ workerUrl });
    await host.start();
    try {
      const [first, second] = await Promise.all([
        host.applyEvent({
          kind: 'advance',
          eventId: new Uint8Array(32).fill(0x61),
          logicalTime: 10n,
          delta: 1n,
        }),
        host.applyEvent({
          kind: 'advance',
          eventId: new Uint8Array(32).fill(0x62),
          logicalTime: 20n,
          delta: 2n,
        }),
      ]);
      expect(first.accumulator).toBe(1n);
      expect(second.accumulator).toBe(3n);
      expect((await host.inspect()).stateDigest).toEqual(second.stateDigest);
    } finally {
      await host.stop();
    }
  });

  it('keeps the Node event loop responsive, kills a hung Wasm Worker, and restores state', async () => {
    const host = new SemanticRuntimeHost({
      workerUrl,
      allowTestOperations: true,
      config: { watchdogMs: 40 },
    });
    await host.start();
    try {
      await host.applyEvent({
        kind: 'advance',
        eventId: new Uint8Array(32).fill(0x33),
        logicalTime: 100n,
        delta: 12n,
      });
      let eventLoopTicks = 0;
      const timer = setInterval(() => {
        eventLoopTicks += 1;
      }, 5);
      try {
        await expect(host.phase0TestHang()).rejects.toBeInstanceOf(WorkerRequestTimeoutError);
      } finally {
        clearInterval(timer);
      }
      const restored = await host.inspect();
      expect(eventLoopTicks).toBeGreaterThanOrEqual(3);
      expect(host.workerRestartCount).toBe(1);
      expect(restored.appliedEvents).toBe(1);
      expect(restored.accumulator).toBe(12n);
    } finally {
      await host.stop();
    }
  });

  it('treats a Wasm trap as a partition failure and restores in a replacement Worker', async () => {
    const host = new SemanticRuntimeHost({
      workerUrl,
      allowTestOperations: true,
      config: { watchdogMs: 200 },
    });
    await host.start();
    try {
      await expect(host.phase0TestTrap()).rejects.toBeInstanceOf(WorkerUnavailableError);
      expect((await host.inspect()).appliedEvents).toBe(0);
      expect(host.workerRestartCount).toBe(1);
    } finally {
      await host.stop();
    }
  });
});
