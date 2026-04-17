/* eslint-disable @typescript-eslint/no-explicit-any */
import 'dotenv/config';
import { execSync } from 'child_process';
import * as fs from 'fs';

import { AddressLike, Contract } from 'ethers';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

import { HubLib } from '../typechain/contracts/storage/Hub';

type AbiEntry = {
  inputs?: Array<{ internalType: string; name: string; type: string }>;
  name?: string;
  outputs?: Array<{ internalType: string; name: string; type: string }>;
  stateMutability?: string;
  type: string;
};

type ContractDeployments = {
  contracts: {
    [contractName: string]: {
      evmAddress: string;
      version: string;
      gitBranch: string;
      gitCommitHash: string;
      deploymentBlock: number;
      deploymentTimestamp: number;
      deployed: boolean;
      migration?: boolean;
    };
  };
};

type DeploymentParameters = {
  newContractName: string;
  newContractNameInHub?: string;
  passHubInConstructor?: boolean;
  setContractInHub?: boolean;
  setAssetStorageInHub?: boolean;
  additionalArgs?: Array<unknown>;
  deterministicDeployment?: boolean;
};

type ContractParameter = {
  getterArgs?: any[];
  desiredValue?: any[];
  setter?: string;
  setterArgs: any[];
};

type ContractParametersConfig = {
  [parameter: string]: ContractParameter | string | ContractParameter[];
};

type BaseEnvironmentParametersConfig = {
  [contractName: string]: ContractParametersConfig;
};

type OverridesConfig = {
  overrides?: {
    [network: string]: {
      [contractName: string]: ContractParametersConfig;
    };
  };
};

type EnvironmentParametersConfig = BaseEnvironmentParametersConfig &
  OverridesConfig;

type ParametersConfig = {
  [environment: string]: EnvironmentParametersConfig;
};

type EvmWallet = {
  address: string;
  mnemonic: string;
  privateKey: string;
};

export class Helpers {
  hre: HardhatRuntimeEnvironment;
  repositoryPath: string;
  contractDeployments: ContractDeployments;
  parametersConfig: ParametersConfig;
  newContracts: HubLib.ContractStruct[];
  newAssetStorageContracts: HubLib.ContractStruct[];
  contractsForReinitialization: AddressLike[];
  setParametersEncodedData: HubLib.ForwardCallInputArgsStruct[];
  newHashFunctions: Array<string>;
  newScoreFunctions: Array<string>;
  // Explicit nonce tracker for live networks where two tx managers (hardhat-deploy
  // + ethers) would otherwise conflict by tracking nonces independently.
  private _nonce: number | undefined = undefined;

  constructor(hre: HardhatRuntimeEnvironment) {
    this.hre = hre;

    this.repositoryPath = this._getGitRepositoryPath();

    const deploymentsConfig = `./deployments/${this.hre.network.name}_contracts.json`;

    if (fs.existsSync(deploymentsConfig)) {
      this.contractDeployments = JSON.parse(
        fs.readFileSync(deploymentsConfig).toString(),
      );
    } else {
      this.contractDeployments = { contracts: {} };
    }

    const parametersConfig = './deployments/parameters.json';

    if (fs.existsSync(parametersConfig)) {
      this.parametersConfig = JSON.parse(
        fs.readFileSync(parametersConfig).toString(),
      );
    } else {
      this.parametersConfig = {
        development: {},
        devnet: {},
        testnet: {},
        mainnet: {},
      };
    }

    this.newContracts = [];
    this.newAssetStorageContracts = [];
    this.contractsForReinitialization = [];
    this.setParametersEncodedData = [];
    this.newHashFunctions = [];
    this.newScoreFunctions = [];
  }

