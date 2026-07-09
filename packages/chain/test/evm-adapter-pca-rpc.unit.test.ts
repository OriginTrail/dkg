import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import { isChainRpcTransportError } from '../src/chain-rpc-transport-error.js';
import { _resetRpcFailoverStatsForTest } from '../src/rpc-failover-log.js';
import { getPcaLogicInterface } from '../src/evm-adapter-errors.js';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const HUB = '0x0000000000000000000000000000000000000001';
const AGENT = '0x00000000000000000000000000000000000000a1';
const OWNER = '0x00000000000000000000000000000000000000b1';

function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => { calls.push(args); return impl(...args); };
  return Object.assign(fn, { calls });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function minimalConfig(overrides: Partial<EVMAdapterConfig> = {}): EVMAdapterConfig {
  return {
    rpcUrl: 'https://primary.example',
    privateKey: PK,
    hubAddress: HUB,
    chainId: 'evm:31337',
    allowNoAdminSigner: true,
    ...overrides,
  };
}

function retryable429(): Error {
  const err = new Error('429 too many requests');
  (err as { status?: number }).status = 429;
  return err;
}

type SendProvider = {
  send: (method: string, params: unknown[]) => Promise<unknown>;
};

function pcaRpcAdapter(providers: SendProvider[], rpcUrls: string[]): EVMChainAdapter {
  const adapter = new EVMChainAdapter(minimalConfig({
    rpcUrl: rpcUrls[0],
    rpcUrls: rpcUrls.slice(1),
    staticNetwork: false,
  }));
  (adapter as unknown as { init: () => Promise<void> }).init = async () => undefined;
  (adapter as unknown as { providers: SendProvider[] }).providers = providers;
  (adapter as unknown as { rpcUrls: string[] }).rpcUrls = rpcUrls;
  return adapter;
}

function pcaReadCacheAdapter(values: unknown[]): EVMChainAdapter {
  const adapter = new EVMChainAdapter(minimalConfig());
  const a = adapter as unknown as {
    init: () => Promise<void>;
    contracts: { dkgPublishingConvictionNFT?: unknown };
    readContract: ReturnType<typeof recorder<[unknown, string, string, ...unknown[]], Promise<unknown>>>;
  };
  let i = 0;
  a.init = async () => undefined;
  a.contracts.dkgPublishingConvictionNFT = { getAddress: async () => '0x' + '33'.repeat(20) };
  a.readContract = recorder(async () => {
    const value = values[Math.min(i, values.length - 1)];
    i++;
    return value;
  });
  return adapter;
}

function installPcaWriteStubs(adapter: EVMChainAdapter) {
  const calls: Array<{ method: string; args: readonly unknown[]; label: string }> = [];
  (adapter as any).sendContractTransaction = recorder(async (_contract: unknown, method: string, args: readonly unknown[], _signer: unknown, label: string) => {
    calls.push({ method, args, label });
    return { hash: '0xtx', blockNumber: 1, index: 0, status: 1, logs: [] };
  });
  (adapter as any).resolveContract = async (name: string) => ({ __name: name });
  return calls;
}

function accountInfoTuple(
  owner: string,
  committed = 100n,
  topUpBuffer = 0n,
  agentCount = 0n,
  lastSettledWindow = 0n,
): unknown[] {
  return [
    owner,
    committed,
    10n,
    1n,
    24n,
    1000n,
    2000n,
    2500n,
    topUpBuffer,
    agentCount,
    lastSettledWindow,
    false,
  ];
}

function accountTuple(primaryNode: bigint, lastPrimaryNodeChangeEpoch = 0n): unknown[] {
  const tuple = new Array(11).fill(0n);
  tuple[9] = primaryNode;
  tuple[10] = lastPrimaryNodeChangeEpoch;
  return tuple;
}

function accountCreatedLog(accountId: bigint) {
  const iface = getPcaLogicInterface();
  const event = iface.getEvent('AccountCreated');
  if (!event) throw new Error('AccountCreated event missing');
  return iface.encodeEventLog(event, [accountId, OWNER, 100n, 2500, 1, 24]);
}

