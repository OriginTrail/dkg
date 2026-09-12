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
