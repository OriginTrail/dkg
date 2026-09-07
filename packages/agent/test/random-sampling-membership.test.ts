import { describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import { DKGAgentBase } from '../src/dkg-agent-base.js';
import type { RandomSamplingBindOptions, RandomSamplingHandle } from '../src/random-sampling-bind.js';

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
  const internal = agent as unknown as {
    randomSamplingHandle: RandomSamplingHandle | null;
    randomSamplingBindRetryTimer: ReturnType<typeof setInterval> | null;
    randomSamplingBindRetryInFlight: boolean;
    createRandomSamplingHandle(options: RandomSamplingBindOptions): Promise<RandomSamplingHandle>;
  };
  const realCreate = internal.createRandomSamplingHandle.bind(agent);
  const create = vi.spyOn(internal, 'createRandomSamplingHandle');
  const callbacks = new Map<ReturnType<typeof setInterval>, () => void>();
  const realSetInterval = globalThis.setInterval;
  const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback, delay, ...args) => {
    const timer = realSetInterval(callback, delay, ...args);
    callbacks.set(timer, () => callback(...args));
    return timer;
  }) as typeof setInterval);
  try { await agent.start(); } finally { interval.mockRestore(); }
  const beginTick = () => {
    const timer = internal.randomSamplingBindRetryTimer;
    expect(timer, 'running and waiting provers both need eligibility reconciliation').not.toBeNull();
    const callback = callbacks.get(timer!);
    expect(callback).toBeTypeOf('function');
    callback!();
  };
  const settleTick = () => vi.waitFor(() => expect(internal.randomSamplingBindRetryInFlight).toBe(false));
  return { agent, chain, internal, create, realCreate, membership, beginTick, settleTick,
    setMember: (value: boolean) => { member = value; },
    tick: async () => { beginTick(); await settleTick(); },
  };
}

describe('Random Sampling membership reconciliation', () => {
  it('stops an admitted prover on removal and creates a fresh handle after readmission', async () => {
    const f = await startCore();
    try {
      const original = f.internal.randomSamplingHandle!;
      const stop = vi.spyOn(original, 'stop');
      f.setMember(false);
      await f.tick();
      expect(stop).toHaveBeenCalledOnce();
      expect(f.agent.getRandomSamplingStatus()).toMatchObject({ enabled: false, disabledReason: 'awaiting_sharding_table', identityId: '52' });
      expect(f.internal.randomSamplingHandle).toBeNull();
      f.setMember(true);
      await f.tick();
      expect(f.create).toHaveBeenCalledTimes(2);
      expect(f.internal.randomSamplingHandle).not.toBe(original);
      expect(f.agent.getRandomSamplingStatus()).toMatchObject({ enabled: true, disabledReason: null, identityId: '52' });
      await f.tick();
      expect(f.create).toHaveBeenCalledTimes(2);
    } finally { await f.agent.stop(); }
  });

  it.each(['identity', 'membership'] as const)('keeps the active handle through a transient %s lookup failure', async (stage) => {
    const f = await startCore();
    try {
      const original = f.internal.randomSamplingHandle!;
      const stop = vi.spyOn(original, 'stop');
      if (stage === 'identity') vi.spyOn(f.chain, 'getIdentityId').mockRejectedValueOnce(new Error('temporary RPC outage'));
      else f.membership.mockRejectedValueOnce(new Error('temporary RPC outage'));
      await f.tick();
      expect(f.internal.randomSamplingHandle).toBe(original);
      expect(stop).not.toHaveBeenCalled();
      expect(f.agent.getRandomSamplingStatus()).toMatchObject({ enabled: true, disabledReason: null, identityId: '52' });
      await f.tick();
      expect(f.create).toHaveBeenCalledOnce();
    } finally { await f.agent.stop(); }
  });

  it.each([0n, 53n])('rebinds only after the current identity becomes eligible (%s)', async (identityId) => {
    const f = await startCore();
    try {
      const original = f.internal.randomSamplingHandle!;
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
      expect(f.internal.randomSamplingHandle).toBeNull();
      expect(f.internal.randomSamplingBindRetryTimer).toBeNull();
      expect(f.agent.getRandomSamplingStatus().enabled).toBe(false);
    } finally { gate.resolve(false); await f.agent.stop(); }
  });

  it('retires a handle created during shutdown without installing or starting it', async () => {
    const f = await startCore(false);
    const gate = deferred<void>();
    const entered = deferred<RandomSamplingHandle>();
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
      const stop = vi.spyOn(handle, 'stop');
      const stopping = f.agent.stop();
      gate.resolve();
      await stopping;
      await f.settleTick();
      expect(start).not.toHaveBeenCalled();
      expect(stop).toHaveBeenCalledOnce();
      expect(f.internal.randomSamplingHandle).toBeNull();
      expect(f.internal.randomSamplingBindRetryTimer).toBeNull();
    } finally { gate.resolve(); await f.agent.stop(); }
  });

  it('waits for physical retirement before replacing a readmitted prover', async () => {
    const f = await startCore();
    const timeout = DKGAgentBase.RANDOM_SAMPLING_SHUTDOWN_TIMEOUT_MS;
    const gate = deferred<void>();
    Object.defineProperty(DKGAgentBase, 'RANDOM_SAMPLING_SHUTDOWN_TIMEOUT_MS', { configurable: true, value: 10 });
    try {
      const original = f.internal.randomSamplingHandle!;
      const realStop = original.stop.bind(original);
      const stopped = realStop().then(() => gate.promise);
      vi.spyOn(original, 'stop').mockReturnValue(stopped);
      f.setMember(false);
      await f.tick();
      expect(f.internal.randomSamplingHandle).toBe(original);
      f.setMember(true);
      await f.tick();
      expect(f.create).toHaveBeenCalledOnce();
      gate.resolve();
      await f.tick();
      expect(f.create).toHaveBeenCalledTimes(2);
      expect(f.internal.randomSamplingHandle).not.toBe(original);
    } finally {
      gate.resolve();
      Object.defineProperty(DKGAgentBase, 'RANDOM_SAMPLING_SHUTDOWN_TIMEOUT_MS', { configurable: true, value: timeout });
      await f.agent.stop();
    }
  });
});
