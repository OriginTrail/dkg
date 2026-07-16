import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'KnowledgeCollection',
  });
};

export default func;
func.tags = ['KnowledgeCollection'];
func.dependencies = [
  'Hub',
  'Chronos',
  'ShardingTableStorage',
  'KnowledgeCollectionStorage',
  'ParametersStorage',
  'IdentityStorage',
  'PaymasterManager',
];

// Archived per PRD §4.1 (V8/V9 contract stack retired in V10).
// hardhat-deploy still discovers this file via recursive scan of paths.deploy;
// func.skip guarantees the deployment step is a no-op.
func.skip = async () => true;
