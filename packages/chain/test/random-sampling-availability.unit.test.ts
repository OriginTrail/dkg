import { MockChainAdapter } from '../src/mock-adapter.js';
import { Contract, ZeroAddress } from 'ethers';
import { afterEach, expect, it, vi } from 'vitest';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import { readRandomSamplingAvailability } from '../src/random-sampling-availability.js';
import { HubContractNotFoundError } from '../src/hub-contract-not-found-error.js';

// Exercise the real public capability with deterministic contract-resolution
// ports. Hub cache rotation itself also has a real-chain integration witness.
class AvailabilityAdapter extends EVMChainAdapter {
  resolutions = 0;
  member = true;
  bindingFailure: unknown;
  membershipFailure: unknown;
  invalidateDuringMembership = false;
  readonly shardingTableStorage = new Contract(
    '0x0000000000000000000000000000000000000004',
    [],
  );
  constructor() {
    super({ rpcUrl: 'http://127.0.0.1:1', privateKey: '0x' + '11'.repeat(32),
      hubAddress: '0x0000000000000000000000000000000000000001', chainId: 'evm:31337' });
  }
  protected override async init(): Promise<void> { return; }
  protected override async getRandomSampling() {
    this.resolutions++;
    if (this.bindingFailure !== undefined) throw this.bindingFailure;
    const rs = new Contract('0x0000000000000000000000000000000000000002', []);
    const rss = new Contract('0x0000000000000000000000000000000000000003', []);
    this.contracts.randomSampling = rs;
    this.contracts.randomSamplingStorage = rss;
    return { rs, rss };
  }
  protected override async resolveContract(name: string) {
    if (name === 'ShardingTableStorage') return this.shardingTableStorage;
    return super.resolveContract(name);
  }
  protected override async readRandomSamplingLifecycleMembership(
    _shardingTableStorage: Contract,
    identityId: bigint,
  ): Promise<boolean> {
    return this.isShardingTableMember(identityId);
  }
  override async isShardingTableMember(identityId: bigint): Promise<boolean> {
    expect(identityId).toBe(52n);
    if (this.membershipFailure !== undefined) throw this.membershipFailure;
    if (this.invalidateDuringMembership) this.invalidateBindings();
    return this.member;
  }
  invalidateBindings(): void { this.invalidateRandomSamplingPair(); }
}

class HubLookupAvailabilityAdapter extends EVMChainAdapter {
  constructor() {
    super({ rpcUrl: 'http://127.0.0.1:1', privateKey: '0x' + '22'.repeat(32),
      hubAddress: '0x0000000000000000000000000000000000000001', chainId: 'evm:31337' });
  }
  protected override async init(): Promise<void> { return; }
  invalidateBindings(): void { this.invalidateRandomSamplingPair(); }
  /** Age the cached pair past its Hub-refresh TTL so the next resolve re-reads the Hub. */
  expireBindingTtl(): void {
    (this.randomSamplingPairCache as unknown as { resolvedAt: number }).resolvedAt = 0;
  }
}

const deployedAddresses: Readonly<Record<string, string>> = {
  RandomSampling: '0x0000000000000000000000000000000000000002',
  RandomSamplingStorage: '0x0000000000000000000000000000000000000003',
  ShardingTableStorage: '0x0000000000000000000000000000000000000004',
};

function stubHubReads(
  chain: EVMChainAdapter,
  resolveAddress: (name: string) => string,
) {
  type ReadContractPort = {
    readContract(contract: unknown, label: string, method: string, ...args: unknown[]): Promise<unknown>;
  };
  return vi.spyOn(chain as unknown as ReadContractPort, 'readContract').mockImplementation(
    async (_contract, label, _method, ...args) => {
      if (label.startsWith('Hub.getContractAddress(')) return resolveAddress(String(args[0]));
      if (label === 'shardingTableStorage.nodeExists') return true;
      throw new Error(`unexpected contract read: ${label}`);
    },
  );
}
const adapters: EVMChainAdapter[] = [];
function adapter() { const value = new AvailabilityAdapter(); adapters.push(value); return value; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => { for (const value of adapters.splice(0)) value.getProvider().destroy(); });

