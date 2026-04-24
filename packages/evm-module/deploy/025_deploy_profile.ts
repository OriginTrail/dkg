import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'Profile',
  });
};

export default func;
func.tags = ['Profile'];
func.dependencies = [
  'Hub',
  'Identity',
  'IdentityStorage',
  'ParametersStorage',
  'ProfileStorage',
  'WhitelistStorage',
  'Ask',
  // D13 — Profile.initialize() reads `isOperatorFeeClaimedForEpoch` via CSS
  // after the DelegatorsInfo redirect. DelegatorsInfo kept in deps for fresh
  // chain bring-ups that still run the V6/V8 migrators (see 021 header).
  'ConvictionStakingStorage',
  'DelegatorsInfo',
  'Chronos',
];
