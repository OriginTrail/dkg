import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'KnowledgeAssetsLifecycle',
    newContractNameInHub: 'KnowledgeAssetsLifecycle',
  });
};

export default func;
func.tags = ['KnowledgeAssetsLifecycle', 'v10'];
func.dependencies = [
  'Hub',
  'DKGKnowledgeAssets',
  'Chronos',
  'ParametersStorage',
  'IdentityStorage',
  // PaymasterManager dep removed in TB-2 (archived alongside Paymaster).
  // KAv10 no longer routes through the Paymaster contract — sponsorship is
  // expressed as PCA-agent registration on DKGPublishingConvictionNFT.
  // v4.0.0 — KAv10 now reads V10 stake from CSS for the ACK signer gate
  // and routes publish-fee TRAC into the CSS vault. StakingStorage is no
  // longer in the V10 init path.
  'ConvictionStakingStorage',
  'AskStorage',
  'EpochStorage',
  // V10 Phase 8 dependencies — `KnowledgeAssetsV10.initialize()` reverts
  // ZeroAddressDependency for any of these missing from Hub at init time.
  'ContextGraphStorage',
  'ContextGraphs',
  'ContextGraphValueStorage',
  'DKGPublishingConvictionNFT',
];
