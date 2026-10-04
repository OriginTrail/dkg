import { describe, expect, it } from 'vitest';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { withDraftArtifactCollection, withDraftArtifactReferences } from '../src/draft-artifact-retention.js';

function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

describe('draft artifact operation leases and exclusive collection', () => {
  it('excludes operations during collection and releases the fence after collector failure', async () => {
    const store = {} as TripleStore; const held = gate(); const entered = gate();
    const failure = new Error('collector failed');
    const collecting = withDraftArtifactCollection(store, async () => { entered.release(); await held.promise; throw failure; }).catch(error => error);
    await entered.promise;
    let admitted = false;
    const admission = withDraftArtifactReferences(store, async () => { admitted = true; });
    await tick(); expect(admitted).toBe(false);
    held.release(); expect(await collecting).toBe(failure); await admission;
    expect(admitted).toBe(true);
    await expect(withDraftArtifactCollection(store, async () => 'next')).resolves.toBe('next');
  });

  it('waits for every shared lease, releases failed operations and serializes collectors', async () => {
    const store = {} as TripleStore; const a = gate(); const b = gate(); const firstCollector = gate(); const startedCollector = gate();
    const failure = new Error('signer failed');
    const operationA = withDraftArtifactReferences(store, async () => { await a.promise; throw failure; }).catch(error => error);
    const operationB = withDraftArtifactReferences(store, () => b.promise);
    let firstStarted = false; let secondStarted = false;
    const first = withDraftArtifactCollection(store, async () => { firstStarted = true; startedCollector.release(); await firstCollector.promise; });
    const second = withDraftArtifactCollection(store, async () => { secondStarted = true; });
    a.release(); expect(await operationA).toBe(failure); await tick(); expect(firstStarted).toBe(false);
    b.release(); await operationB; await startedCollector.promise;
    expect(secondStarted).toBe(false);
    firstCollector.release(); await Promise.all([first, second]); expect(secondStarted).toBe(true);
  });
});
