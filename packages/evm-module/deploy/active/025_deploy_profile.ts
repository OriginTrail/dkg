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
  // recreate-profile-recovery 0001 — recreateProfile reads
  // ShardingTableStorage to keep the recovered nodeId consistent with any
  // surviving sharding-table entry for the same identityId.
  'ShardingTableStorage',
  'Ask',
  // D13 — Profile.initialize() reads `isOperatorFeeClaimedForEpoch` via CSS
  // after the DelegatorsInfo redirect. V6/V8 DelegatorsInfo migrators
  // retired in TB-1 (archive).
  'ConvictionStakingStorage',
  'Chronos',
];