  public async deploy({
    newContractName,
    newContractNameInHub = undefined,
    passHubInConstructor = true,
    setContractInHub = true,
    setAssetStorageInHub = false,
    additionalArgs = [],
    deterministicDeployment = false,
  }: DeploymentParameters): Promise<Contract> {
    const { deployer } = await this.hre.getNamedAccounts();

    const nameInHub = newContractNameInHub
      ? newContractNameInHub
      : newContractName;

    if (this.isDeployed(nameInHub)) {
      const contractInstance = await this.hre.ethers.getContractAt(
        this.getAbi(newContractName),
        this.contractDeployments.contracts[nameInHub].evmAddress,
      );

      if (this.hasFunction(newContractName, 'initialize')) {
        // TODO: Reinitialize only if any dependency contract was redeployed
        this.contractsForReinitialization.push(
          await contractInstance.getAddress(),
        );
      }

      return contractInstance;
    }

    let hubAddress;
    if ('Hub' in this.contractDeployments.contracts) {
      hubAddress = this.contractDeployments.contracts['Hub'].evmAddress;
    } else {
      hubAddress = (await this.hre.deployments.get('Hub')).address;
    }

    let newContract;
    try {
      const deployNonce = await this._nextNonce(deployer);
      newContract = await this.hre.deployments.deploy(nameInHub, {
        contract: newContractName,
        from: deployer,
        args: passHubInConstructor
          ? [hubAddress, ...additionalArgs]
          : additionalArgs,
        deterministicDeployment,
        log: true,
        ...(deployNonce !== undefined ? { nonce: deployNonce } : {}),
      });
    } catch (error) {
      if (this.hre.network.config.environment !== 'development') {
        this.saveDeploymentsJson('deployments');
      }
      let message;
      if (error instanceof Error) message = error.message;
      else message = String(error);

      throw Error(message);
    }

    const Hub = await this.hre.ethers.getContractAt('Hub', hubAddress);

    let tx;
    if (setContractInHub) {
      if (this.hre.network.config.environment === 'development') {
        const regNonce = await this._nextNonce(deployer);
        tx = await Hub.setContractAddress(
          nameInHub,
          newContract.address,
          ...(regNonce !== undefined ? [{ nonce: regNonce }] : []),
        );
        await tx.wait();
      } else {
        this.newContracts.push({ name: nameInHub, addr: newContract.address });
      }
    } else if (setAssetStorageInHub) {
      if (this.hre.network.config.environment === 'development') {
        const regNonce = await this._nextNonce(deployer);
        tx = await Hub.setAssetStorageAddress(
          nameInHub,
          newContract.address,
          ...(regNonce !== undefined ? [{ nonce: regNonce }] : []),
        );
        await tx.wait();

      } else {
        this.newAssetStorageContracts.push({
          name: nameInHub,
          addr: newContract.address,
        });
      }
    }

    if (this.hasFunction(newContractName, 'initialize')) {
      if (
        (setContractInHub || setAssetStorageInHub) &&
        this.hre.network.config.environment === 'development'
      ) {
        const newContractInterface = new this.hre.ethers.Interface(
          this.getAbi(newContractName),
        );
        const initNonce = await this._nextNonce(deployer);
        const initializeTx = await Hub.forwardCall(
          newContract.address,
          newContractInterface.encodeFunctionData('initialize'),
          ...(initNonce !== undefined ? [{ nonce: initNonce }] : []),
        );
        await initializeTx.wait();
      }
      this.contractsForReinitialization.push(newContract.address);
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await this.updateDeploymentsJson(
      nameInHub,
      newContract.address,
      newContract.receipt!.blockNumber,
      newContractName,
    );

    this.saveDeploymentsJson('deployments');

    return this.hre.ethers.getContractAt(
      this.getAbi(newContractName),
      newContract.address,
    );
  }

  public async updateContractParameters(
    contractName: string,
    contract: Contract,
  ) {
    let parameters =
      this.parametersConfig[this.hre.network.config.environment]?.[
        contractName
      ];

    const overrideParameters =
      this.parametersConfig[this.hre.network.config.environment]?.overrides?.[
        this.hre.network.name
      ]?.[contractName];

    parameters = { ...parameters, ...overrideParameters };

    if (!parameters) {
      return;
    }

    const forwardCall: HubLib.ForwardCallInputArgsStruct = {
      contractName,
      encodedData: [],
    };
    for (const [getterName, paramValue] of Object.entries(parameters)) {
      const values = Array.isArray(paramValue) ? paramValue : [paramValue];

      for (const value of values) {
        let getterArgs = [];
        let desiredValue;
        let setterName;
        let setterArgs;

        if (value instanceof Object) {
          getterArgs = value.getterArgs ? value.getterArgs : [];
          desiredValue =
            value.setterArgs.length === 1
              ? value.setterArgs[0]
              : value.desiredValue;
          setterName = value.setter
            ? value.setter
            : `set${getterName.charAt(0).toUpperCase() + getterName.slice(1)}`;
          setterArgs = value.setterArgs;
        } else {
          desiredValue = value;
          setterName = `set${getterName.charAt(0).toUpperCase() + getterName.slice(1)}`;
          setterArgs = [value];
        }

        if (contract.interface.hasFunction(getterName)) {
          const currentValue = await contract[getterName](...getterArgs);

          if (currentValue.toString() !== desiredValue.toString()) {
            console.log(
              `Parameter '${getterName}' for ${contractName} in the contract isn't the same as define in config. Blockchain: ${currentValue}. Config: ${desiredValue}.`,
            );
            if (contract.interface.hasFunction(setterName)) {
              const encodedFunctionData = contract.interface.encodeFunctionData(
                setterName,
                setterArgs,
              );

              if (this.hre.network.config.environment === 'development') {
                console.log(
                  `[${contractName}] Setting parameter '${getterName}' value to be ${desiredValue}.`,
                );

                const targetContractAddress =
                  this.contractDeployments.contracts[contractName].evmAddress;
                const hubAddress =
                  this.contractDeployments.contracts['Hub'].evmAddress;
                const Hub = await this.hre.ethers.getContractAt(
                  'Hub',
                  hubAddress,
                );
                const { deployer } = await this.hre.getNamedAccounts();
                const paramNonce = await this._nextNonce(deployer);
                const tx = await Hub.forwardCall(
                  targetContractAddress,
                  encodedFunctionData,
                  ...(paramNonce !== undefined ? [{ nonce: paramNonce }] : []),
                );
                await tx.wait();
              } else {
                console.log(
                  `[${contractName}] Adding parameter '${getterName}' value to be set to ${desiredValue} using Hub.`,
                );

                forwardCall.encodedData.push(encodedFunctionData);
              }
            } else {
              throw Error(
                `Setter '${setterName}' doesn't exist in the contract '${contractName}'.`,
              );
            }
          }
        } else {
          throw Error(
            `Parameter '${getterName}' doesn't exist in the contract '${contractName}'.`,
          );
        }
      }
    }

    if (forwardCall.encodedData.length !== 0) {
      this.setParametersEncodedData.push(forwardCall);
    }
  }

  public inConfig(contractName: string): boolean {
    return contractName in this.contractDeployments.contracts;
  }

  public isDeployed(contractName: string): boolean {
    if (this.inConfig(contractName)) {
      return this.contractDeployments.contracts[contractName].deployed;
    } else {
      return false;
    }
  }

  public hasFunction(contractName: string, functionName: string): boolean {
    const contractAbi = this.getAbi(contractName);
    return contractAbi.some(
      (entry) => entry.type === 'function' && entry.name === functionName,
    );
  }

  public getAbi(contractName: string): AbiEntry[] {
    return JSON.parse(fs.readFileSync(`./abi/${contractName}.json`, 'utf-8'));
  }

  public resetDeploymentsJson() {
    this.contractDeployments = { contracts: {} };
  }

  public async updateDeploymentsJson(
    newContractName: string,
    newContractAddress: string,
    deploymentBlock: number,
    originalContractName: string | null = null,
  ) {
    const contractABI = this.getAbi(originalContractName ?? newContractName);
    const isVersionedContract = contractABI.some(
      (abiEntry) => abiEntry.type === 'function' && abiEntry.name === 'version',
    );

    let contractVersion;

    if (isVersionedContract) {
      const VersionedContract = await this.hre.ethers.getContractAt(
        originalContractName ?? newContractName,
        newContractAddress,
      );
      // Retry with backoff — public RPC nodes (e.g. Base Sepolia) can lag
      // slightly after a deployment tx is mined, returning 0x before state propagates.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          contractVersion = await VersionedContract.version();
          break;
        } catch (err) {
          if (attempt < 4) {
            console.log(`version() call failed (attempt ${attempt + 1}/5), retrying in 3s...`);
            await this._delay(3000);
          } else {
            throw err;
          }
        }
      }
    } else {
      contractVersion = null;
    }