it('prefers the typed capability without invoking a proof-period read', async () => {
  const capability = vi.fn(async () => ({ kind: 'available' as const, member: true }));
  const proof = vi.fn(async () => { throw new Error('unrelated proof read'); });
  const chain = { resolveRandomSamplingAvailability: capability, isRandomSamplingReady: () => false, getActiveProofPeriodStatus: proof };
  expect(await readRandomSamplingAvailability(chain, 52n)).toEqual({ kind: 'available', member: true });
  expect(capability).toHaveBeenCalledWith(52n);
  expect(proof).not.toHaveBeenCalled();
});

it('refreshes invalidated EVM bindings before returning membership', async () => {
  const chain = adapter();
  const proof = vi.spyOn(chain, 'getActiveProofPeriodStatus');
  expect(await chain.resolveRandomSamplingAvailability(52n)).toEqual({ kind: 'available', member: true });
  chain.invalidateBindings();
  expect(chain.isRandomSamplingReady()).toBe(false);
  expect(await chain.resolveRandomSamplingAvailability(52n)).toEqual({ kind: 'available', member: true });
  expect(chain.resolutions).toBe(2);
  expect(chain.isRandomSamplingReady()).toBe(true);
  expect(proof).not.toHaveBeenCalled();
});

it('reuses only a positive lifecycle admission for one reconcile and invalidates it with the RS pair', async () => {
  vi.useFakeTimers();
  try {
    const chain = adapter();
    const membership = vi.spyOn(chain as any, 'readRandomSamplingLifecycleMembership');

    await expect(chain.resolveRandomSamplingAvailability(52n))
      .resolves.toEqual({ kind: 'available', member: true });
    vi.advanceTimersByTime(30_000);
    await expect(chain.resolveRandomSamplingAvailability(52n))
      .resolves.toEqual({ kind: 'available', member: true });
    expect(membership).toHaveBeenCalledTimes(1);

    // At the 60 s bound the membership value is live again.
    vi.advanceTimersByTime(30_000);
    await chain.resolveRandomSamplingAvailability(52n);
    expect(membership).toHaveBeenCalledTimes(2);

    chain.invalidateBindings();
    chain.member = false;
    await chain.resolveRandomSamplingAvailability(52n);
    expect(membership).toHaveBeenCalledTimes(3);

    // A negative is never reused: joining the table must be visible on the
    // very next reconciliation pass.
    chain.member = true;
    await chain.resolveRandomSamplingAvailability(52n);
    expect(membership).toHaveBeenCalledTimes(4);
  } finally {
    vi.useRealTimers();
  }
});

it('does not publish a late positive membership across a same-address Hub generation', async () => {
  const chain = adapter();
  const gate = deferred<boolean>();
  const entered = deferred<void>();
  const membership = vi.spyOn(chain as any, 'readRandomSamplingLifecycleMembership')
    .mockImplementationOnce(async () => {
      entered.resolve();
      return gate.promise;
    });

  const pending = chain.resolveRandomSamplingAvailability(52n);
  await entered.promise;
  // Same physical address after a reset/ABA: address equality alone must not
  // let the pre-rotation nodeExists result populate the new generation.
  (chain as any).applyHubRotationEventName('ShardingTableStorage');
  gate.resolve(true);
  await expect(pending).resolves.toMatchObject({ kind: 'indeterminate' });
  expect((chain as any).randomSamplingEligibilityObservation).toBeUndefined();

  await expect(chain.resolveRandomSamplingAvailability(52n))
    .resolves.toEqual({ kind: 'available', member: true });
  expect(membership).toHaveBeenCalledTimes(2);
});

