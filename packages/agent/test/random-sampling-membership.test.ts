import { RandomSamplingRuntime } from '../src/random-sampling-runtime.js';
import { describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import { DKGAgentBase } from '../src/dkg-agent-base.js';
import type { RandomSamplingHandle } from '../src/random-sampling-bind.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function startCore(initialMembership = true) {
  const address = '0x1111111111111111111111111111111111111111';
  const chain = new MockChainAdapter('mock:31337', address);
  chain.seedIdentity(address, 52n);
  let member = initialMembership;
  const membership = vi.spyOn(chain, 'isShardingTableMember').mockImplementation(async () => member);
  const agent = await DKGAgent.create({
    name: 'RsMembershipLifecycle', listenHost: '127.0.0.1', listenPort: 0,
    chainAdapter: chain, nodeRole: 'core',
    randomSamplingUseWorkerThread: false, randomSamplingTickIntervalMs: 60_000,
  });
  const handles: RandomSamplingHandle[] = [];
  const realCreate = agent.createRandomSamplingHandle.bind(agent);
  const create = vi.spyOn(agent, 'createRandomSamplingHandle').mockImplementation(async (options) => {
    const handle = await realCreate(options);
    handles.push(handle);
    return handle;
  });
  const runtimeFactory = vi.spyOn(agent, 'createRandomSamplingRuntime');
  await agent.start();
  const runtime = (): ReturnType<DKGAgent['createRandomSamplingRuntime']> => {
    const result = runtimeFactory.mock.results.at(-1);
    if (!result || result.type !== 'return') throw new Error('Runtime was not constructed');
    return result.value;
  };
  let pending: ReturnType<DKGAgent['reconcileRandomSamplingProver']> | undefined;
  const beginTick = () => {
    expect(runtime().getLifecycleSnapshot().reconciliationScheduled).toBe(true);
    pending = agent.reconcileRandomSamplingProver({ operationName: 'sync', operationId: 'rs-membership-test' });
    return pending;
  };
  const settleTick = async () => { await pending; };
  return { agent, chain, handles, runtime, create, realCreate, membership, beginTick, settleTick,
    setMember: (value: boolean) => { member = value; },
    tick: async () => { beginTick(); await settleTick(); },
  };
}

