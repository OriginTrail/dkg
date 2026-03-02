import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();

  if (hre.network.config.environment === 'development') {
    hre.helpers.resetDeploymentsJson();
  }

  if (!hre.helpers.isDeployed('Hub')) {
    const hubDeploymentResult = await hre.deployments.deploy('Hub', {
      contract: 'Hub',
      from: deployer,
      log: true,
    });

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await hre.helpers.updateDeploymentsJson(
      'Hub',
      hubDeploymentResult.address,
      hubDeploymentResult.receipt!.blockNumber,
    );
  }
};

export default func;
func.tags = ['Hub'];
