import { describe, expect, it } from 'vitest';
import { createAsyncAdmissionDiagnosticTrace, currentAsyncAdmissionDiagnosticContext } from '@origintrail-official/dkg-core';
import { activeDefaultStoreWorkPriority, withDefaultStoreWorkPriority, OxigraphStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { AsyncLiftQueueScheduler } from '../src/async-lift-queue-scheduler.js';
import { TripleStoreAsyncPromoteQueue } from '../src/async-promote-queue-impl.js';

describe('detached publisher diagnostics', () => {
  it('clears both priority and request diagnostics at the real promote worker wake boundary', async () => {
    const store = new OxigraphStore();
    const queue = new TripleStoreAsyncPromoteQueue(store);
    const observed: Promise<unknown>[] = [];
    const detach = queue.workScheduling.attachScheduler({ onWorkAvailable() {
      observed.push(Promise.resolve().then(() => ({
        priority: activeDefaultStoreWorkPriority(), context: currentAsyncAdmissionDiagnosticContext(),
      })));
    } });
    const trace = createAsyncAdmissionDiagnosticTrace('share_async');
    try {
      await trace.run('enqueue', () => withDefaultStoreWorkPriority('background', async () => {
        await queue.resume();
        expect(activeDefaultStoreWorkPriority()).toBe('background');
        expect(currentAsyncAdmissionDiagnosticContext()?.requestId).toBe(trace.requestId);
      }));
      expect(await Promise.all(observed)).toEqual([{ priority: undefined, context: undefined }]);
    } finally { detach(); await store.close(); }
  });

  it('does not attribute wallet, reconciliation or work wakes to the admission request', async () => {
    const queue = new AsyncLiftQueueScheduler({} as TripleStore, 'urn:test:queue');
    const observed: Promise<unknown>[] = [];
    const observe = () => { observed.push(Promise.resolve().then(() => currentAsyncAdmissionDiagnosticContext())); };
    const detach = queue.attach({
      onWorkAvailable: observe, onReconciliationDemand: observe, onWalletRelease: observe,
    });
    const trace = createAsyncAdmissionDiagnosticTrace('publish_async');
    try {
      trace.run('enqueue', () => {
        queue.workAvailable(); queue.walletRelease('wallet'); queue.reconciliationDemand();
        expect(currentAsyncAdmissionDiagnosticContext()?.requestId).toBe(trace.requestId);
      });
      expect(await Promise.all(observed)).toEqual([undefined, undefined, undefined]);
    } finally { detach(); }
  });
});
