import { createRandomSamplingEligibilityResolver, type RandomSamplingEligibilityChain } from '../src/random-sampling-eligibility.js';
import { RandomSamplingRuntime, type RandomSamplingRuntimeOptions } from '../src/random-sampling-runtime.js';
import { describe, expect, it, vi } from 'vitest';
import { MockChainAdapter, type RandomSamplingAvailability } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import { DKGAgentBase } from '../src/dkg-agent-base.js';
import {
  bindRandomSampling,
  type RandomSamplingBindingResult,
  type RandomSamplingDisabledReason,
  type RandomSamplingHandle,
} from '../src/random-sampling-bind.js';

function readyBinding(handle: RandomSamplingHandle): RandomSamplingBindingResult {
  return { kind: 'ready', handle };
}

function createRuntime(options: Omit<RandomSamplingRuntimeOptions, 'resolveEligibility'> & { chain: RandomSamplingEligibilityChain }) {
  return new RandomSamplingRuntime({ ...options, resolveEligibility: createRandomSamplingEligibilityResolver(options) });
}

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
    const binding = await realCreate(options);
    if (binding.kind === 'ready') handles.push(binding.handle);
    return binding;
  });
  await agent.start();
  const runtime = (): RandomSamplingRuntime => {
    const owned = (agent as unknown as { randomSamplingRuntime: RandomSamplingRuntime | null }).randomSamplingRuntime;
    if (!owned) throw new Error('Runtime was not constructed');
    return owned;
  };
  let pending: Promise<void> | undefined;
  const beginTick = () => {
    expect(runtime().getDiagnostics().reconciliationScheduled).toBe(true);
    pending = runtime().reconcile();
    return pending;
  };
  const settleTick = async () => { await pending; };
  return { agent, chain, handles, runtime, create, realCreate, membership, beginTick, settleTick,
    setMember: (value: boolean) => { member = value; },
    tick: async () => { beginTick(); await settleTick(); },
  };
}

