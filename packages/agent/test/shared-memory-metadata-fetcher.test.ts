import { describe, expect, it, vi } from 'vitest';
import type { Quad } from '@origintrail-official/dkg-storage';
import {
  normalizeSharedMemoryMetadataFetcher,
  selectSharedMemoryMetadataFetcher,
} from '../src/sync/requester/shared-memory-metadata-fetcher.js';
import type {
  SharedMemoryMetadataFetchRequest,
  SharedMemoryMetadataFetcher,
} from '../src/sync/requester/shared-memory-sync.js';

const request = {
  ctx: { kind: 'system', id: 'test', startedAt: 0 },
  remotePeerId: 'peer',
  contextGraphId: 'cg',
  graphUri: 'did:dkg:context-graph:cg/_shared_memory_meta',
  deadline: Number.MAX_SAFE_INTEGER,
  workAdmission: {
    deadline: Number.MAX_SAFE_INTEGER,
    scope: { sharing: 'coalescible', key: 'test' },
  },
} as const satisfies SharedMemoryMetadataFetchRequest;

class ReceiverFetcher implements SharedMemoryMetadataFetcher {
  readonly calls: string[] = [];
  async fetch(input: SharedMemoryMetadataFetchRequest) {
    this.calls.push(`fetch:${input.contextGraphId}`);
    return {
      result: {
        quads: [] as Quad[], bytesReceived: 0, resumedFromOffset: 0,
        nextOffset: 0, checkpointKey: 'key', completed: true, timedOut: false,
      },
      continuationYielded: false,
    };
  }
  release(contextGraphId: string) { this.calls.push(`release:${contextGraphId}`); }
}

describe('shared-memory metadata fetcher normalization', () => {
  it('preserves the receiver for the released selected-mode layout', async () => {
    const fetcher = new ReceiverFetcher();
    const selected = selectSharedMemoryMetadataFetcher({
      mode: {
        kind: 'selected-recovery',
        recoveryGuard: { signal: new AbortController().signal, assertCurrent: () => {} },
        metadataFetcher: fetcher,
      },
    });
    const normalized = normalizeSharedMemoryMetadataFetcher(
      {
        mode: {
          kind: 'selected-recovery',
          recoveryGuard: { signal: new AbortController().signal, assertCurrent: () => {} },
          metadataFetcher: selected,
        },
      },
      vi.fn(),
    );
    await normalized.fetch(request);
    normalized.release('cg');
    expect(fetcher.calls).toEqual(['fetch:cg', 'release:cg']);
  });

  it('rejects conflicting current and legacy fetchers before use', () => {
    expect(() => selectSharedMemoryMetadataFetcher({
      metadataFetcher: new ReceiverFetcher(),
      mode: {
        kind: 'selected-recovery',
        recoveryGuard: { signal: new AbortController().signal, assertCurrent: () => {} },
        metadataFetcher: new ReceiverFetcher(),
      },
    })).toThrow('Conflicting shared-memory metadata fetchers');
  });

  it('normalizes the direct low-level page fallback', async () => {
    const direct = vi.fn(async () => ({
      quads: [] as Quad[], bytesReceived: 0, resumedFromOffset: 0,
      nextOffset: 0, checkpointKey: 'direct', completed: true, timedOut: false,
    }));
    const normalized = normalizeSharedMemoryMetadataFetcher(
      { mode: { kind: 'ordinary' } },
      direct,
    );
    await expect(normalized.fetch(request)).resolves.toMatchObject({
      continuationYielded: false,
      result: { checkpointKey: 'direct' },
    });
    expect(direct).toHaveBeenCalledOnce();
  });
});