describe('EVMChainAdapter PCA RPC bridge', () => {
  beforeEach(() => { _resetRpcFailoverStatsForTest(); });
  afterEach(() => { _resetRpcFailoverStatsForTest(); });

  it('requestPublishingConvictionRpc reads through the provider failover loop', async () => {
    const primary = {
      send: recorder(async () => { throw retryable429(); }),
    };
    const backup = {
      send: recorder(async (method: string, params: unknown[]) => ({ method, params, endpoint: 'backup' })),
    };
    const adapter = pcaRpcAdapter(
      [primary, backup],
      ['https://primary.example/v2/SECRETKEY', 'https://backup.example'],
    );

    await expect(adapter.requestPublishingConvictionRpc('eth_chainId', []))
      .resolves.toEqual({ method: 'eth_chainId', params: [], endpoint: 'backup' });

    expect(primary.send.calls).toEqual([['eth_chainId', []]]);
    expect(backup.send.calls).toEqual([['eth_chainId', []]]);
  });

  it('requestPublishingConvictionRpc surfaces typed host-only exhaustion when all endpoints fail', async () => {
    const primary = {
      send: recorder(async () => { throw retryable429(); }),
    };
    const backup = {
      send: recorder(async () => { throw retryable429(); }),
    };
    const adapter = pcaRpcAdapter(
      [primary, backup],
      ['https://primary.example/v2/SECRETKEY', 'https://backup.example'],
    );

    let thrown: unknown;
    try {
      await adapter.requestPublishingConvictionRpc('eth_chainId', []);
    } catch (err) {
      thrown = err;
    }

    expect(isChainRpcTransportError(thrown)).toBe(true);
    expect(thrown).toMatchObject({ code: 'RPC_ENDPOINTS_EXHAUSTED' });
    expect(String((thrown as Error).message)).toContain('primary.example');
    expect(String((thrown as Error).message)).not.toContain('SECRETKEY');
    expect(String((thrown as Error).message)).not.toContain('https://');
    expect(primary.send.calls).toEqual([['eth_chainId', []]]);
    expect(backup.send.calls).toEqual([['eth_chainId', []]]);
  });

  it('getPublishingConvictionContracts returns configured wallet-public RPCs without private adapter RPCs', async () => {
    const adapter = new EVMChainAdapter(minimalConfig({
      rpcUrl: 'https://private-rpc.example/v2/SECRETKEY',
      walletRpcUrls: [' https://wallet-rpc.example/base-sepolia ', 'https://wallet-rpc.example/base-sepolia'],
    }));
    (adapter as unknown as { init: () => Promise<void> }).init = async () => undefined;
    (adapter as unknown as {
      contracts: {
        dkgPublishingConvictionNFT: { getAddress: () => Promise<string> };
        token: { getAddress: () => Promise<string> };
      };
    }).contracts = {
      dkgPublishingConvictionNFT: { getAddress: async () => '0x' + '11'.repeat(20) },
      token: { getAddress: async () => '0x' + '22'.repeat(20) },
    };

    const contracts = await adapter.getPublishingConvictionContracts();

    expect(contracts.rpcUrls).toEqual(['https://wallet-rpc.example/base-sepolia']);
    expect(contracts.walletRpcUrls).toEqual(['https://wallet-rpc.example/base-sepolia']);
    expect(JSON.stringify(contracts)).not.toContain('SECRETKEY');
    expect(JSON.stringify(contracts)).not.toContain('private-rpc.example');
  });
});

