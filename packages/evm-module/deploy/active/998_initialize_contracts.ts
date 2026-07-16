import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const {
    newContracts,
    newAssetStorageContracts,
    contractsForReinitialization,
    setParametersEncodedData,
    newHashFunctions,
    newScoreFunctions,
  } = hre.helpers;

  const noChangesWereMade = [
    newContracts,
    newAssetStorageContracts,
    setParametersEncodedData,
    newHashFunctions,
    newScoreFunctions,
  ].every((arr) => arr.length === 0);

  console.log(`New or redeployed contracts: ${JSON.stringify(newContracts)}`);
  console.log(
    `New or redeployed Asset Storage contracts: ${JSON.stringify(newAssetStorageContracts)}`,
  );
  console.log(
    `New or redeployed hash functions set in the proxy: ${JSON.stringify(newHashFunctions)}`,
  );
  console.log(
    `New or redeployed score functions set in the proxy: ${JSON.stringify(newScoreFunctions)}`,
  );
  console.log(
    `Initialized contracts: ${JSON.stringify(contractsForReinitialization)}`,
  );
  console.log(
    `Encoded data for parameters settings: ${JSON.stringify(setParametersEncodedData)}`,
  );

  if (
    !noChangesWereMade &&
    !['development'].includes(hre.network.config.environment)
  ) {
    const hubAddress =
      hre.helpers.contractDeployments.contracts['Hub'].evmAddress;

    console.log(`Hub: ${hubAddress}`);

    const Hub = await hre.ethers.getContractAt('Hub', hubAddress);

    const setAndReinitializeContractsTx = await Hub.setAndReinitializeContracts(
      newContracts,
      newAssetStorageContracts,
      contractsForReinitialization,
      setParametersEncodedData,
    );
    await setAndReinitializeContractsTx.wait();
  }
};

export default func;
func.runAtTheEnd = true;