describe('Random Sampling membership reconciliation', () => {
  it.each(['bind', 'start'] as const)('retires acquired resources and retries after a %s failure', async (stage) => {
    const handle: RandomSamplingHandle = {
      enabled: true, start: vi.fn(), stop: vi.fn(async () => {}),
      getStatus: () => ({ enabled: true, role: 'core', identityId: '52', disabledReason: null, loop: null }),
    };
    const replacement = { ...handle, start: vi.fn(), stop: vi.fn(async () => {}) };
    const createHandle = vi.fn<(identityId: bigint) => Promise<RandomSamplingHandle>>(async () => replacement);
    if (stage === 'bind') createHandle.mockRejectedValueOnce(new Error('WAL open failed'));
    else {
      vi.mocked(handle.start).mockImplementationOnce(() => { throw new Error('loop start failed'); });
      createHandle.mockResolvedValueOnce(handle);
    }
    const runtime = new RandomSamplingRuntime({
      role: 'core', chain: { chainId: 'mock:0', getIdentityId: async () => 52n, isShardingTableMember: async () => true },
      createHandle, log: { info: vi.fn(), warn: vi.fn() }, shutdownTimeoutMs: () => 100,
    });
    try {
      await expect(runtime.reconcile()).resolves.toBe('retryable');
      expect(runtime.getStatus()).toMatchObject({ enabled: false, disabledReason: 'bind_failed' });
      expect(handle.stop).toHaveBeenCalledTimes(stage === 'start' ? 1 : 0);
      await expect(runtime.reconcile()).resolves.toBe('started');
      expect(replacement.start).toHaveBeenCalledOnce();
    } finally { await runtime.stop(); }
  });

  it('closes a disabled binding without installing or starting it', async () => {
    const handle: RandomSamplingHandle = {
      enabled: false, start: vi.fn(), stop: vi.fn(async () => {}),
      getStatus: () => ({ enabled: false, role: 'core', identityId: '52', disabledReason: 'unsupported_chain', loop: null }),
    };
    const runtime = new RandomSamplingRuntime({
      role: 'core', chain: { chainId: 'mock:0', getIdentityId: async () => 52n, isShardingTableMember: async () => true },
      createHandle: async () => handle, log: { info: vi.fn(), warn: vi.fn() }, shutdownTimeoutMs: () => 100,
    });
    try {
      await expect(runtime.start()).resolves.toBe('disabled');
      expect(handle.start).not.toHaveBeenCalled();
      expect(handle.stop).toHaveBeenCalledOnce();
      expect(runtime.getStatus()).toMatchObject({ enabled: false, disabledReason: 'unsupported_chain' });
      expect(runtime.getLifecycleSnapshot().reconciliationScheduled).toBe(false);
    } finally { await runtime.stop(); }
  });

  it('periodically reconciles eligibility and stops scheduling after cancellation', async () => {
    vi.useFakeTimers();
    let member = false;
    const membership = vi.fn(async () => member);
    const handle: RandomSamplingHandle = {
      enabled: true, start: vi.fn(), stop: vi.fn(async () => {}),
      getStatus: () => ({ enabled: true, role: 'core', identityId: '52', disabledReason: null, loop: null }),
    };
    const createHandle = vi.fn(async () => handle);
    const runtime = new RandomSamplingRuntime({
      role: 'core', chain: { chainId: 'mock:0', getIdentityId: async () => 52n, isShardingTableMember: membership },
      createHandle, log: { info: vi.fn(), warn: vi.fn() }, shutdownTimeoutMs: () => 100,
    });
    try {
      await runtime.start();
      expect(createHandle).not.toHaveBeenCalled();
      member = true;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(membership).toHaveBeenCalledTimes(2);
      expect(handle.start).toHaveBeenCalledOnce();
      member = false;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(handle.stop).toHaveBeenCalledOnce();
      expect(runtime.getStatus()).toMatchObject({ enabled: false, disabledReason: 'awaiting_sharding_table' });
      await runtime.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(membership).toHaveBeenCalledTimes(3);
      expect(runtime.getLifecycleSnapshot().reconciliationScheduled).toBe(false);
    } finally { await runtime.stop(); vi.useRealTimers(); }
  });

  it('restarts an eligible prover on the same agent instance', async () => {
    const f = await startCore();
    try {
      const original = f.handles.at(-1);
      await f.agent.stop();
      await f.agent.start();
      expect(f.create).toHaveBeenCalledTimes(2);
      expect(f.handles.at(-1)).not.toBe(original);
      expect(f.runtime().getLifecycleSnapshot().reconciliationScheduled).toBe(true);
      await vi.waitFor(() => expect(f.agent.getRandomSamplingStatus().loop?.totalTicks).toBeGreaterThan(0));
    } finally { await f.agent.stop(); }
  });


  it('stops an admitted prover on removal and creates a fresh handle after readmission', async () => {
    const f = await startCore();
    try {
      const original = f.handles.at(-1)!;
      const stop = vi.spyOn(original, 'stop');
      f.setMember(false);
      await f.tick();
      expect(stop).toHaveBeenCalledOnce();
      expect(f.agent.getRandomSamplingStatus()).toMatchObject({ enabled: false, disabledReason: 'awaiting_sharding_table', identityId: '52' });
      expect(f.runtime().getLifecycleSnapshot().phase).not.toBe('running');
      f.setMember(true);
      await f.tick();
      expect(f.create).toHaveBeenCalledTimes(2);
      expect(f.handles.at(-1)).not.toBe(original);
      expect(f.agent.getRandomSamplingStatus()).toMatchObject({ enabled: true, disabledReason: null, identityId: '52' });
      await vi.waitFor(() => expect(f.agent.getRandomSamplingStatus().loop?.totalTicks).toBeGreaterThan(0));
      await f.tick();
      expect(f.create).toHaveBeenCalledTimes(2);
    } finally { await f.agent.stop(); }
  });

  it.each(['identity', 'membership'] as const)('keeps the active handle through a transient %s lookup failure', async (stage) => {
    const f = await startCore();
    try {
      const original = f.handles.at(-1)!;
      const stop = vi.spyOn(original, 'stop');
      if (stage === 'identity') vi.spyOn(f.chain, 'getIdentityId').mockRejectedValueOnce(new Error('temporary RPC outage'));
      else f.membership.mockRejectedValueOnce(new Error('temporary RPC outage'));
      await f.tick();
      expect(f.handles.at(-1)).toBe(original);
      expect(stop).not.toHaveBeenCalled();
      expect(f.agent.getRandomSamplingStatus()).toMatchObject({ enabled: true, disabledReason: null, identityId: '52' });
      await f.tick();
      expect(f.create).toHaveBeenCalledOnce();
    } finally { await f.agent.stop(); }
  });

  it.each([0n, 53n])('rebinds only after the current identity becomes eligible (%s)', async (identityId) => {
    const f = await startCore();
    try {
      const original = f.handles.at(-1)!;
      const stop = vi.spyOn(original, 'stop');
      vi.spyOn(f.chain, 'getIdentityId').mockResolvedValue(identityId);
      await f.tick();
      expect(stop).toHaveBeenCalledOnce();
      expect(f.agent.getRandomSamplingStatus()).toMatchObject({
        enabled: identityId !== 0n,
        identityId: identityId.toString(),
        disabledReason: identityId === 0n ? 'no_identity' : null,
      });
      expect(f.create).toHaveBeenCalledTimes(identityId === 0n ? 1 : 2);
    } finally { await f.agent.stop(); }
  });

  it('coalesces overlapping reconciliation ticks while membership is unresolved', async () => {
    const f = await startCore();
    const gate = deferred<boolean>();
    const entered = deferred<void>();
    try {
      f.membership.mockClear();
      f.membership.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
      f.beginTick();
      await entered.promise;
      f.beginTick();
      f.beginTick();
      expect(f.membership).toHaveBeenCalledOnce();
      gate.resolve(true);
      await f.settleTick();
      expect(f.create).toHaveBeenCalledOnce();
    } finally { gate.resolve(true); await f.agent.stop(); }
  });

  it('does not bind when a pending membership lookup completes after shutdown begins', async () => {
    const f = await startCore(false);
    const gate = deferred<boolean>();
    const entered = deferred<void>();
    try {
      f.membership.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
      f.beginTick();
      await entered.promise;
      const stopping = f.agent.stop();
      gate.resolve(true);
      await stopping;
      await f.settleTick();
      expect(f.create).not.toHaveBeenCalled();
      expect(f.runtime().getLifecycleSnapshot().phase).not.toBe('running');
      expect(f.runtime().getLifecycleSnapshot().reconciliationScheduled).toBe(false);
      expect(f.agent.getRandomSamplingStatus().enabled).toBe(false);
    } finally { gate.resolve(false); await f.agent.stop(); }
  });

  it('drains binding and physical close before shutdown completes without starting the unused handle', async () => {
    const f = await startCore(false);
    const gate = deferred<void>();
    const entered = deferred<RandomSamplingHandle>();
    const closeGate = deferred<void>();
    try {
      f.create.mockImplementationOnce(async (options) => {
        const handle = await f.realCreate(options);
        entered.resolve(handle);
        await gate.promise;
        return handle;
      });
      f.setMember(true);
      f.beginTick();
      const handle = await entered.promise;
      const start = vi.spyOn(handle, 'start');
      const realStop = handle.stop.bind(handle);
      const stop = vi.spyOn(handle, 'stop').mockImplementation(async () => { await realStop(); await closeGate.promise; });
      const stopNode = vi.spyOn(f.agent.node, 'stop');
      let finished = false;
      const stopping = f.agent.stop().then(() => { finished = true; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(finished).toBe(false);
      expect(stopNode).not.toHaveBeenCalled();
      gate.resolve();
      await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
      expect(finished).toBe(false);
      expect(stopNode).not.toHaveBeenCalled();
      closeGate.resolve();
      await stopping;
      await f.settleTick();
      expect(start).not.toHaveBeenCalled();
      expect(stop).toHaveBeenCalledOnce();
      expect(f.runtime().getLifecycleSnapshot().phase).not.toBe('running');
      expect(f.runtime().getLifecycleSnapshot().reconciliationScheduled).toBe(false);
    } finally { gate.resolve(); closeGate.resolve(); await f.agent.stop(); }
  });

  it('quarantines a timed-out bind until physical cleanup completes before restart', async () => {
    const f = await startCore(false);
    const timeout = DKGAgentBase.RANDOM_SAMPLING_SHUTDOWN_TIMEOUT_MS;
    const gate = deferred<void>();
    const entered = deferred<RandomSamplingHandle>();
    Object.defineProperty(DKGAgentBase, 'RANDOM_SAMPLING_SHUTDOWN_TIMEOUT_MS', { configurable: true, value: 10 });
    try {
      f.create.mockImplementationOnce(async (options) => {
        const handle = await f.realCreate(options);
        entered.resolve(handle);
        await gate.promise;
        return handle;
      });
      f.setMember(true);
      f.beginTick();
      const unused = await entered.promise;
      const start = vi.spyOn(unused, 'start');
      const close = vi.spyOn(unused, 'stop');
      const stopNode = vi.spyOn(f.agent.node, 'stop');
      await expect(f.agent.stop()).rejects.toMatchObject({ name: 'RandomSamplingShutdownTimeoutError' });
      expect(stopNode).not.toHaveBeenCalled();
      expect(f.create).toHaveBeenCalledOnce();
      gate.resolve();
      await f.agent.stop();
      expect(close).toHaveBeenCalledOnce();
      expect(start).not.toHaveBeenCalled();
      await f.agent.start();
      expect(f.create).toHaveBeenCalledTimes(2);
      await vi.waitFor(() => expect(f.agent.getRandomSamplingStatus().loop?.totalTicks).toBeGreaterThan(0));
    } finally {
      gate.resolve();
      Object.defineProperty(DKGAgentBase, 'RANDOM_SAMPLING_SHUTDOWN_TIMEOUT_MS', { configurable: true, value: timeout });
      await f.agent.stop();
    }
  });

  it('waits for physical retirement before replacing a readmitted prover', async () => {
    const f = await startCore();
    const timeout = DKGAgentBase.RANDOM_SAMPLING_SHUTDOWN_TIMEOUT_MS;
    const gate = deferred<void>();
    Object.defineProperty(DKGAgentBase, 'RANDOM_SAMPLING_SHUTDOWN_TIMEOUT_MS', { configurable: true, value: 10 });
    try {
      const original = f.handles.at(-1)!;
      const realStop = original.stop.bind(original);
      const stopped = realStop().then(() => gate.promise);
      vi.spyOn(original, 'stop').mockReturnValue(stopped);
      f.setMember(false);
      await f.tick();
      expect(f.handles.at(-1)).toBe(original);
      expect(f.agent.getRandomSamplingStatus()).toMatchObject({ enabled: false, disabledReason: 'retiring', identityId: '52' });
      f.setMember(true);
      await f.tick();
      expect(f.create).toHaveBeenCalledOnce();
      gate.resolve();
      await f.tick();
      expect(f.create).toHaveBeenCalledTimes(2);
      expect(f.handles.at(-1)).not.toBe(original);
    } finally {
      gate.resolve();
      Object.defineProperty(DKGAgentBase, 'RANDOM_SAMPLING_SHUTDOWN_TIMEOUT_MS', { configurable: true, value: timeout });
      await f.agent.stop();
    }
  });
});
