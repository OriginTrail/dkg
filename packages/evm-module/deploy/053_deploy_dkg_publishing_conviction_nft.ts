import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'DKGPublishingConvictionNFT',
  });
};

export default func;
func.tags = ['DKGPublishingConvictionNFT', 'v10'];
func.dependencies = [
  'Hub',
  'Token',
  // v4.0.0 — `DKGPublishingConvictionNFT.initialize()` resolves
  // `ConvictionStakingStorage` (V10 vault) for `stakingStorageAddress`
  // post-consolidation. The Hub registration must precede this deploy.
  'ConvictionStakingStorage',
  'StakingStorage',
  'EpochStorage',
  'Chronos',
];
