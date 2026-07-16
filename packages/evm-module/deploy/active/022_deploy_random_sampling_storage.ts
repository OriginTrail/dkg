import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

type RandomSamplingStorageNetworkConfig = {
  proofingPeriodDurationInBlocks: string;
  W1: string;
  W2: string;
};

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const randomSamplingStorageParametersConfig = hre.helpers.parametersConfig[
    hre.network.config.environment
  ].RandomSamplingStorage[
    hre.network.name
  ] as unknown as RandomSamplingStorageNetworkConfig;

  if (!randomSamplingStorageParametersConfig) {
    throw new Error(
      `RandomSamplingStorage parameters config not found for network: ${hre.network.name}`,
    );
  }

  await hre.helpers.deploy({
    newContractName: 'RandomSamplingStorage',
    additionalArgs: [
      randomSamplingStorageParametersConfig.proofingPeriodDurationInBlocks,
      randomSamplingStorageParametersConfig.W1,
      randomSamplingStorageParametersConfig.W2,
    ],
  });
};

export default func;
func.tags = ['RandomSamplingStorage'];
func.dependencies = ['Hub'];
