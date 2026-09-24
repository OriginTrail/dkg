import { describe, expect, it } from 'vitest';
import { resolveChainIndexCapability, type ChainIndexCapability } from '../src/chain-index-capability.js';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/index.js';
import { MemoryChainEventLogStore } from './helpers/chain-event-log.js';

describe('chain-index capability admission', () => {
  it('retains one capability and normalizes legacy store-only callers', () => {
    const store = new MemoryChainEventLogStore();
    const capability: ChainIndexCapability = { store };
    expect(resolveChainIndexCapability({ chainIndex: capability })).toBe(capability);
    expect(resolveChainIndexCapability({ chainEventLogStore: store })).toEqual({ store });
    expect(resolveChainIndexCapability({})).toBeUndefined();
  });

  it('rejects contradictory ownership through the extendable public adapter config', () => {
    const store = new MemoryChainEventLogStore();
    const config: EVMAdapterConfig = {
      rpcUrl: 'http://127.0.0.1:59998',
      privateKey: `0x${'11'.repeat(32)}`,
      hubAddress: `0x${'22'.repeat(20)}`,
      chainIndex: { store },
      chainEventLogStore: store,
    };
    expect(() => new EVMChainAdapter(config)).toThrow('not both');
  });

  it('rejects competing owners and reader-only JavaScript configurations', () => {
    const store = new MemoryChainEventLogStore();
    expect(() => resolveChainIndexCapability({ chainIndex: { store }, chainEventLogStore: store }))
      .toThrow('not both');
    expect(() => resolveChainIndexCapability({ chainIndex: {} as ChainIndexCapability }))
      .toThrow('requires its process-owned store');
    expect(() => resolveChainIndexCapability({
      chainEventLogReadModelFactory: () => undefined,
    } as Parameters<typeof resolveChainIndexCapability>[0])).toThrow('with its store');
  });
});