describe('EVMChainAdapter PCA read cache', () => {
  beforeEach(() => { _resetRpcFailoverStatsForTest(); });
  afterEach(() => {
    vi.useRealTimers();
    _resetRpcFailoverStatsForTest();
  });

  it('coalesces concurrent agentToAccountId reads without retaining externally mutable mappings', async () => {
    vi.useFakeTimers({ now: 0 });
    const adapter = pcaReadCacheAdapter([7n, 8n]) as any;

    const results = await Promise.all(
      Array.from({ length: 20 }, () => adapter.getConvictionAgentAccountId(AGENT)),
    );
    expect(results.every((value) => value === 7n)).toBe(true);
    expect(adapter.readContract.calls).toHaveLength(1);

    await expect(adapter.getConvictionAgentAccountId(AGENT)).resolves.toBe(8n);
    expect(adapter.readContract.calls).toHaveLength(2);
  });

  it('does not reuse a cached positive agent lookup after an external deregistration', async () => {
    const adapter = pcaReadCacheAdapter([7n, 0n]) as any;

    await expect(adapter.getConvictionAgentAccountId(AGENT)).resolves.toBe(7n);
    await expect(adapter.getConvictionAgentAccountId(AGENT)).resolves.toBe(0n);
    expect(adapter.readContract.calls).toHaveLength(2);
  });

  it('public agent deregistration clears older in-flight reverse-agent lookups', async () => {
    const first = deferred<bigint>();
    const second = deferred<bigint>();
    const adapter = pcaReadCacheAdapter([]) as any;
    installPcaWriteStubs(adapter);
    const reads = [first.promise, second.promise];
    adapter.readContract = recorder(async () => reads.shift()!);

    const firstLookup = adapter.getConvictionAgentAccountId(AGENT);
    await Promise.resolve();
    expect(adapter.readContract.calls).toHaveLength(1);

    await adapter.deregisterPublishingConvictionAgent(7n, AGENT);
    first.resolve(7n);
    await expect(firstLookup).resolves.toBe(7n);

    const secondLookup = adapter.getConvictionAgentAccountId(AGENT);
    await Promise.resolve();
    expect(adapter.readContract.calls).toHaveLength(2);
    second.resolve(0n);
    await expect(secondLookup).resolves.toBe(0n);
  });

  it('broadly clears agent mappings when a PCA allow-list is cleared', async () => {
    const adapter = pcaReadCacheAdapter([7n, 0n]) as any;
    installPcaWriteStubs(adapter);

    await expect(adapter.getConvictionAgentAccountId(AGENT)).resolves.toBe(7n);

    await adapter.clearPublishingConvictionAgents(7n);

    await expect(adapter.getConvictionAgentAccountId(AGENT)).resolves.toBe(0n);
    expect(adapter.readContract.calls).toHaveLength(2);
  });

  it('clear-all invalidation does not reuse older in-flight reverse-agent lookups', async () => {
    const first = deferred<bigint>();
    const second = deferred<bigint>();
    const adapter = pcaReadCacheAdapter([]) as any;
    installPcaWriteStubs(adapter);
    const reads = [first.promise, second.promise];
    adapter.readContract = recorder(async () => reads.shift()!);

    const staleLookup = adapter.getConvictionAgentAccountId(AGENT);
    await Promise.resolve();
    expect(adapter.readContract.calls).toHaveLength(1);

    await adapter.clearPublishingConvictionAgents(7n);

    const freshLookup = adapter.getConvictionAgentAccountId(AGENT);
    await Promise.resolve();
    expect(adapter.readContract.calls).toHaveLength(2);

    first.resolve(7n);
    second.resolve(0n);
    await expect(staleLookup).resolves.toBe(7n);
    await expect(freshLookup).resolves.toBe(0n);
  });

  it('does not cache a negative agent lookup across an external registration', async () => {
    const adapter = pcaReadCacheAdapter([0n, 7n]) as any;

    await expect(adapter.getConvictionAgentAccountId(AGENT)).resolves.toBe(0n);
    await expect(adapter.getConvictionAgentAccountId(AGENT)).resolves.toBe(7n);
    expect(adapter.readContract.calls).toHaveLength(2);
  });

  it('does not cache fail-soft CALL_EXCEPTION agent lookups as negative answers', async () => {
    const adapter = pcaReadCacheAdapter([]) as any;
    let calls = 0;
    adapter.readContract = recorder(async () => {
      calls++;
      if (calls === 1) {
        const err = new Error('missing revert data');
        (err as { code?: string }).code = 'CALL_EXCEPTION';
        throw err;
      }
      return 7n;
    });

    await expect(adapter.getConvictionAgentAccountId(AGENT)).resolves.toBe(0n);
    await expect(adapter.getConvictionAgentAccountId(AGENT)).resolves.toBe(7n);
    expect(adapter.readContract.calls).toHaveLength(2);
  });

  it('keeps strict agent lookups isolated from soft fail-safe single-flight results', async () => {
    const adapter = pcaReadCacheAdapter([]) as any;
    adapter.readContract = recorder(async () => {
      const err = new Error('missing revert data');
      (err as { code?: string }).code = 'CALL_EXCEPTION';
      throw err;
    });

    const soft = adapter.getConvictionAgentAccountId(AGENT);
    const strict = adapter.getConvictionAgentAccountId(AGENT, { strict: true });

    await expect(soft).resolves.toBe(0n);
    await expect(strict).rejects.toMatchObject({ code: 'CALL_EXCEPTION' });
    expect(adapter.readContract.calls).toHaveLength(2);
  });

  it('public agent registration clears older in-flight reverse-agent lookups', async () => {
    const first = deferred<bigint>();
    const second = deferred<bigint>();
    const adapter = pcaReadCacheAdapter([]) as any;
    installPcaWriteStubs(adapter);
    const reads = [first.promise, second.promise];
    adapter.readContract = recorder(async () => reads.shift()!);

    const staleLookup = adapter.getConvictionAgentAccountId(AGENT);
    await Promise.resolve();
    expect(adapter.readContract.calls).toHaveLength(1);

    await adapter.registerPublishingConvictionAgent(7n, AGENT);

    const freshLookup = adapter.getConvictionAgentAccountId(AGENT);
    await Promise.resolve();
    expect(adapter.readContract.calls).toHaveLength(2);

    first.resolve(0n);
    second.resolve(7n);
    await expect(staleLookup).resolves.toBe(0n);
    await expect(freshLookup).resolves.toBe(7n);
  });

  it('coalesces and briefly caches getAccountInfo reads per account id', async () => {
    vi.useFakeTimers({ now: 0 });
    const adapter = pcaReadCacheAdapter([
      accountInfoTuple(OWNER, 100n),
      accountInfoTuple(OWNER, 200n),
    ]) as any;

    const results = await Promise.all(
      Array.from({ length: 10 }, () => adapter.getPublishingConvictionAccountInfo(9n)),
    );
    expect(results.every((info) => info?.committedTRAC === 100n)).toBe(true);
    expect(adapter.readContract.calls).toHaveLength(1);

    await expect(adapter.getPublishingConvictionAccountInfo(9n))
      .resolves.toMatchObject({ committedTRAC: 100n });
    expect(adapter.readContract.calls).toHaveLength(1);

    vi.setSystemTime(16_000);
    await expect(adapter.getPublishingConvictionAccountInfo(9n))
      .resolves.toMatchObject({ committedTRAC: 200n });
    expect(adapter.readContract.calls).toHaveLength(2);
  });

  it('cached account-info cannot make an expired PCA look coverable', async () => {
    const expiringInfo = accountInfoTuple(OWNER, 100n);
    expiringInfo[6] = 100n;
    const adapter = pcaReadCacheAdapter([expiringInfo]) as any;
    adapter.readProvider = recorder(async (_label: string, fn: (provider: unknown) => Promise<unknown>) => fn({
      getBlock: async () => ({ timestamp: 101 }),
    }));

    await expect(adapter.getPublishingConvictionAccountInfo(9n))
      .resolves.toMatchObject({ expiresAtTimestamp: 100 });
    expect(adapter.readContract.calls).toHaveLength(1);

    await expect(adapter.convictionAccountCanCover(9n, 1n)).resolves.toBe(false);
    expect(adapter.readProvider.calls).toHaveLength(1);
    expect(adapter.readContract.calls).toHaveLength(1);
  });

  it('public top-up refreshes warmed account-info cache immediately', async () => {
    const adapter = pcaReadCacheAdapter([
      accountInfoTuple(OWNER, 100n, 0n),
      accountInfoTuple(OWNER, 100n, 50n),
    ]) as any;
    const calls = installPcaWriteStubs(adapter);

    await expect(adapter.getPublishingConvictionAccountInfo(9n))
      .resolves.toMatchObject({ topUpBuffer: 0n });
    expect(adapter.readContract.calls).toHaveLength(1);

    await adapter.topUpPublishingConvictionAccount(9n, 50n);
    expect(calls).toMatchObject([{ method: 'topUp', args: [9n, 50n] }]);

    await expect(adapter.getPublishingConvictionAccountInfo(9n))
      .resolves.toMatchObject({ topUpBuffer: 50n });
    expect(adapter.readContract.calls).toHaveLength(2);
  });

  it('public top-up prevents older in-flight account-info reads from repopulating stale cache', async () => {
    const first = deferred<unknown[]>();
    const second = deferred<unknown[]>();
    const adapter = pcaReadCacheAdapter([]) as any;
    installPcaWriteStubs(adapter);
    const reads = [first.promise, second.promise];
    adapter.readContract = recorder(async () => reads.shift()!);

    const staleLookup = adapter.getPublishingConvictionAccountInfo(9n);
    await Promise.resolve();
    expect(adapter.readContract.calls).toHaveLength(1);

    await adapter.topUpPublishingConvictionAccount(9n, 50n);

    const freshLookup = adapter.getPublishingConvictionAccountInfo(9n);
    await Promise.resolve();
    expect(adapter.readContract.calls).toHaveLength(2);

    second.resolve(accountInfoTuple(OWNER, 100n, 50n));
    await expect(freshLookup).resolves.toMatchObject({ topUpBuffer: 50n });

    first.resolve(accountInfoTuple(OWNER, 100n, 0n));
    await expect(staleLookup).resolves.toMatchObject({ topUpBuffer: 0n });

    await expect(adapter.getPublishingConvictionAccountInfo(9n))
      .resolves.toMatchObject({ topUpBuffer: 50n });
    expect(adapter.readContract.calls).toHaveLength(2);
  });

  it('account creation clears a cached missing account-info result', async () => {
    const adapter = pcaReadCacheAdapter([]) as any;
    let calls = 0;
    adapter.readContract = recorder(async () => {
      calls++;
      if (calls === 1) {
        const err = new Error('missing account');
        (err as { code?: string }).code = 'CALL_EXCEPTION';
        throw err;
      }
      return accountInfoTuple(OWNER, 100n, 0n, 0n);
    });
    (adapter as any).sendContractTransaction = recorder(async (_contract: unknown, method: string) => {
      if (method !== 'createAccount') throw new Error(`unexpected method ${method}`);
      return {
        hash: '0xcreate',
        blockNumber: 1,
        index: 0,
        status: 1,
        logs: [accountCreatedLog(9n)],
      };
    });

    await expect(adapter.getPublishingConvictionAccountInfo(9n)).resolves.toBeNull();
    expect(adapter.readContract.calls).toHaveLength(1);

    await expect(adapter.createPublishingConvictionAccount(100n)).resolves.toMatchObject({ accountId: 9n });

    await expect(adapter.getPublishingConvictionAccountInfo(9n))
      .resolves.toMatchObject({ committedTRAC: 100n });
    expect(adapter.readContract.calls).toHaveLength(2);
  });

  it('does not retain missing account-info results across external account creation', async () => {
    const adapter = pcaReadCacheAdapter([]) as any;
    let calls = 0;
    adapter.readContract = recorder(async () => {
      calls++;
      if (calls === 1) {
        const err = new Error('missing account');
        (err as { code?: string }).code = 'CALL_EXCEPTION';
        throw err;
      }
      return accountInfoTuple(OWNER, 100n, 0n, 0n);
    });

    const missingReads = await Promise.all([
      adapter.getPublishingConvictionAccountInfo(9n),
      adapter.getPublishingConvictionAccountInfo(9n),
    ]);
    expect(missingReads).toEqual([null, null]);
    expect(adapter.readContract.calls).toHaveLength(1);

    await expect(adapter.getPublishingConvictionAccountInfo(9n))
      .resolves.toMatchObject({ committedTRAC: 100n });
    expect(adapter.readContract.calls).toHaveLength(2);

    await expect(adapter.getPublishingConvictionAccountInfo(9n))
      .resolves.toMatchObject({ committedTRAC: 100n });
    expect(adapter.readContract.calls).toHaveLength(2);
  });

  it('public agent registration refreshes warmed account-info cache immediately', async () => {
    const adapter = pcaReadCacheAdapter([
      accountInfoTuple(OWNER, 100n, 0n, 0n),
      accountInfoTuple(OWNER, 100n, 0n, 1n),
    ]) as any;
    installPcaWriteStubs(adapter);

    await expect(adapter.getPublishingConvictionAccountInfo(9n))
      .resolves.toMatchObject({ agentCount: 0 });
    expect(adapter.readContract.calls).toHaveLength(1);

    await adapter.registerPublishingConvictionAgent(9n, AGENT);

    await expect(adapter.getPublishingConvictionAccountInfo(9n))
      .resolves.toMatchObject({ agentCount: 1 });
    expect(adapter.readContract.calls).toHaveLength(2);
  });

  it('public primary-node update refreshes warmed extended account-info cache immediately', async () => {
    const adapter = pcaReadCacheAdapter([
      accountInfoTuple(OWNER, 100n, 0n, 0n),
      accountTuple(11n, 1n),
      5n,
      500n,
      accountInfoTuple(OWNER, 100n, 0n, 0n),
      accountTuple(22n, 2n),
      6n,
      600n,
    ]) as any;
    installPcaWriteStubs(adapter);
    adapter.contracts.chronos = {};

    await expect(adapter.getPublishingConvictionAccountInfo(9n, { extended: true }))
      .resolves.toMatchObject({ primaryNode: 11n, lastPrimaryNodeChangeEpoch: 1 });
    expect(adapter.readContract.calls).toHaveLength(4);

    await adapter.setPublishingConvictionPrimaryNode(9n, 22n);

    await expect(adapter.getPublishingConvictionAccountInfo(9n, { extended: true }))
      .resolves.toMatchObject({ primaryNode: 22n, lastPrimaryNodeChangeEpoch: 2 });
    expect(adapter.readContract.calls).toHaveLength(8);
  });

  it('public settlement and agent batch mutations refresh warmed account-info cache immediately', async () => {
    const cases: Array<{
      name: string;
      before: unknown[];
      after: unknown[];
      invoke: (adapter: any) => Promise<unknown>;
      expectedMethod: string;
      expectedAfter: Record<string, unknown>;
    }> = [
      {
        name: 'settlement',
        before: accountInfoTuple(OWNER, 100n, 0n, 0n, 0n),
        after: accountInfoTuple(OWNER, 100n, 0n, 0n, 1n),
        invoke: (adapter) => adapter.settlePublishingConvictionAccount(9n),
        expectedMethod: 'settle',
        expectedAfter: { lastSettledWindow: 1 },
      },
      {
        name: 'agent deregistration',
        before: accountInfoTuple(OWNER, 100n, 0n, 1n),
        after: accountInfoTuple(OWNER, 100n, 0n, 0n),
        invoke: (adapter) => adapter.deregisterPublishingConvictionAgent(9n, AGENT),
        expectedMethod: 'deregisterAgent',
        expectedAfter: { agentCount: 0 },
      },
      {
        name: 'batch agent registration',
        before: accountInfoTuple(OWNER, 100n, 0n, 0n),
        after: accountInfoTuple(OWNER, 100n, 0n, 2n),
        invoke: (adapter) => adapter.registerPublishingConvictionAgents(9n, [AGENT, OWNER]),
        expectedMethod: 'registerAgents',
        expectedAfter: { agentCount: 2 },
      },
      {
        name: 'clear agents',
        before: accountInfoTuple(OWNER, 100n, 0n, 3n),
        after: accountInfoTuple(OWNER, 100n, 0n, 0n),
        invoke: (adapter) => adapter.clearPublishingConvictionAgents(9n),
        expectedMethod: 'clearAgents',
        expectedAfter: { agentCount: 0 },
      },
    ];

    for (const scenario of cases) {
      const adapter = pcaReadCacheAdapter([scenario.before, scenario.after]) as any;
      const writes = installPcaWriteStubs(adapter);

      await expect(adapter.getPublishingConvictionAccountInfo(9n))
        .resolves.toMatchObject({ committedTRAC: 100n });
      expect(adapter.readContract.calls, `${scenario.name}: warm read`).toHaveLength(1);

      await scenario.invoke(adapter);
      expect(writes.at(-1), `${scenario.name}: write method`).toMatchObject({ method: scenario.expectedMethod });

      await expect(adapter.getPublishingConvictionAccountInfo(9n))
        .resolves.toMatchObject(scenario.expectedAfter);
      expect(adapter.readContract.calls, `${scenario.name}: refreshed read`).toHaveLength(2);
    }
  });
});
