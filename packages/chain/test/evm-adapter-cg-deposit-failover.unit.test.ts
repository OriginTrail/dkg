/**
 * #1340: the CG-register TooLowAllowance recovery reads the registration deposit
 * through the RPC-failover facade (`this.readContract`) rather than a bare call
 * on the signer's primary-bound `parametersStorage` handle. Before the fix a
 * broken primary threw the read → it was swallowed to 0n → the TRAC approve +
 * retry never ran, so a new CG's first publish failed permanently under a
 * degraded primary despite healthy backups.
 *
 * These test the extracted `readCgRegistrationDeposit` seam directly (bare
 * provider doubles, no Hardhat, no `createOnChainContextGraph` reconstruction).
 * The surrounding recovery/approve/retry orchestration — which this PR does NOT
 * change — is covered by the real-chain `evm-adapter-cg-deposit.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADMIN_PK = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';

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

const retryable429 = () => { const e = new Error('429 too many requests'); (e as any).status = 429; return e; };

describe('readCgRegistrationDeposit — reads the deposit through RPC failover (#1340)', () => {
  const DEPOSIT = 100n;

  // Two endpoints so readContract can fail over; `parametersStorage.connect(p)`
  // branches on provider identity (p0 = primary, p1 = backup) to model a
  // degraded primary. Only the fields the deposit read touches are stubbed —
  // no lifecycle/contract-bag/tx-submission reconstruction.
  function makeAdapter(depositRead: (endpointIndex: 0 | 1) => Promise<bigint>) {
    const a: any = new EVMChainAdapter(minimalConfig());
    // Isolate the failover read from the chainId preflight (not under test).
    a.ensureConfiguredStaticChainIdValidated = async () => {};
    const p0 = {}; const p1 = {};
    a.providers = [p0, p1];
    a.rpcUrls = ['https://primary.example', 'https://backup.example'];
    a.contracts = {
      parametersStorage: {
        connect: (p: unknown) => ({
          contextGraphRegistrationDeposit: () => depositRead(p === p0 ? 0 : 1),
        }),
      },
    };
    return a;
  }

  it('cure: broken primary → the read fails over to a healthy backup', async () => {
    let primaryHits = 0; let backupHits = 0;
    const a = makeAdapter(async (i) => {
      if (i === 0) { primaryHits += 1; throw retryable429(); }
      backupHits += 1; return DEPOSIT;
    });
    expect(await a.readCgRegistrationDeposit()).toBe(DEPOSIT);
    expect(primaryHits).toBe(1); // primary tried and threw
    expect(backupHits).toBe(1);  // failed over to the backup
  });

  it('all endpoints fail → 0n (conservative; the recovery then re-throws the original revert, no approve)', async () => {
    const a = makeAdapter(async () => { throw retryable429(); });
    expect(await a.readCgRegistrationDeposit()).toBe(0n);
  });

  it('healthy primary → answers without consulting the backup', async () => {
    let backupHits = 0;
    const a = makeAdapter(async (i) => { if (i === 1) backupHits += 1; return DEPOSIT; });
    expect(await a.readCgRegistrationDeposit()).toBe(DEPOSIT);
    expect(backupHits).toBe(0);
  });

  it('no parametersStorage contract → 0n (no read attempted)', async () => {
    const a: any = new EVMChainAdapter(minimalConfig());
    a.contracts = {};
    expect(await a.readCgRegistrationDeposit()).toBe(0n);
  });
});
