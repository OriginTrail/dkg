import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'MarketplaceStorage',
  });
};

export default func;
func.tags = ['MarketplaceStorage'];
// OT-RFC-27 — `initialize()` reads `Chronos.epochLength()` to default
// `settlementGraceSeconds` (epochLength/4), so Chronos must be Hub-registered
// before MarketplaceStorage initializes.
func.dependencies = ['Hub', 'Chronos'];