it('does not reuse a positive membership after a same-address ABA', async () => {
  const chain = adapter();
  const membership = vi.spyOn(chain as any, 'readRandomSamplingLifecycleMembership');
  await chain.resolveRandomSamplingAvailability(52n);
  expect(membership).toHaveBeenCalledOnce();

  (chain as any).applyHubRotationEventName('ShardingTableStorage');
  await chain.resolveRandomSamplingAvailability(52n);
  expect(membership).toHaveBeenCalledTimes(2);
});

it('exposes the mock Random Sampling pair identity and current epoch', async () => {
  const chain = new MockChainAdapter();
  const reader = chain.getRandomSamplingReadContextReader();
  expect(reader.getRandomSamplingBindingId())
    .toBe('mock-random-sampling:mock-random-sampling-storage');
  await expect(chain.getCurrentEpoch()).resolves.toBe(1n);
  chain.__advanceEpoch();
  await expect(chain.getCurrentEpoch()).resolves.toBe(2n);
});

it('makes the mock read context unavailable whenever its pair is not ready', async () => {
  const chain = new MockChainAdapter();
  const reader = chain.getRandomSamplingReadContextReader();
  const context = await reader.readRandomSamplingContext();
  expect(context).toBeDefined();
  vi.spyOn(chain, 'isRandomSamplingReady').mockReturnValue(false);
  await expect(reader.readRandomSamplingContext()).resolves.toBeUndefined();
  expect(reader.isRandomSamplingBindingCurrent(context!.bindingId)).toBe(false);
});

it('reads and revalidates a real adapter Random Sampling context as one binding', async () => {
  const chain = adapter();
  const reader = chain.getRandomSamplingReadContextReader();
  const getCurrentEpoch = vi.spyOn(chain, 'getCurrentEpoch').mockResolvedValue(17n);
  await expect(reader.readRandomSamplingContext()).resolves.toBeUndefined();
  expect(getCurrentEpoch).not.toHaveBeenCalled();

  (chain as any).contracts.randomSampling = new Contract(deployedAddresses.RandomSampling!, []);
  (chain as any).contracts.randomSamplingStorage = new Contract(
    deployedAddresses.RandomSamplingStorage!,
    [],
  );
  const context = await reader.readRandomSamplingContext();
  expect(context).toEqual({
    bindingId: `${deployedAddresses.RandomSampling}:${deployedAddresses.RandomSamplingStorage}`,
    chronosEpoch: 17n,
  });
  expect(reader.isRandomSamplingBindingCurrent(context!.bindingId)).toBe(true);

  (chain as any).contracts.randomSampling = new Contract(
    '0x00000000000000000000000000000000000000aa',
    [],
  );
  expect(reader.isRandomSamplingBindingCurrent(context!.bindingId)).toBe(false);
});

it('derives each epoch from one fresh block while reusing only the bound immutable Chronos schedule', async () => {
  const chain = adapter();
  (chain as any).contracts.randomSampling = new Contract(deployedAddresses.RandomSampling!, []);
  (chain as any).contracts.randomSamplingStorage = new Contract(
    deployedAddresses.RandomSamplingStorage!,
    [],
  );
  (chain as any).contracts.chronos = new Contract(
    '0x0000000000000000000000000000000000000005',
    [],
  );
  const getCurrentEpoch = vi.spyOn(chain, 'getCurrentEpoch');
  const readContract = vi.spyOn(chain as any, 'readContract').mockImplementation(
    async (_contract: unknown, label: string) => {
      if (label === 'chronos.startTime') return 100n;
      if (label === 'chronos.epochLength') return 10n;
      throw new Error(`unexpected read ${label}`);
    },
  );
  let block = { number: 17, timestamp: 119 };
  const readTip = vi.spyOn(chain as any, 'readTipProvider')
    .mockImplementation(async () => block);
  const reader = chain.getRandomSamplingReadContextReader();

  await expect(reader.readRandomSamplingBlockContext!()).resolves.toEqual({
    bindingId: `${deployedAddresses.RandomSampling}:${deployedAddresses.RandomSamplingStorage}`,
    chronosEpoch: 2n,
    epochBindingId: '0x0000000000000000000000000000000000000005:g0',
    headBlockNumber: 17n,
  });
  block = { number: 18, timestamp: 120 };
  await expect(reader.readRandomSamplingBlockContext!()).resolves.toMatchObject({
    chronosEpoch: 3n,
    headBlockNumber: 18n,
  });

  expect(readTip).toHaveBeenCalledTimes(2);
  expect(readContract).toHaveBeenCalledTimes(2);
  expect(getCurrentEpoch).not.toHaveBeenCalled();
});

