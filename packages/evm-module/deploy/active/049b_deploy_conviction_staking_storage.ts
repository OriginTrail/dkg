import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'ConvictionStakingStorage',
  });
};

export default func;
func.tags = ['ConvictionStakingStorage', 'v10'];
// v4.0.0 — CSS now extends Guardian, so its initialize() pulls the Token
// address from Hub. Token must therefore be Hub-registered before CSS
// initialize() runs (mirrors V8 StakingStorage's deploy dependencies).
func.dependencies = ['Hub', 'Token', 'Chronos'];
