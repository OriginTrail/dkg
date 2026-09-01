import { afterEach, describe, expect, it, vi } from 'vitest';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import {
  AUTO_COVERAGE_DISCOVERY_TIMEOUT_MS,
  AUTO_COVERAGE_READ_CONCURRENCY,
  MAX_AUTO_COVERAGE_CANDIDATES,
} from '../src/evm-adapter-context-graph.js';
import {
  ContextGraphFacadeVersionUnknownError,
  ContextGraphRegistrationCoverageSignerUnavailableError,
  PcaCoverageUnsupportedError,
} from '../src/evm-adapter-errors.js';
import { ChainRpcTransportError } from '../src/chain-rpc-transport-error.js';

const PRIMARY_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const SECONDARY_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ADMIN_PK = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const OLD_FACADE = '0x' + '11'.repeat(20);
const NEW_FACADE = '0x' + '22'.repeat(20);
const PARAMETERS_ADDRESS = '0x' + '33'.repeat(20);
const UNRELATED_ADDRESS = '0x' + '44'.repeat(20);

function minimalConfig(overrides: Partial<EVMAdapterConfig> = {}): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: PRIMARY_PK,
    adminPrivateKey: ADMIN_PK,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    staticNetwork: false,
    ...overrides,
  };
}

function makeAdapter(additionalKeys: string[] = []) {
  const adapter: any = new EVMChainAdapter(minimalConfig({ additionalKeys }));
  adapter.initialized = true;
  adapter.init = async () => { adapter.initialized = true; };
  return adapter;
}

function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => { calls.push(args); return impl(...args); };
  return Object.assign(fn, { calls });
}

function successfulReceipt(contextGraphId = 17n) {
  return {
    logs: [{ topics: [], data: '0x' }],
    hash: '0xhash',
    blockNumber: 1,
    index: 0,
    status: 1,
    contextGraphId,
  };
}

function storageDouble() {
  return {
    interface: {
      parseLog: () => ({ name: 'ContextGraphCreated', args: { contextGraphId: 17n } }),
    },
  };
}

function immediateReads() {
  return {
    run: <T>(read: () => Promise<T>) => read(),
    expired: () => false,
  };
}

function coverageSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    deposit: 100n,
    minimumCommitment: 100n,
    latestTimestamp: 1_000n,
    pca: { kind: 'pca' },
    waiverStorage: { kind: 'waiver' },
    reads: immediateReads(),
    ...overrides,
  };
}

function configureExplicitCoverage(
  adapter: any,
  options: {
    owner: string;
    agentAccounts?: ReadonlyMap<string, bigint>;
  },
) {
  const pca = { kind: 'pca' };
  adapter.contracts = { ...adapter.contracts, dkgPublishingConvictionNFT: pca };
  adapter.readContract = async (
    contract: unknown,
    _label: string,
    method: string,
    ...args: unknown[]
  ) => {
    if (contract !== pca) throw new Error(`unexpected contract read ${method}`);
    if (method === 'ownerOf') return options.owner;
    if (method === 'agentToAccountId') {
      return options.agentAccounts?.get(String(args[0]).toLowerCase()) ?? 0n;
    }
    throw new Error(`unexpected PCA read ${method}`);
  };
  return pca;
}

function configureRealCoverageDiscovery(
  adapter: any,
  read: (method: string, ...args: unknown[]) => unknown | Promise<unknown>,
) {
  const pca = { kind: 'pca' };
  const waiverStorage = { kind: 'waiver' };
  adapter.contracts = {
    ...adapter.contracts,
    dkgPublishingConvictionNFT: pca,
    parametersStorage: { getAddress: async () => PARAMETERS_ADDRESS },
  };
  adapter.resolveContract = async (name: string) => {
    if (name === 'ContextGraphWaiverStorage') return waiverStorage;
    throw new Error(`unexpected contract resolution ${name}`);
  };
  adapter.readTipProvider = async () => ({ timestamp: 1_000 });
  adapter.readContract = async (
    _contract: unknown,
    _label: string,
    method: string,
    ...args: unknown[]
  ) => {
    if (method === 'contextGraphRegistrationDeposit') return 100n;
    if (method === 'minPcaCommitmentForCgWaiver') return 100n;
    return read(method, ...args);
  };
  return { pca, waiverStorage };
}

function configureSubmission(
  adapter: any,
  version: string | Error,
  facadeAddress = NEW_FACADE,
) {
  const previousRead = Object.prototype.hasOwnProperty.call(adapter, 'readContract')
    ? adapter.readContract.bind(adapter)
    : undefined;
  const contextGraphs = { getAddress: async () => facadeAddress };
  adapter.contracts = {
    ...adapter.contracts,
    dkgPublishingConvictionNFT:
      adapter.contracts?.dkgPublishingConvictionNFT ?? { kind: 'pca' },
    contextGraphs,
    contextGraphStorage: storageDouble(),
    parametersStorage: { kind: 'parameters' },
  };
  adapter.readContract = async (
    _contract: unknown,
    _label: string,
    method: string,
    ...args: unknown[]
  ) => {
    if (method === 'version') {
      if (version instanceof Error) throw version;
      return version;
    }
    if (method === 'contextGraphRegistrationDeposit') return 100n;
    if (previousRead) return previousRead(_contract, _label, method, ...args);
    if (method === 'ownerOf') return adapter.signerPool[0].address;
    if (method === 'agentToAccountId') return 0n;
    throw new Error(`unexpected read ${method}`);
  };
  adapter.isCurrentHubContractAddress = async () => true;
  return contextGraphs;
}

