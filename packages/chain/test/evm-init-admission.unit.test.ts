import { afterEach, describe, expect, it, vi } from 'vitest';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import { HubBindingNotFoundError, HubContractNotFoundError, HubAssetStorageNotFoundError } from '../src/hub-contract-not-found-error.js';
import { ZeroAddress } from 'ethers';
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
      .mockImplementation(async () => { await resolve('RandomSampling'); return resolve('RandomSamplingStorage'); });
    vi.spyOn(adapter, 'readContract').mockResolvedValue(7n);
    vi.spyOn(adapter, 'startChainIndexRuntime').mockImplementation(() => {});
    vi.spyOn(adapter, 'startHubRotationListener').mockResolvedValue(undefined);
    adapter.tokenAddress = ADDRESS;
    return { adapter, allow: () => { fail = false; } };
  }

  it.each([
    'Staking', 'ProfileStorage', 'KnowledgeAssets', 'AskStorage',
    'KnowledgeAssetsStorage', 'ContextGraphNameRegistry', 'ContextGraphs', 'ContextGraphStorage', 'KnowledgeAssetsLifecycle',
    'DKGPublishingConvictionNFT', 'Chronos', 'RandomSampling', 'RandomSamplingStorage',
  ])('refuses incomplete %s initialization and permits the same adapter to retry', async (contract) => {
    const error = { code: 'RPC_REQUEST_GOVERNOR_QUEUE_FULL' };
    const { adapter, allow } = fixture(contract, error);
    await expect(adapter.getIdentityId()).rejects.toBe(error);
    expect(adapter.initialized).toBe(false);
    allow();
    await expect(adapter.getIdentityId()).resolves.toBe(7n);
    expect(adapter.initialized).toBe(true);
  });

  it.each([
    'Staking', 'ProfileStorage', 'KnowledgeAssets', 'KnowledgeAssetsStorage', 'AskStorage',
    'ContextGraphNameRegistry', 'ContextGraphs', 'ContextGraphStorage', 'KnowledgeAssetsLifecycle',
    'DKGPublishingConvictionNFT', 'Chronos', 'RandomSampling', 'RandomSamplingStorage',
  ])('propagates non-absence failure at %s and permits the same adapter to retry', async (name) => {
    const error = new Error('invalid transport configuration');
    const { adapter, allow } = fixture(name, error);
    await expect(adapter.getIdentityId()).rejects.toBe(error);
    expect(adapter.initialized).toBe(false);
    allow();
    await expect(adapter.getIdentityId()).resolves.toBe(7n);
    expect(adapter.initialized).toBe(true);
  });

  it('continues to tolerate genuinely absent optional contracts', async () => {
    const { adapter } = fixture('KnowledgeAssetsLifecycle', new HubContractNotFoundError('KnowledgeAssetsLifecycle', ADDRESS));
    await expect(adapter.getIdentityId()).resolves.toBe(7n);
    expect(adapter.contracts.knowledgeAssetsLifecycle).toBeUndefined();
  });

  it.each([
    'Staking', 'ProfileStorage', 'KnowledgeAssets', 'KnowledgeAssetsStorage', 'AskStorage',
    'ContextGraphNameRegistry', 'ContextGraphs', 'ContextGraphStorage', 'KnowledgeAssetsLifecycle',
    'DKGPublishingConvictionNFT', 'Chronos', 'RandomSampling', 'RandomSamplingStorage',
  ])('tolerates typed absence at %s', async (name) => {
    const error = ['KnowledgeAssetsStorage', 'ContextGraphStorage'].includes(name)
      ? new HubAssetStorageNotFoundError(name, ADDRESS) : new HubContractNotFoundError(name, ADDRESS);
    const { adapter } = fixture(name, error);
    await expect(adapter.getIdentityId()).resolves.toBe(7n);
    expect(adapter.initialized).toBe(true);
  });

  it.each(['Identity', 'DKGKnowledgeAssets'])('refuses required typed absence at %s', async (name) => {
    const error = name === 'Identity' ? new HubContractNotFoundError(name, ADDRESS)
      : new HubAssetStorageNotFoundError(name, ADDRESS);
    const { adapter } = fixture(name, error);
    await expect(adapter.getIdentityId()).rejects.toBe(error);
    expect(adapter.initialized).toBe(false);
  });

  it.each([
    ['KnowledgeAssetsStorage', 'knowledgeAssets', 'knowledgeAssetsStorage'],
    ['ContextGraphStorage', 'contextGraphs', 'contextGraphStorage'],
  ])('retains the resolved contract on %s failure and safely retries the incomplete pair', async (storage, contractSlot, storageSlot) => {
    const error = new Error('storage transport failure');
    const { adapter, allow } = fixture(storage, error);
    await expect(adapter.getIdentityId()).rejects.toBe(error);
    expect(adapter.contracts[contractSlot].target).toBe(ADDRESS);
    expect(adapter.contracts[storageSlot]).toBeUndefined();
    expect(adapter.initialized).toBe(false);
    allow();
    await expect(adapter.getIdentityId()).resolves.toBe(7n);
    expect(adapter.contracts[storageSlot].target).toBe(ADDRESS);
    expect(adapter.initialized).toBe(true);
  });

  it.each(['contract', 'asset-storage'] as const)('normalizes both zero and custom-revert %s misses', async (kind) => {
    const { adapter, allow } = fixture('unused', undefined);
    allow();
    const method = kind === 'contract' ? 'resolveContract' : 'resolveAssetStorage';
    vi.mocked(adapter[method]).mockRestore();
    for (const value of [ZeroAddress, new Error('execution reverted: ContractDoesNotExist')]) {
      vi.mocked(adapter.readContract).mockImplementation(async () => {
        if (value instanceof Error) throw value;
        return value;
      });
      const error = await adapter[method](`Absent-${kind}-${String(value)}`).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(HubBindingNotFoundError);
      expect(error).toBeInstanceOf(kind === 'contract' ? HubContractNotFoundError : HubAssetStorageNotFoundError);
      expect(error.bindingKind).toBe(kind);
      expect(error.hubAddress).toBe(ADDRESS);
      expect(error.cause).toBe(value instanceof Error ? value : undefined);
    }
  });

  it.each([new Error('aborted transport'), new HubContractNotFoundError('KnowledgeAssetsLifecycle', ADDRESS)])('does not swallow cancellation during an optional contract read (%s)', async (failure) => {
    const controller = new AbortController();
    const reason = new Error('bootstrap cancelled');
    const { adapter } = fixture('KnowledgeAssetsLifecycle', failure,
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