describe('Random Sampling membership reconciliation', () => {
  it.each([
    {
      name: 'edge role', role: 'edge' as const, identityId: 52n,
      chain: {}, reason: 'edge_node' as RandomSamplingDisabledReason,
    },
    {
      name: 'zero identity', role: 'core' as const, identityId: 0n,
      chain: {}, reason: 'no_identity' as RandomSamplingDisabledReason,
    },
    {
      name: 'missing chain methods', role: 'core' as const, identityId: 52n,
      chain: {}, reason: 'unsupported_chain' as RandomSamplingDisabledReason,
    },
    {
      name: 'contracts not ready', role: 'core' as const, identityId: 52n,
      chain: {
        getActiveProofPeriodStatus() {}, createChallenge() {}, submitProof() {},
        getNodeChallenge() {}, getKAContextGraphId() {}, isRandomSamplingReady: () => false,
      },
      reason: 'contracts_not_deployed' as RandomSamplingDisabledReason,
    },
  ])('preserves the public no-op handle contract for $name', async ({ role, identityId, chain, reason }) => {
    const handle = await bindRandomSampling({
      role, identityId, chain: chain as never, store: {} as never,
      // If an early-unavailable path attempted to acquire a WAL, this invalid
      // parent would make the compatibility test fail instead of leaking it.
      walPath: '/path-that-must-not-exist/random-sampling/wal.json',
    });
    expect(handle.enabled).toBe(false);
    expect(() => handle.start()).not.toThrow();
    await expect(handle.stop()).resolves.toBeUndefined();
    expect(handle.getStatus()).toMatchObject({
      enabled: false, role, identityId: identityId.toString(), disabledReason: reason, loop: null,
    });
  });

  it.each([
    { active: false, missing: false, phase: 'waiting', stopped: 0, scheduled: true, observed: false },
    { active: true, missing: false, phase: 'running', stopped: 0, scheduled: true, observed: true },
    { active: false, missing: true, phase: 'disabled', stopped: 0, scheduled: false, observed: false },
    { active: true, missing: true, phase: 'waiting', stopped: 1, scheduled: true, observed: true },
  ])('applies typed chain outcomes: active=$active missing=$missing', async ({ active, missing, phase, stopped, scheduled, observed }) => {
    const failure = new Error('temporary RPC outage');
    const availability = vi.fn(async (): Promise<RandomSamplingAvailability> => ({ kind: 'available', member: true }));
    const stop = vi.fn(async () => {});
    const runtime = createRuntime({
      role: 'core', chain: {
        chainId: 'mock:0', getIdentityId: async () => 52n,
        resolveRandomSamplingAvailability: availability,
      },
      createHandle: async () => readyBinding({ enabled: true, start: vi.fn(), stop,
        getStatus: () => ({ enabled: true, role: 'core', identityId: '52', disabledReason: null, loop: null }) }),
      log: { info: vi.fn(), warn: vi.fn() }, shutdownTimeoutMs: () => 100,
    });
    try {
      if (active) await runtime.start();
      availability.mockResolvedValue(missing
        ? { kind: 'unavailable', reason: 'contracts_not_deployed' }
        : { kind: 'indeterminate', error: failure });
      await runtime.reconcile();
      expect(runtime.getDiagnostics()).toMatchObject({
        phase,
        reconciliationScheduled: scheduled,
        deploymentObserved: observed,
      });
      expect(stop).toHaveBeenCalledTimes(stopped);
      expect(runtime.getStatus().enabled).toBe(active && !missing);
    } finally { await runtime.stop(); }
  });

  it.each(['shutdown', 'membership'] as const)('waits for a failing close to settle during %s, then permits a fresh lifecycle', async (stage) => {
    const f = await startCore();
    const gate = deferred<void>();
    const entered = deferred<void>();
    const original = f.handles.at(-1)!;
    const realStop = original.stop.bind(original);
    const stop = vi.spyOn(original, 'stop').mockImplementation(async () => {
      await realStop();
      entered.resolve();
      await gate.promise;
      throw new Error('WAL close failed');
    });
    const stopNode = vi.spyOn(f.agent.node, 'stop');
    const closeStore = vi.spyOn(f.agent.store, 'close');
    try {
      if (stage === 'membership') f.setMember(false);
      const settling = stage === 'shutdown' ? f.agent.stop() : f.tick();
      await entered.promise;
      expect(stopNode).not.toHaveBeenCalled();
      expect(closeStore).not.toHaveBeenCalled();
      expect(f.agent.getRandomSamplingStatus().disabledReason).toBe('retiring');
      gate.resolve();
      await settling;
      expect(stop).toHaveBeenCalledOnce();
      if (stage === 'shutdown') {
        expect(stopNode).toHaveBeenCalledOnce();
        expect(closeStore).toHaveBeenCalledOnce();
        await f.agent.stop();
        await f.agent.start();
      } else {
        expect(f.agent.getRandomSamplingStatus().disabledReason).toBe('awaiting_sharding_table');
        expect(stopNode).not.toHaveBeenCalled();
        f.setMember(true);
        await f.tick();
      }
      expect(f.create).toHaveBeenCalledTimes(2);
      expect(f.agent.getRandomSamplingStatus().enabled).toBe(true);
    } finally { gate.resolve(); await f.agent.stop(); }
  });

  it('continues draining physical retirement when its reconciliation deadline expires during shutdown', async () => {
    let member = true;
    const gate = deferred<void>();
    const entered = deferred<void>();
    const runtime = createRuntime({
      role: 'core', chain: { chainId: 'mock:0', getIdentityId: async () => 52n, isShardingTableMember: async () => member },
      createHandle: async () => readyBinding({ enabled: true, start: vi.fn(), stop: async () => { entered.resolve(); await gate.promise; },
        getStatus: () => ({ enabled: true, role: 'core', identityId: '52', disabledReason: null, loop: null }) }),
      log: { info: vi.fn(), warn: vi.fn() }, shutdownTimeoutMs: () => 10,
    });
    try {
      await runtime.start();
      member = false;
      const reconciling = runtime.reconcile();
      await entered.promise;
      await expect(runtime.stop()).rejects.toMatchObject({ name: 'RandomSamplingShutdownTimeoutError' });
      await reconciling;
      expect(runtime.getDiagnostics().phase).toBe('retiring');
      gate.resolve();
      await expect(runtime.stop()).resolves.toBeUndefined();
      expect(runtime.getDiagnostics().phase).toBe('stopped');
    } finally { gate.resolve(); await runtime.stop(); }
  });

  it('rechecks invalidated contract handles and binds afresh after contracts return', async () => {
    vi.useFakeTimers();
    let ready = true;
    let deployed = true;
    const refresh = vi.fn(async () => {
      ready = deployed;
      return ready ? { kind: 'available' as const, member: true }
        : { kind: 'unavailable' as const, reason: 'contracts_not_deployed' as const };
    });
    const handles: RandomSamplingHandle[] = [];
    const runtime = createRuntime({
      role: 'core', chain: {
        chainId: 'mock:0', getIdentityId: async () => 52n,
        isRandomSamplingReady: () => ready, isShardingTableMember: async () => true,
        resolveRandomSamplingAvailability: refresh,
      },
      createHandle: async () => {
        const handle: RandomSamplingHandle = {
          enabled: true, start: vi.fn(), stop: vi.fn(async () => {}),
          getStatus: () => ({ enabled: true, role: 'core', identityId: '52', disabledReason: null, loop: null }),
        };
        handles.push(handle);
        return readyBinding(handle);
      },
      log: { info: vi.fn(), warn: vi.fn() }, shutdownTimeoutMs: () => 100,
    });
    try {
      await runtime.start();
      ready = false;
      deployed = false;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(handles[0].stop).toHaveBeenCalledOnce();
      expect(runtime.getDiagnostics().reconciliationScheduled).toBe(true);
      deployed = true;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(refresh).toHaveBeenCalledTimes(3);
      expect(handles).toHaveLength(2);
      expect(handles[1].start).toHaveBeenCalledOnce();
      expect(runtime.getStatus().enabled).toBe(true);
    } finally { await runtime.stop(); vi.useRealTimers(); }
  });

  it('releases settled failed cleanup instead of caching a rejected shutdown forever', async () => {
    const stop = vi.fn(async () => { throw new Error('WAL close failed'); });
    const warn = vi.fn();
    const runtime = createRuntime({
      role: 'core', chain: { chainId: 'mock:0', getIdentityId: async () => 52n, isShardingTableMember: async () => true },
      createHandle: async () => readyBinding({ enabled: true, start: vi.fn(), stop,
        getStatus: () => ({ enabled: true, role: 'core', identityId: '52', disabledReason: null, loop: null }) }),
      log: { info: vi.fn(), warn }, shutdownTimeoutMs: () => 100,
    });
    try {
      await runtime.start();
      await expect(runtime.stop()).resolves.toBeUndefined();
      await expect(runtime.stop()).resolves.toBeUndefined();
      expect(stop).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('WAL close failed'));
      expect(runtime.getDiagnostics().phase).toBe('stopped');
      expect(runtime.getStatus().enabled).toBe(false);
    } finally { await runtime.stop().catch(() => {}); }
  });

  it.each(['bind', 'start'] as const)('retires acquired resources and retries after a %s failure', async (stage) => {
    const handle: RandomSamplingHandle = {
      enabled: true, start: vi.fn(), stop: vi.fn(async () => {}),
      getStatus: () => ({ enabled: true, role: 'core', identityId: '52', disabledReason: null, loop: null }),
    };
    const replacement = { ...handle, start: vi.fn(), stop: vi.fn(async () => {}) };
    const createHandle = vi.fn<(identityId: bigint) => Promise<RandomSamplingBindingResult>>(async () => readyBinding(replacement));
    if (stage === 'bind') createHandle.mockRejectedValueOnce(new Error('WAL open failed'));
    else {
      vi.mocked(handle.start).mockImplementationOnce(() => { throw new Error('loop start failed'); });
      createHandle.mockResolvedValueOnce(readyBinding(handle));
    }
    const runtime = createRuntime({
      role: 'core', chain: { chainId: 'mock:0', getIdentityId: async () => 52n, isShardingTableMember: async () => true },
      createHandle, log: { info: vi.fn(), warn: vi.fn() }, shutdownTimeoutMs: () => 100,
    });
    try {
      await expect(runtime.reconcile()).resolves.toBeUndefined();
      expect(runtime.getStatus()).toMatchObject({ enabled: false, disabledReason: 'bind_failed' });
      expect(handle.stop).toHaveBeenCalledTimes(stage === 'start' ? 1 : 0);
      await expect(runtime.reconcile()).resolves.toBeUndefined();
      expect(replacement.start).toHaveBeenCalledOnce();
    } finally { await runtime.stop(); }
  });

  it('closes a disabled binding without installing or starting it', async () => {
    const handle: RandomSamplingHandle = {
      enabled: false, start: vi.fn(), stop: vi.fn(async () => {}),
      getStatus: () => ({ enabled: false, role: 'core', identityId: '52', disabledReason: 'unsupported_chain', loop: null }),
    };
    const runtime = createRuntime({
      role: 'core', chain: { chainId: 'mock:0', getIdentityId: async () => 52n, isShardingTableMember: async () => true },
      createHandle: async () => ({
        kind: 'unavailable', reason: 'unsupported_chain', handleToClose: handle,
      }),
      log: { info: vi.fn(), warn: vi.fn() }, shutdownTimeoutMs: () => 100,
    });
    try {
      await expect(runtime.start()).resolves.toBeUndefined();
      expect(handle.start).not.toHaveBeenCalled();
      expect(handle.stop).toHaveBeenCalledOnce();
      expect(runtime.getStatus()).toMatchObject({ enabled: false, disabledReason: 'unsupported_chain' });
      expect(runtime.getDiagnostics().reconciliationScheduled).toBe(false);
    } finally { await runtime.stop(); }
  });

  it('retries contract invalidation between eligibility and binding', async () => {
    const disabled: RandomSamplingHandle = {
      enabled: false, start: vi.fn(), stop: vi.fn(async () => {}),
      getStatus: () => ({ enabled: false, role: 'core', identityId: '52', disabledReason: 'contracts_not_deployed', loop: null }),
    };
    const enabled: RandomSamplingHandle = {
      enabled: true, start: vi.fn(), stop: vi.fn(async () => {}),
      getStatus: () => ({ enabled: true, role: 'core', identityId: '52', disabledReason: null, loop: null }),
    };
    const createHandle = vi.fn(async (): Promise<RandomSamplingBindingResult> => readyBinding(enabled))
      .mockResolvedValueOnce({
        kind: 'unavailable', reason: 'contracts_not_deployed', handleToClose: disabled,
      });
    const runtime = createRuntime({
      role: 'core', chain: { chainId: 'mock:0', getIdentityId: async () => 52n, isShardingTableMember: async () => true },
      createHandle, log: { info: vi.fn(), warn: vi.fn() }, shutdownTimeoutMs: () => 100,
    });
    try {
      await runtime.start();
      expect(disabled.start).not.toHaveBeenCalled();
      expect(disabled.stop).toHaveBeenCalledOnce();
      expect(runtime.getDiagnostics()).toMatchObject({ phase: 'waiting', reconciliationScheduled: true });
      await runtime.reconcile();
      expect(enabled.start).toHaveBeenCalledOnce();
      expect(runtime.getStatus().enabled).toBe(true);
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
    const createHandle = vi.fn(async () => readyBinding(handle));
    const runtime = createRuntime({
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
      expect(runtime.getDiagnostics().reconciliationScheduled).toBe(false);
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
      expect(f.runtime().getDiagnostics().reconciliationScheduled).toBe(true);
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
      expect(f.runtime().getDiagnostics().phase).not.toBe('running');
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
      expect(f.runtime().getDiagnostics().phase).not.toBe('running');
      expect(f.runtime().getDiagnostics().reconciliationScheduled).toBe(false);
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
        const binding = await f.realCreate(options);
        if (binding.kind !== 'ready') throw new Error('expected ready Random Sampling binding');
        entered.resolve(binding.handle);
        await gate.promise;
        return binding;
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
      expect(f.runtime().getDiagnostics().phase).not.toBe('running');
      expect(f.runtime().getDiagnostics().reconciliationScheduled).toBe(false);
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
        const binding = await f.realCreate(options);
        if (binding.kind !== 'ready') throw new Error('expected ready Random Sampling binding');
        entered.resolve(binding.handle);
        await gate.promise;
        return binding;
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
