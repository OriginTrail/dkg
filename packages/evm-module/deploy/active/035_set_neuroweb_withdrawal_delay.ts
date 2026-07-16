import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const NEUROWEB_MAINNET_CHAIN_ID = 2043;
const NEUROWEB_TESTNET_CHAIN_ID = 20430;
const NEW_WITHDRAWAL_DELAY = 5 * 60; // 5 minutes in seconds

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const chainId = hre.network.config.chainId;

  if (chainId !== NEUROWEB_MAINNET_CHAIN_ID && chainId !== NEUROWEB_TESTNET_CHAIN_ID) {
    console.log(`Skipping withdrawal delay update: not on NeuroWeb (chainId: ${chainId})`);
    return;
  }

  const parametersStorageAddress =
    hre.helpers.contractDeployments.contracts['ParametersStorage'].evmAddress;

  const ParametersStorage = await hre.ethers.getContractAt(
    'ParametersStorage',
    parametersStorageAddress,
  );

  const currentDelay = await ParametersStorage.stakeWithdrawalDelay();
  console.log(`Current stakeWithdrawalDelay: ${currentDelay} seconds (${Number(currentDelay) / 86400} days)`);

  if (Number(currentDelay) === NEW_WITHDRAWAL_DELAY) {
    console.log(`stakeWithdrawalDelay already set to ${NEW_WITHDRAWAL_DELAY}s, skipping`);
    return;
  }

  console.log(`Setting stakeWithdrawalDelay to ${NEW_WITHDRAWAL_DELAY}s (5 minutes) on NeuroWeb...`);
  const tx = await ParametersStorage.setStakeWithdrawalDelay(NEW_WITHDRAWAL_DELAY);
  await tx.wait();
  console.log(`stakeWithdrawalDelay updated to ${NEW_WITHDRAWAL_DELAY}s (tx: ${tx.hash})`);
};

export default func;
func.tags = ['SetNeurowebWithdrawalDelay'];
func.dependencies = ['ParametersStorage'];
