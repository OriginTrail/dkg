import { MockChainAdapter } from '../src/mock-adapter.js';
import { Contract } from 'ethers';
import { afterEach, expect, it, vi } from 'vitest';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import { RandomSamplingContractsUnavailableError, resolveRandomSamplingAvailability } from '../src/random-sampling-availability.js';
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
const adapters: AvailabilityAdapter[] = [];
function adapter() { const value = new AvailabilityAdapter(); adapters.push(value); return value; }
afterEach(() => { for (const value of adapters.splice(0)) value.getProvider().destroy(); });

it('prefers the typed capability without invoking a proof-period read', async () => {
  const capability = vi.fn(async () => ({ kind: 'available' as const, member: true }));
  const proof = vi.fn(async () => { throw new Error('unrelated proof read'); });
  const chain = { resolveRandomSamplingAvailability: capability, isRandomSamplingReady: () => false, getActiveProofPeriodStatus: proof };
  expect(await resolveRandomSamplingAvailability(chain, 52n)).toEqual({ kind: 'available', member: true });
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

it.each(['bindingFailure', 'membershipFailure'] as const)('normalizes missing contracts at %s', async (failure) => {
  const chain = adapter();
  chain[failure] = failure === 'bindingFailure'
    ? new RandomSamplingContractsUnavailableError()
    : new HubContractNotFoundError('ShardingTableStorage', '0x1');
  expect(await chain.resolveRandomSamplingAvailability(52n)).toEqual({ kind: 'unavailable', reason: 'contracts_not_deployed' });
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
  expect(await resolveRandomSamplingAvailability({ isShardingTableMember: async () => false }, 52n))
    .toEqual({ kind: 'available', member: false });
  expect(await resolveRandomSamplingAvailability({}, 52n)).toEqual({ kind: 'unavailable', reason: 'unsupported_chain' });
  expect(await resolveRandomSamplingAvailability({ isShardingTableMember: async () => true, isRandomSamplingReady: () => false }, 52n))
    .toEqual({ kind: 'unavailable', reason: 'contracts_not_deployed' });
});

it('implements typed availability for the offline adapter', async () => {
  const chain = new MockChainAdapter();
  expect(await chain.resolveRandomSamplingAvailability(0n)).toEqual({ kind: 'available', member: false });
  expect(await chain.resolveRandomSamplingAvailability(52n)).toEqual({ kind: 'available', member: true });
});
it.each(['readiness', 'capability'])('contains an unexpected %s failure as an indeterminate fact', async (source) => {
  const error = new Error('temporary read failure');
  const chain = source === 'readiness'
    ? { isShardingTableMember: async () => true, isRandomSamplingReady: () => { throw error; } }
    : { resolveRandomSamplingAvailability: async () => { throw error; } };
  expect(await resolveRandomSamplingAvailability(chain, 52n)).toEqual({ kind: 'indeterminate', error });
});
