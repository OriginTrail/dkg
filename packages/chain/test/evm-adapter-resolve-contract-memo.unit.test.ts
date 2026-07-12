/**
 * #1583 — resolved-contract-address memo in `resolveContract`.
 *
 * A sustained 100-KA publish burst saturated the chain RPC with ~99% reads,
 * almost all of them redundant `Hub.getContractAddress` calls re-resolving
 * effectively-constant proxy addresses on every hot read (identity resolution,
 * ACK verification, token-amount). This suite pins the memo's behaviour: hit /
 * miss counts, per-name keying, invalidation-hook + TTL-backstop refresh,
 * negative-result non-poisoning, the deliberate ShardingTableStorage /
 * RandomSampling exclusions, and that the ACK-verify security floor
 * (keyHasPurpose / nodeExists RESULTS) stays LIVE.
 *
 * Mirrors the `minimalConfig` / `recorder` unit harness used across the chain
 * adapter suite (no live RPC).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ethers } from 'ethers';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADMIN_PK = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';

// PREFLIGHT_TTL_MS is a protected static on the adapter base; read it through the
// class so the TTL-backstop test stays coupled to the production constant.
const PREFLIGHT_TTL_MS = ((EVMChainAdapter as unknown as { PREFLIGHT_TTL_MS?: number })
  .PREFLIGHT_TTL_MS) ?? 60 * 60 * 1000;

const ADDR_BY_NAME: Record<string, string> = {
  IdentityStorage: '0x00000000000000000000000000000000000000A1',
  ParametersStorage: '0x00000000000000000000000000000000000000A2',
  Token: '0x00000000000000000000000000000000000000A3',
  ShardingTableStorage: '0x00000000000000000000000000000000000000A4',
  RandomSampling: '0x00000000000000000000000000000000000000A5',
  RandomSamplingStorage: '0x00000000000000000000000000000000000000A6',
  Foo: '0x00000000000000000000000000000000000000A7',
};
const RECOVERED = ethers.getAddress('0x00000000000000000000000000000000000000ab');

function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => { calls.push(args); return impl(...args); };
  return Object.assign(fn, { calls });
}

function minimalConfig(overrides: Partial<EVMAdapterConfig> = {}): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: DEPLOYER_PK,
    adminPrivateKey: ADMIN_PK,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    staticNetwork: false,
    ...overrides,
  };
}

// Bare adapter with `init()` short-circuited — no live RPC.
function makeAdapter(): any {
  const a: any = new EVMChainAdapter(minimalConfig());
  a.initialized = true;
  a.init = async () => { a.initialized = true; };
  return a;
}

// Count the memo's Hub reads. `readHubContractAddress` calls
// `readContract(hub, 'Hub.getContractAddress(X)', 'getContractAddress', name)`.
function hubReads(rc: { calls: unknown[][] }, name?: string): number {
  return rc.calls.filter(
    (c) => c[2] === 'getContractAddress' && (name === undefined || c[3] === name),
  ).length;
}

// readContract spy returning the fixed per-name address (miss path).
function spyByName(a: any) {
  const rc = recorder(async (..._args: unknown[]) => ADDR_BY_NAME[_args[3] as string]);
  a.readContract = rc;
  return rc;
}

describe('resolveContract address memo (#1583)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('N sequential resolves of one name issue exactly ONE Hub.getContractAddress', async () => {
    const a = makeAdapter();
    const rc = spyByName(a);
    for (let i = 0; i < 6; i++) {
      await expect(a.resolveContractAddress('IdentityStorage'))
        .resolves.toBe(ADDR_BY_NAME.IdentityStorage);
    }
    expect(hubReads(rc)).toBe(1);
  });

  it('distinct contract names are keyed independently — one Hub read each', async () => {
    const a = makeAdapter();
    const rc = spyByName(a);
    for (const name of ['IdentityStorage', 'ParametersStorage', 'Token']) {
      for (let i = 0; i < 3; i++) {
        await expect(a.resolveContractAddress(name)).resolves.toBe(ADDR_BY_NAME[name]);
      }
    }
    expect(hubReads(rc)).toBe(3);
    expect(hubReads(rc, 'IdentityStorage')).toBe(1);
    expect(hubReads(rc, 'ParametersStorage')).toBe(1);
    expect(hubReads(rc, 'Token')).toBe(1);
  });

  it('an IdentityStorage-rotation invalidation hook forces the next resolve to re-hit the Hub', async () => {
    const a = makeAdapter();
    const rc = spyByName(a);
    await a.resolveContractAddress('IdentityStorage');
    await a.resolveContractAddress('IdentityStorage');
    expect(hubReads(rc)).toBe(1);

    (a as any).invalidateIdentityStorageBinding();
    await a.resolveContractAddress('IdentityStorage');
    expect(hubReads(rc)).toBe(2);
  });

  it('a generic Hub rotation (finalizeKnownHubRotation) flushes the memo for every name', async () => {
    const a = makeAdapter();
    const rc = spyByName(a);
    await a.resolveContractAddress('Token');
    await a.resolveContractAddress('ParametersStorage');
    expect(hubReads(rc)).toBe(2);

    // Any allowlisted rotation event reaches finalizeKnownHubRotation.
    (a as any).applyHubRotationEventName('Token');
    await a.resolveContractAddress('Token');
    await a.resolveContractAddress('ParametersStorage');
    expect(hubReads(rc)).toBe(4);
  });

  it('the bulk write-side self-heal (invalidateAllBoundContracts) flushes the memo', async () => {
    const a = makeAdapter();
    const rc = spyByName(a);
    await a.resolveContractAddress('Token');
    expect(hubReads(rc)).toBe(1);
    (a as any).invalidateAllBoundContracts();
    await a.resolveContractAddress('Token');
    expect(hubReads(rc)).toBe(2);
  });

  it('re-resolves after the PREFLIGHT_TTL_MS backstop even with no invalidation hook', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const a = makeAdapter();
    const rc = spyByName(a);

    await a.resolveContractAddress('IdentityStorage');
    await a.resolveContractAddress('IdentityStorage');
    expect(hubReads(rc)).toBe(1);

    // Just inside the TTL — still served from the memo.
    vi.setSystemTime(PREFLIGHT_TTL_MS - 1);
    await a.resolveContractAddress('IdentityStorage');
    expect(hubReads(rc)).toBe(1);

    // Past the TTL — re-resolves.
    vi.setSystemTime(PREFLIGHT_TTL_MS + 1);
    await a.resolveContractAddress('IdentityStorage');
    expect(hubReads(rc)).toBe(2);
  });

  it('a ZeroAddress result is never cached — the next call re-tries and recovers', async () => {
    const a = makeAdapter();
    let call = 0;
    const rc = recorder(async () => {
      call += 1;
      return call <= 2 ? ethers.ZeroAddress : ADDR_BY_NAME.IdentityStorage;
    });
    a.readContract = rc;

    await expect(a.resolveContractAddress('IdentityStorage')).rejects.toThrow('not found in Hub');
    await expect(a.resolveContractAddress('IdentityStorage')).rejects.toThrow('not found in Hub');
    // Both misses re-hit the Hub (no negative poisoning).
    expect(hubReads(rc)).toBe(2);

    // A subsequent successful resolve caches, so the following call is a hit.
    await expect(a.resolveContractAddress('IdentityStorage'))
      .resolves.toBe(ADDR_BY_NAME.IdentityStorage);
    await expect(a.resolveContractAddress('IdentityStorage'))
      .resolves.toBe(ADDR_BY_NAME.IdentityStorage);
    expect(hubReads(rc)).toBe(3);
  });

  it('a ContractDoesNotExist revert is normalized and not cached', async () => {
    const a = makeAdapter();
    let call = 0;
    const rc = recorder(async () => {
      call += 1;
      if (call === 1) throw new Error('execution reverted: ContractDoesNotExist("Foo")');
      return ADDR_BY_NAME.Foo;
    });
    a.readContract = rc;

    await expect(a.resolveContractAddress('Foo')).rejects.toThrow('not found in Hub');
    await expect(a.resolveContractAddress('Foo')).resolves.toBe(ADDR_BY_NAME.Foo);
    expect(hubReads(rc)).toBe(2);
  });

  it('excluded names (ShardingTableStorage, RandomSampling*) ALWAYS resolve fresh', async () => {
    const a = makeAdapter();
    const rc = spyByName(a);
    for (const name of ['ShardingTableStorage', 'RandomSampling', 'RandomSamplingStorage']) {
      for (let i = 0; i < 4; i++) {
        await expect(a.resolveContractAddress(name)).resolves.toBe(ADDR_BY_NAME[name]);
      }
      // Every call re-hits the Hub — these are deliberately NOT memoized.
      expect(hubReads(rc, name)).toBe(4);
    }
  });
});

describe('ACK-verify security floor stays live under the address memo (#1583)', () => {
  it('runs keyHasPurpose + nodeExists on EVERY verify (results never memoized)', async () => {
    const a = makeAdapter();
    const identityStorage = { id: 'IdentityStorage' };
    const shardingTableStorage = { id: 'ShardingTableStorage' };
    // Route the two ACK-verify resolves to distinct stub handles.
    a.resolveContract = recorder(async (name: string) => (
      name === 'IdentityStorage' ? identityStorage : shardingTableStorage
    ));
    // keyHasPurpose + nodeExists both pass.
    const rc = recorder(async () => true);
    a.readContract = rc;

    await expect(a.verifyACKIdentityDetailed(RECOVERED, 5n)).resolves.toEqual({ valid: true });
    await expect(a.verifyACKIdentityDetailed(RECOVERED, 5n)).resolves.toEqual({ valid: true });

    const keyHasPurposeCalls = rc.calls.filter((c) => c[2] === 'keyHasPurpose').length;
    const nodeExistsCalls = rc.calls.filter((c) => c[2] === 'nodeExists').length;
    // One LIVE read of each per verify — the security floor is never cached.
    expect(keyHasPurposeCalls).toBe(2);
    expect(nodeExistsCalls).toBe(2);
    // The reads target the freshly-resolved contract handles.
    expect(rc.calls.filter((c) => c[0] === identityStorage && c[2] === 'keyHasPurpose')).toHaveLength(2);
    expect(rc.calls.filter((c) => c[0] === shardingTableStorage && c[2] === 'nodeExists')).toHaveLength(2);
  });
});
