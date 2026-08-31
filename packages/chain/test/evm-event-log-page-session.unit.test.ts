import type { Contract, JsonRpcProvider } from 'ethers';
import { describe, expect, it } from 'vitest';
import { EvmEventLogPageSession } from '../src/evm-event-log-page-session.js';

describe('EvmEventLogPageSession', () => {
  it('keeps provider affinity and contract bindings within one session only', async () => {
    const providerA = {} as JsonRpcProvider;
    const providerB = {} as JsonRpcProvider;
    const binding = {} as Contract;
    const connectedByCall: Array<Map<JsonRpcProvider, Contract>> = [];
    const preferredByCall: Array<JsonRpcProvider | undefined> = [];
    let call = 0;
    const execute = async (
      _filter: unknown,
      _lo: number,
      _hi: number,
      _providers: ReadonlyArray<{ provider: JsonRpcProvider; backendHead: number }>,
      connected: Map<JsonRpcProvider, Contract>,
      preferred?: JsonRpcProvider,
    ) => {
      connectedByCall.push(connected);
      preferredByCall.push(preferred);
      if (call++ === 0) connected.set(providerB, binding);
      return { logs: [], provider: providerB };
    };
    const providers = [
      { provider: providerA, backendHead: 100 },
      { provider: providerB, backendHead: 100 },
    ];

    const session = new EvmEventLogPageSession(providers, execute);
    await session.query({}, 1, 50);
    await session.query({}, 51, 100);

    expect(preferredByCall).toEqual([undefined, providerB]);
    expect(connectedByCall[1]).toBe(connectedByCall[0]);
    expect(connectedByCall[1].get(providerB)).toBe(binding);

    const isolated = new EvmEventLogPageSession(providers, execute);
    await isolated.query({}, 1, 50);
    expect(preferredByCall[2]).toBeUndefined();
    expect(connectedByCall[2]).not.toBe(connectedByCall[0]);
    expect(connectedByCall[2].size).toBe(0);
  });
});
