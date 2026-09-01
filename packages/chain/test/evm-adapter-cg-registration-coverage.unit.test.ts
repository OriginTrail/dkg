import { describe, expect, it } from 'vitest';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import {
  AUTO_COVERAGE_DISCOVERY_TIMEOUT_MS,
  AUTO_COVERAGE_READ_CONCURRENCY,
  MAX_AUTO_COVERAGE_CANDIDATES,
} from '../src/evm-adapter-context-graph.js';
import {
  ContextGraphFacadeVersionUnknownError,
  PcaCoverageUnsupportedError,
} from '../src/evm-adapter-errors.js';

const PRIMARY_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const SECONDARY_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ADMIN_PK = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const OLD_FACADE = '0x' + '11'.repeat(20);
const NEW_FACADE = '0x' + '22'.repeat(20);

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

function configureSubmission(
  adapter: any,
  version: string | Error,
  facadeAddress = NEW_FACADE,
) {
  const contextGraphs = { getAddress: async () => facadeAddress };
  adapter.contracts = {
    contextGraphs,
    contextGraphStorage: storageDouble(),
    parametersStorage: { kind: 'parameters' },
  };
  adapter.readContract = async (
    _contract: unknown,
    _label: string,
    method: string,
  ) => {
    if (method === 'version') {
      if (version instanceof Error) throw version;
      return version;
    }
    if (method === 'contextGraphRegistrationDeposit') return 100n;
    throw new Error(`unexpected read ${method}`);
  };
  return contextGraphs;
}

const CREATE_PARAMS = { accessPolicy: 0, publishPolicy: 1 } as const;

describe('prepared context-graph PCA registration coverage', () => {
  it('pins pooled registration to signer B when only B has verified coverage', async () => {
    const adapter = makeAdapter([SECONDARY_PK]);
    const [walletA, walletB] = adapter.signerPool;
    adapter.prepareCoverageDiscoverySnapshot = async () => coverageSnapshot();
    adapter.discoverCoverageForSigner = async (signer: { address: string }) =>
      signer.address === walletB.address
        ? { source: 'owned', accountId: 8n }
        : { source: 'none' };
    const contextGraphs = configureSubmission(adapter, '10.0.5');
    const send = recorder(async (..._args: unknown[]) => successfulReceipt());
    adapter.sendContractTransaction = send;

    const prepared = await adapter.prepareOnChainContextGraphRegistration({
      preferPcaCoveredSigner: true,
    });
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
    adapter.prepareCoverageDiscoverySnapshot = async () => coverageSnapshot();
    adapter.discoverCoverageForSigner = async (signer: { address: string }) =>
      signer.address === walletB.address
        ? { source: 'owned', accountId: 8n }
        : { source: 'none' };

    const prepared = await adapter.prepareOnChainContextGraphRegistration({
      registrationSignerAddress: walletA.address,
      preferPcaCoveredSigner: true,
    });

    expect(prepared.signerAddress).toBe(walletA.address);
    expect(prepared.coverage).toEqual({ source: 'none' });
  });

  it('seals capability fields and rejects runtime signer/PCA override smuggling', async () => {
    const adapter = makeAdapter();
    const prepared = await adapter.prepareOnChainContextGraphRegistration({
      registrationPcaAccountId: 4n,
    });

    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.coverage)).toBe(true);
    await expect(prepared.submit({
      ...CREATE_PARAMS,
      registrationPcaAccountId: 9n,
    } as any)).rejects.toThrow(/does not accept signer or PCA coverage overrides/);
  });
});

describe('automatic PCA coverage discovery bounds and eligibility', () => {
  it('pins the advertised 32-candidate, four-read, five-second bounds', () => {
    expect(MAX_AUTO_COVERAGE_CANDIDATES).toBe(32);
    expect(AUTO_COVERAGE_READ_CONCURRENCY).toBe(4);
    expect(AUTO_COVERAGE_DISCOVERY_TIMEOUT_MS).toBe(5_000);
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
  it('uses the additive selector on 10.0.5+ and preserves legacy selector for matching authority coverage', async () => {
    const adapter = makeAdapter();
    configureSubmission(adapter, '10.0.5');
    const send = recorder(async (..._args: unknown[]) => successfulReceipt());
    adapter.sendContractTransaction = send;
    const prepared = await adapter.prepareOnChainContextGraphRegistration({ registrationPcaAccountId: 5n });

    await prepared.submit(CREATE_PARAMS);
    expect(send.calls[0][1]).toBe('createContextGraphWithPcaCoverage');
    expect(send.calls[0][2]).toHaveLength(8);

    send.calls.length = 0;
    await prepared.submit({ ...CREATE_PARAMS, publishAuthorityAccountId: 5n });
    expect(send.calls[0][1]).toBe('createContextGraph');
    expect(send.calls[0][2]).toHaveLength(7);
  });

  it('rejects explicit decoupled coverage on a confirmed old facade before any transaction', async () => {
    const adapter = makeAdapter();
    configureSubmission(adapter, '10.0.4');
    const send = recorder(async (..._args: unknown[]) => successfulReceipt());
    adapter.sendContractTransaction = send;
    const prepared = await adapter.prepareOnChainContextGraphRegistration({ registrationPcaAccountId: 5n });

    await expect(prepared.submit(CREATE_PARAMS)).rejects.toBeInstanceOf(PcaCoverageUnsupportedError);
    expect(send.calls).toEqual([]);
  });

  it('treats malformed and unreadable facade versions as retryable unknown, with no transaction', async () => {
    for (const version of ['release-candidate', new Error('RPC unavailable')]) {
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

  it('re-resolves facade/version/spender after stale Hub while retaining signer and coverage', async () => {
    const adapter = makeAdapter([SECONDARY_PK]);
    const walletB = adapter.signerPool[1];
    const oldFacade = { getAddress: async () => OLD_FACADE };
    const newFacade = { getAddress: async () => NEW_FACADE };
    const oldContracts = {
      contextGraphs: oldFacade,
      contextGraphStorage: storageDouble(),
      parametersStorage: { kind: 'old-parameters' },
    };
    const newContracts = {
      contextGraphs: newFacade,
      contextGraphStorage: storageDouble(),
      parametersStorage: { kind: 'new-parameters' },
    };
    adapter.contracts = oldContracts;
    adapter.readContract = async (
      _contract: unknown,
      _label: string,
      method: string,
    ) => method === 'version' ? '10.0.5' : 100n;
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