it('rejects a block context when the RS pair rotates during the tip read', async () => {
  const chain = adapter();
  (chain as any).contracts.randomSampling = new Contract(deployedAddresses.RandomSampling!, []);
  (chain as any).contracts.randomSamplingStorage = new Contract(
    deployedAddresses.RandomSamplingStorage!,
    [],
  );
  (chain as any).contracts.chronos = new Contract(
    '0x0000000000000000000000000000000000000005',
    [],
  );
  vi.spyOn(chain as any, 'readContract').mockImplementation(
    async (_contract: unknown, label: string) => label === 'chronos.startTime' ? 100n : 10n,
  );
  vi.spyOn(chain as any, 'readTipProvider').mockImplementation(async () => {
    (chain as any).contracts.randomSamplingStorage = new Contract(
      '0x00000000000000000000000000000000000000bb',
      [],
    );
    return { number: 17, timestamp: 119 };
  });

  await expect(chain.getRandomSamplingReadContextReader().readRandomSamplingBlockContext!())
    .resolves.toBeUndefined();
});

it('does not publish a late Chronos schedule across a same-address generation', async () => {
  const chain = adapter();
  (chain as any).contracts.randomSampling = new Contract(deployedAddresses.RandomSampling!, []);
  (chain as any).contracts.randomSamplingStorage = new Contract(
    deployedAddresses.RandomSamplingStorage!,
    [],
  );
  const chronosAddress = '0x0000000000000000000000000000000000000005';
  const oldChronos = new Contract(chronosAddress, []);
  (chain as any).contracts.chronos = oldChronos;
  const startGate = deferred<bigint>();
  const entered = deferred<void>();
  vi.spyOn(chain as any, 'readContract').mockImplementation(
    async (_contract: unknown, label: string) => {
      if (label === 'chronos.startTime') {
        entered.resolve();
        return startGate.promise;
      }
      return 10n;
    },
  );
  vi.spyOn(chain as any, 'readTipProvider').mockResolvedValue({ number: 17, timestamp: 119 });

  const pending = chain.getRandomSamplingReadContextReader().readRandomSamplingBlockContext!();
  await entered.promise;
  (chain as any).applyHubRotationEventName('Chronos');
  (chain as any).contracts.chronos = new Contract(chronosAddress, []);
  startGate.resolve(100n);

  await expect(pending).resolves.toBeUndefined();
  expect((chain as any).randomSamplingChronosSchedule).toBeUndefined();
});

it('does not serve a late block context after same-address Chronos ABA during the head read', async () => {
  const chain = adapter();
  (chain as any).contracts.randomSampling = new Contract(deployedAddresses.RandomSampling!, []);
  (chain as any).contracts.randomSamplingStorage = new Contract(
    deployedAddresses.RandomSamplingStorage!,
    [],
  );
  const chronosAddress = '0x0000000000000000000000000000000000000005';
  (chain as any).contracts.chronos = new Contract(chronosAddress, []);
  vi.spyOn(chain as any, 'readContract').mockImplementation(
    async (_contract: unknown, label: string) => label === 'chronos.startTime' ? 100n : 10n,
  );
  const headGate = deferred<{ number: number; timestamp: number }>();
  const entered = deferred<void>();
  vi.spyOn(chain as any, 'readTipProvider').mockImplementation(async () => {
    entered.resolve();
    return headGate.promise;
  });

  const pending = chain.getRandomSamplingReadContextReader().readRandomSamplingBlockContext!();
  await entered.promise;
  (chain as any).applyHubRotationEventName('Chronos');
  (chain as any).contracts.chronos = new Contract(chronosAddress, []);
  headGate.resolve({ number: 17, timestamp: 119 });

  await expect(pending).resolves.toBeUndefined();
});

