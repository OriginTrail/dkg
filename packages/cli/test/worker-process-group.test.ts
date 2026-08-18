import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  reapWorkerProcessGroup,
  waitForTcpPortRelease,
} from '../src/daemon/worker-process-group.js';

function esrch(): NodeJS.ErrnoException {
  return Object.assign(new Error('missing process'), { code: 'ESRCH' });
}

describe('worker process-group cleanup', () => {
  it('returns immediately when the private group is already empty', async () => {
    const signals: Array<number | NodeJS.Signals> = [];
    const kill = ((_pid: number, signal?: number | NodeJS.Signals) => {
      signals.push(signal ?? 'SIGTERM');
      throw esrch();
    }) as typeof process.kill;

    await expect(reapWorkerProcessGroup(42, { platform: 'linux', kill }))
      .resolves.toEqual({
        applicable: true,
        termSent: false,
        killSent: false,
        empty: true,
      });
    expect(signals).toEqual([0]);
  });

  it('gives descendants a bounded SIGTERM window', async () => {
    let exists = true;
    const signals: Array<number | NodeJS.Signals> = [];
    const kill = ((_pid: number, signal?: number | NodeJS.Signals) => {
      const actual = signal ?? 'SIGTERM';
      signals.push(actual);
      if (actual === 0) {
        if (!exists) throw esrch();
        return true;
      }
      if (actual === 'SIGTERM') exists = false;
      return true;
    }) as typeof process.kill;

    const result = await reapWorkerProcessGroup(42, {
      platform: 'linux',
      kill,
    });
    expect(result).toEqual({
      applicable: true,
      termSent: true,
      killSent: false,
      empty: true,
    });
    expect(signals).toEqual([0, 'SIGTERM', 0]);
  });

  it('escalates stubborn descendants to SIGKILL and verifies exit', async () => {
    let exists = true;
    let clock = 0;
    const signals: Array<number | NodeJS.Signals> = [];
    const kill = ((_pid: number, signal?: number | NodeJS.Signals) => {
      const actual = signal ?? 'SIGTERM';
      signals.push(actual);
      if (actual === 0) {
        if (!exists) throw esrch();
        return true;
      }
      if (actual === 'SIGKILL') exists = false;
      return true;
    }) as typeof process.kill;

    const result = await reapWorkerProcessGroup(42, {
      platform: 'linux',
      kill,
      termGraceMs: 10,
      killGraceMs: 10,
      pollIntervalMs: 5,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    });
    expect(result).toEqual({
      applicable: true,
      termSent: true,
      killSent: true,
      empty: true,
    });
    expect(signals).toContain('SIGTERM');
    expect(signals).toContain('SIGKILL');
  });

  it.runIf(process.platform !== 'win32')(
    'reaps a real descendant left behind by a SIGKILLed worker',
    async () => {
      const worker = spawn(
        process.execPath,
        [
          '-e',
          [
            "const { spawn } = require('node:child_process');",
            "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
            'process.stdout.write(String(child.pid));',
            'setInterval(() => {}, 1000);',
          ].join(''),
        ],
        { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const pgid = worker.pid!;
      try {
        const descendantPid = await new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('descendant pid timeout')), 3_000);
          worker.stdout!.once('data', (chunk) => {
            clearTimeout(timer);
            resolve(Number(String(chunk)));
          });
          worker.once('error', reject);
        });

        worker.kill('SIGKILL');
        await new Promise<void>((resolve) => worker.once('exit', () => resolve()));
        expect(() => process.kill(descendantPid, 0)).not.toThrow();

        const result = await reapWorkerProcessGroup(pgid, {
          termGraceMs: 1_000,
          killGraceMs: 1_000,
          pollIntervalMs: 10,
        });
        expect(result.empty).toBe(true);
        expect(result.termSent).toBe(true);
        expect(() => process.kill(descendantPid, 0)).toThrow();
      } finally {
        try { process.kill(-pgid, 'SIGKILL'); } catch { /* already gone */ }
      }
    },
  );
});

describe('managed store port cleanup barrier', () => {
  it('waits until the listener releases the port', async () => {
    let clock = 0;
    let probes = 0;
    const released = await waitForTcpPortRelease('127.0.0.1', 7878, {
      timeoutMs: 50,
      pollIntervalMs: 10,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      isListening: async () => ++probes < 3,
    });
    expect(released).toBe(true);
    expect(probes).toBe(3);
  });

  it('fails closed when a listener survives the deadline', async () => {
    let clock = 0;
    const released = await waitForTcpPortRelease('127.0.0.1', 7878, {
      timeoutMs: 20,
      pollIntervalMs: 10,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      isListening: async () => true,
    });
    expect(released).toBe(false);
  });
});
