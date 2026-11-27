import { describe, expect, it, vi } from 'vitest';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';

const PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

function minimalConfig(): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: PRIVATE_KEY,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    staticNetwork: false,
  };
}

function makeAdapter() {
  const adapter = new EVMChainAdapter(minimalConfig()) as EVMChainAdapter & {
    initialized: boolean;
    contracts: { contextGraphStorage: object };
    readContractWithOptions: ReturnType<typeof vi.fn>;
  };
  adapter.initialized = true;
  adapter.init = vi.fn(async () => undefined);
  adapter.contracts = { contextGraphStorage: {} };
  adapter.readContractWithOptions = vi.fn();
  return adapter;
}

describe('EVM Context Graph policy cancellation', () => {
  it('forwards the caller signal to the liveness contract read', async () => {
    const adapter = makeAdapter();
    const controller = new AbortController();
    adapter.readContractWithOptions.mockResolvedValue(true);

    await expect(adapter.isContextGraphActiveOnChain(
      7n,
      { signal: controller.signal },
    )).resolves.toBe(true);

    expect(adapter.readContractWithOptions).toHaveBeenCalledWith(
      adapter.contracts.contextGraphStorage,
      'cgStorage.isContextGraphActive',
      'isContextGraphActive',
      [7n],
      { signal: controller.signal },
    );
  });

  it('forwards the policy signal and never starts fallback after primary cancellation', async () => {
    const adapter = makeAdapter();
    const controller = new AbortController();
    const abortError = new Error('policy read cancelled');
    adapter.readContractWithOptions.mockImplementation(async (
      _contract: object,
      _label: string,
      method: string,
      _args: unknown[],
      options: { signal?: AbortSignal },
    ) => {
      expect(method).toBe('getAccessPolicy');
      expect(options.signal).toBe(controller.signal);
      controller.abort(abortError);
      throw abortError;
    });

    await expect(adapter.getContextGraphAccessPolicy(
      7n,
      { signal: controller.signal },
    )).rejects.toBe(abortError);

    expect(adapter.readContractWithOptions).toHaveBeenCalledTimes(1);
    expect(adapter.readContractWithOptions).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'getContextGraph',
      expect.anything(),
      expect.anything(),
    );
  });
});
