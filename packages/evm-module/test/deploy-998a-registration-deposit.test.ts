// Unit test for deploy/active/998a_set_context_graph_registration_deposit.ts.
//
// This deploy script is the ONLY path that activates the OT-RFC-53 registration
// deposit on real networks — the integration suite keeps it dormant via the
// chainId-31337 gate, and the contract tests set the parameter directly — so its
// gate / readiness / idempotency logic is otherwise unvalidated (a regression
// could leave production at the constructor default of 0). This exercises the
// script in isolation against a mocked HRE: no chain, no real deploy.

import { expect } from 'chai';
import { ethers } from 'ethers';

import deployFn from '../deploy/active/998a_set_context_graph_registration_deposit';

const DEPOSIT = 100n * 10n ** 18n; // 100 TRAC — must match the script
const PS_ADDR = '0x1111111111111111111111111111111111111111';
const CG_ADDR = '0x2222222222222222222222222222222222222222';
const READY_PS = '0x3333333333333333333333333333333333333333';

function buildMockHre(opts: {
  chainId: bigint;
  currentDeposit?: bigint;
  cachedParametersStorage?: string; // what ContextGraphs.parametersStorage() returns
}) {
  const setCalls: bigint[] = [];
  const mockParametersStorage = {
    contextGraphRegistrationDeposit: async () => opts.currentDeposit ?? 0n,
    setContextGraphRegistrationDeposit: async (v: bigint) => {
      setCalls.push(v);
      return { hash: '0xtx', wait: async () => undefined };
    },
  };
  const mockContextGraphs = {
    parametersStorage: async () => opts.cachedParametersStorage ?? READY_PS,
  };
  const hre = {
    ethers: {
      ZeroAddress: ethers.ZeroAddress,
      provider: { getNetwork: async () => ({ chainId: opts.chainId }) },
      getContractAt: async (name: string) =>
        name === 'ParametersStorage' ? mockParametersStorage : mockContextGraphs,
    },
    helpers: {
      contractDeployments: {
        contracts: {
          ParametersStorage: { evmAddress: PS_ADDR },
          ContextGraphs: { evmAddress: CG_ADDR },
        },
      },
    },
  };
  return { hre, setCalls };
}

describe('@unit deploy/054 — OT-RFC-53 registration-deposit activation', () => {
  it('stays dormant on local Hardhat (chainId 31337) — never calls the setter', async () => {
    const { hre, setCalls } = buildMockHre({ chainId: 31337n });
    await deployFn(hre as never);
    expect(setCalls).to.have.length(0);
  });

  it('activates 100 TRAC on a real network when unset and ContextGraphs is ready', async () => {
    const { hre, setCalls } = buildMockHre({ chainId: 8453n, currentDeposit: 0n });
    await deployFn(hre as never);
    expect(setCalls).to.deep.equal([DEPOSIT]);
  });

  it('is idempotent — skips the setter when already at 100 TRAC', async () => {
    const { hre, setCalls } = buildMockHre({ chainId: 8453n, currentDeposit: DEPOSIT });
    await deployFn(hre as never);
    expect(setCalls).to.have.length(0);
  });

  it('fails loud when ContextGraphs has not cached its deposit stack (deposit would be inert)', async () => {
    const { hre, setCalls } = buildMockHre({
      chainId: 8453n,
      currentDeposit: 0n,
      cachedParametersStorage: ethers.ZeroAddress,
    });
    let error: Error | undefined;
    try {
      await deployFn(hre as never);
    } catch (e) {
      error = e as Error;
    }
    expect(error, 'expected the deploy to throw on an inert ContextGraphs').to.be.an('Error');
    expect(error!.message).to.match(/has not cached its deposit stack/);
    expect(setCalls, 'must not set the deposit on the failure path').to.have.length(0);
  });
});
