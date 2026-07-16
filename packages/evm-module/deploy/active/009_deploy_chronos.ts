import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const block = await hre.ethers.provider.getBlock('latest');
  const chronosParametersConfig =
    hre.helpers.parametersConfig[hre.network.config.environment].Chronos;

  await hre.helpers.deploy({
    newContractName: 'Chronos',
    passHubInConstructor: false,
    additionalArgs: [
      chronosParametersConfig.startTime ?? block!.timestamp,
      chronosParametersConfig.epochLength,
    ],
  });
};

export default func;
func.tags = ['Chronos'];
func.dependencies = ['Hub'];
