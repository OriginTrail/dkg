import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();

  const isDeployed = hre.helpers.isDeployed('Token');

  if (isDeployed) {
    const hubAddress =
      hre.helpers.contractDeployments.contracts['Hub'].evmAddress;
    const Hub = await hre.ethers.getContractAt('Hub', hubAddress);

    const tokenInHub = await Hub['isContract(string)']('Token');

    if (!tokenInHub) {
      hre.helpers.newContracts.push({
        name: 'Token',
        addr: hre.helpers.contractDeployments.contracts['Token'].evmAddress,
      });
    }
  } else if (!isDeployed && hre.network.config.environment === 'development') {
    const Token = await hre.helpers.deploy({
      newContractName: 'Token',
      passHubInConstructor: false,
      additionalArgs: ['TEST TOKEN', 'TEST'],
    });

    const minterRole = await Token.MINTER_ROLE();
    if (!(await Token.hasRole(minterRole, deployer))) {
      console.log(`Granting minter role for ${deployer}.`);
      const setupMinterRoleTx = await Token['grantRole(address)'](deployer, {
        from: deployer,
      });
      await setupMinterRoleTx.wait();
    }

    const amountToMint = hre.ethers.parseEther(`${10_000_000}`);
    const accounts = await hre.ethers.getSigners();

    for (const acc of accounts) {
      const mintTx = await Token.mint(acc.address, amountToMint, {
        from: deployer,
        gasLimit: 80_000,
      });
      await mintTx.wait();
    }
  } else {
    throw new Error('Missing Token address in the JSON config!');
  }
};

export default func;
func.tags = ['Token'];
func.dependencies = ['Hub'];
