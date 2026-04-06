/**
 * PublishHandler journal restore / expiry paths (tentative publish persistence).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ethers } from 'ethers';
import { PublishHandler } from '../src/publish-handler.js';
import type { JournalEntry } from '../src/publish-journal.js';

const TENTATIVE_MS = 60 * 60 * 1000;

function makeStore() {
  return {
    query: vi.fn().mockResolvedValue({ type: 'bindings' as const, bindings: [] }),
    insert: vi.fn(),
    delete: vi.fn(),
    deleteByPattern: vi.fn().mockResolvedValue(0),
    deleteBySubjectPrefix: vi.fn().mockResolvedValue(0),
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
  const bus = { emit: vi.fn(), on: vi.fn(), off: vi.fn(), once: vi.fn() } as any;

  beforeEach(() => {
    store = makeStore();
  });

  it('returns 0 when no journal is configured', async () => {
    const h = new PublishHandler(store as any, bus);
    expect(await h.restorePendingPublishes()).toBe(0);
  });

  it('returns 0 when journal load throws', async () => {
    const journal = { load: vi.fn().mockRejectedValue(new Error('disk')), save: vi.fn() };
    const h = new PublishHandler(store as any, bus, { journal: journal as any });
    expect(await h.restorePendingPublishes()).toBe(0);
  });

  it('restores a non-expired entry into pending state', async () => {
    const journal = {
      load: vi.fn().mockResolvedValue([baseEntry()]),
      save: vi.fn().mockResolvedValue(undefined),
    };
    const h = new PublishHandler(store as any, bus, { journal: journal as any });
    const n = await h.restorePendingPublishes();
    expect(n).toBe(1);
    expect(h.hasPendingPublishes).toBe(true);
  });

  it('skips entries already present in pending', async () => {
    const entry = baseEntry();
    const journal = {
      load: vi.fn().mockResolvedValue([entry]),
      save: vi.fn().mockResolvedValue(undefined),
    };
    const h = new PublishHandler(store as any, bus, { journal: journal as any });
    expect(await h.restorePendingPublishes()).toBe(1);
    expect(await h.restorePendingPublishes()).toBe(0);
    expect(h.hasPendingPublishes).toBe(true);
  });

  it('skips expired journal entries and re-persists journal', async () => {
    const journal = {
      load: vi.fn().mockResolvedValue([
        baseEntry({ createdAt: Date.now() - TENTATIVE_MS - 60_000 }),
      ]),
      save: vi.fn().mockResolvedValue(undefined),
    };
    const h = new PublishHandler(store as any, bus, { journal: journal as any });
    expect(await h.restorePendingPublishes()).toBe(0);
    expect(h.hasPendingPublishes).toBe(false);
    await vi.waitFor(() => expect(journal.save).toHaveBeenCalled());
  });

  it('skips malformed merkle / id fields and re-persists journal', async () => {
    const journal = {
      load: vi.fn().mockResolvedValue([
        baseEntry({ expectedMerkleRoot: '0xnotvalid', expectedStartKAId: '1', expectedEndKAId: '2' }),
      ]),
      save: vi.fn().mockResolvedValue(undefined),
    };
    const h = new PublishHandler(store as any, bus, { journal: journal as any });
    expect(await h.restorePendingPublishes()).toBe(0);
    await vi.waitFor(() => expect(journal.save).toHaveBeenCalled());
  });
});
