import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/dkg-agent.js';

// Pins the policy the real `isShardingTableCore` applies to warm-core pinning:
// best effort when the chain cannot answer, while a chain denial or a failed
// read keeps the core unpinned. The reconcile tests stub this method.
const MEMBER = '0x00000000000000000000000000000000000000a1';
const UNKNOWN = '0x00000000000000000000000000000000000000b2';

describe('warm-core pinning ShardingTable gate', () => {
  let chain: MockChainAdapter;
  let store: OxigraphStore;
  let agent: DKGAgent;

  beforeAll(async () => {
    chain = new MockChainAdapter('mock:31337');
    chain.seedIdentity(MEMBER, 7n);
    store = new OxigraphStore();
    agent = await DKGAgent.create({
      name: 'WarmCoreShardingGate',
      listenHost: '127.0.0.1',
      listenPort: 0,
      nodeRole: 'edge',
      chainAdapter: chain,
      store,
    });
    expect((agent as any).chain).toBe(chain);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await agent.node.stop();
    await store.close();
  });

  it.each(['getIdentityIdForAddress', 'isShardingTableMember'] as const)(
    'lets the phonebook role stand when the chain cannot answer (%s absent)',
    async (read) => {
      // An own undefined property hides the adapter's method, as on a chain without it.
      Object.defineProperty(chain, read, { value: undefined, configurable: true, writable: true });
      try {
        expect(await agent.isShardingTableCore(UNKNOWN)).toBe(true);
      } finally {
        delete (chain as unknown as Record<string, unknown>)[read];
      }
    },
  );

  it.each([undefined, ''])('denies a profile without an operational address when the chain can answer (%j)', async (address) => {
    // Unsigned profiles: `nodeRole='core'` alone must not win a warm slot.
    const identity = vi.spyOn(chain, 'getIdentityIdForAddress');
    expect(await agent.isShardingTableCore(address)).toBe(false);
    expect(identity).not.toHaveBeenCalled();
  });

  it('still lets the phonebook role stand for an address-less profile when the chain cannot answer', async () => {
    Object.defineProperty(chain, 'isShardingTableMember', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    try {
      expect(await agent.isShardingTableCore(undefined)).toBe(true);
    } finally {
      delete (chain as unknown as Record<string, unknown>).isShardingTableMember;
    }
  });

  it('pins a staked ShardingTable member', async () => {
    expect(await agent.isShardingTableCore(MEMBER)).toBe(true);
  });

  it('denies an address with no identity on chain', async () => {
    const member = vi.spyOn(chain, 'isShardingTableMember');
    expect(await agent.isShardingTableCore(UNKNOWN)).toBe(false);
    expect(member).not.toHaveBeenCalled();
  });

  it('denies an identity outside the ShardingTable', async () => {
    vi.spyOn(chain, 'isShardingTableMember').mockResolvedValue(false);
    expect(await agent.isShardingTableCore(MEMBER)).toBe(false);
  });

  it.each(['getIdentityIdForAddress', 'isShardingTableMember'] as const)(
    'denies when %s fails instead of pinning on an unverifiable gate',
    async (read) => {
      vi.spyOn(chain, read).mockRejectedValue(new Error('rpc unavailable'));
      expect(await agent.isShardingTableCore(MEMBER)).toBe(false);
    },
  );
});
