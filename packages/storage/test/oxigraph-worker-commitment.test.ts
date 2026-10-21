import { expect, it, vi } from 'vitest';
import type { Worker } from 'node:worker_threads';
import type { TripleStore } from '../src/triple-store.js';
import { oxigraphWorkerCommitment } from '../src/adapters/oxigraph-worker-commitment.js';
import { composeTripleStoreCommitment } from '../src/persistence.js';

it('rejects a replaced or absent owner before flushing and permits a fresh capture', async () => {
  let worker: Worker | undefined = {} as Worker;
  const flush = vi.fn(async () => {});
  const capability = oxigraphWorkerCommitment('restart-durable', () => worker, flush);
  const old = capability.capture();
  worker = {} as Worker;
  await expect(old()).rejects.toMatchObject({ code: 'OXIGRAPH_WORKER_COMMIT_OWNER_CHANGED' });
  expect(flush).not.toHaveBeenCalled();
  await capability.capture()(); expect(flush).toHaveBeenCalledTimes(1);
  worker = undefined;
  await expect(capability.capture()()).rejects.toMatchObject({ code: 'OXIGRAPH_WORKER_COMMIT_OWNER_CHANGED' });
});

it('rejects replacement during a held flush, including a composed barrier', async () => {
  let worker = {} as Worker;
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const commitment = oxigraphWorkerCommitment('restart-durable', () => worker, async () => { started(); await gate; });
  const composed = composeTripleStoreCommitment({ commitment } as TripleStore)!;
  const attempt = composed.capture()();
  const rejected = expect(attempt).rejects.toMatchObject({ code: 'OXIGRAPH_WORKER_COMMIT_OWNER_CHANGED' });
  await entered; worker = {} as Worker; release(); await rejected;
  await composed.capture()();
});

it('captures the owner before a decorator drains its queue', async () => {
  let worker = {} as Worker;
  const flush = vi.fn(async () => {});
  const commitment = oxigraphWorkerCommitment('restart-durable', () => worker, flush);
  const composed = composeTripleStoreCommitment({ commitment } as TripleStore, async () => { worker = {} as Worker; })!;
  await expect(composed.capture()()).rejects.toMatchObject({ code: 'OXIGRAPH_WORKER_COMMIT_OWNER_CHANGED' });
  expect(flush).not.toHaveBeenCalled();
});