    this.contractDeployments.contracts[newContractName] = {
      evmAddress: newContractAddress,
      version: contractVersion,
      gitBranch: this.getCurrentGitBranch(),
      gitCommitHash: this.getCurrentGitCommitHash(),
      deploymentBlock: deploymentBlock,
      deploymentTimestamp: Date.now(),
      deployed: true,
    };
  }

  public saveDeploymentsJson(folder: string) {
    console.log(
      `New or redeployed contracts: ${JSON.stringify(this.newContracts)}`,
    );
    console.log(
      `New or redeployed Asset Storage contracts: ${JSON.stringify(this.newAssetStorageContracts)}`,
    );
    console.log(
      `New or redeployed hash functions set in the proxy: ${JSON.stringify(this.newHashFunctions)}`,
    );
    console.log(
      `New or redeployed score functions set in the proxy: ${JSON.stringify(this.newScoreFunctions)}`,
    );
    console.log(
      `Initialized contracts: ${JSON.stringify(this.contractsForReinitialization)}`,
    );
    console.log(
      `Encoded data for parameters settings: ${JSON.stringify(this.setParametersEncodedData)}`,
    );

    fs.writeFileSync(
      `${folder}/${this.hre.network.name}_contracts.json`,
      JSON.stringify(this.contractDeployments, null, 4),
    );
  }

  public generateEvmWallet(): EvmWallet {
    const wallet = this.hre.ethers.Wallet.createRandom();

    return {
      address: wallet.address,
      mnemonic: wallet.mnemonic!.phrase,
      privateKey: wallet.privateKey,
    };
  }

  public getCurrentGitCommitHash(): string {
    return this._executeGitCommandSync('git rev-parse HEAD');
  }

  public getCurrentGitBranch(): string {
    return this._executeGitCommandSync('git rev-parse --abbrev-ref HEAD');
  }

  private _delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Returns the next nonce for the deployer, using a single in-process
  // counter so hardhat-deploy txs and ethers txs share the same sequence.
  private async _nextNonce(deployer: string): Promise<number | undefined> {
    const isLive =
      this.hre.network.name !== 'hardhat' &&
      this.hre.network.name !== 'localhost';
    if (!isLive) return undefined;
    if (this._nonce === undefined) {
      this._nonce = await this.hre.ethers.provider.getTransactionCount(
        deployer,
        'latest',
      );
    }
    return this._nonce++;
  }

  private _executeGitCommandSync(command: string): string {
    try {
      const stdout = execSync(command, { cwd: this.repositoryPath });
      return stdout.toString().trim();
    } catch (error) {
      throw new Error(`exec error: ${error}`);
    }
  }

  private _getGitRepositoryPath(): string {
    try {
      const stdout = execSync('git rev-parse --show-toplevel');
      return stdout.toString().trim();
    } catch (error) {
      throw new Error(`Could not determine the repository path: ${error}`);
    }
  }
}
