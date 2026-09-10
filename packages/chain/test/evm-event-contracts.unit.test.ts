import { Contract } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import { eventContractKeysFor } from '../src/evm-event-contracts.js';
import { EvmHubContractBindings } from '../src/evm-hub-contract-bindings.js';

const first = new Contract('0x0000000000000000000000000000000000000001', []);
const second = new Contract('0x0000000000000000000000000000000000000002', []);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('generation-owned Hub bindings and event selection', () => {
  it('shares one capability across aliases and repeated requested event types', () => {
    expect(eventContractKeysFor(['KCCreated', 'KnowledgeAssetCreated', 'KCCreated']))
      .toEqual(['knowledgeAssetStorage']);
    expect(eventContractKeysFor(['NameClaimed', 'ContextGraphNameClaimed']))
      .toEqual(['contextGraphNameRegistry']);
  });

  it('keeps a noncancellable caller independent of an aborted concurrent load', async () => {
    const group = new EvmHubContractBindings({ hub: first });
    const pending = deferred<Contract>();
    const load = vi.fn(() => pending.promise);
    let settled = false;
    const ordinary = group.resolve(['contextGraphStorage'], load).finally(() => { settled = true; });
    const controller = new AbortController();
    const reason = new Error('event caller cancelled');
    const cancelled = vi.fn(async () => { controller.abort(reason); return second; });
    await expect(group.resolve(['contextGraphStorage'], cancelled, controller.signal)).rejects.toBe(reason);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    pending.resolve(first);
    await expect(ordinary).resolves.toEqual({ contextGraphStorage: first });
    const unused = vi.fn(async () => second);
    await expect(group.resolve(['contextGraphStorage'], unused)).resolves.toEqual({ contextGraphStorage: first });
    expect(unused).not.toHaveBeenCalled();
  });

  it('restarts a staged group when Hub rotation arrives during a lookup', async () => {
    const group = new EvmHubContractBindings({ hub: first });
    const pending = deferred<Contract>();
    const load = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(second);
    const resolving = group.resolve(['contextGraphStorage'], load);
    group.invalidate();
    pending.resolve(first);
    await expect(resolving).resolves.toEqual({ contextGraphStorage: second });
    expect(load).toHaveBeenCalledTimes(2);
    await expect(group.resolve(['contextGraphStorage'], load)).resolves.toEqual({ contextGraphStorage: second });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('merges concurrently completed disjoint groups without losing either capability', async () => {
    const group = new EvmHubContractBindings({ hub: first });
    const pending = deferred<Contract>();
    const firstGroup = group.resolve(['contextGraphStorage'], () => pending.promise);
    await group.resolve(['knowledgeAssetStorage'], async () => second);
    pending.resolve(first);
    await firstGroup;
    const unused = vi.fn(async () => first);
    await expect(group.resolve(['contextGraphStorage', 'knowledgeAssetStorage'], unused))
      .resolves.toEqual({ contextGraphStorage: first, knowledgeAssetStorage: second });
    expect(unused).not.toHaveBeenCalled();
  });

  it('retains the first committed handle when a concurrent same-generation load completes late', async () => {
    const group = new EvmHubContractBindings({ hub: first });
    const pending = deferred<Contract>();
    const slow = group.resolve(['contextGraphStorage'], () => pending.promise);
    await group.resolve(['contextGraphStorage'], async () => second);
    pending.resolve(first);
    await expect(slow).resolves.toEqual({ contextGraphStorage: second });
    expect(group.contracts.contextGraphStorage).toBe(second);
  });

  it('preserves missing optional legacy contracts until the Hub generation changes', async () => {
    const group = new EvmHubContractBindings({ hub: first });
    const load = vi.fn().mockRejectedValueOnce(new Error('legacy contract absent')).mockResolvedValue(first);
    await expect(group.resolve(['contextGraphNameRegistry'], load)).resolves.toEqual({ contextGraphNameRegistry: undefined });
    await group.resolve(['contextGraphNameRegistry'], load);
    expect(load).toHaveBeenCalledOnce();
    group.invalidate();
    await expect(group.resolve(['contextGraphNameRegistry'], load)).resolves.toEqual({ contextGraphNameRegistry: first });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not retain any staged bindings when a required contract fails', async () => {
    const group = new EvmHubContractBindings({ hub: first });
    const failure = new Error('KA storage unavailable');
    const load = vi.fn().mockResolvedValueOnce(first).mockRejectedValueOnce(failure).mockResolvedValue(second);
    const keys = ['contextGraphStorage', 'knowledgeAssetStorage'] as const;
    await expect(group.resolve(keys, load)).rejects.toBe(failure);
    expect(group.contracts.contextGraphStorage).toBeUndefined();
    expect(group.contracts.knowledgeAssetStorage).toBeUndefined();
    await expect(group.resolve(keys, load)).resolves.toEqual({ contextGraphStorage: second, knowledgeAssetStorage: second });
    expect(load).toHaveBeenCalledTimes(4);
  });
});
