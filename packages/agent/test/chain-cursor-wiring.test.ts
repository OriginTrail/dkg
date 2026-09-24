import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MockChainAdapter,
} from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';

const OPERATIONAL_KEY =
  '0x59c6995e998f97a5a0044966f0945388c9e82d88a3fdf0e0c7b33e0d2d2d8b2f';

describe('DKGAgent chain cursor wiring', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => {});
    agent = undefined;
  });

  it.each(['capability', 'legacy store'] as const)('passes EVM chainConfig and %s ownership into the constructed adapter', async (ownership) => {
    const registryCursorStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };
    const authorityHistoryStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    };
    const authorityIndexStore = {
      load: vi.fn(async () => undefined),
      compareAndSwap: vi.fn(async () => 1),
      invalidate: vi.fn(async () => 2),
    };
    // The node's ONE chain log. Reaching the adapter is what makes it the
    // adapter that OWNS the tick; an adapter without it builds no tick at all.
    const chainEventLogStore = {
      load: vi.fn(async () => undefined),
      commit: vi.fn(async () => 1),
      tombstone: vi.fn(async () => 2),
      readEvents: vi.fn(async () => []),
      blockHashAt: vi.fn(async () => undefined),
    };
    const chainEventLogReadModelFactory = vi.fn(() => ({
      async readContextGraphForKa() { return undefined; },
      async readContextGraphKaList() { return undefined; },
    }));

    agent = await DKGAgent.create({
      name: 'RegistryCursorWiring',
      listenPort: 0,
      chainConfig: {
        rpcUrl: 'http://127.0.0.1:59998',
        hubAddress: '0x0000000000000000000000000000000000000001',
        operationalKeys: [OPERATIONAL_KEY],
        chainId: 'evm:31337',
        receiptTimeoutMs: 1_200_000,
        indexTickMs: 12_000,
        minPublisherNativeWei: 123n,
        minPublisherTracWei: 456n,
      },
      contextGraphRegistryScanCursorStore: registryCursorStore,
      localContextGraphAuthorityHistoryStore: authorityHistoryStore,
      localContextGraphAuthorityIndexStore: authorityIndexStore,
      ...(ownership === 'capability'
        ? { chainIndex: { store: chainEventLogStore, readModelFactory: chainEventLogReadModelFactory } }
        : { chainEventLogStore }),
    });

    expect((agent as any).chain.contextGraphRegistryScanCursor?.input?.store).toBe(registryCursorStore);
    expect((agent as any).chain.contextGraphAuthorityHistory?.localStore).toBe(authorityHistoryStore);
    expect((agent as any).chain.contextGraphAuthorityIndex?.localStore).toBe(authorityIndexStore);
    expect((agent as any).chain.minPublisherNativeWei).toBe(123n);
    expect((agent as any).chain.minPublisherTracWei).toBe(456n);
    expect((agent as any).chain.receiptTimeoutMs).toBe(1_200_000);
    expect((agent as any).chain.contextGraphAuthorityIndex?.projectionTickMs).toBe(12_000);
    // The adapter delegates ownership of the durable store to the extracted
    // runtime owner. Exercise that boundary instead of asserting the removed
    // adapter implementation field.
    let receivedCapability: any;
    const runtime = {
      binding: undefined,
      start: vi.fn(),
      stop: vi.fn(async () => {}),
    };
    const owner = (agent as any).chain.chainIndexOwner;
    owner.start(async (capability: unknown) => {
      receivedCapability = capability;
      return runtime;
    });
    await owner.starting;
    expect(receivedCapability.store).toBe(chainEventLogStore);
    expect(receivedCapability.readModelFactory).toBe(ownership === 'capability' ? chainEventLogReadModelFactory : undefined);
    expect(runtime.start).toHaveBeenCalledOnce();
    expect((agent as any).chain.indexTickMs).toBe(12_000);
  });

  it('passes the chain-event lane cursor store into the poller on start', async () => {
    const chainEventCursorStore = {
      loadLane: vi.fn(async () => undefined),
      saveLane: vi.fn(async () => {}),
    };

    agent = await DKGAgent.create({
      name: 'LaneCursorWiring',
      listenPort: 0,
      chainAdapter: new MockChainAdapter('mock:31337'),
      chainEventCursorStore,
    });
    await agent.start();

    expect(chainEventCursorStore.loadLane).toHaveBeenCalled();
    expect(chainEventCursorStore.loadLane.mock.calls.map(([lane]) => lane)).toContain('contextGraphDiscovery');
  });
});
