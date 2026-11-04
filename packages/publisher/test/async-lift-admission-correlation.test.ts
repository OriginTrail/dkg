import { describe, expect, it } from 'vitest';
import { createAsyncAdmissionDiagnosticTrace, currentAsyncAdmissionDiagnosticContext } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { AsyncLiftQueueScheduler } from '../src/async-lift-queue-scheduler.js';

describe('detached publisher diagnostics', () => {
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