it('does not publish a late Chronos schedule after adapter teardown', async () => {
  const chain = adapter();
  (chain as any).contracts.randomSampling = new Contract(deployedAddresses.RandomSampling!, []);
  (chain as any).contracts.randomSamplingStorage = new Contract(
    deployedAddresses.RandomSamplingStorage!,
    [],
  );
  (chain as any).contracts.chronos = new Contract(
    '0x0000000000000000000000000000000000000005',
    [],
  );
  const startGate = deferred<bigint>();
  const entered = deferred<void>();
  vi.spyOn(chain as any, 'readContract').mockImplementation(
    async (_contract: unknown, label: string) => {
      if (label === 'chronos.startTime') {
        entered.resolve();
        return startGate.promise;
      }
      return 10n;
    },
  );
  vi.spyOn(chain as any, 'readTipProvider').mockResolvedValue({ number: 17, timestamp: 119 });

  const pending = chain.getRandomSamplingReadContextReader().readRandomSamplingBlockContext!();
  await entered.promise;
  chain.destroy();
  startGate.resolve(100n);

  await expect(pending).resolves.toBeUndefined();
  expect((chain as any).randomSamplingChronosSchedule).toBeUndefined();
});

it('does not return a late Random Sampling block context after adapter teardown', async () => {
  const chain = adapter();
  (chain as any).contracts.randomSampling = new Contract(deployedAddresses.RandomSampling!, []);
  (chain as any).contracts.randomSamplingStorage = new Contract(
    deployedAddresses.RandomSamplingStorage!,
    [],
  );
  (chain as any).contracts.chronos = new Contract(
    '0x0000000000000000000000000000000000000005',
    [],
  );
  vi.spyOn(chain as any, 'readContract').mockImplementation(
    async (_contract: unknown, label: string) => label === 'chronos.startTime' ? 100n : 10n,
  );
  const headGate = deferred<{ number: number; timestamp: number }>();
  const entered = deferred<void>();
  vi.spyOn(chain as any, 'readTipProvider').mockImplementation(async () => {
    entered.resolve();
    return headGate.promise;
  });

  const pending = chain.getRandomSamplingReadContextReader().readRandomSamplingBlockContext!();
  await entered.promise;
  chain.destroy();
  headGate.resolve({ number: 17, timestamp: 119 });

  await expect(pending).resolves.toBeUndefined();
});

it('fails a real adapter context read open when the pair rotates during the epoch read', async () => {
  const chain = adapter();
  const reader = chain.getRandomSamplingReadContextReader();
  (chain as any).contracts.randomSampling = new Contract(deployedAddresses.RandomSampling!, []);
  (chain as any).contracts.randomSamplingStorage = new Contract(
    deployedAddresses.RandomSamplingStorage!,
    [],
  );
  vi.spyOn(chain, 'getCurrentEpoch').mockImplementation(async () => {
    (chain as any).contracts.randomSamplingStorage = new Contract(
      '0x00000000000000000000000000000000000000bb',
      [],
    );
    return 17n;
  });

  await expect(reader.readRandomSamplingContext()).resolves.toBeUndefined();
});

