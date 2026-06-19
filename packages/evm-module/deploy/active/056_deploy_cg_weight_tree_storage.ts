import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

// Fixed Fenwick capacity (power of two). Valid CG ids are 1..BIT_CAPACITY-1.
// Phase-0 (base_sepolia_v10) showed ~75 CGs by epoch 521, so 2^21 (~2.1M) is ample
// headroom. RandomSampling is a fresh-deploy contract — re-pick this at redeploy if the
// live getLatestContextGraphId() ever approaches the cap.
const BIT_CAPACITY = 2_097_152; // 2 ** 21

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'CGWeightTreeStorage',
    additionalArgs: [BIT_CAPACITY],
  });
};

export default func;
func.tags = ['CGWeightTreeStorage', 'v10'];
func.dependencies = ['Hub', 'Chronos', 'ContextGraphValueStorage'];
