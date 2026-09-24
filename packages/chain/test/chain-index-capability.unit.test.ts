import { describe, expect, it } from 'vitest';
import { resolveChainIndexCapability, type ChainIndexCapability, type ChainIndexConfig } from '../src/chain-index-capability.js';
import { MemoryChainEventLogStore } from './helpers/chain-event-log.js';

describe('chain-index capability admission', () => {
  it('retains one capability and normalizes legacy store-only callers', () => {
    const store = new MemoryChainEventLogStore();
    const capability: ChainIndexCapability = { store };
    expect(resolveChainIndexCapability({ chainIndex: capability })).toBe(capability);
    expect(resolveChainIndexCapability({ chainEventLogStore: store })).toEqual({ store });
    expect(resolveChainIndexCapability({})).toBeUndefined();
  });

  it('rejects competing owners and reader-only JavaScript configurations', () => {
    const store = new MemoryChainEventLogStore();
    expect(() => resolveChainIndexCapability({ chainIndex: { store }, chainEventLogStore: store } as unknown as ChainIndexConfig))
      .toThrow('not both');
    expect(() => resolveChainIndexCapability({ chainIndex: {} as ChainIndexCapability }))
      .toThrow('requires its process-owned store');
    expect(() => resolveChainIndexCapability({
      chainEventLogReadModelFactory: () => undefined,
    } as Parameters<typeof resolveChainIndexCapability>[0])).toThrow('with its store');
  });
});
