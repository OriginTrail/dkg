import { describe, expect, it, vi } from 'vitest';
import { AsyncLiftRunner } from '../src/index.js';
import { createRunnerPublisher as createPublisher } from './_helpers/async-lift-runner-fixture.js';

describe('AsyncLiftRunner claim control', () => {
  it('uses the same claim gate for startup maintenance and later live pause/resume', async () => {
    const order: string[] = [];
    let paused = false;
    const publisher = createPublisher({
      pause: async () => {
        paused = true;
        order.push('pause');
      },
      resume: async () => {
        paused = false;
        order.push('resume');
      },
      recover: async () => {
        order.push('recover');
        return 0;
      },
      processNext: async () => {
        order.push(paused ? 'process-paused' : 'process-active');
        return null;
      },
    } as any);

    const runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      startPaused: true,
      pollIntervalMs: 60_000,
    });

    try {
      await runner.start();
      expect(runner.claimGateStatus().held).toBe(true);
      expect(order).toEqual(['pause', 'recover']);
      await runner.releaseClaims();
      await vi.waitFor(() => expect(order).toContain('process-active'));
      expect(runner.claimGateStatus().held).toBe(false);
      await runner.holdClaims();
      expect(runner.claimGateStatus().held).toBe(true);
      await runner.releaseClaims();
      await vi.waitFor(() => expect(order.filter(step => step === 'process-active')).toHaveLength(2));
      expect(order).not.toContain('process-paused');
    } finally { await runner.stop(); }
  });

  it('closes admission synchronously before the publisher pause barrier settles', async () => {
    let releasePause!: () => void;
    const pauseHeld = new Promise<void>(resolve => { releasePause = resolve; });
    const resume = vi.fn(async () => {});
    const runner = new AsyncLiftRunner({ publisher: createPublisher({ pause: () => pauseHeld, resume }),
      walletIds: ['wallet-1'] });
    const closing = runner.closeClaims();
    try {
      expect(runner.claimGateStatus().held).toBe(true);
      await expect(runner.releaseClaims()).rejects.toThrow('closed');
      expect(resume).not.toHaveBeenCalled();
    } finally { releasePause(); await closing; await runner.stop(); }
  });

  it('reinstalls publisher pause when terminal closure races an awaited resume', async () => {
    let enterResume!: () => void; const entered = new Promise<void>(resolve => { enterResume = resolve; });
    let releaseResume!: () => void; const held = new Promise<void>(resolve => { releaseResume = resolve; });
    let paused = false;
    const processNext = vi.fn(async () => null);
    const runner = new AsyncLiftRunner({ publisher: createPublisher({
      pause: async () => { paused = true; },
      resume: async () => { enterResume(); await held; paused = false; },
      processNext,
    }), walletIds: ['wallet-1'], pollIntervalMs: 60_000 });
    await runner.holdClaims(); await runner.start();
    const resuming = runner.releaseClaims();
    const rejected = expect(resuming).rejects.toThrow('closed');
    try {
      await entered; await runner.closeClaims();
      releaseResume(); await rejected;
      expect(runner.claimGateStatus().held).toBe(true);
      expect(paused).toBe(true);
      expect(processNext).not.toHaveBeenCalled();
      await expect(runner.releaseClaims()).rejects.toThrow('closed');
    } finally { releaseResume(); await resuming.catch(() => {}); await runner.stop(); }
  });

});
