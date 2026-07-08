/**
 * #1340: the CG-register TooLowAllowance recovery must read the registration
 * deposit through the RPC-failover facade (`this.readContract`), not a bare
 * call on the signer's primary-bound `parametersStorage` handle. Before the
 * fix, a broken primary threw the read → it was swallowed to 0n → the TRAC
 * approve + retry never ran, so a new CG's first publish failed permanently
 * under a degraded primary despite healthy backups.
 *
 * These drive the REAL `readContract` failover through `createOnChainContextGraph`
 * with bare-provider doubles (no Hardhat) — a focused sibling of the real-chain
 * `evm-adapter-cg-deposit.test.ts`, kept in the fast unit lane.
 */
import { describe, it, expect } from 'vitest';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADMIN_PK = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const V10_KA_ADDRESS = '0x' + 'aa'.repeat(20);

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

const tooLowAllowanceRevert = () =>
  new Error('execution reverted: TooLowAllowance(0xTRAC, 0, 1)');

describe('createOnChainContextGraph — deposit read fails over under a broken primary (#1340)', () => {
  const DEPOSIT = 100n;
  const CG_PARAMS = { accessPolicy: 0, publishPolicy: 1 } as const;

  // Stub the CG-register path EXCEPT the deposit read + recovery control flow.
  // `depositRead(i)` is the per-endpoint deposit view (i=0 primary, i=1 backup):
  // readContract rebinds `parametersStorage.connect(provider)` per endpoint, so
  // the double branches on provider identity to model a broken primary.
  function makeCgAdapter(opts: {
    depositRead: (endpointIndex: 0 | 1) => Promise<bigint>;
    firstRevert?: () => unknown; // the first-attempt submitCreate error (default TooLowAllowance)
  }) {
    const a: any = new EVMChainAdapter(minimalConfig());
    a.initialized = true;
    a.init = async () => { a.initialized = true; };
    // Isolate the failover read from the chainId preflight (not under test).
    a.ensureConfiguredStaticChainIdValidated = async () => {};

    const p0 = {}; const p1 = {};
    a.providers = [p0, p1]; // two endpoints so readContract can fail over
    a.rpcUrls = ['https://primary.example', 'https://backup.example'];

    a.contracts = {
      parametersStorage: {
        connect: (p: unknown) => ({
          contextGraphRegistrationDeposit: () => opts.depositRead(p === p0 ? 0 : 1),
        }),
      },
      contextGraphs: { getAddress: async () => V10_KA_ADDRESS },
      contextGraphStorage: {
        interface: { parseLog: () => ({ name: 'ContextGraphCreated', args: { contextGraphId: 7n } }) },
      },
    };

    const ensureSpy = recorder(async (..._a: unknown[]) => {});
    a.ensureV10ApproveTrac = ensureSpy;

    // submitCreate → sendContractTransaction: revert once, then mine a receipt.
    let sends = 0;
    const receipt = { logs: [{ topics: [], data: '0x' }], hash: '0xhash', blockNumber: 1, index: 0, status: 1 };
    const sendSpy = recorder(async (..._a: unknown[]) => {
      sends += 1;
      if (sends === 1) throw (opts.firstRevert ?? tooLowAllowanceRevert)();
      return receipt;
    });
    a.sendContractTransaction = sendSpy;

    return { a, ensureSpy, sendSpy };
  }

  const retryable429 = () => { const e = new Error('429 too many requests'); (e as any).status = 429; return e; };

  it('cure: broken primary → deposit read fails over to the backup → exactly one approve → create succeeds', async () => {
    let primaryHits = 0; let backupHits = 0;
    const { a, ensureSpy, sendSpy } = makeCgAdapter({
      depositRead: async (i) => {
        if (i === 0) { primaryHits += 1; throw retryable429(); }
        backupHits += 1; return DEPOSIT;
      },
    });

    const result = await a.createOnChainContextGraph(CG_PARAMS);

    // Failover actually happened (not just "approve fired"):
    expect(primaryHits).toBe(1);            // primary view tried and threw
    expect(backupHits).toBe(1);             // failed over to the backup
    // Approve fired exactly once, with the real (failed-over) deposit, force=true:
    expect(ensureSpy.calls).toHaveLength(1);
    expect(ensureSpy.calls[0][2]).toBe(DEPOSIT);
    expect(ensureSpy.calls[0][4]).toBe(true);
    // Recovery is one-shot: initial submit reverts, retry mines.
    expect(sendSpy.calls).toHaveLength(2);
    expect(result.success).toBe(true);
    expect(result.contextGraphId).toBe(7n);
  });

  it('preserved semantics: deposit read throws on ALL endpoints → no approve, original TooLowAllowance propagates', async () => {
    const { a, ensureSpy, sendSpy } = makeCgAdapter({ depositRead: async () => { throw retryable429(); } });
    await expect(a.createOnChainContextGraph(CG_PARAMS)).rejects.toThrow('TooLowAllowance');
    expect(ensureSpy.calls).toEqual([]); // conservative: never approve on an unreadable deposit
    expect(sendSpy.calls).toHaveLength(1); // only the initial submit; no retry
  });

  it('healthy primary unchanged: deposit answers on the primary, backup never consulted, one approve', async () => {
    let backupHits = 0;
    const { a, ensureSpy } = makeCgAdapter({
      depositRead: async (i) => { if (i === 1) backupHits += 1; return DEPOSIT; },
    });
    const result = await a.createOnChainContextGraph(CG_PARAMS);
    expect(backupHits).toBe(0); // no failover on a healthy primary
    expect(ensureSpy.calls).toHaveLength(1);
    expect(result.success).toBe(true);
  });

  it('dormant deposit (reads 0) → no approve (deposit===0n branch), original revert propagates', async () => {
    const { a, ensureSpy } = makeCgAdapter({ depositRead: async () => 0n });
    await expect(a.createOnChainContextGraph(CG_PARAMS)).rejects.toThrow('TooLowAllowance');
    expect(ensureSpy.calls).toEqual([]);
  });

  it('guard intact: a non-TooLowAllowance first revert → deposit NOT read, no approve', async () => {
    let reads = 0;
    const { a, ensureSpy, sendSpy } = makeCgAdapter({
      depositRead: async () => { reads += 1; return DEPOSIT; },
      firstRevert: () => new Error('execution reverted: SomeOtherError()'),
    });
    await expect(a.createOnChainContextGraph(CG_PARAMS)).rejects.toThrow('SomeOtherError');
    expect(reads).toBe(0); // guard short-circuits before the deposit read
    expect(ensureSpy.calls).toEqual([]);
    expect(sendSpy.calls).toHaveLength(1);
  });
});