const CREATE_PARAMS = { accessPolicy: 0, publishPolicy: 1 } as const;

afterEach(() => {
  vi.useRealTimers();
});

describe('prepared context-graph PCA registration coverage', () => {
  it('uses real discovery to pin pooled registration to signer B when only B has verified coverage', async () => {
    const adapter = makeAdapter([SECONDARY_PK]);
    const [walletA, walletB] = adapter.signerPool;
    configureRealCoverageDiscovery(adapter, async (method, ...args) => {
      if (method === 'balanceOf') return args[0] === walletB.address ? 1n : 0n;
      if (method === 'tokenOfOwnerByIndex') return 8n;
      if (method === 'accounts') {
        return { committedTRAC: 1_000n, expiresAtTimestamp: 0n, fullySwept: false };
      }
      if (method === 'ownerOf') return walletB.address;
      if (method === 'waivedCgCount') return 0n;
      if (method === 'agentToAccountId') return 0n;
      throw new Error(`unexpected read ${method}`);
    });

    const prepared = await adapter.prepareOnChainContextGraphRegistration({
      preferPcaCoveredSigner: true,
    });
    const contextGraphs = configureSubmission(adapter, '10.0.5');
    const send = recorder(async (..._args: unknown[]) => successfulReceipt());
    adapter.sendContractTransaction = send;

    const result = await prepared.submit(CREATE_PARAMS);

    expect(prepared.signerAddress).toBe(walletB.address);
    expect(prepared.coverage).toEqual({ source: 'owned', accountId: 8n });
    expect(send.calls[0][0]).toBe(contextGraphs);
    expect(send.calls[0][1]).toBe('createContextGraphWithPcaCoverage');
    expect(send.calls[0][2]).toEqual([[], 0n, 0, 1, expect.any(String), 0n, expect.any(String), 8n]);
    expect(send.calls[0][3]).toBe(walletB);
    expect(send.calls[0][3]).not.toBe(walletA);
    expect(result.success).toBe(true);
  });

  it('honors an exact signer pin and does not substitute a better-covered pool signer', async () => {
    const adapter = makeAdapter([SECONDARY_PK]);
    const [walletA, walletB] = adapter.signerPool;
    configureRealCoverageDiscovery(adapter, async (method, ...args) => {
      if (method === 'balanceOf') return args[0] === walletB.address ? 1n : 0n;
      if (method === 'tokenOfOwnerByIndex') return 8n;
      if (method === 'accounts') {
        return { committedTRAC: 1_000n, expiresAtTimestamp: 0n, fullySwept: false };
      }
      if (method === 'ownerOf') return walletB.address;
      if (method === 'waivedCgCount') return 0n;
      if (method === 'agentToAccountId') return 0n;
      throw new Error(`unexpected read ${method}`);
    });

    const prepared = await adapter.prepareOnChainContextGraphRegistration({
      registrationSignerAddress: walletA.address,
      preferPcaCoveredSigner: true,
    });

    expect(prepared.signerAddress).toBe(walletA.address);
    expect(prepared.coverage).toEqual({ source: 'none' });
  });

  it('selects a secondary owner for explicit unpinned coverage', async () => {
    const adapter = makeAdapter([SECONDARY_PK]);
    const walletB = adapter.signerPool[1];
    configureExplicitCoverage(adapter, { owner: walletB.address });

    const prepared = await adapter.prepareOnChainContextGraphRegistration({
      registrationPcaAccountId: 8n,
      preferPcaCoveredSigner: true,
    });

    expect(prepared.signerAddress).toBe(walletB.address);
    expect(prepared.coverage).toEqual({ source: 'explicit', accountId: 8n });
  });

  it('selects a secondary exact agent for explicit unpinned coverage', async () => {
    const adapter = makeAdapter([SECONDARY_PK]);
    const walletB = adapter.signerPool[1];
    configureExplicitCoverage(adapter, {
      owner: UNRELATED_ADDRESS,
      agentAccounts: new Map([[walletB.address.toLowerCase(), 8n]]),
    });

    const prepared = await adapter.prepareOnChainContextGraphRegistration({
      registrationPcaAccountId: 8n,
      preferPcaCoveredSigner: true,
    });

    expect(prepared.signerAddress).toBe(walletB.address);
    expect(prepared.coverage).toEqual({ source: 'explicit', accountId: 8n });
  });

  it('fails explicit unpinned coverage before submit when no configured signer matches', async () => {
    const adapter = makeAdapter([SECONDARY_PK]);
    configureExplicitCoverage(adapter, { owner: UNRELATED_ADDRESS });

    const rejected = adapter.prepareOnChainContextGraphRegistration({
      registrationPcaAccountId: 8n,
      preferPcaCoveredSigner: true,
    }).catch((error: unknown) => error);

    const error = await rejected;
    expect(error).toBeInstanceOf(ContextGraphRegistrationCoverageSignerUnavailableError);
    expect(error.accountId).toBe(8n);
  });

  it.each(['ownerOf', 'agentToAccountId'] as const)(
    'preserves a retryable %s verification failure instead of fabricating a signer mismatch',
    async (failingMethod) => {
      const adapter = makeAdapter();
      const pca = { kind: 'pca' };
      const rpcError = new ChainRpcTransportError(
        'RPC_ENDPOINTS_EXHAUSTED',
        `${failingMethod} RPC endpoints exhausted`,
      );
      adapter.contracts = { ...adapter.contracts, dkgPublishingConvictionNFT: pca };
      adapter.readContract = async (
        contract: unknown,
        _label: string,
        method: string,
      ) => {
        if (contract !== pca) throw new Error(`unexpected contract read ${method}`);
        if (method === failingMethod) throw rpcError;
        if (method === 'ownerOf') return UNRELATED_ADDRESS;
        if (method === 'agentToAccountId') return 0n;
        throw new Error(`unexpected PCA read ${method}`);
      };

      const rejected = adapter.prepareOnChainContextGraphRegistration({
        registrationPcaAccountId: 8n,
      }).catch((error: unknown) => error);

      expect(await rejected).toBe(rpcError);
    },
  );

  it('verifies a hard pin without rotating to a different matching pool signer', async () => {
    const adapter = makeAdapter([SECONDARY_PK]);
    const [walletA, walletB] = adapter.signerPool;
    configureExplicitCoverage(adapter, {
      owner: walletB.address,
      agentAccounts: new Map([[walletA.address.toLowerCase(), 8n]]),
    });

    const pinnedAgent = await adapter.prepareOnChainContextGraphRegistration({
      registrationPcaAccountId: 8n,
      registrationSignerAddress: walletA.address,
      preferPcaCoveredSigner: true,
    });
    expect(pinnedAgent.signerAddress).toBe(walletA.address);

    configureExplicitCoverage(adapter, { owner: walletB.address });
    await expect(adapter.prepareOnChainContextGraphRegistration({
      registrationPcaAccountId: 8n,
      registrationSignerAddress: walletA.address,
      preferPcaCoveredSigner: true,
    })).rejects.toBeInstanceOf(ContextGraphRegistrationCoverageSignerUnavailableError);
  });

  it('seals capability fields and rejects non-positive coverage IDs', async () => {
    const adapter = makeAdapter();
    configureExplicitCoverage(adapter, { owner: adapter.signerPool[0].address });
    const prepared = await adapter.prepareOnChainContextGraphRegistration({
      registrationPcaAccountId: 4n,
    });

    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.coverage)).toBe(true);
    await expect(adapter.prepareOnChainContextGraphRegistration({
      registrationPcaAccountId: 0n,
    })).rejects.toThrow(/positive PCA account id/);
    expect(() => adapter.sealContextGraphRegistration(
      adapter.signerPool[0],
      { source: 'owned', accountId: 0n },
    )).toThrow(/positive PCA account id/);
  });
});