// The prover keys its remembered "period already solved" read on the derived pair.
// `isRandomSamplingReady()` cannot carry the rotation signal on its own: the
// 30 s eligibility reconcile below re-binds the pair, so by the prover's next
// tick "ready" is `true` again and only the addresses identify the binding.
it('an invalidated pair re-bound to the same addresses keeps the same derived identity', async () => {
  const chain = new HubLookupAvailabilityAdapter();
  adapters.push(chain);
  stubHubReads(chain, (name) => deployedAddresses[name]!);
  expect(await chain.resolveRandomSamplingAvailability(52n)).toEqual({ kind: 'available', member: true });
  const reader = chain.getRandomSamplingReadContextReader();
  const recorded = reader.getRandomSamplingBindingId();

  chain.invalidateBindings();
  expect(await chain.resolveRandomSamplingAvailability(52n)).toEqual({ kind: 'available', member: true });

  expect(chain.isRandomSamplingReady()).toBe(true);
  expect(reader.getRandomSamplingBindingId()).toBe(recorded);
});

it.each(['RandomSampling', 'RandomSamplingStorage'] as const)(
  'a TTL re-resolve that lands on a new %s address changes the derived binding, with no "not ready" blip',
  async (rotated) => {
    const chain = new HubLookupAvailabilityAdapter();
    adapters.push(chain);
    const addresses: Record<string, string> = { ...deployedAddresses };
    stubHubReads(chain, (name) => addresses[name]!);
    await chain.resolveRandomSamplingAvailability(52n);
    const reader = chain.getRandomSamplingReadContextReader();
    const recorded = reader.getRandomSamplingBindingId();

    // Rotation the Hub poller never saw: nothing calls invalidate().
    addresses[rotated] = '0x00000000000000000000000000000000000000aa';
    chain.expireBindingTtl();
    expect(chain.isRandomSamplingReady()).toBe(true);
    expect(await chain.resolveRandomSamplingAvailability(52n)).toEqual({ kind: 'available', member: true });

    expect(chain.isRandomSamplingReady()).toBe(true);
    expect(reader.getRandomSamplingBindingId()).not.toBe(recorded);
  },
);

it('a TTL re-resolve onto the SAME pair keeps the derived binding (the routine refresh must not end the prover skip)', async () => {
  const chain = new HubLookupAvailabilityAdapter();
  adapters.push(chain);
  const hub = stubHubReads(chain, (name) => deployedAddresses[name]!);
  await chain.resolveRandomSamplingAvailability(52n);
  const reader = chain.getRandomSamplingReadContextReader();
  const recorded = reader.getRandomSamplingBindingId();
  const hubReadsBefore = hub.mock.calls.length;

  chain.expireBindingTtl();
  await chain.resolveRandomSamplingAvailability(52n);

  // The Hub WAS re-read (fresh handles), it just resolved to the same addresses.
  expect(hub.mock.calls.length).toBeGreaterThan(hubReadsBefore + 1);
  expect(reader.getRandomSamplingBindingId()).toBe(recorded);
});

it.each(['RandomSampling', 'RandomSamplingStorage', 'ShardingTableStorage'] as const)(
  'normalizes a real Hub zero-address miss for %s',
  async (missingContract) => {
  const chain = new HubLookupAvailabilityAdapter();
  adapters.push(chain);
  stubHubReads(chain, (name) => name === missingContract ? ZeroAddress : deployedAddresses[name]!);
  expect(await chain.resolveRandomSamplingAvailability(52n)).toEqual({ kind: 'unavailable', reason: 'contracts_not_deployed' });
  },
);

it.each(['Identity', 'Profile', 'ParametersStorage'] as const)(
  'keeps an unrelated missing %s contract indeterminate during real initialization',
  async (missingContract) => {
    const resolveAddress = (name: string) => name === missingContract
      ? ZeroAddress
      : deployedAddresses[name] ?? '0x0000000000000000000000000000000000000005';

    // Prove the same Hub fixture can resolve the complete sampling deployment.
    const deployment = new HubLookupAvailabilityAdapter();
    adapters.push(deployment);
    stubHubReads(deployment, resolveAddress);
    expect(await deployment.resolveRandomSamplingAvailability(52n))
      .toEqual({ kind: 'available', member: true });

    // Keep init() and contract resolution real on the fresh adapter: only the
    // RPC read boundary is stubbed, so the missing mandatory binding originates
    // from production Hub resolution rather than an injected typed error.
    const chain = new EVMChainAdapter({
      rpcUrl: 'http://127.0.0.1:1', privateKey: '0x' + '33'.repeat(32),
      hubAddress: '0x0000000000000000000000000000000000000001', chainId: 'evm:31337',
    });
    adapters.push(chain);
    stubHubReads(chain, resolveAddress);
    const result = await chain.resolveRandomSamplingAvailability(52n);
    expect(result.kind).toBe('indeterminate');
    if (result.kind !== 'indeterminate') throw new Error('Expected initialization failure');
    expect(result.error).toBeInstanceOf(HubContractNotFoundError);
    expect(result.error).toMatchObject({ contractName: missingContract });
  },
);

