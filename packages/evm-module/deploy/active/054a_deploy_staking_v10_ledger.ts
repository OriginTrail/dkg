import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

/**
 * V10 — deploys `StakingV10Ledger`, which runs the balance moves of
 * `StakingV10` that touch no position: the operator-fee withdrawal (request,
 * finalize, cancel) and the drains of V8 stake and V8 operator fees into
 * migration credit. `StakingV10` keeps those entry points and their caller
 * gates and forwards to it, so the two contracts deploy together.
 *
 * It is registered in the Hub's contract set, so the `onlyContracts` mutators
 * of `StakingStorage` and `ConvictionStakingStorage` admit it. `initialize()`
 * wires `StakingStorage`, `ConvictionStakingStorage`, `IdentityStorage` and
 * `ParametersStorage`; it admits only the contract the Hub holds as
 * `StakingV10`, looked up at each call, so `StakingV10` may deploy after it.
 *
 * `StakingV10.initialize()` resolves this contract from the Hub, so it is
 * registered first: on development it is deployed and initialized here, before
 * `055_deploy_staking_v10.ts`, which depends on it; on a live network
 * `998_initialize_contracts.ts` registers both in one
 * `Hub.setAndReinitializeContracts` before either is initialized.
 *
 * Included in the `v10` deploy tag so the prod cutover pulls it.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'StakingV10Ledger',
  });
};

export default func;
func.tags = ['StakingV10Ledger', 'v10'];
func.dependencies = [
  'Hub',
  'StakingStorage',
  'ConvictionStakingStorage',
  'IdentityStorage',
  'ParametersStorage',
];
