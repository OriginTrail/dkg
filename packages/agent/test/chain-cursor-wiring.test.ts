import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';

const OPERATIONAL_KEY =
  '0x59c6995e998f97a5a0044966f0945388c9e82d88a3fdf0e0c7b33e0d2d2d8b2f';

describe('DKGAgent chain cursor wiring', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => {});
    agent = undefined;
  });

  it('passes EVM chainConfig fields into the constructed adapter', async () => {
    const registryCursorStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };

    agent = await DKGAgent.create({
      name: 'RegistryCursorWiring',
      listenPort: 0,
      chainConfig: {
        rpcUrl: 'http://127.0.0.1:59998',
        hubAddress: '0x0000000000000000000000000000000000000001',
        operationalKeys: [OPERATIONAL_KEY],
        chainId: 'evm:31337',
        receiptTimeoutMs: 1_200_000,
        minPublisherNativeWei: 123n,
        minPublisherTracWei: 456n,
      },
      contextGraphRegistryRoleAwareScanCursorStore: registryCursorStore,
    });

    const cursorKey = {
      chainId: 'evm:31337',
      deploymentId: 'evm:31337:hub=0x0000000000000000000000000000000000000001',
      registryAddress: '0x3333333333333333333333333333333333333333',
    };
    await (agent as any).chain.contextGraphRegistryScanCursor.input.store.save(cursorKey, 111);
    await (agent as any).chain.contextGraphRegistryTipScanCursor.input.store.save(cursorKey, 222);
    expect(registryCursorStore.save).toHaveBeenNthCalledWith(
      1,
      { ...cursorKey, cursorKind: 'historical' },
      111,
    );
    expect(registryCursorStore.save).toHaveBeenNthCalledWith(
      2,
      { ...cursorKey, cursorKind: 'tip' },
      222,
    );
    expect((agent as any).chain.minPublisherNativeWei).toBe(123n);
    expect((agent as any).chain.minPublisherTracWei).toBe(456n);
    expect((agent as any).chain.receiptTimeoutMs).toBe(1_200_000);
  });

  it('preserves legacy historical keys without exposing tip persistence', async () => {
    const legacyStore = {
      load: vi.fn(async () => 100),
      save: vi.fn(async () => {}),
    };

    agent = await DKGAgent.create({
      name: 'LegacyRegistryCursorWiring',
      listenPort: 0,
      chainConfig: {
        rpcUrl: 'http://127.0.0.1:59998',
        hubAddress: '0x0000000000000000000000000000000000000001',
        operationalKeys: [OPERATIONAL_KEY],
        chainId: 'evm:31337',
      },
      contextGraphRegistryScanCursorStore: legacyStore,
    });

    const cursorKey = {
      chainId: 'evm:31337',
      deploymentId: 'evm:31337:hub=0x0000000000000000000000000000000000000001',
      registryAddress: '0x3333333333333333333333333333333333333333',
    };
    const chain = (agent as any).chain;
    await expect(
      chain.contextGraphRegistryScanCursor.loadBestEffortWatermark(cursorKey.registryAddress),
    ).resolves.toBe(100);
    await chain.contextGraphRegistryScanCursor.saveBestEffortWatermark(
      cursorKey.registryAddress,
      111,
    );
    await expect(
      chain.contextGraphRegistryTipScanCursor.loadStrictWatermark(cursorKey.registryAddress),
    ).resolves.toBeUndefined();
    await chain.contextGraphRegistryTipScanCursor.saveStrictWatermark(
      cursorKey.registryAddress,
      222,
    );

    expect(legacyStore.load).toHaveBeenCalledWith(cursorKey);
    expect(legacyStore.save).toHaveBeenCalledWith(cursorKey, 111);
    expect(Object.keys(legacyStore.load.mock.calls[0]?.[0] ?? {}).sort()).toEqual([
      'chainId',
      'deploymentId',
      'registryAddress',
    ]);
    expect(chain.contextGraphRegistryTipScanCursor.input.store).toBeUndefined();
    expect(legacyStore.load).toHaveBeenCalledTimes(1);
    expect(legacyStore.save).toHaveBeenCalledTimes(1);
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
