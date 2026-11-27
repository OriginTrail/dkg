import { expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';

const resources = vi.hoisted(() => ({ allocated: 0 }));
vi.mock('node:async_hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:async_hooks')>();
  return { ...actual, AsyncLocalStorage: class<T> extends actual.AsyncLocalStorage<T> {
    constructor() { super(); resources.allocated++; }
  } };
});
import { AsyncLiftJournalCompletion } from '../src/async-lift-journal-completion.js';

it('keeps async-context resources bounded across completed publisher lifetimes', async () => {
  const before = resources.allocated;
  for (let index = 0; index < 128; index++) {
    const store = new OxigraphStore();
    try {
      const completion = new AsyncLiftJournalCompletion(store, 'urn:journal');
      await completion.runPublicOperation(async () => { await Promise.resolve(); });
      await completion.drain();
    } finally { await store.close(); }
  }
  // Node propagates every enabled AsyncLocalStorage on each promise. Repeated
  // settled instances must not keep adding process-wide propagation hooks.
  expect(resources.allocated - before).toBeLessThanOrEqual(1);
});

it('preserves nested per-instance drain ownership with a shared context resource', async () => {
  const store = new OxigraphStore();
  try {
    const first = new AsyncLiftJournalCompletion(store, 'urn:first');
    const second = new AsyncLiftJournalCompletion(store, 'urn:second');
    await first.runPublicOperation(async () => {
      await expect(first.drain()).rejects.toThrow('active publisher operation');
      await expect(second.drain()).resolves.toBeUndefined();
      await second.runPublicOperation(async () => {
        await expect(first.drain()).rejects.toThrow('active publisher operation');
        await expect(second.drain()).rejects.toThrow('active publisher operation');
        await first.runPublicOperation(async () => {
          await expect(first.drain()).rejects.toThrow('active publisher operation');
        });
      });
      await expect(first.drain()).rejects.toThrow('active publisher operation');
      await expect(second.drain()).resolves.toBeUndefined();
    });
    await Promise.all([first.drain(), second.drain()]);
  } finally { await store.close(); }
});

it('keeps concurrent operation scopes independent and lets an outside drain join them', async () => {
  const store = new OxigraphStore();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  try {
    const first = new AsyncLiftJournalCompletion(store, 'urn:first');
    const second = new AsyncLiftJournalCompletion(store, 'urn:second');
    const running = first.runPublicOperation(async () => {
      await held;
      await expect(first.drain()).rejects.toThrow('active publisher operation');
    });
    const outsideDrain = second.runPublicOperation(async () => {
      await expect(second.drain()).rejects.toThrow('active publisher operation');
      // This context owns only second; joining first must not reject.
      await first.drain();
    });
    release();
    await Promise.all([running, outsideDrain]);
    await Promise.all([first.drain(), second.drain()]);
  } finally { release(); await store.close(); }
});
