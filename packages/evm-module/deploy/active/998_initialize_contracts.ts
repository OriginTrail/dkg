import { Interface } from 'ethers';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

/**
 * `Hub.setAndReinitializeContracts` is `onlyOwnerOrMultiSigOwner`: the Hub
 * owner, or one of the owners a multisig Hub owner reports through
 * `getOwners()`. True when the deployer is one of them.
 */
async function deployerMayCallHub(
  hre: HardhatRuntimeEnvironment,
  hubOwner: string,
  deployer: string,
): Promise<boolean> {
  if (hubOwner.toLowerCase() === deployer.toLowerCase()) return true;
  try {
    const multisig = await hre.ethers.getContractAt(
      ['function getOwners() view returns (address[])'],
      hubOwner,
    );
    const owners: string[] = await multisig.getOwners();
    return owners.some((o) => o.toLowerCase() === deployer.toLowerCase());
  } catch {
    // Not a multisig that reports its owners (an EOA, or another account).
    return false;
  }
}

/** One forwarded call, decoded against its target's ABI when that is available. */
function describeCall(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  data: string,
): string {
  try {
    const parsed = new Interface(hre.helpers.getAbi(contractName)).parseTransaction({ data });
    if (parsed) {
      return `${contractName}.${parsed.name}(${parsed.args.map((a) => String(a)).join(', ')})`;
    }
  } catch {
    // Fall through to the raw calldata.
  }
  return `${contractName} <- ${data}`;
}

/**
 * Print the Hub transaction for the Hub owner to send, decoded, as 057 prints
 * its own go-live step when the deployer is not the Hub owner.
 */
function printHubOwnerTransaction(
  hre: HardhatRuntimeEnvironment,
  hubAddress: string,
  data: string,
  hubOwner: string,
  deployer: string,
) {
  const { newContracts, newAssetStorageContracts, contractsForReinitialization, setParametersEncodedData } =
    hre.helpers;
  const names = new Map<string, string>();
  for (const [name, c] of Object.entries(hre.helpers.contractDeployments.contracts)) {
    names.set(c.evmAddress.toLowerCase(), name);
  }
  const nameOf = (address: unknown) => names.get(String(address).toLowerCase()) ?? 'unknown';

  console.log(
    `[Hub] The deployer ${deployer} is neither the Hub owner ${hubOwner} nor an owner it reports, so it ` +
      'cannot call Hub.setAndReinitializeContracts. The contracts above are deployed, and recorded in the ' +
      'deployments file, but they are not registered, initialized or parameterized until the Hub owner ' +
      'sends this transaction:',
  );
  console.log(`[Hub]   to:    ${hubAddress}`);
  console.log('[Hub]   value: 0');
  console.log(`[Hub]   data:  ${data}`);
  console.log('[Hub] Decoded, in the order the Hub applies it:');
  console.log('[Hub]   1. register in the contract set (Hub.setContractAddress semantics):');
  for (const c of newContracts) console.log(`[Hub]        ${c.name} -> ${c.addr}`);
  if (newContracts.length === 0) console.log('[Hub]        none');
  console.log('[Hub]   2. register as asset storages:');
  for (const c of newAssetStorageContracts) console.log(`[Hub]        ${c.name} -> ${c.addr}`);
  if (newAssetStorageContracts.length === 0) console.log('[Hub]        none');
  console.log('[Hub]   3. call initialize(), in this order:');
  contractsForReinitialization.forEach((a, i) =>
    console.log(`[Hub]        ${String(i + 1).padStart(2)}. ${String(a)} (${nameOf(a)})`),
  );
  if (contractsForReinitialization.length === 0) console.log('[Hub]        none');
  console.log('[Hub]   4. forward, through Hub.forwardCall:');
  for (const f of setParametersEncodedData) {
    for (const d of f.encodedData) console.log(`[Hub]        ${describeCall(hre, String(f.contractName), String(d))}`);
  }
  if (setParametersEncodedData.length === 0) console.log('[Hub]        none');
  console.log(`[Hub] Hub owner transaction (JSON): ${JSON.stringify({ to: hubAddress, value: '0', data })}`);
  console.log(
    '[Hub] Send it before any further deploy run on this network: the deployments file now records these ' +
      'contracts as deployed, so a later run would neither deploy nor register them, and the transaction it ' +
      'prints would revert.',
  );
}

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

    // Send the Hub transaction only when the deployer may. Otherwise (a
    // deployer that is neither the Hub owner nor an owner of a multisig that
    // owns the Hub) print it, decoded, for the Hub owner to send, and leave the
    // contracts unregistered.
    const { deployer } = await hre.getNamedAccounts();
    const hubOwner: string = await Hub.owner();
    if (!(await deployerMayCallHub(hre, hubOwner, deployer))) {
      const data = Hub.interface.encodeFunctionData('setAndReinitializeContracts', [
        newContracts,
        newAssetStorageContracts,
        contractsForReinitialization,
        setParametersEncodedData,
      ]);
      printHubOwnerTransaction(hre, hubAddress, data, hubOwner, deployer);
      return;
    }

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
