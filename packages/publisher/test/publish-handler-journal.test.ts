/**
 * PublishHandler journal restore / expiry paths (tentative publish persistence).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ethers } from 'ethers';
import { PublishHandler } from '../src/publish-handler.js';
import type { JournalEntry } from '../src/publish-journal.js';

const TENTATIVE_MS = 60 * 60 * 1000;

function makeStore() {
  return {
    query: async () => ({ type: 'bindings' as const, bindings: [] }),
    insert: async () => {},
    delete: async () => {},
    deleteByPattern: async () => 0,
    deleteBySubjectPrefix: async () => 0,
  };
}

function baseEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    ual: 'did:dkg:evm:31337/0x1111111111111111111111111111111111111111/1',
    paranetId: 'paranet-1',
    expectedPublisherAddress: '0x2222222222222222222222222222222222222222',
    expectedMerkleRoot: ethers.hexlify(ethers.randomBytes(32)),
    expectedStartKAId: '1',
    expectedEndKAId: '2',
    expectedChainId: 'evm:31337',
    rootEntities: ['urn:root'],
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('PublishHandler.restorePendingPublishes', () => {
  let store: ReturnType<typeof makeStore>;
  const bus = { emit: () => {}, on: () => {}, off: () => {}, once: () => {} } as any;

  beforeEach(() => {
    store = makeStore();
  });

  it('returns 0 when no journal is configured', async () => {
    const h = new PublishHandler(store as any, bus);
    expect(await h.restorePendingPublishes()).toBe(0);
  });

  it('returns 0 when journal load throws', async () => {
    const journal = {
      load: async () => { throw new Error('disk'); },
      save: async () => {},
    };
    const h = new PublishHandler(store as any, bus, { journal: journal as any });
    expect(await h.restorePendingPublishes()).toBe(0);
  });

  it('restores a non-expired entry into pending state', async () => {
    const journal = {
      load: async () => [baseEntry()],
      save: async () => {},
    };
    const h = new PublishHandler(store as any, bus, { journal: journal as any });
    const n = await h.restorePendingPublishes();
    expect(n).toBe(1);
    expect(h.hasPendingPublishes).toBe(true);
  });

  it('skips entries already present in pending', async () => {
    const entry = baseEntry();
    const journal = {
      load: async () => [entry],
      save: async () => {},
    };
    const h = new PublishHandler(store as any, bus, { journal: journal as any });
    expect(await h.restorePendingPublishes()).toBe(1);
    expect(await h.restorePendingPublishes()).toBe(0);
    expect(h.hasPendingPublishes).toBe(true);
  });

  it('skips expired journal entries and re-persists journal', async () => {
    let saveCalled = false;
    const journal = {
      load: async () => [
        baseEntry({ createdAt: Date.now() - TENTATIVE_MS - 60_000 }),
      ],
      save: async () => { saveCalled = true; },
    };
    const h = new PublishHandler(store as any, bus, { journal: journal as any });
    expect(await h.restorePendingPublishes()).toBe(0);
    expect(h.hasPendingPublishes).toBe(false);
    // Give async save a tick to complete
    await new Promise(r => setTimeout(r, 50));
    expect(saveCalled).toBe(true);
  });

  it('skips malformed merkle / id fields and re-persists journal', async () => {
    let saveCalled = false;
    const journal = {
      load: async () => [
        baseEntry({ expectedMerkleRoot: '0xnotvalid', expectedStartKAId: '1', expectedEndKAId: '2' }),
      ],
      save: async () => { saveCalled = true; },
    };
    const h = new PublishHandler(store as any, bus, { journal: journal as any });
    expect(await h.restorePendingPublishes()).toBe(0);
    expect(h.hasPendingPublishes).toBe(false);
    await new Promise(r => setTimeout(r, 50));
    expect(saveCalled).toBe(true);
  });
});
