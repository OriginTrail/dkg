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

  it('passes the registry scan cursor store into an EVM adapter built from chainConfig', async () => {
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
      },
      contextGraphRegistryScanCursorStore: registryCursorStore,
    });

    expect((agent as any).chain.contextGraphRegistryScanCursor?.input?.store).toBe(registryCursorStore);
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