describe('automatic PCA coverage discovery bounds and eligibility', () => {
  it('pins the advertised 32-candidate, four-read, five-second bounds', () => {
    expect(MAX_AUTO_COVERAGE_CANDIDATES).toBe(32);
    expect(AUTO_COVERAGE_READ_CONCURRENCY).toBe(4);
    expect(AUTO_COVERAGE_DISCOVERY_TIMEOUT_MS).toBe(5_000);
  });

  it('prefers secondary owned coverage over an earlier consent-free agent binding', async () => {
    const adapter = makeAdapter([SECONDARY_PK]);
    const [walletA, walletB] = adapter.signerPool;
    configureRealCoverageDiscovery(adapter, async (method, ...args) => {
      if (method === 'balanceOf') return args[0] === walletB.address ? 1n : 0n;
      if (method === 'tokenOfOwnerByIndex') return 8n;
      if (method === 'agentToAccountId') return args[0] === walletA.address ? 7n : 0n;
      if (method === 'ownerOf') return walletB.address;
      if (method === 'accounts') {
        return { committedTRAC: 1_000n, expiresAtTimestamp: 0n, fullySwept: false };
      }
      if (method === 'waivedCgCount') return 0n;
      throw new Error(`unexpected read ${method}`);
    });

    const prepared = await adapter.prepareOnChainContextGraphRegistration({
      preferPcaCoveredSigner: true,
    });

    expect(prepared.signerAddress).toBe(walletB.address);
    expect(prepared.coverage).toEqual({ source: 'owned', accountId: 8n });
  });

  it('caps real public preparation discovery at four concurrent RPC reads', async () => {
    const adapter = makeAdapter();
    const signer = adapter.signerPool[0];
    let active = 0;
    let maxActive = 0;
    configureRealCoverageDiscovery(adapter, async (method, ...args) => {
      if (method === 'balanceOf') return 8n;
      if (method === 'tokenOfOwnerByIndex') {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return BigInt(Number(args[1]) + 1);
      }
      if (method === 'accounts') {
        return { committedTRAC: 1_000n, expiresAtTimestamp: 0n, fullySwept: false };
      }
      if (method === 'ownerOf') return signer.address;
      if (method === 'waivedCgCount') return 0n;
      if (method === 'agentToAccountId') return 0n;
      throw new Error(`unexpected read ${method}`);
    });

    const prepared = await adapter.prepareOnChainContextGraphRegistration({
      preferPcaCoveredSigner: true,
    });

    expect(prepared.coverage).toEqual({ source: 'owned', accountId: 1n });
    expect(maxActive).toBe(AUTO_COVERAGE_READ_CONCURRENCY);
  });

  it('stops queued public preparation reads at five seconds without post-budget starts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const adapter = makeAdapter();
    let tokenReadStarts = 0;
    configureRealCoverageDiscovery(adapter, async (method) => {
      if (method === 'balanceOf') return 8n;
      if (method === 'tokenOfOwnerByIndex') {
        tokenReadStarts += 1;
        return new Promise<bigint>(() => {});
      }
      throw new Error(`unexpected read ${method}`);
    });

    const preparing = adapter.prepareOnChainContextGraphRegistration({
      preferPcaCoveredSigner: true,
    });
    for (let turns = 0; turns < 20 && tokenReadStarts < AUTO_COVERAGE_READ_CONCURRENCY; turns += 1) {
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(tokenReadStarts).toBe(AUTO_COVERAGE_READ_CONCURRENCY);

    await vi.advanceTimersByTimeAsync(AUTO_COVERAGE_DISCOVERY_TIMEOUT_MS);
    const prepared = await preparing;
    await vi.advanceTimersByTimeAsync(0);

    expect(prepared.coverage).toEqual({ source: 'none' });
    expect(tokenReadStarts).toBe(AUTO_COVERAGE_READ_CONCURRENCY);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('over-cap ownership skips both enumeration and unsolicited agent fallback', async () => {
    const adapter = makeAdapter();
    const signer = adapter.signerPool[0];
    const methods: string[] = [];
    adapter.readContract = async (
      _contract: unknown,
      _label: string,
      method: string,
    ) => {
      methods.push(method);
      if (method === 'balanceOf') return 33n;
      throw new Error(`unexpected read ${method}`);
    };

    const coverage = await adapter.discoverCoverageForSigner(signer, coverageSnapshot());

    expect(coverage).toEqual({ source: 'none' });
    expect(methods).toEqual(['balanceOf']);
  });

  it('sorts owned IDs, skips an under-floor candidate, and applies current quota', async () => {
    const adapter = makeAdapter();
    const signer = adapter.signerPool[0];
    adapter.readContract = async (
      _contract: unknown,
      _label: string,
      method: string,
      ...args: unknown[]
    ) => {
      if (method === 'balanceOf') return 3n;
      if (method === 'tokenOfOwnerByIndex') return [9n, 3n, 7n][Number(args[1])];
      if (method === 'ownerOf') return signer.address;
      if (method === 'accounts') {
        const accountId = BigInt(args[0] as bigint);
        if (accountId === 3n) return { committedTRAC: 99n, expiresAtTimestamp: 0n, fullySwept: false };
        return { committedTRAC: 1_000n, expiresAtTimestamp: 0n, fullySwept: false };
      }
      if (method === 'waivedCgCount') {
        const accountId = BigInt(args[0] as bigint);
        return accountId === 7n ? 10n : 9n;
      }
      if (method === 'agentToAccountId') return 0n;
      throw new Error(`unexpected read ${method}`);
    };

    const coverage = await adapter.discoverCoverageForSigner(signer, coverageSnapshot());

    // 3 is below the live floor; 7 has exhausted committed/deposit == 10;
    // 9 is the first fully eligible account despite enumeration order [9,3,7].
    expect(coverage).toEqual({ source: 'owned', accountId: 9n });
  });

  it('continues after a candidate-local read failure and uses the next eligible owner', async () => {
    const adapter = makeAdapter();
    const signer = adapter.signerPool[0];
    adapter.readContract = async (
      _contract: unknown,
      _label: string,
      method: string,
      ...args: unknown[]
    ) => {
      if (method === 'balanceOf') return 2n;
      if (method === 'tokenOfOwnerByIndex') return BigInt(Number(args[1]) + 1);
      if (method === 'accounts' && args[0] === 1n) throw new Error('candidate-local RPC failure');
      if (method === 'accounts') return { committedTRAC: 1_000n, expiresAtTimestamp: 0n, fullySwept: false };
      if (method === 'ownerOf') return signer.address;
      if (method === 'waivedCgCount') return 0n;
      if (method === 'agentToAccountId') return 0n;
      throw new Error(`unexpected read ${method}`);
    };

    await expect(adapter.discoverCoverageForSigner(signer, coverageSnapshot()))
      .resolves.toEqual({ source: 'owned', accountId: 2n });
  });

  it.each([
    {
      label: 'fully swept',
      account: { committedTRAC: 1_000n, expiresAtTimestamp: 0n, fullySwept: true },
      ownerMatches: true,
      snapshot: {},
      expected: { source: 'none' },
    },
    {
      label: 'expired exactly at the latest block timestamp',
      account: { committedTRAC: 1_000n, expiresAtTimestamp: 1_000n, fullySwept: false },
      ownerMatches: true,
      snapshot: {},
      expected: { source: 'none' },
    },
    {
      label: 'not yet expired',
      account: { committedTRAC: 1_000n, expiresAtTimestamp: 1_001n, fullySwept: false },
      ownerMatches: true,
      snapshot: {},
      expected: { source: 'owned', accountId: 1n },
    },
    {
      label: 'owner mismatch',
      account: { committedTRAC: 1_000n, expiresAtTimestamp: 0n, fullySwept: false },
      ownerMatches: false,
      snapshot: {},
      expected: { source: 'none' },
    },
    {
      label: 'zero commitment even with a zero minimum floor',
      account: { committedTRAC: 0n, expiresAtTimestamp: 0n, fullySwept: false },
      ownerMatches: true,
      snapshot: { minimumCommitment: 0n },
      expected: { source: 'none' },
    },
  ])('treats $label with fail-closed eligibility semantics', async ({
    account,
    ownerMatches,
    snapshot,
    expected,
  }) => {
    const adapter = makeAdapter();
    const signer = adapter.signerPool[0];
    adapter.readContract = async (
      _contract: unknown,
      _label: string,
      method: string,
    ) => {
      if (method === 'balanceOf') return 1n;
      if (method === 'tokenOfOwnerByIndex') return 1n;
      if (method === 'ownerOf') return ownerMatches ? signer.address : UNRELATED_ADDRESS;
      if (method === 'accounts') return account;
      if (method === 'waivedCgCount') return 0n;
      if (method === 'agentToAccountId') return 0n;
      throw new Error(`unexpected read ${method}`);
    };

    await expect(adapter.discoverCoverageForSigner(signer, coverageSnapshot(snapshot)))
      .resolves.toEqual(expected);
  });

  it('uses the exact strict-agent mapping only after no owned candidate qualifies', async () => {
    const adapter = makeAdapter();
    const signer = adapter.signerPool[0];
    adapter.readContract = async (
      _contract: unknown,
      _label: string,
      method: string,
      ...args: unknown[]
    ) => {
      if (method === 'balanceOf') return 0n;
      if (method === 'agentToAccountId') return 12n;
      if (method === 'accounts') return { committedTRAC: 1_000n, expiresAtTimestamp: 0n, fullySwept: false };
      if (method === 'waivedCgCount') return 2n;
      throw new Error(`unexpected read ${method}(${args.join(',')})`);
    };

    await expect(adapter.discoverCoverageForSigner(signer, coverageSnapshot()))
      .resolves.toEqual({ source: 'agent', accountId: 12n });
  });

  it('fails closed to deposit when enumeration hits its total-budget failure seam', async () => {
    const adapter = makeAdapter();
    const signer = adapter.signerPool[0];
    const methods: string[] = [];
    adapter.readContract = async (
      _contract: unknown,
      _label: string,
      method: string,
    ) => {
      methods.push(method);
      if (method === 'balanceOf') return 1n;
      if (method === 'tokenOfOwnerByIndex') throw new Error('discovery deadline');
      throw new Error(`unexpected read ${method}`);
    };

    await expect(adapter.discoverCoverageForSigner(signer, coverageSnapshot()))
      .resolves.toEqual({ source: 'none' });
    expect(methods).not.toContain('agentToAccountId');
  });
});

describe('facade capability and allowance/stale-Hub behavior', () => {
  it('keeps canonical create data separate while the direct wrapper prepares an explicit hard pin', async () => {
    const adapter = makeAdapter([SECONDARY_PK]);
    const walletB = adapter.signerPool[1];
    configureExplicitCoverage(adapter, { owner: walletB.address });
    const contextGraphs = configureSubmission(adapter, '10.0.5');
    const send = recorder(async (..._args: unknown[]) => successfulReceipt());
    adapter.sendContractTransaction = send;

    await adapter.createOnChainContextGraph(CREATE_PARAMS, {
      registrationPcaAccountId: 5n,
      registrationSignerAddress: walletB.address,
      preferPcaCoveredSigner: true,
    });

    expect(Object.keys(CREATE_PARAMS)).toEqual(['accessPolicy', 'publishPolicy']);
    expect(send.calls[0][0]).toBe(contextGraphs);
    expect(send.calls[0][1]).toBe('createContextGraphWithPcaCoverage');
    expect(send.calls[0][2]).toEqual([[], 0n, 0, 1, expect.any(String), 0n, expect.any(String), 5n]);
    expect(send.calls[0][3]).toBe(walletB);
  });

  it('preserves the old direct-create wrapper path without PCA discovery', async () => {
    const adapter = makeAdapter();
    configureSubmission(adapter, '10.0.5');
    const send = recorder(async (..._args: unknown[]) => successfulReceipt());
    adapter.sendContractTransaction = send;
    const prepare = recorder(async () => {
      throw new Error('legacy wrapper must not prepare coverage');
    });
    adapter.prepareOnChainContextGraphRegistration = prepare;

    await adapter.createOnChainContextGraph(CREATE_PARAMS);

    expect(prepare.calls).toEqual([]);
    expect(send.calls[0][1]).toBe('createContextGraph');
    expect(send.calls[0][3]).toBe(adapter.signerPool[0]);
  });

  it('dispatches a direct PCA policy without off-chain signer verification', async () => {
    const adapter = makeAdapter();
    configureSubmission(adapter, '10.0.5');
    const send = recorder(async (..._args: unknown[]) => successfulReceipt());
    adapter.sendContractTransaction = send;
    const prepare = recorder(async () => {
      throw new Error('direct PCA policy must leave eligibility to the contract');
    });
    adapter.prepareOnChainContextGraphRegistration = prepare;

    await adapter.createOnChainContextGraph({
      ...CREATE_PARAMS,
      publishAuthorityAccountId: 5n,
      registrationDepositPolicy: { mode: 'pca', accountId: 5n },
    });

    expect(prepare.calls).toEqual([]);
    expect(send.calls[0][1]).toBe('createContextGraphWithPcaCoverage');
    expect(send.calls[0][2]).toEqual([
      [], 0n, 0, 1, expect.any(String), 5n, expect.any(String), 5n,
    ]);
  });

  it('maps an explicit paid policy to the additive selector with account zero', async () => {
    const adapter = makeAdapter();
    configureSubmission(adapter, '10.0.5');
    const send = recorder(async (..._args: unknown[]) => successfulReceipt());
    adapter.sendContractTransaction = send;

    await adapter.createOnChainContextGraph({
      ...CREATE_PARAMS,
      registrationDepositPolicy: { mode: 'paid' },
    });

    expect(send.calls[0][1]).toBe('createContextGraphWithPcaCoverage');
    expect(send.calls[0][2].at(-1)).toBe(0n);
  });

  it('rejects direct PCA coverage on an unsupported current facade', async () => {
    const adapter = makeAdapter();
    configureSubmission(adapter, '10.0.4');
    const send = recorder(async (..._args: unknown[]) => successfulReceipt());
    adapter.sendContractTransaction = send;

    await expect(adapter.createOnChainContextGraph({
      ...CREATE_PARAMS,
      registrationDepositPolicy: { mode: 'pca', accountId: 5n },
    })).rejects.toBeInstanceOf(PcaCoverageUnsupportedError);

    expect(send.calls).toEqual([]);
  });

  it('rejects a policy override when registration preparation seals the policy', async () => {
    const adapter = makeAdapter();
    const prepare = recorder(async () => {
      throw new Error('conflicting inputs must fail before preparation');
    });
    adapter.prepareOnChainContextGraphRegistration = prepare;

    await expect(adapter.createOnChainContextGraph({
      ...CREATE_PARAMS,
      registrationDepositPolicy: { mode: 'paid' },
    }, {
      registrationPcaAccountId: 5n,
    })).rejects.toThrow(/seals its deposit policy/);
    expect(prepare.calls).toEqual([]);
  });

  it.each([
    '10.0.5',
    '10.0.5+build.1',
    '10.0.6-rc.1',
    '11.0.0',
  ])('uses the additive selector on supported facade version %s', async (version) => {
    const adapter = makeAdapter();
    configureSubmission(adapter, version);
    const send = recorder(async (..._args: unknown[]) => successfulReceipt());
    adapter.sendContractTransaction = send;
    const prepared = await adapter.prepareOnChainContextGraphRegistration({ registrationPcaAccountId: 5n });

    await prepared.submit(CREATE_PARAMS);
    expect(send.calls[0][1]).toBe('createContextGraphWithPcaCoverage');
    expect(send.calls[0][2]).toHaveLength(8);
  });

  it('preserves the legacy selector when publish authority provides the same coverage', async () => {
    const adapter = makeAdapter();
    configureSubmission(adapter, '10.0.5');
    const send = recorder(async (..._args: unknown[]) => successfulReceipt());
    adapter.sendContractTransaction = send;
    const prepared = await adapter.prepareOnChainContextGraphRegistration({ registrationPcaAccountId: 5n });

    await prepared.submit({ ...CREATE_PARAMS, publishAuthorityAccountId: 5n });
    expect(send.calls[0][1]).toBe('createContextGraph');
    expect(send.calls[0][2]).toHaveLength(7);
  });

  it('rejects explicit decoupled coverage on old or floor-prerelease facades before any transaction', async () => {
    for (const version of ['10.0.4', '10.0.5-rc.1']) {
      const adapter = makeAdapter();
      configureSubmission(adapter, version);
      const send = recorder(async (..._args: unknown[]) => successfulReceipt());
      adapter.sendContractTransaction = send;
      const prepared = await adapter.prepareOnChainContextGraphRegistration({ registrationPcaAccountId: 5n });

      await expect(prepared.submit(CREATE_PARAMS)).rejects.toBeInstanceOf(PcaCoverageUnsupportedError);
      expect(send.calls).toEqual([]);
    }
  });

  it('treats malformed and unreadable facade versions as retryable unknown, with no transaction', async () => {
    for (const version of [
      'release-candidate',
      '999999999999999999999999.0.0',
      new Error('RPC unavailable'),
    ]) {
      const adapter = makeAdapter();
      configureSubmission(adapter, version);
      const send = recorder(async (..._args: unknown[]) => successfulReceipt());
      adapter.sendContractTransaction = send;
      const prepared = await adapter.prepareOnChainContextGraphRegistration({ registrationPcaAccountId: 5n });

      const rejected = prepared.submit(CREATE_PARAMS).catch((error: unknown) => error);
      const error = await rejected;
      expect(error).toBeInstanceOf(ContextGraphFacadeVersionUnknownError);
      expect(error.retryable).toBe(true);
      expect(send.calls).toEqual([]);
    }
  });

  it.each([
    ['unreadable', new Error('RPC unavailable')],
    ['malformed', 'release-candidate'],
  ])('refreshes a retired %s facade before resolving its unknown version', async (_label, oldVersion) => {
    const adapter = makeAdapter();
    const oldFacade = { getAddress: async () => OLD_FACADE };
    const newFacade = { getAddress: async () => NEW_FACADE };
    const storage = storageDouble();
    const pca = { kind: 'pca' };
    adapter.contracts = {
      contextGraphs: oldFacade,
      contextGraphStorage: storage,
      parametersStorage: { kind: 'old-parameters' },
      dkgPublishingConvictionNFT: pca,
    };
    adapter.readContract = async (
      contract: unknown,
      _label: string,
      method: string,
    ) => {
      if (method === 'version') {
        if (contract === oldFacade && oldVersion instanceof Error) throw oldVersion;
        return contract === oldFacade ? oldVersion : '10.0.5';
      }
      if (method === 'ownerOf') return adapter.signerPool[0].address;
      if (method === 'agentToAccountId') return 0n;
      throw new Error(`unexpected read ${method}`);
    };
    adapter.isCurrentHubContractAddress = async (
      _name: string,
      boundAddress: string,
    ) => boundAddress === NEW_FACADE;
    adapter.invalidateAllBoundContracts = () => {
      adapter.contracts = {
        contextGraphs: newFacade,
        contextGraphStorage: storage,
        parametersStorage: { kind: 'new-parameters' },
        dkgPublishingConvictionNFT: pca,
      };
    };
    const send = recorder(async (..._args: unknown[]) => successfulReceipt());
    adapter.sendContractTransaction = send;
    const prepared = await adapter.prepareOnChainContextGraphRegistration({
      registrationPcaAccountId: 5n,
    });

    await prepared.submit(CREATE_PARAMS);

    expect(send.calls).toHaveLength(1);
    expect(send.calls[0][0]).toBe(newFacade);
    expect(send.calls[0][1]).toBe('createContextGraphWithPcaCoverage');
  });

  it('falls back to a paid legacy registration for automatic coverage on a confirmed old facade', async () => {
    const adapter = makeAdapter();
    configureSubmission(adapter, '10.0.4');
    const send = recorder(async (..._args: unknown[]) => successfulReceipt());
    adapter.sendContractTransaction = send;
    const prepared = adapter.sealContextGraphRegistration(
      adapter.signerPool[0],
      { source: 'owned', accountId: 5n },
    );

    await prepared.submit(CREATE_PARAMS);
    expect(send.calls[0][1]).toBe('createContextGraph');
    expect(send.calls[0][2]).toHaveLength(7);
  });

  it('uses one signer for create, forced approval, and retry after an eligibility race', async () => {
    const adapter = makeAdapter([SECONDARY_PK]);
    const walletB = adapter.signerPool[1];
    const contextGraphs = configureSubmission(adapter, '10.0.5');
    let attempt = 0;
    const send = recorder(async (..._args: unknown[]) => {
      attempt += 1;
      if (attempt === 1) throw new Error('execution reverted: TooLowAllowance(TRAC, 0, 100)');
      return successfulReceipt();
    });
    const approve = recorder(async (..._args: unknown[]) => {});
    adapter.sendContractTransaction = send;
    adapter.ensureV10ApproveTrac = approve;
    const prepared = adapter.sealContextGraphRegistration(
      walletB,
      { source: 'owned', accountId: 8n },
    );

    await prepared.submit(CREATE_PARAMS);

    expect(send.calls).toHaveLength(2);
    expect(send.calls.map((call) => call[3])).toEqual([walletB, walletB]);
    expect(send.calls.map((call) => call[1])).toEqual([
      'createContextGraphWithPcaCoverage',
      'createContextGraphWithPcaCoverage',
    ]);
    expect(approve.calls).toHaveLength(1);
    expect(approve.calls[0][0]).toBe(walletB);
    expect(approve.calls[0][1]).toBe(await contextGraphs.getAddress());
    expect(approve.calls[0][4]).toBe(true);
  });

  it('refreshes a retired old facade before rejecting explicit coverage as unsupported', async () => {
    const adapter = makeAdapter();
    const oldFacade = { getAddress: async () => OLD_FACADE };
    const newFacade = { getAddress: async () => NEW_FACADE };
    const storage = storageDouble();
    adapter.contracts = {
      contextGraphs: oldFacade,
      contextGraphStorage: storage,
      parametersStorage: { kind: 'parameters' },
      dkgPublishingConvictionNFT: { kind: 'pca' },
    };
    adapter.readContract = async (
      contract: unknown,
      _label: string,
      method: string,
    ) => {
      if (method === 'version') return contract === oldFacade ? '10.0.4' : '10.0.5';
      if (method === 'ownerOf') return adapter.signerPool[0].address;
      if (method === 'agentToAccountId') return 0n;
      throw new Error(`unexpected read ${method}`);
    };
    adapter.isCurrentHubContractAddress = async (
      _name: string,
      boundAddress: string,
    ) => boundAddress === NEW_FACADE;
    adapter.invalidateAllBoundContracts = () => {
      adapter.contracts = {
        contextGraphs: newFacade,
        contextGraphStorage: storage,
        parametersStorage: { kind: 'parameters' },
        dkgPublishingConvictionNFT: { kind: 'pca' },
      };
    };
    const send = recorder(async (..._args: unknown[]) => successfulReceipt());
    adapter.sendContractTransaction = send;
    const prepared = await adapter.prepareOnChainContextGraphRegistration({
      registrationPcaAccountId: 5n,
    });

    await prepared.submit(CREATE_PARAMS);

    expect(send.calls).toHaveLength(1);
    expect(send.calls[0][0]).toBe(newFacade);
    expect(send.calls[0][1]).toBe('createContextGraphWithPcaCoverage');
  });

  it('re-resolves facade/version/spender after stale Hub while retaining signer and coverage', async () => {
    const adapter = makeAdapter([SECONDARY_PK]);
    const walletB = adapter.signerPool[1];
    const oldFacade = { getAddress: async () => OLD_FACADE };
    const newFacade = { getAddress: async () => NEW_FACADE };
    const oldContracts = {
      contextGraphs: oldFacade,
      contextGraphStorage: storageDouble(),
      parametersStorage: { kind: 'old-parameters' },
      dkgPublishingConvictionNFT: { kind: 'pca' },
    };
    const newContracts = {
      contextGraphs: newFacade,
      contextGraphStorage: storageDouble(),
      parametersStorage: { kind: 'new-parameters' },
      dkgPublishingConvictionNFT: { kind: 'pca' },
    };
    adapter.contracts = oldContracts;
    adapter.readContract = async (
      _contract: unknown,
      _label: string,
      method: string,
    ) => {
      if (method === 'version') return '10.0.5';
      if (method === 'ownerOf') return walletB.address;
      if (method === 'agentToAccountId') return 0n;
      return 100n;
    };
    adapter.invalidateAllBoundContracts = () => { adapter.contracts = newContracts; };

    const sendsByFacade = new Map<unknown, number>();
    const send = recorder(async (facade: unknown, ..._args: unknown[]) => {
      const count = (sendsByFacade.get(facade) ?? 0) + 1;
      sendsByFacade.set(facade, count);
      if (facade === oldFacade && count === 1) {
        throw new Error('execution reverted: TooLowAllowance(TRAC, 0, 100)');
      }
      if (facade === oldFacade) {
        throw new Error('execution reverted: UnauthorizedAccess(Only Contracts in Hub)');
      }
      if (count === 1) throw new Error('execution reverted: TooLowAllowance(TRAC, 0, 100)');
      return successfulReceipt();
    });
    const approve = recorder(async (..._args: unknown[]) => {});
    adapter.sendContractTransaction = send;
    adapter.ensureV10ApproveTrac = approve;
    const prepared = adapter.sealContextGraphRegistration(
      walletB,
      { source: 'owned', accountId: 8n },
    );

    await prepared.submit(CREATE_PARAMS);

    expect(send.calls).toHaveLength(4);
    expect(send.calls.every((call) => call[3] === walletB)).toBe(true);
    expect(send.calls.every((call) => (call[2] as unknown[]).at(-1) === 8n)).toBe(true);
    expect(approve.calls.map((call) => call[0])).toEqual([walletB, walletB]);
    expect(approve.calls.map((call) => call[1])).toEqual([OLD_FACADE, NEW_FACADE]);
  });
});
