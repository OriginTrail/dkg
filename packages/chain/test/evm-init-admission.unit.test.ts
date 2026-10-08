import { afterEach, describe, expect, it, vi } from 'vitest';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import { activeRpcRequestContext, withRpcRequestContext, type RpcRequestContext } from '../src/rpc-request-transport.js';

const ADDRESS = '0x0000000000000000000000000000000000000001';
const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

describe('optional contract initialization preserves local refusal', () => {
  const adapters: EVMChainAdapter[] = [];
  afterEach(() => {
    for (const adapter of adapters.splice(0)) adapter.destroy();
    vi.restoreAllMocks();
  });

  function fixture(failing: string, error: unknown, beforeThrow = () => {}) {
    const adapter: any = new EVMChainAdapter({
      rpcUrl: 'http://127.0.0.1:1', privateKey: PRIVATE_KEY,
      hubAddress: ADDRESS, chainId: 'evm:31337', allowNoAdminSigner: true,
    });
    adapters.push(adapter);
    let fail = true;
    const resolve = async (name: string) => {
      if (name === failing && fail) {
        beforeThrow();
        throw error;
      }
      return { target: ADDRESS, getAddress: async () => ADDRESS };
    };
    vi.spyOn(adapter, 'resolveContract').mockImplementation(resolve);
    vi.spyOn(adapter, 'resolveAssetStorage').mockImplementation(resolve);
    vi.spyOn(adapter, 'resolveAndAssignRandomSamplingPair')
      .mockImplementation(() => resolve('RandomSampling'));
    vi.spyOn(adapter, 'readContract').mockResolvedValue(7n);
    vi.spyOn(adapter, 'startChainIndexRuntime').mockImplementation(() => {});
    vi.spyOn(adapter, 'startHubRotationListener').mockResolvedValue(undefined);
    adapter.tokenAddress = ADDRESS;
    return { adapter, allow: () => { fail = false; } };
  }

  it.each([
    'Staking', 'ProfileStorage', 'KnowledgeAssets', 'AskStorage',
    'KnowledgeAssetsStorage', 'ContextGraphNameRegistry', 'ContextGraphs', 'ContextGraphStorage', 'KnowledgeAssetsLifecycle',
    'DKGPublishingConvictionNFT', 'Chronos', 'RandomSampling',
  ])('refuses incomplete %s initialization and permits the same adapter to retry', async (contract) => {
    const error = { code: 'RPC_REQUEST_GOVERNOR_QUEUE_FULL' };
    const { adapter, allow } = fixture(contract, error);
    await expect(adapter.getIdentityId()).rejects.toBe(error);
    expect(adapter.initialized).toBe(false);
    allow();
    await expect(adapter.getIdentityId()).resolves.toBe(7n);
    expect(adapter.initialized).toBe(true);
  });

  it('continues to tolerate genuinely absent optional contracts', async () => {
    const { adapter } = fixture('KnowledgeAssetsLifecycle', new Error('ContractDoesNotExist'));
    await expect(adapter.getIdentityId()).resolves.toBe(7n);
    expect(adapter.contracts.knowledgeAssetsLifecycle).toBeUndefined();
  });

  it('does not swallow cancellation during an optional contract read', async () => {
    const controller = new AbortController();
    const reason = new Error('bootstrap cancelled');
    const { adapter } = fixture('KnowledgeAssetsLifecycle', new Error('aborted transport'),
      () => controller.abort(reason));
    await expect(withRpcRequestContext({ signal: controller.signal }, () => adapter.getIdentityId()))
      .rejects.toBe(reason);
    expect(adapter.initialized).toBe(false);
  });

  it('detaches both adapter-owned background starts from transient bootstrap context', async () => {
    const { adapter, allow } = fixture('Staking', new Error('unused'));
    allow();
    vi.mocked(adapter.startChainIndexRuntime).mockRestore();
    vi.mocked(adapter.startHubRotationListener).mockRestore();
    const contexts: RpcRequestContext[] = [];
    const continuations: Promise<void>[] = [];
    const capture = () => {
      contexts.push(activeRpcRequestContext());
      continuations.push(Promise.resolve().then(() => { contexts.push(activeRpcRequestContext()); }));
    };
    vi.spyOn(adapter.chainIndexOwner, 'start').mockImplementation(capture);
    vi.spyOn(adapter.hubRotationPoller, 'start').mockImplementation(capture);
    const controller = new AbortController();
    const onProgress = vi.fn();
    await expect(withRpcRequestContext({ signal: controller.signal, onProgress }, () => adapter.getIdentityId()))
      .resolves.toBe(7n);
    controller.abort(new Error('bootstrap disposed'));
    await Promise.all(continuations);
    expect(contexts).toHaveLength(4);
    for (const context of contexts) {
      expect(context.requestClass).toBe('foreground');
      expect(context.signal).toBeUndefined();
      expect(context.onProgress).toBeUndefined();
    }
  });

  it('keeps the admission priority of an initializing authority read out of the adapter-owned starts', async () => {
    const { adapter, allow } = fixture('Staking', new Error('unused'));
    allow();
    vi.mocked(adapter.startChainIndexRuntime).mockRestore();
    vi.mocked(adapter.startHubRotationListener).mockRestore();
    const contexts: RpcRequestContext[] = [];
    const continuations: Promise<void>[] = [];
    const capture = () => {
      contexts.push(activeRpcRequestContext());
      continuations.push(Promise.resolve().then(() => { contexts.push(activeRpcRequestContext()); }));
    };
    vi.spyOn(adapter.chainIndexOwner, 'start').mockImplementation(capture);
    vi.spyOn(adapter.hubRotationPoller, 'start').mockImplementation(capture);

    await expect(withRpcRequestContext(
      { requestClass: 'background', admissionPriority: 'authority' },
      () => adapter.getIdentityId(),
    )).resolves.toBe(7n);
    await Promise.all(continuations);

    // What the adapter starts for itself runs for the life of the process. The
    // priority belonged to the one read that found the adapter uninitialized.
    expect(contexts).toHaveLength(4);
    for (const context of contexts) {
      expect(context.admissionPriority).toBeUndefined();
      expect(context.signal).toBeUndefined();
    }
  });
});