it('keeps lookalike provider prose indeterminate instead of parsing its message', async () => {
  const chain = new HubLookupAvailabilityAdapter();
  adapters.push(chain);
  const error = new Error('Contract "RandomSampling" not found in Hub at 0x1');
  stubHubReads(chain, () => { throw error; });
  expect(await chain.resolveRandomSamplingAvailability(52n)).toEqual({ kind: 'indeterminate', error });
});

it.each(['bindingFailure', 'membershipFailure'] as const)('keeps transient %s indeterminate', async (failure) => {
  const chain = adapter();
  const error = new Error('RPC request timed out');
  chain[failure] = error;
  expect(await chain.resolveRandomSamplingAvailability(52n)).toEqual({ kind: 'indeterminate', error });
});

it('returns a confirmed non-member without declaring the deployment unavailable', async () => {
  const chain = adapter(); chain.member = false;
  expect(await chain.resolveRandomSamplingAvailability(52n)).toEqual({ kind: 'available', member: false });
});

it('does not publish stale availability when bindings invalidate during the membership read', async () => {
  const chain = adapter(); chain.invalidateDuringMembership = true;
  expect(await chain.resolveRandomSamplingAvailability(52n)).toMatchObject({ kind: 'indeterminate' });
});

it('preserves legacy readiness and membership capabilities', async () => {
  expect(await readRandomSamplingAvailability({ isShardingTableMember: async () => false }, 52n))
    .toEqual({ kind: 'available', member: false });
  expect(await readRandomSamplingAvailability({}, 52n)).toEqual({ kind: 'unavailable', reason: 'unsupported_chain' });
  expect(await readRandomSamplingAvailability({ isShardingTableMember: async () => true, isRandomSamplingReady: () => false }, 52n))
    .toEqual({ kind: 'unavailable', reason: 'contracts_not_deployed' });
});

it('preserves the adapter receiver through legacy readiness and membership probes', async () => {
  const chain = {
    ready: true,
    member: true,
    isRandomSamplingReady() { return this.ready; },
    async isShardingTableMember(identityId: bigint) { return this.member && identityId === 52n; },
  };
  expect(await readRandomSamplingAvailability(chain, 52n)).toEqual({ kind: 'available', member: true });
  chain.ready = false;
  expect(await readRandomSamplingAvailability(chain, 52n)).toEqual({ kind: 'unavailable', reason: 'contracts_not_deployed' });
});

it('dispatches the offline adapter through its legacy readiness and membership capabilities', async () => {
  const chain = new MockChainAdapter();
  expect(await readRandomSamplingAvailability(chain, 0n)).toEqual({ kind: 'available', member: false });
  expect(await readRandomSamplingAvailability(chain, 52n)).toEqual({ kind: 'available', member: true });
});
it.each(['readiness', 'capability'])('contains an unexpected %s failure as an indeterminate fact', async (source) => {
  const error = new Error('temporary read failure');
  const chain = source === 'readiness'
    ? { isShardingTableMember: async () => true, isRandomSamplingReady: () => { throw error; } }
    : { resolveRandomSamplingAvailability: async () => { throw error; } };
  expect(await readRandomSamplingAvailability(chain, 52n)).toEqual({ kind: 'indeterminate', error });
});
