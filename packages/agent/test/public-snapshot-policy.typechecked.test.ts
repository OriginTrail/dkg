import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import type { ProtocolRouter } from '@origintrail-official/dkg-core';
import { PUBLIC_GRAPH_SNAPSHOT_MAX_BYTES } from '@origintrail-official/dkg-chain';
import { bindSnapshotRequest, bindSnapshotSourcePolicy } from '../src/public-snapshot-policy.js';
import { createPublicSnapshotSourcePlan } from '../src/public-snapshot-source-plan.js';
import { PUBLIC_GRAPH_SNAPSHOT_PROTOCOL } from '../src/public-snapshot-reader.js';
import { BASE_MAINNET_SOURCE_POLICY, PUBLIC_SNAPSHOT_SOURCE_PROTOCOL, sourceProofPayload,
  type SnapshotSourceChallenge } from '../src/public-snapshot-source-proof.js';
import { DKG_CORE_CHAIN_CACHE, CORE_CHAIN_CACHE_SOURCE_PROTOCOL, CORE_CHAIN_CACHE_SNAPSHOT_PROTOCOL,
  type CoreChainCacheNetwork } from '../src/core-chain-cache-config.js';
import { cacheProofPayload } from '../src/core-chain-cache-proof.js';

const scope = { contextGraphId: 'public', onChainId: '14' };
const chain = { chainId: 'base:8453', deploymentId: 'base:8453:hub=data' };
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));
const signal = new AbortController().signal;
const reply = new Uint8Array([9]);

function expectRequest(send: ReturnType<typeof vi.fn<ProtocolRouter['send']>>, protocol: string, expected: object) {
  const call = send.mock.calls.at(-1)!;
  expect(call[0]).toBe('core'); expect(call[1]).toBe(protocol);
  expect(decode(call[2])).toEqual({ version: 1, ...scope, refresh: true, ...expected });
  expect(call[3]).toEqual({ signal, timeoutMs: 115_000, maxReadBytes: PUBLIC_GRAPH_SNAPSHOT_MAX_BYTES });
}

describe('snapshot request and authenticated discovery boundaries', () => {
  it('keeps explicit-peer requests usable without any identity or discovery capability', async () => {
    const send = vi.fn<ProtocolRouter['send']>(async () => reply);
    const request = bindSnapshotRequest(send, scope);
    expect(await request('core', true, signal)).toBe(reply);
    expectRequest(send, PUBLIC_GRAPH_SNAPSHOT_PROTOCOL, {});
    // The explicit plan must not even acquire identity/discovery dependencies.
    const host = { router: { send }, get chain() { throw new Error('no identity adapter'); },
      get discovery() { throw new Error('no discovery'); } } as unknown as Parameters<typeof createPublicSnapshotSourcePlan>[0];
    const plan = await createPublicSnapshotSourcePlan(host, { ...scope, trustedCorePeerIds: ['core'] }, signal,
      {} as Parameters<typeof createPublicSnapshotSourcePlan>[3]);
    expect(plan.inventoryPeers).toEqual(['core']);
    expect(await plan.request('core', true, signal)).toBe(reply);
    const batches = []; for await (const batch of plan.contentPeerBatches()) batches.push(batch);
    expect(batches).toEqual([['core']]); expect(plan.report()).toEqual({});
  });

  it('validates registered Base capability before constructing authentication and preserves its wire formats', async () => {
    const wallet = ethers.Wallet.createRandom();
    const verify = vi.fn(async () => true);
    const send = vi.fn<ProtocolRouter['send']>(async (_peer, protocol, bytes) => protocol === PUBLIC_SNAPSHOT_SOURCE_PROTOCOL
      ? encode({ identityId: '7', signature: await wallet.signMessage(sourceProofPayload(decode(bytes) as SnapshotSourceChallenge, '7')) }) : reply);
    const input = { sourcePolicy: BASE_MAINNET_SOURCE_POLICY, selfPeerId: 'requester', chain, networks: [], send, scope };
    expect(() => bindSnapshotSourcePolicy(input)).toThrow('verification unavailable');
    expect(send).not.toHaveBeenCalled();
    const policy = bindSnapshotSourcePolicy({ ...input, chain: { ...chain, verifyACKIdentity: verify } });
    expect(await policy.probe('core', 'a'.repeat(64), signal)).toBe(true);
    expect(verify).toHaveBeenCalledWith(wallet.address, 7n, { signal });
    expect(await policy.request('core', true, signal)).toBe(reply);
    expectRequest(send, PUBLIC_GRAPH_SNAPSHOT_PROTOCOL, {});
    // @ts-expect-error explicit transport is not an authenticated policy name
    expect(() => bindSnapshotSourcePolicy({ ...input, sourcePolicy: undefined })).toThrow('Unsupported');
    // @ts-expect-error arbitrary policy names cannot enter authenticated discovery
    expect(() => bindSnapshotSourcePolicy({ ...input, sourcePolicy: 'unknown' })).toThrow('Unsupported');
  });

  it('authenticates a foreign cache registry without requiring the data-chain adapter to verify identities', async () => {
    const wallet = ethers.Wallet.createRandom(), verify = vi.fn(async () => true);
    const registration = { chainId: 'gnosis:100', deploymentId: 'gnosis:100:hub=registration', identityId: '7' };
    const networks: CoreChainCacheNetwork[] = [{ identity: { networkId: 'mainnet', genesisId: 'mainnet', chainId: registration.chainId },
      relays: [], registry: { ...registration, verifyACKIdentity: verify, rpcUsage: () => ({}), destroy: () => {},
        readPublicGraphSnapshot: async () => { throw new Error('not requested'); } } }];
    const send = vi.fn<ProtocolRouter['send']>(async (_peer, protocol, bytes) => protocol === CORE_CHAIN_CACHE_SOURCE_PROTOCOL
      ? encode({ ...registration, signature: await wallet.signMessage(cacheProofPayload(decode(bytes) as SnapshotSourceChallenge, registration)) }) : reply);
    const input = { sourcePolicy: DKG_CORE_CHAIN_CACHE, chain, networks, selfPeerId: 'requester', send, scope };
    expect(() => bindSnapshotSourcePolicy({ ...input, networks: [] })).toThrow('unavailable');
    expect(() => bindSnapshotSourcePolicy({ ...input, chain: { ...chain, deploymentId: '' } })).toThrow('unavailable');
    const policy = bindSnapshotSourcePolicy(input);
    expect(await policy.probe('core', 'b'.repeat(64), signal)).toBe(true);
    expect(verify).toHaveBeenCalledWith(wallet.address, 7n, { signal });
    expect(await policy.request('core', true, signal)).toBe(reply);
    expectRequest(send, CORE_CHAIN_CACHE_SNAPSHOT_PROTOCOL, chain);
  });
});
