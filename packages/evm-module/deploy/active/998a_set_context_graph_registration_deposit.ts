import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

// OT-RFC-53 anti-spam: the per-CG registration deposit ships at 0 in the
// ParametersStorage constructor (so isolated test fixtures are unaffected) and
// is set to its live value here as part of the standard deploy. This protects
// production automatically — no manual governance step, no "we shipped it but
// it was off" silent failure. Test fixtures that don't include the
// `SetContextGraphRegistrationDeposit` tag keep the deposit at 0.
const CONTEXT_GRAPH_REGISTRATION_DEPOSIT = 100n * 10n ** 18n; // 100 TRAC

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  // OT-RFC-53: activate the live deposit on real-network deploys, but keep it
  // DORMANT on the local Hardhat integration suite (chainId 31337). Activating it
  // locally forces every createContextGraph across the broad agent/publisher/chain
  // e2e suites to fund + approve 100 TRAC, and that added per-CG approval latency
  // tips the timing-sensitive ACK/SWM e2e tests over their timeouts. The deposit's
  // behaviour is covered directly + deterministically by the evm-module tests
  // (v10-cg-registration-deposit, v10-pca-lifecycle) and the chain-adapter test
  // (evm-adapter-cg-deposit), which set it explicitly — so dormancy here costs no
  // real coverage.
  //
  // NB: detect the local chain via the PROVIDER's chainId, NOT
  // `hre.network.config.chainId` — the integration deploy targets the `localhost`
  // network whose `config.chainId` is `undefined`, so the original `=== 31337`
  // guard silently never fired (the deposit had been running live in CI). The
  // provider reports the true chainId regardless of network config.
  const { chainId } = await hre.ethers.provider.getNetwork();
  if (chainId === 31337n) {
    console.log('OT-RFC-53: deposit stays dormant on local Hardhat (chainId 31337).');
    return;
  }

  const parametersStorageAddress =
    hre.helpers.contractDeployments.contracts['ParametersStorage'].evmAddress;

  const ParametersStorage = await hre.ethers.getContractAt(
    'ParametersStorage',
    parametersStorageAddress,
  );

  // OT-RFC-53 (deploy-robustness): the deposit is only ENFORCED if ContextGraphs
  // initialized with its deposit stack cached — `createContextGraph` gates the
  // feature on the cached `parametersStorage`. A misordered/partial deploy could
  // leave that cache empty, silently making this anti-spam mitigation inert even
  // though the parameter reads as set. Fail loud instead of shipping it dormant.
  const contextGraphsAddress =
    hre.helpers.contractDeployments.contracts['ContextGraphs'].evmAddress;
  const ContextGraphs = await hre.ethers.getContractAt('ContextGraphs', contextGraphsAddress);
  if ((await ContextGraphs.parametersStorage()) === hre.ethers.ZeroAddress) {
    throw new Error(
      'OT-RFC-53: ContextGraphs has not cached its deposit stack (parametersStorage == 0); ' +
        'the registration deposit would be inert. (Re)initialize ContextGraphs after ' +
        'ParametersStorage/CSS/EpochStorage/Chronos/Token are deployed before activating.',
    );
  }

  const current = await ParametersStorage.contextGraphRegistrationDeposit();
  if (current === CONTEXT_GRAPH_REGISTRATION_DEPOSIT) {
    console.log(
      `contextGraphRegistrationDeposit already ${current} (100 TRAC), skipping`,
    );
    return;
  }

  console.log(
    `Setting contextGraphRegistrationDeposit to ${CONTEXT_GRAPH_REGISTRATION_DEPOSIT} (100 TRAC)...`,
  );
  const tx = await ParametersStorage.setContextGraphRegistrationDeposit(
    CONTEXT_GRAPH_REGISTRATION_DEPOSIT,
  );
  await tx.wait();
  console.log(`contextGraphRegistrationDeposit set (tx: ${tx.hash})`);
};

export default func;
// NB: intentionally NOT tagged 'v10' — only a full deploy (runs every script)
// or a fixture explicitly listing this tag activates the deposit, so v10-group
// test fixtures stay at 0.
func.tags = ['SetContextGraphRegistrationDeposit'];
// This script reads ContextGraphs' CACHED deposit stack (parametersStorage),
// which on a FRESH live deploy is only populated when `998_initialize_contracts`
// runs `Hub.setAndReinitializeContracts` (it registers ParametersStorage, THEN
// reinitializes ContextGraphs — see Hub.sol). The per-contract deploy step only
// COLLECTS contracts for that batch; it does not register/initialize them. So
// this MUST run AFTER 998.
//
// hardhat-deploy runs all `runAtTheEnd` scripts in FILENAME order
// (DeploymentsManager: alphabetical sort, runAtTheEnd bucket appended). 057, 998
// and 999 are all runAtTheEnd, so to land AFTER 998_initialize this file is
// named `998a_…` (998_ < 998a_ < 999_) AND keeps runAtTheEnd = true. Drop the
// flag and it falls into the normal group, which runs before the ENTIRE end-group
// (998 included) and trips the readiness guard again; a numeric prefix < 998
// (e.g. the original 054_) runs first in the end-group, also before 998, and
// fails identically. Incremental deploys are unaffected (already cached).
func.runAtTheEnd = true;
func.dependencies = ['ParametersStorage', 'ContextGraphs'];
