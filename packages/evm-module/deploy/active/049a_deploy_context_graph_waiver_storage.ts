import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

// OT-RFC-53: spam-cap state + logic for the PCA-backed CG registration-deposit
// waiver. ContextGraphs resolves it fresh via the Hub at create-time, so no
// re-initialization of ContextGraphs is required when this is (re)deployed.
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'ContextGraphWaiverStorage',
  });
};

export default func;
func.tags = ['ContextGraphWaiverStorage', 'v10'];
func.dependencies = ['Hub'];
