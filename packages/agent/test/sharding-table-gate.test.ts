import { describe, expect, it, vi } from 'vitest';
import {
  evaluateShardingTableGate,
  probeShardingTableGate,
  type ShardingTableGateReads,
} from '../src/p2p/sharding-table-gate.js';

const ADDRESS = '0x00000000000000000000000000000000000000c0';

function reads(overrides: Partial<ShardingTableGateReads> = {}) {
  return {
    getIdentityIdForAddress: vi.fn(async () => 7n),
    isShardingTableMember: vi.fn(async () => true),
    ...overrides,
  };
}

describe('sharding table gate', () => {
  it('reports a chain verdict for a registered member and for an outsider', async () => {
    const member = reads();
    await expect(probeShardingTableGate(member, ADDRESS)).resolves.toBe('member');
    expect(member.getIdentityIdForAddress).toHaveBeenCalledExactlyOnceWith(ADDRESS);
    expect(member.isShardingTableMember).toHaveBeenCalledExactlyOnceWith(7n);

    const outsider = reads({ isShardingTableMember: vi.fn(async () => false) });
    await expect(probeShardingTableGate(outsider, ADDRESS)).resolves.toBe('non-member');
  });

  it('treats an address without an on-chain identity as a non-member without asking the table', async () => {
    const unknown = reads({ getIdentityIdForAddress: vi.fn(async () => 0n) });
    await expect(probeShardingTableGate(unknown, ADDRESS)).resolves.toBe('non-member');
    expect(unknown.isShardingTableMember).not.toHaveBeenCalled();
  });

  it.each([
    ['no identity read', reads({ getIdentityIdForAddress: undefined }), ADDRESS],
    ['no membership read', reads({ isShardingTableMember: undefined }), ADDRESS],
    ['no operational address', reads(), undefined],
    ['an empty operational address', reads(), ''],
  ])('is unavailable with %s and reads nothing', async (_label, chain, agentAddress) => {
    await expect(probeShardingTableGate(chain, agentAddress)).resolves.toBe('unavailable');
    expect(chain.getIdentityIdForAddress ?? vi.fn()).not.toHaveBeenCalled();
    expect(chain.isShardingTableMember ?? vi.fn()).not.toHaveBeenCalled();
  });

  it.each([
    ['the identity read', reads({ getIdentityIdForAddress: vi.fn(async () => { throw new Error('rpc down'); }) })],
    ['the membership read', reads({ isShardingTableMember: vi.fn(async () => { throw new Error('rpc down'); }) })],
  ])('reports a failed probe when %s throws', async (_label, chain) => {
    await expect(probeShardingTableGate(chain, ADDRESS)).resolves.toBe('failed');
  });

  describe.each([
    ['allow', true],
    ['deny', false],
  ] as const)('policy unavailable=%s', (unavailable, unavailableVerdict) => {
    it('lets a chain verdict decide', async () => {
      await expect(evaluateShardingTableGate({ ...reads(), agentAddress: ADDRESS, unavailable })).resolves.toBe(true);
      await expect(evaluateShardingTableGate({
        ...reads({ isShardingTableMember: vi.fn(async () => false) }), agentAddress: ADDRESS, unavailable,
      })).resolves.toBe(false);
      await expect(evaluateShardingTableGate({
        ...reads({ getIdentityIdForAddress: vi.fn(async () => 0n) }), agentAddress: ADDRESS, unavailable,
      })).resolves.toBe(false);
    });

    it(`answers ${unavailableVerdict} when the gate cannot be consulted`, async () => {
      await expect(evaluateShardingTableGate({
        ...reads({ getIdentityIdForAddress: undefined }), agentAddress: ADDRESS, unavailable,
      })).resolves.toBe(unavailableVerdict);
      await expect(evaluateShardingTableGate({
        ...reads({ isShardingTableMember: undefined }), agentAddress: ADDRESS, unavailable,
      })).resolves.toBe(unavailableVerdict);
      await expect(evaluateShardingTableGate({ ...reads(), agentAddress: undefined, unavailable }))
        .resolves.toBe(unavailableVerdict);
    });

    it('denies on a failed read', async () => {
      await expect(evaluateShardingTableGate({
        ...reads({ isShardingTableMember: vi.fn(async () => { throw new Error('rpc down'); }) }),
        agentAddress: ADDRESS,
        unavailable,
      })).resolves.toBe(false);
    });
  });
});
